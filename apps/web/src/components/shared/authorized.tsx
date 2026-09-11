import type { AccessResponse } from "@heima/contracts";
import { ShieldCheck } from "lucide-react";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { auth, signOut } from "@/auth";
import { BackendError, backendJson } from "@/lib/backend";
import { providerSessionLease } from "@/lib/session-store";
import { Button } from "../ui/button";
import { AppShell } from "./app-shell";
import { Providers } from "./providers";
import { PurgePrivate } from "./purge-private";

function admissionMessage(error: unknown) {
  if (error instanceof BackendError) {
    if (error.status === 401)
      return {
        title: "Your session has ended.",
        description: "Sign in again with Usable to continue to your household.",
        signIn: true,
      };
    if (error.code === "not-installed")
      return {
        title: "An invitation is needed.",
        description:
          "This Usable account doesn't have an active invitation to Heima. Ask your household owner to check your app invitation, or sign out to use another account.",
      };
    if (error.code === "access-denied")
      return {
        title: "Household access is needed.",
        description:
          "You're signed in and your Usable invitation is valid, but this account doesn't currently have access to this household. Ask your household owner to check your access, or sign out to use another account.",
      };
  }
  return {
    title: "We can't check access right now.",
    description:
      "Heima couldn't complete the access check. Try again shortly. You don't need a new invitation because of this error.",
  };
}

export async function Authorized({ children }: { children: ReactNode }) {
  const session = await auth();
  if (!session?.sessionId) redirect("/");
  let access: AccessResponse;
  try {
    access = await backendJson<AccessResponse>("/v1/access/admit", {
      method: "POST",
      body: "{}",
    });
  } catch (error) {
    const message = admissionMessage(error);
    return (
      <main className="login-panel" style={{ minHeight: "100vh" }}>
        <PurgePrivate />
        <div className="login-box">
          <span className="welcome-icon">
            <ShieldCheck size={28} />
          </span>
          <p className="eyebrow">A PRIVATE HOUSEHOLD</p>
          <h1>{message.title}</h1>
          <p>{message.description}</p>
          <div className="form-actions">
            {!message.signIn && (
              <Button asChild variant="secondary">
                <a href="/">Try again</a>
              </Button>
            )}
            <form
              style={{ marginTop: 0 }}
              action={async () => {
                "use server";
                await signOut({ redirectTo: "/" });
              }}
            >
              <Button type="submit">
                {message.signIn ? "Back to sign in" : "Sign out"}
              </Button>
            </form>
          </div>
        </div>
      </main>
    );
  }
  const providerLease = await providerSessionLease(session.sessionId);
  return (
    <Providers
      access={access}
      lease={{
        actorId: access.member.userId,
        householdId: access.household.id,
        expiresAt: providerLease?.expiresAt ?? Date.now(),
      }}
    >
      <AppShell>{children}</AppShell>
    </Providers>
  );
}
