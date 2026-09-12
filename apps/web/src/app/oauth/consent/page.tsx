import { Leaf, LockKeyhole } from "lucide-react";
import Link from "next/link";
import { signIn } from "@/auth";
import { AgentConsent } from "@/components/agents/consent";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { getConsentView } from "@/lib/oauth/server";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Connect an agent",
  robots: { index: false, follow: false },
  referrer: "no-referrer" as const,
};

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ request?: string }>;
}) {
  const { request } = await searchParams;
  const view = await getConsentView(typeof request === "string" ? request : "");
  return (
    <main className="agent-consent-page">
      <Link href="/" className="brand agent-consent-brand">
        <span className="brand-mark">
          <Leaf size={25} />
        </span>
        <span>heima.</span>
      </Link>
      <Card className="agent-consent-card">
        {view.status === "ready" ? (
          <AgentConsent view={view} />
        ) : view.status === "sign-in" ? (
          <>
            <span className="agent-emblem">
              <LockKeyhole size={28} />
            </span>
            <h1>Sign in before connecting</h1>
            <p className="agent-intro">
              Use your invited Usable account. You will choose the agent's
              permissions before it can access your household.
            </p>
            <form
              action={async () => {
                "use server";
                await signIn("usable", { redirectTo: view.returnTo });
              }}
            >
              <Button type="submit">Continue with Usable</Button>
            </form>
          </>
        ) : (
          <>
            <span className="agent-emblem">
              <LockKeyhole size={28} />
            </span>
            <h1>
              {view.status === "expired"
                ? "Start the connection again"
                : "This connection isn't available"}
            </h1>
            <p className="agent-intro">{view.message}</p>
            <p className="field-hint">
              This request cannot be used again. Review existing connections in
              Household settings, or return to your agent and start a new login.
            </p>
            <Button asChild variant="secondary">
              <Link href="/settings/household#agent-access">
                Go to Household settings
              </Link>
            </Button>
          </>
        )}
      </Card>
    </main>
  );
}
