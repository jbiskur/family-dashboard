import { auth, signIn } from "@/auth";
import { Login } from "@/components/auth/login";
import { HomePage } from "@/components/home/home-page";
import { Authorized } from "@/components/shared/authorized";
export default async function Welcome() {
  if (await auth())
    return (
      <Authorized>
        <HomePage />
      </Authorized>
    );
  return (
    <Login
      onSignIn={async () => {
        "use server";
        await signIn("usable", { redirectTo: "/" });
      }}
    />
  );
}
