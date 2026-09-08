import Link from "next/link";
export default function AuthError() {
  return (
    <main className="access-page">
      <h1>A place for your household.</h1>
      <p>
        Heima is invite-only. Your sign-in could not be completed. Check that
        you accepted an invitation to Heima Family Dashboard, then try again.
      </p>
      <Link href="/">Back to sign in</Link>
    </main>
  );
}
