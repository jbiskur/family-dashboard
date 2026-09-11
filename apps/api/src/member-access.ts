import { config } from "./config";

// Runtime authorization is separate from replayable historical membership.
export function memberEnabled(member: {
  userId: string;
  role: string;
  status: string;
}) {
  return (
    member.status === "active" &&
    (member.role !== "admin" ||
      config.APP_ADMIN_USER_IDS.includes(member.userId))
  );
}
