"use client";
import { Bot, Unplug } from "lucide-react";
import type { AgentConnection } from "@/lib/oauth/types";
import { EmptyState } from "../shared/page";
import { Button } from "../ui/button";
import { Badge } from "../ui/card";
import { connectionTime, permissions } from "./permissions";

export function AgentConnections({
  connections,
  onDisconnect,
}: {
  connections: AgentConnection[];
  onDisconnect: (connection: AgentConnection) => void;
}) {
  const active = connections.filter(
    (connection) => connection.status === "active",
  );
  const previous = connections.filter(
    (connection) => connection.status !== "active",
  );
  const row = (connection: AgentConnection) => (
    <div className="agent-connection" key={connection.id}>
      <div className="row-between wrap">
        <strong>{connection.clientName}</strong>
        <Badge className={connection.status === "active" ? "forest" : "ochre"}>
          {connection.status === "active"
            ? "Connected"
            : connection.status === "revoked"
              ? "Disconnected"
              : "Expired"}
        </Badge>
      </div>
      <ul>
        {connection.scopes.map((scope) => (
          <li key={scope}>{permissions[scope].title}</li>
        ))}
      </ul>
      <p className="field-hint">
        Connected {connectionTime(connection.createdAt)}
        <br />
        Ends {connectionTime(connection.expiresAt)}
      </p>
      {connection.status === "active" ? (
        <Button
          variant="ghost"
          size="compact"
          onClick={() => onDisconnect(connection)}
        >
          <Unplug size={16} />
          Disconnect {connection.clientName}
        </Button>
      ) : (
        <p className="field-hint">Run the login command to reconnect.</p>
      )}
    </div>
  );
  return (
    <div className="agent-connections">
      <h3>Your connections</h3>
      <p className="field-hint">
        Only your agents appear here. Connections end on sign-out or within 30
        days. Heima renews access in the background while the connection is
        valid. To reconnect after expiry, run the login command again.
      </p>
      {active.length ? (
        active.map(row)
      ) : (
        <EmptyState
          icon={<Bot size={27} />}
          title="No agents connected"
          description="Connect an agent when you need a hand. Read access is the starting point."
        />
      )}
      {previous.length > 0 && (
        <details className="agent-connection-history">
          <summary>Previous connections ({previous.length})</summary>
          {previous.map(row)}
        </details>
      )}
    </div>
  );
}
