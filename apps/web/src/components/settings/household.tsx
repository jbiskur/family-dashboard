"use client";
import type { AccessResponse, HouseholdProfile } from "@heima/contracts";
import {
  Check,
  LogOut,
  Plus,
  ShieldCheck,
  Trash2,
  UserRound,
  Users,
} from "lucide-react";
import { useState } from "react";
import { AgentAccessPanel } from "@/components/agents/access-panel";
import { useCommand, useHeima } from "@/lib/client";
import { memberLabel } from "@/lib/member-label";
import { purgeOffline } from "@/lib/offline";
import { EntityForm } from "../shared/form";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from "../shared/page";
import { Button } from "../ui/button";
import { Badge, Card } from "../ui/card";
import { Dialog } from "../ui/dialog";

export function HouseholdSettings({
  onSignOut,
}: {
  onSignOut: () => void | Promise<void>;
}) {
  const query = useHeima<AccessResponse>("/v1/access");
  const profiles = useHeima<{ items: HouseholdProfile[] }>(
    "/v1/household/profiles",
  );
  const command = useCommand();
  const [profile, setProfile] = useState<HouseholdProfile | "new" | null>(null);
  const [archive, setArchive] = useState<HouseholdProfile | null>(null);
  const [revoke, setRevoke] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const data = query.data;
  const pending = data?.invitation;
  const owner = data?.member.role === "owner";
  return (
    <>
      <PageHeader
        eyebrow="YOUR PEOPLE, YOUR PLACE"
        title="Household"
        description="Manage invited access and the people you assign tasks to."
      />
      {notice && (
        <div className="notice" role="status">
          <Check size={16} />
          {notice}
        </div>
      )}
      {query.isPending ? (
        <LoadingState />
      ) : query.error ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : (
        data && (
          <div className="settings-grid">
            <Card className="settings-panel">
              <div className="row" style={{ marginBottom: 12 }}>
                <ShieldCheck size={21} />
                <h2 style={{ margin: 0 }}>People with access</h2>
              </div>
              <p>Only people invited to this household can sign in.</p>
              {data.members
                .filter((m) => m.status === "active")
                .map((member) => (
                  <div className="member-row" key={member.userId}>
                    <span className="avatar">
                      <UserRound size={19} />
                    </span>
                    <span className="grow">
                      <strong>
                        {member.userId === data.member.userId
                          ? "You"
                          : memberLabel(member)}
                      </strong>
                      <small>
                        {member.role === "owner"
                          ? "Owner · manages invitations"
                          : member.role === "admin"
                            ? "Admin · shared household access"
                            : "Spouse · household member"}
                      </small>
                    </span>
                    <Badge className="forest">Active</Badge>
                    {owner && member.role === "spouse" && (
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label="Revoke spouse access"
                        onClick={() => setRevoke(member.userId)}
                      >
                        <Trash2 size={15} />
                      </Button>
                    )}
                  </div>
                ))}
              {owner && (
                <>
                  <hr className="separator" />
                  <h3 style={{ marginBottom: 9 }}>Invite your spouse</h3>
                  {pending &&
                    (pending.status === "cancelled" ||
                      pending.status === "expired") && (
                      <p
                        className="notice"
                        role="status"
                        style={{ marginBottom: 16 }}
                      >
                        {pending.status === "expired"
                          ? "The previous invitation expired. Request a new invitation below."
                          : "The previous invitation was cancelled. You can request access again below."}
                      </p>
                    )}
                  {pending &&
                  ["requesting", "pending", "request-failed"].includes(
                    pending.status,
                  ) ? (
                    <div>
                      <Badge
                        className={
                          pending.status === "request-failed" ? "clay" : "ochre"
                        }
                      >
                        {pending.status === "pending"
                          ? "Waiting for their first sign-in"
                          : pending.status === "requesting"
                            ? "Requesting app access"
                            : "Access request needs attention"}
                      </Badge>
                      {pending.email && (
                        <p className="text-small" style={{ marginTop: 11 }}>
                          {pending.email}
                        </p>
                      )}
                      <p className="field-hint">
                        This requests access through Usable. It doesn't send an
                        email. Share your Heima sign-in link after the request
                        succeeds.
                      </p>
                      {pending.status === "pending" && (
                        <Button
                          variant="secondary"
                          style={{ marginTop: 14 }}
                          onClick={async () => {
                            await navigator.clipboard.writeText(
                              window.location.origin,
                            );
                            setNotice(
                              "Heima sign-in link copied. Share it with your invited spouse.",
                            );
                          }}
                        >
                          Copy sign-in link
                        </Button>
                      )}
                      <div className="row wrap" style={{ marginTop: 13 }}>
                        <Button
                          variant="ghost"
                          onClick={async () => {
                            await command.execute(
                              `/v1/access/invitations/${pending.id}/resend`,
                            );
                            setNotice(
                              "Access requested through Usable. Share the sign-in link when ready.",
                            );
                          }}
                        >
                          Retry access request
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={async () => {
                            await command.execute(
                              `/v1/access/invitations/${pending.id}/cancel`,
                            );
                            setNotice("The pending invitation was cancelled.");
                          }}
                        >
                          Cancel invitation
                        </Button>
                      </div>
                    </div>
                  ) : data.members.filter(
                      (m) => m.status === "active" && m.role !== "admin",
                    ).length < 2 ? (
                    <EntityForm
                      fields={[
                        {
                          name: "email",
                          label: "Their Usable email",
                          type: "email",
                          required: true,
                          placeholder: "spouse@example.com",
                          hint: "Use the email on their existing Usable account. Their verified first sign-in links it to a stable household identity.",
                        },
                      ]}
                      submitLabel="Request invited access"
                      onSubmit={async (values) => {
                        await command.execute("/v1/access/invitations", values);
                        setNotice(
                          "Access invitation requested. Share your Heima sign-in link for the next step.",
                        );
                      }}
                    />
                  ) : (
                    <p className="text-small muted">
                      Your two-person household is connected.
                    </p>
                  )}
                </>
              )}
              {command.error && (
                <ErrorState
                  error={command.error}
                  retry={() => {
                    command.reset();
                    void command.refresh();
                  }}
                />
              )}
            </Card>
            <Card className="settings-panel">
              <div className="row" style={{ marginBottom: 12 }}>
                <Users size={21} />
                <h2 style={{ margin: 0 }}>Everyone who helps</h2>
              </div>
              <p>
                Add kids or other household profiles to assign responsibilities.
                Profiles can't sign in, see household data, or perform actions.
              </p>
              {profiles.isPending ? (
                <LoadingState label="Loading household profiles…" />
              ) : profiles.error ? (
                <ErrorState
                  error={profiles.error}
                  retry={() => void profiles.refetch()}
                />
              ) : profiles.data?.items.length ? (
                profiles.data.items.map((p) => (
                  <div className="member-row" key={p.id}>
                    <span
                      className="avatar"
                      style={{
                        background: "var(--ochre-soft)",
                        color: "var(--ochre)",
                      }}
                    >
                      <UserRound size={18} />
                    </span>
                    <button
                      type="button"
                      className="button button-ghost grow"
                      style={{
                        justifyContent: "flex-start",
                        textAlign: "left",
                      }}
                      onClick={() => setProfile(p)}
                    >
                      <span>
                        <strong>{p.name}</strong>
                        <small>Assignable profile · no login</small>
                      </span>
                    </button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Archive ${p.name}`}
                      onClick={() => setArchive(p)}
                    >
                      <Trash2 size={15} />
                    </Button>
                  </div>
                ))
              ) : (
                <EmptyState
                  icon={<Users size={27} />}
                  title="Add household profiles"
                  description="Profiles help you share responsibilities without sharing app access."
                />
              )}
              <Button
                variant="secondary"
                style={{ marginTop: 20 }}
                onClick={() => setProfile("new")}
              >
                <Plus size={16} />
                Add a household profile
              </Button>
            </Card>
          </div>
        )
      )}
      {data && <AgentAccessPanel />}
      <Card className="card-pad section-gap">
        <div className="row-between wrap">
          <div>
            <h3>Time to step away?</h3>
            <p className="field-hint">
              Signing out removes this device's saved household data and pending
              offline commands. Agent connections linked to this session also
              end.
            </p>
          </div>
          <form
            action={async () => {
              try {
                purgeOffline();
                for (const key of Object.keys(localStorage))
                  if (key.startsWith("heima-")) localStorage.removeItem(key);
                if ("caches" in window)
                  for (const key of await caches.keys())
                    if (
                      key.startsWith("heima-data") ||
                      key.startsWith("heima-private")
                    )
                      await caches.delete(key);
              } finally {
                await onSignOut();
              }
            }}
          >
            <Button variant="secondary" type="submit">
              <LogOut size={16} />
              Sign out
            </Button>
          </form>
        </div>
      </Card>
      <Dialog
        open={profile !== null}
        onOpenChange={(open) => !open && setProfile(null)}
        title={
          profile === "new" ? "Add a household profile" : "Update this profile"
        }
        description="A name for assignments. No login or data access."
      >
        {profile && (
          <EntityForm
            fields={[
              {
                name: "name",
                label: "Name",
                required: true,
                defaultValue: profile === "new" ? "" : profile.name,
                placeholder: "Their name",
              },
            ]}
            onCancel={() => setProfile(null)}
            submitLabel={profile === "new" ? "Add profile" : "Save name"}
            onSubmit={async (values) => {
              await command.execute(
                profile === "new"
                  ? "/v1/household/profiles"
                  : `/v1/household/profiles/${profile.id}`,
                {
                  ...values,
                  ...(profile === "new"
                    ? {}
                    : { baseVersion: profile.version }),
                },
              );
              setProfile(null);
            }}
          />
        )}
      </Dialog>
      <Dialog
        open={archive !== null}
        onOpenChange={(open) => !open && setArchive(null)}
        title="Archive this profile?"
        description="Past assignments keep their name. New assignments won't offer this profile."
      >
        <p className="confirm-copy">{archive?.name}</p>
        <div className="form-actions">
          <Button variant="ghost" onClick={() => setArchive(null)}>
            Keep profile
          </Button>
          <Button
            variant="destructive"
            onClick={async () => {
              if (archive)
                await command.execute(
                  `/v1/household/profiles/${archive.id}/archive`,
                  { baseVersion: archive.version },
                );
              setArchive(null);
            }}
          >
            Archive profile
          </Button>
        </div>
      </Dialog>
      <Dialog
        open={revoke !== null}
        onOpenChange={(open) => !open && setRevoke(null)}
        title="Revoke spouse access?"
        description="This removes their household access. It doesn't erase recorded history."
      >
        <p className="confirm-copy">
          Your spouse will no longer be able to open protected household
          information or make changes. Inviting them again requires a new
          admission.
        </p>
        <div className="form-actions">
          <Button variant="ghost" onClick={() => setRevoke(null)}>
            Keep access
          </Button>
          <Button
            variant="destructive"
            onClick={async () => {
              if (revoke)
                await command.execute(`/v1/access/members/${revoke}/revoke`);
              setRevoke(null);
              setNotice("Spouse access was revoked.");
            }}
          >
            Revoke access
          </Button>
        </div>
      </Dialog>
    </>
  );
}
