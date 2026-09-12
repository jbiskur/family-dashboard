import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const requireWeb = createRequire(
  new URL("../apps/web/package.json", import.meta.url),
);
const requireNext = createRequire(requireWeb.resolve("next/package.json"));
const sharp = requireNext("sharp");
sharp.concurrency(1);
sharp.cache(false);
const image = process.argv[2];
const reportPath = process.argv[3] ?? "test-results/container/image-cache.json";
assert(image, "Usage: node scripts/test-web-container.mjs <image> [report]");
const docker = (...args) =>
  execFileSync("docker", args, { encoding: "utf8", timeout: 30000 }).trim();
const report = {
  image,
  imageId: docker("image", "inspect", image, "--format", "{{.Id}}"),
  runs: [],
};
const publicOrigin = "http://localhost:3010";
const noticeDirectory = mkdtempSync(join(tmpdir(), "heima-container-notices-"));
let expectedNotices;
try {
  execFileSync(
    process.execPath,
    ["scripts/collect-mcp-runtime-licenses.mjs", noticeDirectory],
    { encoding: "utf8", timeout: 30000 },
  );
  expectedNotices = JSON.parse(
    readFileSync(join(noticeDirectory, "index.json"), "utf8"),
  );
} finally {
  rmSync(noticeDirectory, { recursive: true, force: true });
}
const expectedLicenseHash = createHash("sha256")
  .update(readFileSync("LICENSE"))
  .digest("hex");
const sleep = () => new Promise((resolve) => setTimeout(resolve, 250));
async function fetchBytes(url, timeoutMs) {
  const controller = new AbortController();
  // AbortSignal.timeout() is unreferenced and can let Node exit before finally
  // records failure and removes the container. Keep the deadline alive through
  // the response body, then release it on success or failure.
  const timer = setTimeout(() => {
    controller.abort(new DOMException("HTTP probe timed out", "TimeoutError"));
  }, timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const bytes = Buffer.from(await response.arrayBuffer());
    return { response, bytes };
  } finally {
    clearTimeout(timer);
  }
}
const logs = (name) => {
  const result = spawnSync("docker", ["logs", name], {
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(result.status, 0, "Container log collection failed");
  return result.stdout + result.stderr;
};
const checkLogs = (value) =>
  assert(
    !/Failed to write image to cache|(?:ENOENT|EACCES|EROFS)[^\n]*(?:cache|images)/i.test(
      value,
    ),
    "Image-cache write error in container logs",
  );

// Observe the actual container through public HTTP and Docker CLI. Decode on the
// test host so the probe does not consume the application's runtime memory.
async function probe(base) {
  const { response, bytes } = await fetchBytes(
    `${base}/_next/image?url=%2Fimages%2Fhome-still-life.png&w=640&q=75`,
    30000,
  );
  assert.equal(response.status, 200);
  const type = response.headers.get("content-type");
  assert.match(type, /^image\//);
  const decoded = await sharp(bytes)
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.equal(decoded.info.width, 640);
  assert(decoded.info.height > 0 && decoded.data.length > 0);
  return {
    status: response.status,
    type,
    bytes: bytes.length,
    width: decoded.info.width,
    height: decoded.info.height,
    cache: response.headers.get("x-nextjs-cache"),
  };
}

// The container's canonical public Host is independent of its ephemeral local
// Docker port. node:http preserves that Host header on the actual wire.
async function oauthRequest(base, path, body) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      `${base}${path}`,
      {
        method: body ? "POST" : "GET",
        headers: {
          host: new URL(publicOrigin).host,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        timeout: 10000,
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > 65536)
            response.destroy(new Error("OAuth smoke response too large"));
          else chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          try {
            resolve({
              status: response.statusCode,
              headers: response.headers,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            });
          } catch {
            reject(new Error("OAuth smoke did not return JSON"));
          }
        });
      },
    );
    request.on("error", reject);
    request.on("timeout", () =>
      request.destroy(new Error("OAuth smoke request timed out")),
    );
    request.end(body ? JSON.stringify(body) : undefined);
  });
}
async function probeOAuth(base) {
  const resource = `${publicOrigin}/api/mcp`;
  const authorization = await oauthRequest(
    base,
    "/.well-known/oauth-authorization-server",
  );
  assert.equal(authorization.status, 200);
  assert.equal(authorization.body.issuer, publicOrigin);
  assert(authorization.body.code_challenge_methods_supported.includes("S256"));
  assert(
    authorization.body.token_endpoint_auth_methods_supported.includes("none"),
  );
  const metadata = await oauthRequest(
    base,
    "/.well-known/oauth-protected-resource/api/mcp",
  );
  assert.equal(metadata.status, 200);
  assert.equal(metadata.body.resource, resource);
  assert.deepEqual(metadata.body.authorization_servers, [publicOrigin]);
  const denied = await oauthRequest(base, "/api/mcp", {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
  });
  assert.equal(denied.status, 401);
  assert.equal(denied.body.error, "invalid_token");
  assert.equal(denied.headers["cache-control"], "no-store");
  assert(
    denied.headers["www-authenticate"].includes(
      `resource_metadata="${publicOrigin}/.well-known/oauth-protected-resource/api/mcp"`,
    ),
  );
  return {
    authorizationMetadataStatus: authorization.status,
    resourceMetadataStatus: metadata.status,
    unauthenticatedMcpStatus: denied.status,
    issuer: publicOrigin,
    resource,
  };
}
function probeNotices(name) {
  const actual = JSON.parse(
    docker(
      "exec",
      name,
      "node",
      "-e",
      `
    const fs = require('node:fs');
    const crypto = require('node:crypto');
    const index = JSON.parse(fs.readFileSync('/app/third-party-licenses/index.json', 'utf8'));
    for (const pkg of index.packages) for (const file of pkg.files) {
      const bytes = fs.readFileSync('/app/third-party-licenses/' + file.path);
      if (crypto.createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('Packaged notice hash mismatch');
    }
    console.log(JSON.stringify({ index, licenseHash: crypto.createHash('sha256').update(fs.readFileSync('/app/LICENSE')).digest('hex') }));
  `,
    ),
  );
  assert.deepEqual(actual.index, expectedNotices);
  assert.equal(actual.licenseHash, expectedLicenseHash);
  return {
    path: "/app/third-party-licenses",
    packageCount: actual.index.packages.length,
    filesVerified: actual.index.packages.reduce(
      (total, pkg) => total + pkg.files.length,
      0,
    ),
    exactInstalledNotices: true,
    rootLicenseUnchanged: true,
  };
}

