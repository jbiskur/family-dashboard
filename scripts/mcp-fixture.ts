import { loadTestEnv, request, tokenFor } from "../tests/fixtures/auth";

// MCP boundary tests exercise every supported household role. Keep this
// fixture limited to access events so the suite remains independent from the
// screenshot data used by visual journeys.
await loadTestEnv();
const owner = await tokenFor();
const ownerAdmission = await request("access/admit", owner, {});
if (!ownerAdmission.ok)
  throw new Error(`MCP owner admission failed: ${ownerAdmission.status}`);

const accessResponse = await request("access", owner);
if (!accessResponse.ok)
  throw new Error(`MCP access read failed: ${accessResponse.status}`);
const access = (await accessResponse.json()) as {
  members: { userId: string; role: string; status: string }[];
};
if (
  !access.members.some(
    (member) => member.role === "spouse" && member.status === "active",
  )
) {
  const invitation = await request("access/invitations", owner, {
    commandId: crypto.randomUUID(),
    email: "spouse@heima.test",
  });
  if (!invitation.ok)
    throw new Error(`MCP spouse invitation failed: ${invitation.status}`);
  const spouse = await request("access/admit", await tokenFor("spouse"), {});
  if (!spouse.ok)
    throw new Error(`MCP spouse admission failed: ${spouse.status}`);
}

const admin = await request("access/admit", await tokenFor("admin"), {});
if (!admin.ok) throw new Error(`MCP admin admission failed: ${admin.status}`);
console.log("MCP household fixture ready for owner, spouse and admin.");
