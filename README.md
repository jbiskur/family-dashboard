# Heima

A private home for shopping, household work, and finances. Built for one owner and an invited spouse, with non-login profiles for shared responsibilities.

Heima uses the invite-only **Heima Family Dashboard** Usable application, encrypted Flowcore Pathways events, and PostgreSQL projections. [Architecture and standards](docs/architecture.md) describe the trust boundaries.

## Local verification

Requires Bun 1.3.10 and Docker. Tests create an isolated real Keycloak realm and Postgres database; no production credentials needed.

```sh
bun install --frozen-lockfile
bun run test:setup
bun run build
HEIMA_WEB_MODE=production bun scripts/test-runtime.ts
```

In another terminal:

```sh
bun test tests/http
bunx playwright install chromium firefox webkit
bunx playwright test
bun run typecheck
bun run lint
```

The API listens on `http://localhost:3211`. Health checks are `/health/live` and `/health/ready`. Test credentials are generated into ignored `.env.test.local` with mode 0600. Keep that file private. The canonical webhook fixture emulates external transport and forwards encrypted events to real projection handlers.

Open `http://localhost:3010` and continue through the isolated Usable-compatible Keycloak login. The test owner is `owner@heima.test`; its generated password is `TEST_USER_PASSWORD` in the private test environment file. Real production login uses the invite-only Usable application; the local realm is a verification fixture.

Home connects quick capture and attention items to Shopping, Work and Finance. Shopping and Work support bounded offline access, durable queues and explicit conflict recovery. Finance stays online, keeps personal account details private, preserves exact amounts and requires zero-difference statement reconciliation before trusting imports.

[Feature paths and screenshots](docs/screenshot-manifest.json) cover all 29 work units. [Verification](docs/verification.md) distinguishes observed evidence from outstanding acceptance requirements. Live specifications and plan references are indexed in [the project map](docs/spec-index.json).
