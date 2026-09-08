"use client";
import type { AccessResponse } from "@heima/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useState } from "react";
import type { OfflineLease } from "@/lib/offline";
import { SyncManager } from "./sync-manager";

const HouseholdContext = createContext<AccessResponse | null>(null);
export function Providers({
  children,
  access,
  lease,
}: {
  children: ReactNode;
  access: AccessResponse;
  lease: OfflineLease;
}) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            refetchInterval: 5000,
            refetchOnWindowFocus: true,
            refetchOnReconnect: true,
            retry: 1,
            staleTime: 0,
          },
        },
      }),
  );
  return (
    <HouseholdContext.Provider value={access}>
      <QueryClientProvider client={client}>
        <SyncManager lease={lease}>{children}</SyncManager>
      </QueryClientProvider>
    </HouseholdContext.Provider>
  );
}
export function useHousehold() {
  const access = useContext(HouseholdContext);
  if (!access) throw new Error("Household context is unavailable");
  return access;
}
