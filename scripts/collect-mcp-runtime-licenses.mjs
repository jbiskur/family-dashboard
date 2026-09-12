import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Next standalone bundles these dependencies without retaining their license
// files. Preserve installed notices verbatim, including transitive dependencies.
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2];
if (!target)
  throw new Error(
    "Usage: node scripts/collect-mcp-runtime-licenses.mjs <empty-output-directory>",
  );
const output = resolve(target);
mkdirSync(output, { recursive: true });
if (readdirSync(output).length)
  throw new Error("License output directory must be empty");

function dependencyDirectory(from, name) {
  let directory = from;
  while (true) {
    const candidate = join(directory, "node_modules", name);
    if (existsSync(join(candidate, "package.json")))
      return realpathSync(candidate);
    const parent = dirname(directory);
    if (parent === directory)
      throw new Error(`Installed dependency missing: ${name}`);
    directory = parent;
  }
}

const seen = new Set();
const packages = [];
function collect(directory) {
  if (seen.has(directory)) return;
  seen.add(directory);
  const metadata = JSON.parse(
    readFileSync(join(directory, "package.json"), "utf8"),
  );
  const notices = readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        /^(?:licen[cs]e|notice|copying|copyright)(?:[._-].*)?$/i.test(
          entry.name,
        ),
    )
    .map((entry) => entry.name)
    .sort();
  if (!notices.length)
    throw new Error(`Installed notices missing: ${metadata.name}`);
  const folder = `${encodeURIComponent(metadata.name)}@${metadata.version}`;
  mkdirSync(join(output, folder));
  const files = notices.map((name) => {
    const bytes = readFileSync(join(directory, name));
    writeFileSync(join(output, folder, name), bytes);
    return {
      path: `${folder}/${name}`,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
  packages.push({
    name: metadata.name,
    version: metadata.version,
    declaredLicense: metadata.license ?? null,
    files,
  });
  for (const name of Object.keys(metadata.dependencies ?? {}).sort())
    collect(dependencyDirectory(directory, name));
}
for (const name of [
  "@modelcontextprotocol/server",
  "@node-oauth/oauth2-server",
  "zod-mcp",
])
  collect(dependencyDirectory(join(repository, "apps/web"), name));
packages.sort(
  (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
);
writeFileSync(
  join(output, "index.json"),
  `${JSON.stringify({ note: "Installed LICENSE and NOTICE texts are authoritative; declaredLicense only records package metadata.", packages }, null, 2)}\n`,
);
console.log(`Preserved notices for ${packages.length} runtime packages.`);
