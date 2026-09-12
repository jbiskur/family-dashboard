"use client";
import { useQuery } from "@tanstack/react-query";
import { Bot, Check, LoaderCircle, Unplug } from "lucide-react";
import { useRef, useState } from "react";
import { loadAgentAccess } from "@/lib/agent-access-actions";
import { revokeAgentConnection } from "@/lib/oauth/actions";
import type { AgentConnection } from "@/lib/oauth/types";
import { ErrorState, LoadingState } from "../shared/page";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Dialog } from "../ui/dialog";
import { AgentConnections } from "./connections";
import { AgentSetup } from "./setup";

export function AgentAccessPanel() {
  const query = useQuery({
    queryKey: ["heima", "agent-access"],
    queryFn: async () => {
      const result = await loadAgentAccess();
      if (!result.ok) throw new Error(result.message);
      return result.data;
    },
    refetchInterval: 60000,
  });
  const [selected, setSelected] = useState<AgentConnection | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const disconnected = useRef(false);
  return (
    <section
      id="agent-access"
      aria-labelledby="agent-access-heading"
      className="section-gap"
    >
      <Card className="card-pad agent-access-card">
        <div className="agent-access-heading">
          <span className="agent-emblem">
            <Bot size={25} />
          </span>
          <div>
            <h2 id="agent-access-heading" ref={heading} tabIndex={-1}>
              Agent access
            </h2>
            <p>Let an agent help with your household, on your terms.</p>
          </div>
        </div>
        {notice && (
          <p className="notice" role="status">
            <Check size={17} />
            {notice}
          </p>
        )}
        {query.isPending ? (
          <LoadingState label="Loading agent connections…" />
        ) : query.error ? (
          <ErrorState error={query.error} retry={() => void query.refetch()} />
        ) : (
          query.data && (
            <div className="agent-access-grid">
              <AgentSetup data={query.data} />
              <AgentConnections
                connections={query.data.connections}
                onDisconnect={(connection) => {
                  setError("");
                  disconnected.current = false;
                  setSelected(connection);
                }}
              />
            </div>
          )
        )}
      </Card>
      <Dialog
        onCloseAutoFocus={(event) => {
          if (disconnected.current) {
            event.preventDefault();
            heading.current?.focus({ preventScroll: true });
          }
        }}
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setSelected(null);
        }}
        title={`Disconnect ${selected?.clientName ?? "agent"}?`}
        description="This connection will lose access immediately. Its previous changes remain in Heima."
      >
        {error && (
          <div className="error-state" role="alert">
            {error}
          </div>
        )}
        <div className="form-actions">
          <Button
            variant="ghost"
            disabled={pending}
            onClick={() => setSelected(null)}
          >
            Keep connected
          </Button>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={async () => {
              if (!selected) return;
              setPending(true);
              setError("");
              try {
                const result = await revokeAgentConnection(selected.id);
                if (!result.ok) {
                  setError(result.message);
                  return;
                }
                setNotice(
                  `${selected.clientName} disconnected. It can no longer use this connection.`,
                );
                disconnected.current = true;
                setSelected(null);
                await query.refetch();
              } catch {
                setError(
                  "The connection could not be disconnected. Try again.",
                );
              } finally {
                setPending(false);
              }
            }}
          >
            {pending ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <Unplug size={16} />
            )}
            {pending ? "Disconnecting…" : "Disconnect agent"}
          </Button>
        </div>
      </Dialog>
    </section>
  );
}
