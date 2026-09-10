import type { AccessResponse } from "@heima/contracts";
import { ShieldCheck } from "lucide-react";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { auth, signOut } from "@/auth";
import { backendJson } from "@/lib/backend";
import { providerSessionLease } from "@/lib/session-store";
import { Button } from "../ui/button";
import { AppShell } from "./app-shell";
import { Providers } from "./providers";
import { PurgePrivate } from "./purge-private";

export async function Authorized({ children }: { children: ReactNode }) {
  const session = await auth();
  if (!session?.sessionId) redirect("/");
  let access: AccessResponse;
  try {
    access = await backendJson<AccessResponse>("/v1/access/admit", {
      method: "POST",
      body: "{}",
    });
  } catch {
    return (
      <main className="login-panel" style={{ minHeight: "100vh" }}>
        <PurgePrivate />
        <div className="login-box">
          <span className="welcome-icon">
            <ShieldCheck size={28} />
          </span>
          <p className="eyebrow">A PRIVATE HOUSEHOLD</p>
          <h1>
            Let's check
            <br />
            your invitation.
          </h1>
          <p>
            We couldn't confirm access to this household. Your invitation may
            need attention, or Heima may be temporarily unavailable.
          </p>
          <div className="form-actions">
            <Button asChild variant="secondary">
              <a href="/">Try again</a>
            </Button>
            <form
              action={async () => {
                "use server";
                await signOut({ redirectTo: "/" });
              }}
            >
              <Button type="submit">Sign out</Button>
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
