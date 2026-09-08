import { ArrowRight, Leaf, LockKeyhole, ShieldCheck } from "lucide-react";
import Image from "next/image";
import { PurgePrivate } from "../shared/purge-private";
import { Button } from "../ui/button";
export function Login({
  onSignIn,
  error,
}: {
  onSignIn: () => void | Promise<void>;
  error?: string;
}) {
  return (
    <div className="login-page">
      <PurgePrivate />
      <div className="login-story">
        <a href="/" className="brand">
          <span className="brand-mark">
            <Leaf size={27} />
          </span>
          <span>heima.</span>
        </a>
        <div className="login-story-copy">
          <p className="eyebrow">YOUR FAMILY. A LITTLE MORE TOGETHER.</p>
          <h1>
            Make room
            <br />
            for what matters.
          </h1>
          <p>
            The list for the store. The little things to do.
            <br />A clearer picture of home.
          </p>
        </div>
        <Image
          width={1536}
          height={1024}
          sizes="(max-width: 767px) 100vw, 60vw"
          priority
          src="/images/home-still-life.png"
          alt="A welcoming Scandinavian home surrounded by hills and trees"
          className="login-art"
        />
        <p className="login-caption">A home for your everyday.</p>
      </div>
      <main className="login-panel">
        <div className="login-box">
          <span className="welcome-icon">
            <HomeIcon />
          </span>
          <p className="eyebrow">WELCOME HOME</p>
          <h2>
            Your people. <br />
            Your place.
          </h2>
          <p>Sign in to your private household with your Usable account.</p>
          {error && (
            <div className="error-state" role="alert">
              {error}
            </div>
          )}
          <form action={onSignIn}>
            <Button type="submit" className="login-button">
              Continue with Usable
              <ArrowRight size={18} />
            </Button>
          </form>
          <p className="login-security">
            <LockKeyhole size={14} /> By invitation, for your household.
          </p>
          <div className="login-divider" />
          <p className="login-help">
            <ShieldCheck size={20} />
            <span>
              Access is checked every time you sign in. If you haven't been
              invited, ask your household owner for access.
            </span>
          </p>
        </div>
      </main>
    </div>
  );
}
function HomeIcon() {
  return <Leaf size={28} strokeWidth={1.4} />;
}
