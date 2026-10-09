# Contributing to Sahay

## Branches
- `main` always runs. Never push to it directly.
- One branch per issue, named `<type>/<ID>-<slug>`: `feat/B-04-dispatch`, `fix/N-02-nearby-perms`, `chore/X-01-repo-conventions`, `docs/D-04-run-sheet`.
- Types: `feat`, `fix`, `chore`, `docs`, `test`, `refactor`.
- Rebase on `main` before opening the PR. Keep branches short-lived.

## Commits
Conventional Commits, subject up to 50 chars, imperative:
`feat(dispatch): add Haversine nearest-unit lookup`
Scopes: `backend`, `web`, `android`, `contract`, `design`, `docs`.

## Pull requests
- Title starts with the issue ID: `B-04: deterministic dispatch engine`.
- One review required before merge. Author does not self-merge without approval.
- Squash merge.
- Fill in the PR template. CI-less repo for now: run your own tests and say so in the PR.
- Contract changes (`docs/api-contract.md`) need review from every side that consumes the change. Update backend, `contract/fixtures/`, and frontend types in the same PR or a linked one.

## Required tests
Merge is blocked without tests for:
- dispatch engine (B-04)
- signature verification (B-03)
- audit hash chain (B-09)

## Conventions
- JSON is `snake_case`. Timestamps ISO-8601 UTC. Binary is base64.
- Dev-only endpoints live under `/dev/*` and are gated by `SAHAY_DEV=1`.
- Dispatch is deterministic code, never an LLM call.
- Emergency number is 112. Use `ACTION_DIAL` only, never `ACTION_CALL`. Never dial 112 in demos.

## Secrets
- No secrets in git: keys, tokens, `.env`, keystores, service-account JSON.
- Copy `backend/.env.example` to `backend/.env` and `web/.env.example` to `web/.env.local`; fill locally.
- If a secret is committed, rotate it first, then clean history.

## Repo layout
See `README.md`. Each area has one owner (listed there) who is the default reviewer.
