import { signOut } from "@/auth";
import { HouseholdSettings } from "@/components/settings/household";
export default function Page() {
  return (
    <HouseholdSettings
      onSignOut={async () => {
        "use server";
        await signOut({ redirectTo: "/" });
      }}
    />
  );
}
