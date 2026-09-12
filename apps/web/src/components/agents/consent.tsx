"use client";
import { useForm } from "@tanstack/react-form";
import { ArrowUpRight, Check, LoaderCircle, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import { decideAgentConsent } from "@/lib/oauth/actions";
import type { ConsentView, McpScope } from "@/lib/oauth/types";
import { Button } from "../ui/button";
import { connectionTime, permissions } from "./permissions";

export function AgentConsent({
  view,
}: {
  view: Extract<ConsentView, { status: "ready" }>;
}) {
  const [error, setError] = useState("");
  const [cancelling, setCancelling] = useState(false);
  async function decide(decision: "approve" | "cancel", scopes: McpScope[]) {
    setError("");
    try {
      const result = await decideAgentConsent({
        requestId: view.requestId,
        csrfToken: view.csrfToken,
        decision,
        scopes,
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      window.location.assign(result.redirectTo);
    } catch {
      setError(
        "The connection could not be completed. Try again, or restart the connection in your agent.",
      );
    }
  }
  const form = useForm({
    defaultValues: { scopes: ["heima.read"] as McpScope[] },
    validators: {
      onSubmit: z.object({
        scopes: z
          .array(
            z.enum([
              "heima.read",
              "heima.shopping.write",
              "heima.work.write",
              "heima.finance.read",
            ]),
          )
          .min(1),
      }),
    },
    onSubmit: async ({ value }) => decide("approve", value.scopes),
  });
  return (
    <>
      <div className="agent-client-summary">
        <span className="agent-emblem">
          <ShieldCheck size={26} />
        </span>
        <div>
          <p className="eyebrow">AGENT CONNECTION</p>
          <h1>Let {view.client.name} help?</h1>
        </div>
      </div>
      <p className="agent-intro">
        Choose what this agent can do in Heima. It acts with your access, and
        every change stays attributed to you.
      </p>
      <div className="agent-destination">
        <ArrowUpRight size={18} />
        <div>
          <strong>Returns to {view.redirectHost}</strong>
          <code>{view.redirectUri}</code>
        </div>
      </div>
      <p className="field-hint">
        The callback destination above is the handoff back to your agent.
        Continue only if you started this connection and recognize that
        destination.
      </p>
      <form
        className="agent-consent-form"
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(submitting) => (
            <fieldset className="agent-permissions">
              <legend>Allow this agent to</legend>
              <form.Field name="scopes">
                {(field) =>
                  view.requestedScopes.map((scope) => {
                    const required = scope === "heima.read";
                    return (
                      <label
                        className={`agent-permission ${field.state.value.includes(scope) ? "is-selected" : ""}`}
                        key={scope}
                      >
                        <input
                          type="checkbox"
                          name="scope"
                          value={scope}
                          checked={field.state.value.includes(scope)}
                          disabled={required || cancelling || submitting}
                          onChange={(event) =>
                            field.handleChange(
                              event.target.checked
                                ? [...field.state.value, scope]
                                : field.state.value.filter(
                                    (value) => value !== scope,
                                  ),
                            )
                          }
                        />
                        <span>
                          <strong>
                            {permissions[scope].title}
                            {required && <small>Required</small>}
                          </strong>
                          <span>{permissions[scope].description}</span>
                        </span>
                      </label>
                    );
                  })
                }
              </form.Field>
            </fieldset>
          )}
        </form.Subscribe>
        <p className="agent-session-note">
          <ShieldCheck size={18} />
          <span>
            Ends when you sign out or your Heima session expires, by{" "}
            {connectionTime(view.connectionExpiresAt)}. Disconnect sooner in
            Household settings.
          </span>
        </p>
        {error && (
          <div className="error-state" role="alert">
            {error}
          </div>
        )}
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(submitting) => (
            <div className="form-actions">
              <Button
                type="button"
                variant="ghost"
                disabled={submitting || cancelling}
                onClick={async () => {
                  setCancelling(true);
                  try {
                    await decide("cancel", []);
                  } finally {
                    setCancelling(false);
                  }
                }}
              >
                {cancelling ? "Cancelling…" : "Cancel"}
              </Button>
              <Button type="submit" disabled={submitting || cancelling}>
                {submitting ? (
                  <LoaderCircle size={17} className="spin" />
                ) : (
                  <Check size={17} />
                )}
                {submitting ? "Connecting…" : "Connect agent"}
              </Button>
            </div>
          )}
        </form.Subscribe>
      </form>
    </>
  );
}
