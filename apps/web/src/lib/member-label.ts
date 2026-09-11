import type { AccessMember } from "@heima/contracts";

export function memberLabel(member: AccessMember) {
  if (member.role === "owner") return "Household owner";
  if (member.role === "admin") return "Admin";
  return "Spouse";
}
