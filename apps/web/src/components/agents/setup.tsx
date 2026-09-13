"use client";
import { Check, Copy, Terminal } from "lucide-react";
import { useState } from "react";
import type { AgentAccessView } from "@/lib/oauth/types";
import { Button } from "../ui/button";

type AccessLevel = "read" | "write";

const accessScopes: Record<AccessLevel, string[]> = {
  read: ["heima.read"],
  write: ["heima.read", "heima.shopping.write", "heima.work.write"],
};

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
  const [accessLevel, setAccessLevel] = useState<AccessLevel>("read");
  const login = codex
    ? `codex -c 'mcp_servers.heima.oauth.callback_url="${codex.callbackUri}"' -c 'mcp_servers.heima.oauth.callback_port=${codex.callbackPort}' mcp login heima`
    : "";
  const selectedLogin = login
    ? `${login} --scopes ${accessScopes[accessLevel].join(",")}`
    : "";
  return (
    <div className="agent-setup">
      <h3>
        <Terminal size={19} /> Connect from your computer
      </h3>
      <p>
        Run the setup command in your terminal, then finish the Usable sign-in
        and permissions screen. Heima keeps the provider refresh token encrypted
        on the server and renews access while the connection is valid.
      </p>
      <p className="field-hint">
        Compatible MCP hosts can discover Heima and select the matching public
        client automatically; no client secret is needed.
      </p>
      <div className="agent-endpoint">
        <span className="field-hint">MCP endpoint</span>
        <code>{data.endpoint}</code>
      </div>
      <div
        className="agent-access-choice"
        role="radiogroup"
        aria-labelledby="agent-access-title"
      >
        <p className="agent-access-title" id="agent-access-title">
          Access for this connection
        </p>
        <p className="field-hint">
          Pick the highest access this agent should request. You can still
          narrow it on the consent screen.
        </p>
        <label
          className={`agent-access-option ${accessLevel === "read" ? "is-selected" : ""}`}
        >
          <input
            type="radio"
            name="agent-access-level"
            value="read"
            checked={accessLevel === "read"}
            onChange={() => setAccessLevel("read")}
          />
          <span>
            <strong>Read only</strong>
            <span>See your household context, shopping and Work items.</span>
          </span>
        </label>
        <label
          className={`agent-access-option ${accessLevel === "write" ? "is-selected" : ""}`}
        >
          <input
            type="radio"
            name="agent-access-level"
            value="write"
            checked={accessLevel === "write"}
            onChange={() => setAccessLevel("write")}
          />
          <span>
            <strong>Read &amp; write</strong>
            <span>
              Read plus add, edit and complete shopping and Work items.
            </span>
          </span>
        </label>
      </div>
      {codex && (
        <>
          <p className="agent-setup-step">
            <span className="agent-step-number">1</span>
            <strong>Add Heima to Codex</strong>
          </p>
          <CopyCommand
            label="Copy Codex setup"
            command={`codex mcp add heima --url ${data.endpoint}`}
          />
          <div className="agent-selected-login">
            <p className="agent-setup-step">
              <span className="agent-step-number">2</span>
              <strong>
                {accessLevel === "read"
                  ? "Connect with read-only access"
                  : "Connect with read and write access"}
              </strong>
            </p>
            <p className="field-hint">
              Copy and run both commands, then finish the sign-in and consent
              screens.
            </p>
            <CopyCommand
              label="Copy selected connection"
              command={selectedLogin}
            />
            <p className="field-hint">
              Finance access is not included in either list access level.
            </p>
          </div>
        </>
      )}
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