try {
  for (const phase of ["cold-and-warm", "fresh-tmpfs-replacement"]) {
    const name = `heima-image-cache-${process.pid}-${phase}`;
    const run = { phase, name, requests: [] };
    report.runs.push(run);
    let started = false;
    try {
      docker(
        "run",
        "-d",
        "--name",
        name,
        "--read-only",
        "--memory",
        "256m",
        "--memory-swap",
        "256m",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=64m",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "-p",
        "127.0.0.1::3010",
        "-e",
        `AUTH_URL=${publicOrigin}`,
        "-e",
        "AUTH_SECRET=local-cache-verification-secret-minimum-thirty-two",
        "-e",
        "DATABASE_URL=postgres://local:local@127.0.0.1:1/local",
        "-e",
        "USABLE_CLIENT_SECRET=local-cache-verification-only",
        image,
      );
      started = true;
      const configuration = JSON.parse(
        docker("inspect", name, "--format", "{{json .HostConfig}}"),
      );
      assert.equal(configuration.ReadonlyRootfs, true);
      assert.deepEqual(configuration.Tmpfs, {
        "/tmp": "rw,noexec,nosuid,size=64m",
      });
      run.user = docker("exec", name, "id", "-u");
      assert.notEqual(run.user, "0");
      run.readOnlyRoot = configuration.ReadonlyRootfs;
      run.tmpfs = configuration.Tmpfs;
      const base = `http://${docker("port", name, "3010/tcp")}`;
      for (let attempt = 0; ; attempt++) {
        try {
          const { response } = await fetchBytes(
            `${base}/images/home-still-life.png`,
            2000,
          );
          assert.equal(response.status, 200);
          break;
        } catch (error) {
          if (attempt >= 30) throw error;
          await sleep();
        }
      }
      for (const request of ["cold", "warm"]) {
        run.requests.push({ request, ...(await probe(base)) });
        checkLogs(logs(name));
      }
      run.oauth = await probeOAuth(base);
      run.notices = probeNotices(name);
      // A real cache HIT ensures asynchronous cache writes completed. HTTP200
      // alone also occurs in the broken released image and is insufficient.
      for (let attempt = 0; ; attempt++) {
        const result = await probe(base);
        if (result.cache === "HIT") {
          run.cachedResponse = result;
          break;
        }
        assert(attempt < 2, "Optimized image never became a cache HIT");
        await sleep();
      }
      run.cachePath = docker(
        "exec",
        name,
        "readlink",
        "-f",
        "/app/apps/web/.next/cache/images",
      );
      assert(
        run.cachePath.startsWith("/tmp/"),
        "Image cache must resolve under /tmp",
      );
    } finally {
      if (started) {
        try {
          run.logs = logs(name);
        } finally {
          docker("rm", "-f", name);
        }
        checkLogs(run.logs);
      }
    }
  }
  report.result = "passed";
} catch (error) {
  report.result = "failed";
  report.error = error.message;
  process.exitCode = 1;
} finally {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `Web image verification ${report.result}; receipt: ${reportPath}`,
  );
}
