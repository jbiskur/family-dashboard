# Heima

A private home for shopping, household work, and finances. Built for one owner and an invited spouse, with non-login profiles for shared responsibilities.

Heima uses the invite-only **Heima Family Dashboard** Usable application, encrypted Flowcore Pathways events, and PostgreSQL projections. [Architecture and standards](docs/architecture.md) describe the trust boundaries.

## Local verification

Requires Bun 1.3.10 and Docker. Tests create an isolated real Keycloak realm and Postgres database; no production credentials needed.

```sh
bun install --frozen-lockfile
bun run test:setup
HEIMA_API_ONLY=1 bun scripts/test-runtime.ts
```

In another terminal:

```sh
bun test tests/http
bun run --filter @heima/api typecheck
```

The API listens on `http://localhost:3211`. Health checks are `/health/live` and `/health/ready`. Test credentials are generated into ignored `.env.test.local` with mode 0600. Keep that file private. The canonical webhook fixture emulates external transport and forwards encrypted events to real projection handlers.

The application UI and browser evidence are delivered in the next stacked change. Version publishing and container-service deployment configuration follow that verified app change.
