# Plan: Run the project's app in a Docker Sandbox, one per job

## Approach

A thin wrapper over the `sbx` CLI (`src/integrations/sbx.ts`) and one command file (`src/commands/app.ts`) with `up`, `exec`, `logs`, `url`, `status`, `down`, as in `research/design.md` §3.3. Config is `.agents/limen/sandbox.json` (§3.2). The job record lives in `.limen/jobs/<id>/app/` (`sandbox`, `ports.json`, `url`, `up.log`); the main-checkout record lives in `.limen/app/`. Then `stop`, `land`, and `prune` take the sandbox down, and the communication hook shows one `App:` line for a job that has `app/url`.

## Assumptions

- Sandbox names are `limen-<project hash 6>-<job hex 8>` and `limen-<project hash 6>-main`. The project hash is the first 6 hex characters of sha256 of the canonical project root. `sbx` is per user, so `prune` touches only its own prefix (correction C9 of the harness plan).
- With no job argument, `limen app` uses `LIMEN_JOB_ID` when it is set, else the main checkout (correction C10).
- Every `sbx` call has a timeout. `up` allows 10 minutes for `create`, because the first create pulls the image.
- `up` polls `ready.url` from the host until `ready.timeout`. On failure it prints the last 40 lines of `up.log`, exits 1, and leaves the sandbox up for `limen app logs`.
- `enabled: false` or no `sandbox.json`: every `limen app` command refuses with "sandbox disabled for this project". A missing `sbx` binary: `up` refuses and names the install steps; no fallback to host Docker.
- The worktree's `.git` file points into the main repository, which is not mounted. The app must not need Git. Mounting the main `.git` read-only is not part of this change.
- The tool-call guard needs no change: it classifies only `limen approve|push|pr|merge`, so `limen app` is allowed for every role that has bash.

## Standards to apply

- [ ] limen-code: small plain functions, one file one job, no new runtime dependency, Biome clean.
- [ ] minimal-implementation: no options the design does not name.
- [ ] Tests use real Git and files; `sbx` is a fake on `PATH`; no network.

## Phases

### Phase 1: app commands for one job
Depends on: none
`limen app up|exec|logs|url|status|down` work for a job and for the main checkout, against a fake `sbx` that records argv and answers `ports --json` and `ls --json`. `src/main.ts` registers `app` with help lines; `docs/commands.md` gets a short section.
Tests: one new test file, at most 50 lines (the `test/` cap is 3,800 lines and about 3,790 are used; retire or tighten lines elsewhere if needed and say so).

### Phase 2: lifecycle and context
Depends on: 1
`limen stop`, `limen land`, and `limen prune` run `app down` for the job. `prune` also removes sandboxes with this project's prefix that have no record, and leaves other prefixes alone. `hook/communication.ts` adds `App: <url> · run commands with limen app exec · logs with limen app logs` for a job whose `app/url` exists.
Tests: the phase 1 file, plus `test/s5-land.test.ts` and `test/s9-housekeeping.test.ts` if they need a fake `sbx` on `PATH`.

## Progress
> `- [ ]` pending, `- [x]` done. Append ` — <short-sha>` when a step lands in a commit.

### Phase 1: app commands for one job
#### Automated
- [ ] 1.1 Fake-`sbx` test: `up` creates `limen-<hash6>-<hex8>` with the worktree, runs setup and start, publishes each port, writes `app/ports.json` and `app/url`
- [ ] 1.2 Fake-`sbx` test: `exec`, `logs`, `url`, and `down` call the recorded sandbox; `down` removes the record
- [ ] 1.3 A missing or disabled `sandbox.json` refuses with "sandbox disabled for this project"
- [ ] 1.4 `npm run check` without `test/s2-hosted.test.ts` is green: `npx tsc --noEmit`, `npx biome check --error-on-warnings .`, and each touched test file
#### Manual
- [ ] 1.5 (agent-runnable) Real `sbx`: `limen app up` on a scratch repo with a Compose app returns a URL that `curl` reaches; `limen app down` removes it from `sbx ls`

### Phase 2: lifecycle and context
#### Automated
- [ ] 2.1 Fake-`sbx` test: `land` removes the job's sandbox
- [ ] 2.2 Fake-`sbx` test: `prune` removes an orphan with this project's prefix and keeps another project's sandbox
- [ ] 2.3 A worker's system prompt holds the `App:` line when `app/url` exists
- [ ] 2.4 `test/structure.test.ts` passes (test line cap)
#### Manual
- [ ] 2.5 (agent-runnable) Real `sbx`: two jobs run the same Compose app at once on different host ports; each URL answers
- [ ] 2.6 (agent-runnable) Real `sbx`: `limen land` removes the sandbox; `limen prune` in a second project leaves the first project's sandbox alone
