import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

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
  console.log(`Image cache ${report.result}; receipt: ${reportPath}`);
}
