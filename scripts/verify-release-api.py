"""Black-box verification of a published API image; no application imports.

Only the existing readiness dependency fixture is mounted into the image. Every
Docker resource is uniquely owned by this invocation; no shared runtime is used.
"""

import argparse
import base64
import hashlib
import json
import os
import platform
import re
import secrets
import shutil
import signal
import subprocess
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

REPOSITORY = "jbiskur/family-dashboard"
IMAGE = "ghcr.io/jbiskur/family-dashboard-api"
ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "tests/fixtures/release-api"
FILES = ("readiness-container-preload.ts", "readiness-fixture-adapted.ts", "socket-probe.ts")
DUMMY_KEY = "fc_heimaReadinessFixture_notARealCredential"


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release-tag", required=True)
    parser.add_argument("--api-digest", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", args.release_tag):
        parser.error("release-tag must be a stable vMAJOR.MINOR.PATCH")
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", args.api_digest):
        parser.error("api-digest must be sha256 followed by64 lowercase hex digits")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    if (output / "receipt.json").exists():
        parser.error("output already contains a receipt; use a new directory")
    private = [v for v in (os.environ.get("GH_TOKEN"), os.environ.get("GITHUB_TOKEN")) if v]
    owned = f"heima-release-proof-{uuid.uuid4()}"
    network, database, api = owned, f"{owned}-db", f"{owned}-api"
    image = f"{IMAGE}@{args.api_digest}"
    created = []
    network_created = False
    result = {"startedAt": timestamp(), "passed": False, "releaseTag": args.release_tag,
              "image": image, "scope": "Native isolated released-image proof; not production-pod execution or household writes"}

    def redact(text):
        for value in private:
            text = text.replace(value, "[REDACTED]")
        return re.sub(r"(?i)(authorization|cookie|api-key)[:=][^\r\n]+", r"\1=[REDACTED]", text)

    def run(command, *, check=True, stdin=None, env=None, timeout=90):
        process = subprocess.run(command, input=stdin, capture_output=True, text=True,
                                 env=env, timeout=timeout)
        if check and process.returncode:
            raise RuntimeError(f"{command[0]} {command[1]} failed: {redact(process.stderr)[:400]}")
        return process

    def save(name, value):
        path = output / name
        path.write_text(json.dumps(value, indent=2) + "\n")
        path.chmod(0o600)

    def inspect(name):
        return json.loads(run(["docker", "inspect", name]).stdout)[0]

    def admin(statement, db="postgres"):
        return run(["docker", "exec", "-i", database, "psql", "-U", "heima_socket_admin",
                    "-d", db, "-At", "-v", "ON_ERROR_STOP=1"], stdin=statement + "\n").stdout.strip()

    def coordinator():
        return json.loads(admin("select json_build_object('observedAt',now(),'instances',"
            "(select coalesce(json_agg(t),'[]') from (select instance_id,address,last_heartbeat "
            "from public.heima_prod_pathway_instances)t),'leases',"
            "(select coalesce(json_agg(t),'[]') from (select key,instance_id,expires_at "
            "from public.heima_prod_pathway_leases)t));", "heima_socket_v022"))

    def interrupt(signum, _frame):
        raise RuntimeError(f"Verification interrupted by signal{signum}")

    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGINT, interrupt)
    # HOME is read only to choose a Docker-shareable path on macOS, never changed.
    scratch_parent = Path.home() / ".cache" if platform.system() == "Darwin" else Path(tempfile.gettempdir())
    scratch_parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="heima-release-proof-", dir=scratch_parent) as directory:
        scratch = Path(directory)
        scratch.chmod(0o755)
        try:
            docker_info = json.loads(run(["docker", "info", "--format", "{{json .}}"]).stdout)
            architecture = platform.machine().lower()
            if architecture not in ("x86_64", "amd64") or docker_info["Architecture"] not in ("x86_64", "amd64"):
                raise RuntimeError("Native AMD64 host and Docker engine required; no emulation fallback")
            result["platform"] = {"host": platform.system(), "architecture": architecture,
                                  "dockerArchitecture": docker_info["Architecture"], "emulated": False}
            if docker_info["MemTotal"] < 1024 * 1024 * 1024:
                raise RuntimeError("Docker engine needs at least1GiB for this isolated512MiB API proof")
            if not docker_info.get("MemoryLimit") or not docker_info.get("SwapLimit"):
                raise RuntimeError("Docker must support explicit memory and swap limits")
            result["toolingCommit"] = run(["git", "-C", str(ROOT), "rev-parse", "HEAD"]).stdout.strip()
            release = json.loads(run(["gh", "api", f"repos/{REPOSITORY}/releases/tags/{args.release_tag}"]).stdout)
            if release.get("draft") or release.get("prerelease") or not release.get("published_at"):
                raise RuntimeError("Specified release must already be published and stable")
            commit = json.loads(run(["gh", "api", f"repos/{REPOSITORY}/commits/{args.release_tag}"]).stdout)["sha"]
            if not re.fullmatch(r"[0-9a-f]{40}", commit):
                raise RuntimeError("Release did not resolve to a full commit")
            result["releaseCommit"] = commit
            provenance = json.loads((FIXTURE / "provenance.json").read_text())
            result["releaseFixtureSources"] = {}
            for path_key, hash_key in (("sourceTest", "sourceTestSha256"), ("sourcePreload", "sourcePreloadSha256")):
                source = provenance[path_key]
                data = json.loads(run(["gh", "api", f"repos/{REPOSITORY}/contents/{source}?ref={commit}"]).stdout)
                digest = hashlib.sha256(base64.b64decode(data["content"])).hexdigest()
                if digest != provenance[hash_key]:
                    raise RuntimeError("Released readiness source differs from reviewed fixture extraction")
                result["releaseFixtureSources"][source] = digest
            result["adapterHashes"] = {name: hashlib.sha256((FIXTURE / name).read_bytes()).hexdigest() for name in FILES}
            token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
            if not token:
                raise RuntimeError("Read-only GHCR token required; no stored credential fallback")
            endpoint = run(["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"] ).stdout.strip()
            # Authentication is deleted before any application container starts.
            with tempfile.TemporaryDirectory(prefix="registry-", dir=scratch) as auth:
                env = {**os.environ, "DOCKER_CONFIG": auth, "DOCKER_HOST": endpoint}
                actor = os.environ.get("GITHUB_ACTOR") or "allora2026"
                run(["docker", "login", "ghcr.io", "--username", actor, "--password-stdin"], stdin=token, env=env)
                run(["docker", "pull", "--platform", "linux/amd64", image], env=env, timeout=180)
            image_info = json.loads(run(["docker", "image", "inspect", image]).stdout)[0]
            labels = image_info["Config"].get("Labels") or {}
            expected = {"org.opencontainers.image.source": f"https://github.com/{REPOSITORY}",
                        "org.opencontainers.image.revision": commit,
                        "org.opencontainers.image.version": args.release_tag}
            if any(labels.get(key) != value for key, value in expected.items()) or image_info["Architecture"] != "amd64":
                raise RuntimeError("Exact image OCI source/revision/version/architecture mismatch")
            if image_info["Config"]["User"] != "bun" or image_info["Config"]["WorkingDir"] != "/app/apps/api":
                raise RuntimeError("Released API user/workdir changed; review runtime contract")
            if not any(value.endswith("@" + args.api_digest) for value in image_info["RepoDigests"]):
                raise RuntimeError("Pulled image digest was not retained in Docker identity")
            result["imageIdentity"] = {"id": image_info["Id"], "repoDigests": image_info["RepoDigests"], "labels": expected}
            run(["docker", "pull", "postgres:17-alpine"], timeout=120)
            pg_image = json.loads(run(["docker", "image", "inspect", "postgres:17-alpine"]).stdout)[0]
            result["postgresImage"] = {"id": pg_image["Id"], "repoDigests": pg_image["RepoDigests"]}
            password, admin_password = secrets.token_hex(24), secrets.token_hex(24)
            encryption_key, auth_key = secrets.token_hex(32), secrets.token_hex(32)
            private.extend([password, admin_password, encryption_key, auth_key, DUMMY_KEY])
            db_env = scratch / "db.env"
            db_env.write_text(f"POSTGRES_USER=heima_socket_admin\nPOSTGRES_PASSWORD={admin_password}\nPOSTGRES_DB=postgres\n")
            db_env.chmod(0o600)
            values = {"DATABASE_URL": f"postgres://heima_socket:{password}@heima-socket-db:5432/heima_socket_v022",
                "NODE_ENV": "production", "DATABASE_SCHEMA": "heima_prod", "PORT": "3211",
                "PATHWAYS_CLUSTER_PORT": "9091", "PATHWAYS_CLUSTER_ADVERTISED_ADDRESS": "127.0.0.1",
                "HEIMA_LOCAL_SOCKET_PROOF": "isolated-local-database-v022", "FLOWCORE_API_KEY": DUMMY_KEY,
                "FLOWCORE_TENANT": "heima-readiness-fixture", "FLOWCORE_DATA_CORE": "heima-readiness-fixture",
                "FLOWCORE_WEBHOOK_BASE_URL": "https://webhook.api.flowcore.io",
                "PATHWAYS_ENCRYPTION_KEY": encryption_key, "AUTH_SECRET": auth_key}
            private.append(values["DATABASE_URL"])
            api_env = scratch / "api.env"
            api_env.write_text("".join(f"{key}={value}\n" for key, value in values.items()))
            api_env.chmod(0o600)
            # Track the unique owned name before create in case the daemon succeeds
            # but the CLI loses its response. Cleanup still verifies actual absence.
            network_created = True
            run(["docker", "network", "create", "--internal", network])
            # Record ownership before create/run, so partial Docker failures also clean up.
            created.append(database)
            run(["docker", "run", "-d", "--name", database, "--network", network, "--network-alias", "heima-socket-db",
                 "--memory", "256m", "--memory-swap", "256m", "--env-file", str(db_env),
                 "--tmpfs", "/var/lib/postgresql/data:rw,size=128m", "--tmpfs", "/var/run/postgresql:rw,size=8m",
                 "postgres:17-alpine", "-c", "shared_buffers=16MB", "-c", "max_connections=25"])
            deadline = time.monotonic() + 45
            while run(["docker", "exec", database, "pg_isready", "-h", "127.0.0.1", "-U", "heima_socket_admin", "-d", "postgres"], check=False).returncode:
                if time.monotonic() > deadline:
                    raise RuntimeError("Owned PostgreSQL startup timeout")
                time.sleep(1)
            admin(f"CREATE ROLE heima_socket LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 20 PASSWORD '{password}';")
            admin("CREATE DATABASE heima_socket_v022 OWNER heima_socket;")
            identity = run(["docker", "exec", database, "psql", "-U", "heima_socket", "-d", "heima_socket_v022", "-Atc",
                           "select json_build_object('database',current_database(),'user',current_user,'superuser',(select rolsuper from pg_roles where rolname=current_user),'createDatabase',(select rolcreatedb from pg_roles where rolname=current_user),'createRole',(select rolcreaterole from pg_roles where rolname=current_user),'replication',(select rolreplication from pg_roles where rolname=current_user),'bypassRls',(select rolbypassrls from pg_roles where rolname=current_user));"])
            result["isolatedDatabaseIdentity"] = json.loads(identity.stdout)
            if result["isolatedDatabaseIdentity"] != {"database": "heima_socket_v022", "user": "heima_socket", "superuser": False, "createDatabase": False, "createRole": False, "replication": False, "bypassRls": False}:
                raise RuntimeError("Isolated database identity mismatch")
            command = ["bun", "--preload", "/evidence/readiness-container-preload.ts", "src/index.ts"]
            invocation = ["docker", "run", "-d", "--name", api, "--network", network, "--memory", "512m", "--memory-swap", "512m",
                          "--read-only", "--tmpfs", "/tmp:rw,size=64m", "--security-opt", "no-new-privileges", "--env-file", str(api_env)]
            for name in FILES:
                destination = scratch / name
                shutil.copyfile(FIXTURE / name, destination)
                destination.chmod(0o644)
                invocation += ["--mount", f"type=bind,src={destination},dst=/evidence/{name},readonly"]
            created.append(api)
            run([*invocation, image, *command])
            result["command"] = command
            deadline = time.monotonic() + 75
            while time.monotonic() < deadline:
                state = inspect(api)["State"]
                if not state["Running"]:
                    raise RuntimeError("Owned API exited during startup")
                logs = run(["docker", "logs", api], check=False)
                if "Heima API ready on port 3211" in logs.stdout:
                    break
                time.sleep(1)
            else:
                raise RuntimeError("Owned API startup timeout")
            probe = run(["docker", "exec", api, "bun", "/evidence/socket-probe.ts"])
            result["probe"] = json.loads(probe.stdout)
            if not result["probe"].get("passed"):
                raise RuntimeError("Native loopback/non-loopback socket proof failed")
            runtime = inspect(api)
            result["checks"] = {"runningImageMatchesPulledImage": runtime["Image"] == image_info["Id"]}
            if not result["checks"]["runningImageMatchesPulledImage"]:
                raise RuntimeError("Running API image differs from the verified pulled image")
            topology = json.loads(run(["docker", "network", "inspect", network]).stdout)[0]
            members = sorted(member["Name"] for member in topology["Containers"].values())
            if not topology["Internal"] or members != sorted([database, api]) or list(runtime["NetworkSettings"]["Networks"]) != [network]:
                raise RuntimeError("Owned internal-only network proof failed")
            host = runtime["HostConfig"]
            if host["PortBindings"] or host["Memory"] != 536870912 or host["MemorySwap"] != 536870912 or not host["ReadonlyRootfs"]:
                raise RuntimeError("API memory/no-swap/readonly/no-port contract failed")
            result["runtime"] = {"imageId": runtime["Image"], "user": runtime["Config"]["User"],
                "workdir": runtime["Config"]["WorkingDir"], "memoryBytes": host["Memory"],
                "memoryPlusSwapBytes": host["MemorySwap"], "readOnly": host["ReadonlyRootfs"],
                "portBindings": host["PortBindings"], "internalNetwork": topology["Internal"], "members": members}
            # Read inside the running mount namespace; daemon archive/cp did not
            # expose this tmpfs file in the native rehearsal.
            raw_fixture = json.loads(run(["docker", "exec", api, "cat", "/tmp/local-socket-fixture-receipt.json"]).stdout)
            allowed = {"mode", "databaseHost", "databaseName", "schema", "observed", "readinessReads", "unexpectedWrites"}
            if set(raw_fixture) != allowed:
                raise RuntimeError("Unexpected fixture receipt fields; raw content withheld")
            if any(set(row) != {"host", "path", "method"} for row in raw_fixture["observed"]) or any(
                    set(row) != {"eventId", "timeBucket", "method"} for row in raw_fixture["readinessReads"]):
                raise RuntimeError("Unexpected fixture request metadata; raw content withheld")
            if any(value in json.dumps(raw_fixture) for value in private):
                raise RuntimeError("Private value detected in fixture receipt; raw content withheld")
            fixture = {key: raw_fixture[key] for key in allowed}
            save("fixture.json", fixture)
            if fixture["unexpectedWrites"] != 0 or len({row["eventId"] for row in fixture["readinessReads"]}) != 3:
                raise RuntimeError("Fixture must observe three distinct readiness streams and no unexpected writes")
            result["coordinatorBeforeStop"] = coordinator()
            snapshot = result["coordinatorBeforeStop"]
            if len(snapshot["instances"]) != 1:
                raise RuntimeError("Expected exactly one real local coordinator instance")
            instance = snapshot["instances"][0]
            observed = datetime.fromisoformat(snapshot["observedAt"].replace("Z", "+00:00"))
            heartbeat = datetime.fromisoformat(instance["last_heartbeat"].replace("Z", "+00:00"))
            # Pathways2.7.0: heartbeat5s, stale threshold15s; coordinator statePrefix
            # namespaces DEFAULT_STATE_NAMES.leaseKey = pathway-cluster-leader.
            active_leases = [lease for lease in snapshot["leases"]
                if datetime.fromisoformat(lease["expires_at"].replace("Z", "+00:00")) > observed]
            result["checks"].update({
                "coordinatorLoopbackAddress": instance["address"] == "ws://127.0.0.1:9091",
                "coordinatorHeartbeatFresh": 0 <= (observed - heartbeat).total_seconds() < 15,
                "oneActiveOwnedLeaderLease": len(active_leases) == 1
                    and active_leases[0]["key"] == "heima_prod_pathway-cluster-leader"
                    and active_leases[0]["instance_id"] == instance["instance_id"],
            })
            if not all(result["checks"].values()):
                raise RuntimeError("Coordinator loopback address, fresh heartbeat or exact active leader lease proof failed")
            run(["docker", "stop", "--time", "35", api])
            result["coordinatorAfterStop"] = coordinator()
            if result["coordinatorAfterStop"]["instances"] or result["coordinatorAfterStop"]["leases"]:
                raise RuntimeError("Real local coordinator failed to unregister after graceful stop")
            result["passed"] = True
        except Exception as error:
            result["failure"] = redact(str(error))[:600]
        finally:
            # SIGTERM is caught above; allow this bounded cleanup to finish.
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            signal.signal(signal.SIGINT, signal.SIG_IGN)
            result["states"] = {}
            cleanup_errors = []

            def cleanup_run(command):
                try:
                    return run(command, check=False, timeout=45)
                except Exception as error:
                    cleanup_errors.append(redact(str(error))[:200])
                    return None

            for name in reversed(created):
                present = cleanup_run(["docker", "inspect", name])
                if present is not None and present.returncode == 0:
                    state = json.loads(present.stdout)[0]["State"]
                    result["states"][name] = {key: state.get(key) for key in ("Status", "ExitCode", "OOMKilled")}
                    if state["Running"]:
                        cleanup_run(["docker", "stop", "--time", "35", name])
                    logs = cleanup_run(["docker", "logs", name])
                    if logs is not None:
                        path = output / ("api.log" if name == api else "postgres.log")
                        path.write_text(redact(logs.stdout + logs.stderr))
                        path.chmod(0o600)
                    cleanup_run(["docker", "rm", name])
            if network_created:
                cleanup_run(["docker", "network", "rm", network])
            containers = cleanup_run(["docker", "ps", "-a", "--format", "{{.Names}}"])
            networks = cleanup_run(["docker", "network", "ls", "--format", "{{.Name}}"])
            result["cleanup"] = {
                "containersAbsent": containers is not None and containers.returncode == 0
                    and not any(name in containers.stdout.splitlines() for name in created),
                "networkAbsent": networks is not None and networks.returncode == 0
                    and network not in networks.stdout.splitlines(),
                "errors": cleanup_errors,
            }
            if not result["cleanup"]["containersAbsent"] or not result["cleanup"]["networkAbsent"] or cleanup_errors:
                result["passed"] = False
    result["cleanup"]["privateScratchAbsent"] = not scratch.exists()
    result["finishedAt"] = timestamp()
    save("receipt.json", result)
    print(json.dumps({"passed": result["passed"], "receipt": str(output / "receipt.json"), "failure": result.get("failure")}))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
