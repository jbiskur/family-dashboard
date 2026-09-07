export async function loadTestEnv() {
  for (const line of (await Bun.file(".env.test.local").text()).split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) process.env[line.slice(0, at)] = line.slice(at + 1);
  }
}
export async function tokenFor(
  user = "owner",
  clientId = process.env.USABLE_CLIENT_ID!,
) {
  const response = await fetch(
    `${process.env.USABLE_ISSUER}/protocol/openid-connect/token`,
    {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "password",
        client_id: clientId,
        client_secret: process.env.USABLE_CLIENT_SECRET!,
        username: `${user}@heima.test`,
        password: process.env.TEST_USER_PASSWORD!,
      }),
    },
  );
  const body = await response.json();
  if (!response.ok || !body.access_token)
    throw new Error(`Local OIDC token failed: ${response.status}`);
  return body.access_token as string;
}
export async function request(path: string, token?: string, body?: unknown) {
  return fetch(`http://127.0.0.1:3211/v1/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
export async function controls(body: unknown) {
  return fetch("http://127.0.0.1:3212/__controls", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
