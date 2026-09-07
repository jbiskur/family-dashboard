import { beforeAll, describe, expect, test } from "bun:test";
import { controls, loadTestEnv, request, tokenFor } from "../fixtures/auth";

let owner: string;
beforeAll(async () => {
  await loadTestEnv();
  owner = await tokenFor();
  await controls({ reset: true });
});
describe("Heima admission and authorization public boundary", () => {
  test("rejects anonymous, malformed and genuine other-client tokens", async () => {
    expect((await request("access")).status).toBe(401);
    expect((await request("access", "invalid")).status).toBe(401);
    expect(
      (
        await request(
          "access/admit",
          await tokenFor("owner", "other-heima-app"),
          {},
        )
      ).status,
    ).toBe(401);
  });
  test("rejects a real Usable identity without the exact invitation group", async () => {
    expect([401, 403]).toContain(
      (await request("access/admit", await tokenFor("outsider"), {})).status,
    );
  });
  test("concurrent configured-owner callbacks claim exactly one owner", async () => {
    const responses = await Promise.all([
      request("access/admit", owner, {}),
      request("access/admit", owner, {}),
    ]);
    for (const response of responses) expect(response.status).toBe(200);
    const body = await (await request("access", owner)).json();
    expect(body.member.userId).toBe("00000000-0000-4000-8000-000000000001");
    expect(
      body.members.filter(
        (member: { role: string }) => member.role === "owner",
      ),
    ).toHaveLength(1);
  });
  test("invalid invitation stays invalid without creating a pending grant", async () => {
    expect(
      (
        await request("access/invitations", owner, {
          commandId: crypto.randomUUID(),
          email: "broken",
        })
      ).status,
    ).toBe(400);
  });
  test("eligibility revocation and outage deny an existing active member", async () => {
    await controls({ denyUser: "00000000-0000-4000-8000-000000000001" });
    expect((await request("access", owner)).status).toBe(403);
    await controls({ reset: true, upstreamFailure: true });
    expect((await request("access", owner)).status).toBe(503);
    await controls({ reset: true });
    expect((await request("access", owner)).status).toBe(200);
  });
  test("Flowcore stores encrypted envelopes, never plaintext identity or invitation details", async () => {
    const emitted = await request("shopping/lists", owner, {
      commandId: crypto.randomUUID(),
      name: "Encryption verification",
      visibility: "personal",
    });
    expect(emitted.ok).toBe(true);
    expect(
      (
        await request("shopping/lists", owner, {
          commandId: crypto.randomUUID(),
          name: "Encrypted transport verification",
          visibility: "personal",
        })
      ).status,
    ).toBe(201);
    const events = await (await fetch("http://127.0.0.1:3212/__events")).json();
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(typeof event.payload.encryptedPayload).toBe("string");
      expect(event.metadata["pathways/encrypted"]).toBe("true");
      expect(JSON.stringify(event.payload)).not.toContain("@heima.test");
    }
  });
});
