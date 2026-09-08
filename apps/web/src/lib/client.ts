"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useHousehold } from "@/components/shared/providers";
import { emitEvent } from "./actions";
import {
  cacheData,
  cached,
  entityPath,
  evictDeniedResource,
  getLease,
  purgeOffline,
  queueable,
  queueCommand,
} from "./offline";

export class RequestError extends Error {
  constructor(
    message: string,
    public code = "REQUEST_FAILED",
    public status = 500,
  ) {
    super(message);
  }
}
export function useHeima<T>(path: string, enabled = true) {
  const actorId = useHousehold().member.userId;
  const queryClient = useQueryClient();
  return useQuery<T>({
    queryKey: ["heima", path],
    enabled,
    retry: 1,
    networkMode: "always",
    queryFn: async () => {
      if (!navigator.onLine) {
        const data = cached<T>(path);
        if (data !== undefined) return data;
        throw new RequestError(
          getLease()
            ? "This information isn't available offline."
            : "Reconnect to renew your household session.",
          "OFFLINE",
          0,
        );
      }
      const clean = path.replace(/^\/v1\//, "").replace(/^\//, "");
      const response = await fetch(`/api/backend/${clean}`, {
        cache: "no-store",
        headers: { "x-heima-actor-id": actorId },
      });
      const body = await response.json();
      if (!response.ok) {
        if (response.status === 404) {
          await evictDeniedResource(path);
          const listId =
            path.split("?")[0] === "/v1/shopping/items"
              ? new URLSearchParams(path.split("?")[1]).get("listId")
              : null;
          const deniedId = listId ?? path.split("?")[0]?.split("/").at(-1);
          const deniedList = !!listId || path.startsWith("/v1/shopping/lists/");
          queryClient.setQueriesData(
            { queryKey: ["heima"] },
            (previous: unknown) => {
              if (!previous || typeof previous !== "object") return previous;
              const value = previous as Record<string, unknown>;
              if (
                value.id === deniedId ||
                (deniedList && value.listId === deniedId)
              )
                return null;
              if (Array.isArray(value.items))
                return {
                  ...value,
                  items: value.items.filter(
                    (item: { id: string; listId?: string }) =>
                      item.id !== deniedId &&
                      (!deniedList || item.listId !== deniedId),
                  ),
                };
              return previous;
            },
          );
        }
        if (response.status === 401 || response.status === 403)
          purgeOffline(actorId);
        throw new RequestError(
          body.error?.message ?? "Couldn't load this information.",
          body.error?.code,
          response.status,
        );
      }
      try {
        cacheData(path, body);
      } catch {
        /* Online reads remain usable when device storage is full. Offline writes report storage failure. */
      }
      return body;
    },
  });
}
export function useCommand() {
  const actorId = useHousehold().member.userId;
  const client = useQueryClient();
  const mutation = useMutation({
    networkMode: "always",
    mutationFn: async ({
      path: inputPath,
      body: inputBody,
    }: {
      path: string;
      body: Record<string, unknown>;
    }) => {
      const path = inputPath.startsWith("/v1/")
        ? inputPath
        : `/v1/${inputPath.replace(/^\//, "")}`;
      const body: Record<string, unknown> = {
        commandId: crypto.randomUUID(),
        ...inputBody,
      };
      if (/\/v1\/(shopping|work)\/items$/.test(path) && !body.id)
        body.id = crypto.randomUUID();
      const resourcePath = entityPath(path);
      const entityId = resourcePath.split("/").at(-1);
      let original: Record<string, unknown> | null = null;
      for (const [, value] of client.getQueriesData({ queryKey: ["heima"] })) {
        if (value && typeof value === "object") {
          const data = value as Record<string, unknown>;
          if (data.id === entityId) original = data;
          else if (Array.isArray(data.items)) {
            const found = data.items.find(
              (item: Record<string, unknown>) => item.id === entityId,
            );
            if (found) original = found;
          }
        }
      }
      if (!navigator.onLine) return queueCommand(path, body, original);
      let result: Awaited<ReturnType<typeof emitEvent>>;
      try {
        result = await emitEvent(path, body, actorId);
      } catch (error) {
        if (queueable(path, body) && getLease())
          return queueCommand(path, body, original);
        throw error;
      }
      if (!result.ok) {
        if (result.error.status === 401 || result.error.status === 403) {
          purgeOffline(actorId);
          client.clear();
        }
        if (result.error.code === "version-conflict") {
          const response = await fetch(
            `/api/backend/${resourcePath.replace(/^\/v1\//, "")}`,
            { cache: "no-store", headers: { "x-heima-actor-id": actorId } },
          );
          if (response.ok) {
            const current = await response.json();
            window.dispatchEvent(
              new CustomEvent("heima-conflict", {
                detail: { path, body, original, current },
              }),
            );
          } else if (
            response.status === 401 ||
            response.status === 403 ||
            response.status === 404
          ) {
            purgeOffline(actorId);
            client.clear();
          }
        }
        if (result.error.status >= 500 && queueable(path, body)) {
          const queued = queueCommand(path, body, original);
          return queued;
        }
        throw new RequestError(
          result.error.message,
          result.error.code,
          result.error.status,
        );
      }
      return result.data;
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["heima"] });
    },
  });
  return {
    ...mutation,
    execute: (path: string, body: Record<string, unknown> = {}) =>
      mutation.mutateAsync({ path, body }),
    refresh: () => client.invalidateQueries({ queryKey: ["heima"] }),
  };
}
