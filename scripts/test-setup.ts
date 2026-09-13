import { createECDH, randomBytes } from "node:crypto";
import { chmod } from "node:fs/promises";

const file = Bun.file(".env.test.local");
const secret = () => randomBytes(24).toString("hex");
if (!(await file.exists())) {
  const databasePassword = secret();
  const clientSecret = secret();
  const values = {
    NODE_ENV: "test",
    DATABASE_URL: `postgres://heima:${databasePassword}@127.0.0.1:55437/heima`,
    DATABASE_SCHEMA: "heima_test",
    TEST_DATABASE_PASSWORD: databasePassword,
    TEST_KEYCLOAK_PASSWORD: secret(),
    TEST_USER_PASSWORD: secret(),
    TEST_TRANSFORMER_SECRET: secret(),
    AUTH_SECRET: secret(),
    AUTH_URL: "http://localhost:3010",
    AUTH_TRUST_HOST: "true",
    USABLE_CLIENT_SECRET: clientSecret,
    USABLE_CLIENT_ID: "8030ec37-eeab-4f99-adf5-35424e7fee63",
    USABLE_APP_ID: "8030ec37-eeab-4f99-adf5-35424e7fee63",
    USABLE_ISSUER: "http://localhost:8187/realms/heima-test",
    USABLE_OIDC_ISSUER: "http://localhost:8187/realms/heima-test",
    USABLE_API_BASE_URL: "http://127.0.0.1:3212",
    HEIMA_API_URL: "http://127.0.0.1:3211",
    PORT: "3211",
    APP_OWNER_USER_ID: "00000000-0000-4000-8000-000000000001",
    APP_ADMIN_USER_IDS:
      "00000000-0000-4000-8000-000000000004,00000000-0000-4000-8000-000000000005",
    HOUSEHOLD_ID: "00000000-0000-4000-8000-000000000010",
    FLOWCORE_WEBHOOK_BASE_URL: "http://127.0.0.1:3212",
    FLOWCORE_API_KEY: secret(),
    FLOWCORE_TENANT: "heima-test",
    FLOWCORE_DATA_CORE: "heima-test",
    PATHWAYS_ENCRYPTION_KEY: secret(),
  };
  await Bun.write(
    ".env.test.local",
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n",
  );
  await chmod(".env.test.local", 0o600);
}
for (const line of (await Bun.file(".env.test.local").text()).split("\n")) {
  const at = line.indexOf("=");
  if (at > 0) process.env[line.slice(0, at)] = line.slice(at + 1);
}
if (process.env.APP_ADMIN_USER_IDS === undefined) {
  process.env.APP_ADMIN_USER_IDS =
    "00000000-0000-4000-8000-000000000004,00000000-0000-4000-8000-000000000005";
  await Bun.write(
    ".env.test.local",
    (await Bun.file(".env.test.local").text()) +
      `\nAPP_ADMIN_USER_IDS=${process.env.APP_ADMIN_USER_IDS}\n`,
  );
  await chmod(".env.test.local", 0o600);
}
if (!process.env.VAPID_PRIVATE_KEY) {
  const vapid = createECDH("prime256v1");
  vapid.generateKeys();
  const keys = {
    VAPID_PUBLIC_KEY: vapid.getPublicKey().toString("base64url"),
    VAPID_PRIVATE_KEY: vapid.getPrivateKey().toString("base64url"),
    VAPID_SUBJECT: "mailto:test@heima.test",
  };
  await Bun.write(
    ".env.test.local",
    (await Bun.file(".env.test.local").text()) +
      Object.entries(keys)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n") +
      "\n",
  );
  await chmod(".env.test.local", 0o600);
  Object.assign(process.env, keys);
}
const up = Bun.spawn(
  ["docker", "compose", "--env-file", ".env.test.local", "up", "-d"],
  { stdout: "inherit", stderr: "inherit" },
);
if (await up.exited) throw new Error("Test services failed to start");
const base = "http://localhost:8187";
for (let attempt = 0; ; attempt++) {
  try {
    if (
      (await fetch(`${base}/realms/master/.well-known/openid-configuration`)).ok
    )
      break;
  } catch {}
  if (attempt > 90) throw new Error("Keycloak did not become ready");
  await Bun.sleep(1000);
}
const login = await fetch(
  `${base}/realms/master/protocol/openid-connect/token`,
  {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "admin-cli",
      username: "admin",
      password: process.env.TEST_KEYCLOAK_PASSWORD!,
    }),
  },
);
const admin = await login.json();
if (!admin.access_token) throw new Error("Local Keycloak admin login failed");
const appId = process.env.USABLE_CLIENT_ID!;
const installed = `/app-marketplace-${appId}-users`;
const mapper = (name: string, attribute: string, claim: string) => ({
  name,
  protocol: "openid-connect",
  protocolMapper: "oidc-usermodel-attribute-mapper",
  config: {
    "user.attribute": attribute,
    "claim.name": claim,
    "jsonType.label": "String",
    "id.token.claim": "true",
    "access.token.claim": "true",
    "userinfo.token.claim": "true",
  },
});
const realm = {
  realm: "heima-test",
  enabled: true,
  sslRequired: "none",
  registrationAllowed: false,
  accessTokenLifespan: 300,
  groups: [{ name: installed.slice(1) }],
  clients: [appId, "other-heima-app"].map((clientId) => ({
    clientId,
    enabled: true,
    protocol: "openid-connect",
    publicClient: false,
    secret: process.env.USABLE_CLIENT_SECRET,
    standardFlowEnabled: true,
    directAccessGrantsEnabled: true,
    redirectUris: ["http://localhost:3010/api/auth/callback/usable"],
    webOrigins: ["http://localhost:3010"],
    attributes: { "pkce.code.challenge.method": "S256" },
    defaultClientScopes: ["profile", "email"],
    optionalClientScopes: ["offline_access"],
    protocolMappers: [
      mapper("usable identity", "usable_user_id", "usable_user_id"),
      {
        name: "installed apps",
        protocol: "openid-connect",
        protocolMapper: "oidc-group-membership-mapper",
        config: {
          "claim.name": "groups",
          "full.path": "true",
          "id.token.claim": "true",
          "access.token.claim": "true",
          "userinfo.token.claim": "true",
        },
      },
    ],
  })),
  users: [
    "owner",
    "spouse",
    "outsider",
    "admin",
    "admin2",
    "guest",
    "admin-alias",
  ].map((name, index) => ({
    id: `00000000-0000-4000-8000-00000000000${index + 1}`,
    username: `${name}@heima.test`,
    email: `${name}@heima.test`,
    emailVerified: true,
    enabled: true,
    firstName:
      name === "owner" ? "Julius" : name === "spouse" ? "Anna" : "Guest",
    lastName: "Home",
    attributes: {
      usable_user_id: [
        `00000000-0000-4000-8000-00000000000${name === "admin-alias" ? 4 : index + 1}`,
      ],
    },
    groups: name !== "outsider" ? [installed] : [],
    credentials: [
      {
        type: "password",
        value: process.env.TEST_USER_PASSWORD,
        temporary: false,
      },
    ],
  })),
};
const response = await fetch(`${base}/admin/realms`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${admin.access_token}`,
    "content-type": "application/json",
  },
  body: JSON.stringify(realm),
});
if (!response.ok && response.status !== 409)
  throw new Error(`Realm provisioning failed: ${response.status}`);
const adminHeaders = { authorization: `Bearer ${admin.access_token}` };
// Existing realms are retained; provision newly added synthetic identities too.
for (const user of realm.users.slice(3)) {
  const added = await fetch(`${base}/admin/realms/heima-test/users`, {
    method: "POST",
    headers: { ...adminHeaders, "content-type": "application/json" },
    body: JSON.stringify(user),
  });
  if (!added.ok && added.status !== 409)
    throw new Error(`Local test identity provisioning failed: ${added.status}`);
}
const offlineRoleResponse = await fetch(
  `${base}/admin/realms/heima-test/roles/offline_access`,
  { headers: adminHeaders },
);
if (!offlineRoleResponse.ok)
  throw new Error("Local offline_access role could not be read");
const offlineRole = await offlineRoleResponse.json();
for (const fixtureUser of realm.users) {
  const usersResponse = await fetch(
    `${base}/admin/realms/heima-test/users?username=${encodeURIComponent(fixtureUser.username)}`,
    { headers: adminHeaders },
  );
  if (!usersResponse.ok)
    throw new Error("Local test identity could not be looked up");
  const user = (await usersResponse.json()).find(
    (entry: { username?: string }) => entry.username === fixtureUser.username,
  );
  if (!user?.id) continue;
  const rolesResponse = await fetch(
    `${base}/admin/realms/heima-test/users/${user.id}/role-mappings/realm`,
    { headers: adminHeaders },
  );
  if (!rolesResponse.ok)
    throw new Error("Local test identity roles could not be read");
  const roles = await rolesResponse.json();
  if (roles.some((role: { name?: string }) => role.name === "offline_access"))
    continue;
  const assigned = await fetch(
    `${base}/admin/realms/heima-test/users/${user.id}/role-mappings/realm`,
    {
      method: "POST",
      headers: { ...adminHeaders, "content-type": "application/json" },
      body: JSON.stringify([offlineRole]),
    },
  );
  if (!assigned.ok)
    throw new Error("Local offline_access role could not be assigned");
}
// Declare only this fixture identity attribute: Admin REST tests can change the
// spouse claim without changing mappers, signing tokens themselves, or owner data.
const profileUrl = `${base}/admin/realms/heima-test/users/profile`;
const profileResponse = await fetch(profileUrl, { headers: adminHeaders });
if (!profileResponse.ok)
  throw new Error("Local test identity profile could not be read");
const profile = await profileResponse.json();
if (
  !profile.attributes.some(
    (attribute: { name: string }) => attribute.name === "usable_user_id",
  )
) {
  const configured = await fetch(profileUrl, {
    method: "PUT",
    headers: { ...adminHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      ...profile,
      attributes: [
        ...profile.attributes,
        {
          name: "usable_user_id",
          displayName: "Usable user UUID",
          permissions: { view: ["admin"], edit: ["admin"] },
          multivalued: false,
        },
      ],
    }),
  });
  if (!configured.ok)
    throw new Error("Local test identity attribute could not be declared");
}

const scopes = await (
  await fetch(`${base}/admin/realms/heima-test/client-scopes`, {
    headers: adminHeaders,
  })
).json();
const basic = scopes.find((scope: { name: string }) => scope.name === "basic");
const clients = await (
  await fetch(`${base}/admin/realms/heima-test/clients`, {
    headers: adminHeaders,
  })
).json();
for (const client of clients.filter((entry: { clientId: string }) =>
  [appId, "other-heima-app"].includes(entry.clientId),
)) {
  const assigned = await fetch(
    `${base}/admin/realms/heima-test/clients/${client.id}/default-client-scopes/${basic.id}`,
    { method: "PUT", headers: adminHeaders },
  );
  if (!assigned.ok)
    throw new Error("Local OIDC basic claims could not be assigned");
}
console.log(
  "Local PostgreSQL and real Keycloak ready. Runtime credentials remain in ignored mode-0600 file.",
);
