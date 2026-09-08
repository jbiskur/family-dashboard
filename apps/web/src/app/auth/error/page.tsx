import { ShieldCheck } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
export default function AuthError() {
  return (
    <main className="login-panel" style={{ minHeight: "100vh" }}>
      <div className="login-box">
        <span className="welcome-icon">
          <ShieldCheck size={28} />
        </span>
        <p className="eyebrow">A PRIVATE HOUSEHOLD</p>
        <h1>A place for your household.</h1>
        <p>
          Heima is invite-only. Your sign-in could not be completed. Check that
          you accepted an invitation to Heima Family Dashboard, then try again.
        </p>
        <div className="form-actions">
          <Button asChild>
            <Link href="/">Back to sign in</Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
