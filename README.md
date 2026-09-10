# Heima

A private home for shopping, household work, and finances. Built for one owner and an invited spouse, with non-login profiles for shared responsibilities.

Heima uses the invite-only **Heima Family Dashboard** Usable application, encrypted Flowcore Pathways events, and PostgreSQL projections. [Architecture and standards](https://usable.dev/dashboard/workspaces/f37b9773-0e9f-4ccd-8e85-05c5971af264/fragments/7fcb6197-1be9-4c10-81fb-2fd780309467) describe the trust boundaries.

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

[Feature paths and screenshots](docs/screenshot-manifest.json) cover all 29 work units. [Verification](https://usable.dev/dashboard/workspaces/f37b9773-0e9f-4ccd-8e85-05c5971af264/fragments/96b98ea2-8fc5-44c8-8b2e-7a7a41baaf5a) distinguishes observed evidence from outstanding acceptance requirements. Live specifications and plan references are indexed in [the project map](docs/spec-index.json).

## Documentation

Project documentation is stored and maintained in the private My Life workspace in Usable. Workspace access is required. Screenshots and machine-readable verification receipts remain in this repository.

- [Heima architecture and foundations](https://usable.dev/dashboard/workspaces/f37b9773-0e9f-4ccd-8e85-05c5971af264/fragments/7fcb6197-1be9-4c10-81fb-2fd780309467)
- [Heima guided bank statement imports](https://usable.dev/dashboard/workspaces/f37b9773-0e9f-4ccd-8e85-05c5971af264/fragments/fa0c091a-0238-4571-a535-9c1499e59906)
- [Heima deployment runbook](https://usable.dev/dashboard/workspaces/f37b9773-0e9f-4ccd-8e85-05c5971af264/fragments/02034e80-5298-41cb-b812-ead7f263d76f)
- [Heima mobile and import verification](https://usable.dev/dashboard/workspaces/f37b9773-0e9f-4ccd-8e85-05c5971af264/fragments/9ecba702-594f-423e-b458-2de5558b1fce)
- [Heima mobile shopping and work](https://usable.dev/dashboard/workspaces/f37b9773-0e9f-4ccd-8e85-05c5971af264/fragments/cc502fde-6cbb-4d5d-8f82-51f1ded2fe78)
- [Heima native Faroese and Revolut statements](https://usable.dev/dashboard/workspaces/f37b9773-0e9f-4ccd-8e85-05c5971af264/fragments/e17be22b-c3a4-4c7a-b3f8-70832e2d04be)
- [Heima released API verification](https://usable.dev/dashboard/workspaces/f37b9773-0e9f-4ccd-8e85-05c5971af264/fragments/9f3b324c-d010-43e4-8cef-213bed650ac4)
- [Heima project acceptance verification](https://usable.dev/dashboard/workspaces/f37b9773-0e9f-4ccd-8e85-05c5971af264/fragments/96b98ea2-8fc5-44c8-8b2e-7a7a41baaf5a)
