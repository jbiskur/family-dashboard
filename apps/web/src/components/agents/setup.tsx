"use client";
import { Check, Copy, Terminal } from "lucide-react";
import { useState } from "react";
import type { AgentAccessView } from "@/lib/oauth/types";
import { Button } from "../ui/button";

function CopyCommand({ label, command }: { label: string; command: string }) {
  const [status, setStatus] = useState("");
  return (
    <div className="agent-command">
      <pre>
        <code>{command}</code>
      </pre>
      <Button
        variant="secondary"
        size="compact"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(command);
            setStatus("Copied");
          } catch {
            setStatus("Copy unavailable. Select the command above to copy it.");
          }
        }}
      >
        {status === "Copied" ? <Check size={15} /> : <Copy size={15} />}
        {label}
      </Button>
      <span className="field-hint" role="status">
        {status}
      </span>
    </div>
  );
}

export function AgentSetup({ data }: { data: AgentAccessView }) {
  const codex = data.clients.find((client) => client.name === "Codex");
  const claude = data.clients.find((client) => client.name === "Claude Code");
  const login = codex
    ? `codex -c 'mcp_servers.heima.oauth.callback_url="${codex.callbackUri}"' -c 'mcp_servers.heima.oauth.callback_port=${codex.callbackPort}' mcp login heima`
    : "";
  return (
    <div className="agent-setup">
      <h3>
        <Terminal size={19} /> Connect from your computer
      </h3>
      <p>
        Run the setup command in your terminal, then finish the Usable sign-in
        and permissions screen. Keep this Heima session signed in while the
        agent is connected.
      </p>
      <div className="agent-endpoint">
        <span className="field-hint">MCP endpoint</span>
        <code>{data.endpoint}</code>
      </div>
      {codex && (
        <CopyCommand
          label="Copy Codex setup"
          command={`codex mcp add heima --url ${data.endpoint} --oauth-client-id ${codex.id} --oauth-resource ${data.endpoint}`}
        />
      )}
      <details>
        <summary>Reconnect with read access</summary>
        <p>
          When your connection ends, run this login again and approve a new
          connection.
        </p>
        {codex && (
          <CopyCommand
            label="Copy reconnect login"
            command={`${login} --scopes heima.read`}
          />
        )}
      </details>
      <details>
        <summary>Allow editing or finance reads</summary>
        <p>
          Run this login to request extra permissions. Choose only the
          permissions you want on the consent screen. Disconnect older
          connections below if you no longer need them.
        </p>
        {codex && (
          <CopyCommand
            label="Copy optional permissions login"
            command={`${login} --scopes heima.read,heima.shopping.write,heima.work.write,heima.finance.read`}
          />
        )}
      </details>
      {claude && (
        <details>
          <summary>Claude Code setup</summary>
          <p>
            Use this command, then open <code>/mcp</code> in Claude Code and
            authenticate. These instructions follow Claude's documented options;
            this client has not been tested here.
          </p>
          <CopyCommand
            label="Copy Claude Code setup"
            command={`claude mcp add --transport http --client-id ${claude.id} --callback-port ${claude.callbackPort} heima ${data.endpoint}`}
          />
        </details>
      )}
    </div>
  );
}
