# Limen — project overview

Personal study notes. Sources: `docs/`, `README.md`, `spec/vision.md`, and a read-only
trace of `src/`, `hook/`, `bin/`. File references are `path:line` at the time of writing.

Contents:

1. [What Limen is](#1-what-limen-is)
2. [Vocabulary](#2-vocabulary)
3. [Building blocks](#3-building-blocks)
4. [Architecture diagrams](#4-architecture-diagrams)
5. [Command reference](#5-command-reference)
6. [Design themes](#6-design-themes)

---

## 1. What Limen is

*"A minimal one-human-many-agents harness built from files, git, and one CLI."*

You talk to one agent, the **coordinator**. The coordinator uses the `limen` CLI to
start short, isolated **jobs** (workers and reviewers). Each job runs in its own Git
worktree. You review the results and decide what gets merged. Limen never merges
on its own.

- About 20k lines of TypeScript. Node 24+ runs it natively, with no build step.
- No runtime dependencies. macOS and Linux only.
- Engines: `omp` (default) or `pi`. Herdr is optional and only provides the visible layout.

The idea that ties it together: **there is no daemon, no database, and no socket
between components. They communicate by reading and writing files in `.limen/`.**
Atomic renames and exclusive creates act as locks and "claims".

---

## 2. Vocabulary

| Term | Meaning |
|---|---|
| **Plant** | A project managed by Limen (a Git repo after `limen init`) |
| **Coordinator** | The agent session you talk to. Runs in Pi or OMP, usually inside a Herdr pane |
| **Job** | One short agent run: one task, one branch, one worktree, one record |
| **Cabinet** | `.limen/jobs/<id>/`, a folder of plain files per job. The source of truth |
| **Engine** | The agent binary that runs a job: `omp` (default) or `pi` |
| **Hosted vs detached** | Hosted runs in a Herdr tab you can type into. Detached runs in the background with a time limit |
| **Board** | `spec/build.md`: TRACK / NOW / NEXT / PROVEN, plus the model choice for each role |
| **Ticket / lanes** | `spec/features/{planned,active,done,dropped}/FNNN-slug/ticket.md` |
| **Seat / window** | Seat: the always-on host that owns the cabinet. Window: any device you attach from |
| **Land** | Merge a job's branch into the checked-out branch |

---

## 3. Building blocks

| # | Block | Location | Role |
|---|---|---|---|
| 1 | CLI | `bin/limen`, `src/main.ts`, `src/commands/` | One file per command, 26 commands in total |
| 2 | Job model | `src/job/` | Record format, lookup by ID/suffix/label, atomic publication, views, usage, wake text and delivery, group cabinet and events |
| 3 | Runtime | `src/runtime/` | `engine.ts` (builds the command line), `stream.ts` (one parser for both engines), `wrapper.ts` (detached), `supervisor.ts` (hosted), `contain.ts`/`reap.ts` (process groups, live or lost owner), `hosted-binding.ts` (pane ownership, hosted Pi on Linux only) |
| 4 | Hooks | `hook/` | Engine extensions: `communication`, `wake`, `steering`, `hosted`, `group-peer` |
| 5 | Prompts | `templates/` | Role prompts (coordinator, worker, reviewer, keeper, judge, scout, researcher, group-member, quality) and the shop manual `agents.md`. The project can replace any one of them |
| 6 | Project layer | `src/project/` | Git helpers, planning source, seat registry, picture tick/watch |
| 7 | Integrations | `src/integrations/` | Herdr, finish webhook and receipts, coordinator signals, GitHub poller and review |
| 8 | Picture | `src/picture/`, `picture/` | Offline HTML architecture map plus a live server |
| 9 | State on disk | `.limen/` | `jobs/`, `groups/`, `coordinators/`, `group-leads/`, `github/`, `picture/`, `last-sweep`; plus `~/.limen/projects` (seat registry) |

### Features at a glance

- **Core job loop:** spawn (worker, review, repair, repo, role), continue, steer → stop → resume, watch/unwatch, wait, status inbox, jobs, diff, open, land (with a ticket check), prune, spec keeper.
- **Planning:** init, workspace init, planning committed|private, ticket new/check, ticket-author.
- **Team groups:** one lead, N teams with competing hypotheses, a folder of events with delivery receipts, a deadline, the lead synthesizes and lands.
- **Picture:** build (no model), serve (live job strip over SSE), tick (refresh only on structural or cited changes), watch (Git hook).
- **Notifications:** coordinator wakes, the seat bell via sweep, finish/plant webhooks with receipts.
- **Remote/external:** remote seat (VPS + Tailscale + Herdr), GitHub doorbell (App poller under an isolated Unix user), Linear mirror toggle.

---

## 4. Architecture diagrams

### 4.1 Big picture: who talks to whom

```
                         ┌──────────────┐
                         │    HUMAN     │  types intent, approves merges
                         └──────┬───────┘
                                │ chat
                                ▼
 ┌──────────────────────────────────────────────────────────────────┐
 │  COORDINATOR SESSION   (Pi or OMP, usually in a Herdr pane)       │
 │                                                                   │
 │   project stub .pi|.omp/extensions/limen.ts                       │
 │        └─► loads package hooks:  wake · communication ·           │
 │                                   steering(no-op) · group-peer    │
 └──────┬───────────────────────────────────────────▲────────────────┘
        │ runs shell: `limen spawn|steer|land|...`  │ wake message
        ▼                                           │ (hook or herdr prompt)
 ┌──────────────────┐   writes/reads   ┌────────────┴─────────────────┐
 │   limen CLI      │ ───────────────► │  CABINET   .limen/           │
 │ bin/limen        │                  │   jobs/<id>/   groups/<id>/   │
 │ src/main.ts      │ ◄─────────────── │   coordinators/ github/       │
 │ src/commands/*   │                  │   picture/   last-sweep       │
 └──┬─────┬─────┬───┘                  └────────────▲─────────────────┘
    │     │     │                                   │ every process
    │     │     └── git worktree add ──► ┌──────────┴──────┐ writes here
    │     │                              │  GIT            │
    │     │                              │  main checkout  │
    │     │                              │  + worktrees    │
    │     │                              │  limen/<id>     │
    │     │                              └─────────────────┘
    │     └──── herdr tab/agent/prompt ─► ┌─────────────────┐
    │                                     │  HERDR (opt.)   │ visual layer only
    │                                     └─────────────────┘
    └── re-execs itself as ──► WRAPPER / SUPERVISOR ──► ENGINE (omp|pi) = the worker
```

### 4.2 One binary, three personalities

`bin/limen` is re-entrant. The wrapper and the supervisor are the same binary,
started again in the background with an internal env flag (`src/main.ts:136-145`,
`src/runtime/wrapper.ts:26-48`).

```
                     bin/limen  (node, TS run natively, no build)
                          │
                          ▼
                     src/main.ts
          ┌───────────────┼────────────────────────┐
          │               │                        │
 LIMEN_INTERNAL_RUN=1   (normal)        LIMEN_INTERNAL_HOSTED=1
          │               │                        │
          ▼               ▼                        ▼
 ┌─────────────────┐ ┌──────────────┐  ┌──────────────────────┐
 │ WRAPPER         │ │ COMMANDS     │  │ SUPERVISOR           │
 │ runtime/        │ │ table        │  │ runtime/             │
 │ wrapper.ts      │ │ spawn, jobs, │  │ supervisor.ts        │
 │ (detached job)  │ │ land, group, │  │ (hosted job)         │
 │                 │ │ picture, ... │  │                      │
 └─────────────────┘ └──────────────┘  └──────────────────────┘
```

### 4.3 Spawn: detached and hosted paths

```
 limen spawn "task"     (src/commands/spawn.ts)
   │
   ├─1 parse + authority checks (group rules, no coordinator role)
   ├─2 hosted?  = !--detached && (--tab || HERDR_ENV=1)
   ├─3 engine profile + preflight              (runtime/engine.ts)
   ├─4 capture wake route:  PI_SESSION_ID  →  notify/subscribers/<sid>
   │                         else HERDR_PANE_ID → origin-pane
   ├─5 PUBLISH record:  .limen/.publishing-<id>/  ──rename──►  jobs/<id>/
   ├─6 git worktree add -b limen/<id> ../.<repo>-limen-worktrees/<id>
   ├─7 state = running
   │
   ├────────── DETACHED ───────────────┐────────── HOSTED ──────────────────┐
   │                                   │                                    │
   │  launchWrapper()                  │  herdr: open shell tab             │
   │     │                             │     env LIMEN_JOB=1 LIMEN_HOSTED=1 │
   │     ▼                             │  launchHostedSupervisor()          │
   │  WRAPPER                          │     │                              │
   │   spawn engine --mode json        │     ▼                              │
   │   stdout ──► stream.ts parser     │  SUPERVISOR                        │
   │      writes activity, last-tool,  │   herdr agent start --pane P       │
   │      tool-calls, log              │     -- omp|pi <argv>               │
   │   enforces 90m / 900 calls /      │   polls every 1s: agent status,    │
   │      stalled-tool                 │      session-ended                 │
   │                                   │   (hook/hosted.ts inside the       │
   │                                   │    engine writes activity etc.)    │
   └───────────────┬───────────────────┘──────────────┬─────────────────────┘
                   │  both write `pid` (handshake)     │
                   ▼                                   ▼
   spawn polls for `pid`, prints the job ID, exits (returns in seconds)
```

The engine command line (`src/runtime/engine.ts:210`):

```
 omp|pi  [--mode json]  --auto-approve|--approve  --no-extensions
         --session-dir jobs/<id>/session
         --append-system-prompt <role preamble: .agents/limen/<role>.md | templates/>
         --extension hook/steering.ts --extension hook/communication.ts
         [--extension hook/hosted.ts] [--extension hook/group-peer.ts]
         [--extension <user extras>]
         --provider P --model M --thinking T   @task.md | --continue
```

`--no-extensions` means the project stubs **never** load inside a job. Jobs get
only the hooks that are passed in explicitly.

### 4.4 Which hooks run where

```
                    COORDINATOR                         JOB (worker/reviewer)
                 (via project stub)                  (via --extension flags)
 ┌──────────────────┬─────────────────────────┬──────────────────────────────┐
 │ hook             │ coordinator             │ job                          │
 ├──────────────────┼─────────────────────────┼──────────────────────────────┤
 │ communication.ts │ AGENTS/register/VISION/ │ register + styleguide only;  │
 │                  │ styleguide/BOARD digest │ Ticket: pointer per turn     │
 │ wake.ts          │ ✔ watches jobs/, wakes  │ ✘ (LIMEN_JOB=1 disables)     │
 │                  │   registers project,    │                              │
 │                  │   reaps dead jobs       │                              │
 │ steering.ts      │ ✘ no-op                 │ ✔ watches steer/inbox        │
 │ group-peer.ts    │ lead heartbeat + events │ member event piggyback       │
 │ hosted.ts        │ —                       │ ✔ hosted only: `finish` tool,│
 │                  │                         │   activity, Herdr metadata   │
 │ coordinator-     │ ✔ registers coordinators│ —                            │
 │ signal (in wake) │   for idle/blocked/exit │                              │
 └──────────────────┴─────────────────────────┴──────────────────────────────┘
```

How `communication.ts` builds the prompt, ordered for cache stability:

```
 system prompt = [shop manual AGENTS.md] [register] [vision] [styleguide] [board NOW/NEXT]
                  ◄──────────── stable, cached prefix ───────────►  ◄─ changes ─►
 per turn      = hidden cue (audience, ticket, failure, wake, drift)
 tool_result   = reminder (edited spec/? → spec rules; code? → styleguide headings)
```

### 4.5 The job folder works as a message bus

Every arrow is a file write or a file read. No process calls another process directly.

```
                          .limen/jobs/<id>/
     WRITERS              ┌───────────────────────┐              READERS
                          │ task.md label branch  │
 spawn (publishJob) ────► │ worktree engine model │ ───► jobs/status/view
                          │ origin-pane/session   │
                          ├───────────────────────┤
 wrapper | supervisor ──► │ pid born   (handshake)│ ───► reap.ts (alive?)
                          ├───────────────────────┤
 wrapper | hosted.ts ───► │ activity last-tool    │ ───► footer, jobs, picture serve
                          │ tool-calls log        │
                          ├───────────────────────┤
 engine itself ─────────► │ session/*.jsonl       │ ───► continue, keeper, usage
                          ├───────────────────────┤
 limen steer ───────────► │ steer/inbox/NNNN      │ ───► hook/steering.ts (in job)
 hook/steering.ts ──────► │ steer/ready,delivered │ ───► limen steer (check)
                          ├───────────────────────┤
 hosted.ts `finish` ────► │ result  session-ended │ ───► supervisor → finalize
                          ├───────────────────────┤
 finalizeJob ───────────► │ STATE  finished-at    │ ───► wake.ts, sweep, status,
   (record.ts:35)         │ commits tip stop-rsn  │       picture serve
                          ├───────────────────────┤
 spawn | watch ─────────► │ notify/subscribers/*  │ ───► wake.ts
 wake.ts ───────────────► │ notify/claims,deliverd│
 sweep ─────────────────► │ notify/seat/<event>   │
                          ├───────────────────────┤
 finish-webhook.ts ─────► │ finish-webhook*       │ ───► jobs <id> (receipts)
                          └───────────────────────┘
```

**Rule:** `state` changes to a terminal value in exactly one function,
`finalizeJob` (`src/job/record.ts:35`). It can be reached from the wrapper, the
supervisor, `limen stop`, or the reaper (when the owning process has died).

### 4.6 Control loops: steer in, wake out

```
           STEER (coordinator ──► running job)

 coordinator                     cabinet                      job engine
 `limen steer id "msg"`                                       hook/steering.ts
     │ check state=running,                                       │ fs.watch + 500ms poll
     │ pid alive, steer/ready                                     │
     └──► steer/inbox/0003 ────────────────────────────────────► claim → claims/0003
                                                                  │ pi.sendUserMessage(
                                                                  │   deliverAs:"steer")
                                                 delivered/0003 ◄─┘ between tool calls


           WAKE (finished job ──► coordinator)

                         finalizeJob
                              │
            ┌─────────────────┼──────────────────────┬──────────────────┐
            ▼                 ▼                      ▼                  ▼
     state=done        promptCoordinator     deliverFinishWebhook   settleJobTab
            │          (OMP / no Pi session)  (if opted in)          (close tab)
            │                 │                      │
            │       herdr agent prompt <pane>        └─► bin/tony-finish-ping.sh
            │         --wait --until working                ──► HTTPS bots
            │                 │
            ▼                 ▼
   Pi coordinator's     OMP coordinator pane
   hook/wake.ts         receives the text as
   (watches jobs/)      a new prompt
   sees terminal state
   → claim notify/claims/<sid>
   → sendUserMessage(wake text)
   → turn answered → delivered/<sid>
```

There are two wake routes because Pi can inject a message into a running session
from a hook, while OMP gets its wake as a prompt typed into its Herdr pane.

### 4.7 Notification channels, kept apart on purpose

```
  event source                channel                 audience        receipt
 ─────────────────────────────────────────────────────────────────────────────
  job terminal ──► wake.ts / herdr prompt ──► coordinator    notify/delivered
  job terminal ──► finish webhook ─────────► external bots  finish-webhook*
  coord idle/blocked/exited ─► webhook ────► external bots  coordinators/.../events
  group lead step ──► webhook ─────────────► external bots  groups/.../lead-steps
  nobody heard ──► limen sweep ──► herdr notification / osascript  notify/seat
                   (only when .limen/last-sweep is stale = no live coordinator)
  phone bell ────► Moshi / ntfy (seat/bell.sh, outside Limen proper)
```

Each channel keeps its own claim files. One channel succeeding never counts as
another channel delivering.

### 4.8 Groups: a second bus inside the cabinet

```
 LEAD = coordinator pane (NOT a job)                 .limen/group-leads/<sid>
   hook/group-peer.ts heartbeat (mtime ~1s) ───────► (must be < 30s old)
   │
   │ limen group start F777 --teams 2 ...
   ▼
 .limen/groups/<run>/
   run.json  ◄── roster, deadline, members[], stopped flag
   launch/   ◄── lock (only one launch at a time; allowance check)
   events/<seq>-<uuid>.json      ◄── publish / lifecycle
   receipts/<recipient>/<ev>.json   queued→accepted→observed→processed
   │
   ├─► spawn (team-1 coordinator job) ──► spawn workers ──► jobs/<id> ...
   └─► spawn (team-2 coordinator job) ──► spawn workers ──► jobs/<id> ...
                     │                                          │
        `limen group publish "finding"`         finalizeJob/supervisor
                     │                           syncLifecycle()
                     ▼                                          ▼
                events/ + receipts for every other recipient ◄──┘
                     │
     ┌───────────────┴─────────────────┐
     ▼                                 ▼
 members: group-peer appends       lead: group-peer sends a custom
 batch to the next tool_result     message (triggerTurn) every ~1s
     └──────── [limen-group-delivery:<token>] marker ──► receipt advances
```

The lead writes `group/synthesis.md`, starts `limen keeper --group`, and lands.
Members cannot land.

### 4.9 Background helpers around the core

```
 ┌─ limen sweep (launchd / systemd every 60s) ─────────────────────────┐
 │  ~/.limen/projects  (seat registry, filled by wake.ts)               │
 │   for each project:                                                  │
 │     confirmDeadJobs ──► finalizeJob(failed) for dead owners          │
 │     sweepCoordinators ─► .limen/coordinators/* pid gone? ─► webhook  │
 │     seat notify (if no live wake hook) ──► notify/seat/<event>       │
 └──────────────────────────────────────────────────────────────────────┘

 ┌─ Picture ───────────────────────────────────────────────────────────┐
 │  .limen/picture/*.md ──┐                                             │
 │  spec/features tickets ├─► picture build ──► map.html  (no model)    │
 │  spec/build.md board ──┘                                             │
 │                                                                      │
 │  picture serve :4747 ◄── reads jobs/*/activity,state,... every 1s    │
 │        └─ SSE /events ──► browser live strip                         │
 │                                                                      │
 │  git ref moves ─► .git/hooks/reference-transaction (picture watch)   │
 │        └─► picture tick ─► relevant diff? ─► spawn --role picture    │
 │                                               --detached (refresh)   │
 └──────────────────────────────────────────────────────────────────────┘
```

### 4.10 Deployment: seat, window, and the GitHub trust boundary

```
  WINDOW (Mac / phone)                SEAT (VPS on tailnet)
 ┌─────────────────┐   tailscale   ┌──────────────────────────────────────────┐
 │ herdr --remote  │ ────────────► │  user: overment (no sudo)                │
 │ browser preview │               │   Herdr session                          │
 │ (no .limen/!)   │               │    └ coordinator pane (OMP)              │
 └─────────────────┘               │    └ job tabs / detached wrappers        │
                                   │   project checkout + .limen/ + worktrees │
                                   │                     ▲                    │
                                   │                     │ herdr agent prompt │
                                   │   ─ ─ ─ ─ ─ ─ ─ ─ ─ ─│─ ─ trust boundary ─│
                                   │  user: limen-github  │ (sudo -u overment  │
                                   │   systemd timer      │  ONLY `github      │
                                   │   github poll ───────┘  ensure|deliver`)  │
                                   │   App PEM (0600), private claims/cursors  │
                                   └───────┬──────────────────────▲───────────┘
                                           │ poll comments/issues │ post replies
                                           ▼                      │ (poller only)
                                       GitHub  ◄──────────────────┘
   "@limen review" ─► poller claim ─► deliver ─► coordinator ─► `limen github review`
                                                 ─► hosted job ─► poller sees result
                                                                  ─► comments back
```

### 4.11 Relationships at a glance

| Relationship | Mechanism |
|---|---|
| Human ↔ coordinator | Chat |
| Coordinator → Limen | Shell commands (`limen …`) |
| Limen → worker | Re-exec as wrapper or supervisor, which starts the engine with explicit hooks |
| Everything ↔ everything | Files in `.limen/` (atomic rename, exclusive create, `fs.watch` plus polling) |
| Coordinator ← job | `wake.ts` file watch (Pi) or `herdr agent prompt` (OMP) |
| Coordinator → job | `steer/inbox` file read by `steering.ts` |
| Isolation | Git worktree per job, branch `limen/<id>` |
| Truth | Job files and Git. Herdr, the footer and toasts are only views of them |
| Outside world | Webhook sender script, the GitHub poller under its own Unix user, Linear (mirror only) |

### 4.12 Job directory files and their writers

| File | Writer |
|---|---|
| `task.md`, `label`, `branch`, `worktree`, `base`, `role`, `engine`, `model`, `extensions.json`, `starting`, `origin-*`, `group`, `team`, `parent`, `finish-webhook-env` | spawn via `publishJob` (`src/job/publication.ts`) |
| `state` | spawn (`running`); `finalizeJob` (terminal value) |
| `pid`, `born` | wrapper or supervisor handshake (`src/job/record.ts:108`) |
| `log` | everyone (wrapper, hooks, tab closer) |
| `activity`, `last-tool`, `tool-calls` | wrapper (detached) or `hook/hosted.ts` (hosted) |
| `session/*.jsonl` | the engine itself (`--session-dir`) |
| `result` | wrapper on exit 0; hosted `finish` tool; supervisor |
| `stop-reason`, `advisory` | wrapper or supervisor |
| `finished-at`, `commits`, `tip` | `finalizeJob` |
| `notify/*` | spawn, `watch`, `hook/wake.ts`, `coordinator-wake.ts`, sweep (`notify/seat`) |
| `steer/inbox/*` | `limen steer` |
| `steer/ready`, `claims`, `delivered` | `hook/steering.ts` |
| `herdr/*` | Herdr integration (`src/integrations/herdr.ts`) and the supervisor |
| `finish-webhook*` | `src/integrations/finish-webhook.ts` |

---

## 5. Command reference

26 top-level commands (`src/main.ts:29-55`). `keeper`, `ticket new` and
`ticket check` are not in `docs/commands.md`; they are described in `jobs.md`
and `picture.md`.

### Conventions shared by most commands

- `<id|suffix|label>`: the full job ID, a unique tail of it, or a unique label.
- Model flags (`--engine --provider --model --thinking`) are always explicit. The
  coordinator copies them from `spec/build.md`. A continuation does not inherit
  provider, model or thinking.
- `limen <cmd> --help` prints only that command's usage lines.
- Who runs it: **C** = the coordinator agent, **O** = you (the operator),
  once per project or seat, **S** = a scheduler or another process.

### The lifecycle, mapped to commands

```
  setup        plan          run            watch/fix         finish            clean
 ───────     ────────      ───────         ──────────        ────────          ───────
  init       ticket new    spawn ─────┬──► status/jobs  ┌──► keeper ──► land ──► prune
  workspace  ticket check  continue   │    diff/open    │    ticket check      prune --retire
  planning   ticket-author group start│    steer/stop ──┘                      close FNNN
                                      │    watch/wait
                                      └──► (wake on finish)
  side systems:  picture *  ·  sweep  ·  webhook test  ·  linear  ·  github *
```

### 5.1 Project setup (O)

| Command | What it does |
|---|---|
| `limen init` | Creates the files the project owns: `spec/vision.md`, `spec/build.md`, the feature lanes, `.agents/limen/styleguide.md`. Writes hook stubs to `.pi/extensions/` and `.omp/extensions/` and deletes old `limen-*.ts` copies. Never overwrites existing files. Ends with a `next:` hint and warns if the repo has no commit. |
| `limen init --drop-leftovers` | Also deletes prompt overlays that are byte-for-byte the same as the package defaults. Overlays you edited are kept. |
| `limen workspace init` | For a parent folder that is not a Git repo but holds several repos. Tickets live in the parent (`spec/workspace.md`). Jobs target one child with `spawn --repo R`. |
| `limen planning [committed\|private]` | With no argument, prints the planning source. `committed` (the default) keeps planning in Git. `private` keeps it only in the canonical root, and jobs read it by absolute path. Stored in `.limen/planning-source`. Each job keeps the setting it was spawned with. |

### 5.2 Tickets and specs (C)

| Command | What it does |
|---|---|
| `limen ticket new "what becomes true" [--lane planned\|active] [--touches id,id]` | Creates `spec/features/<lane>/FNNN-slug/ticket.md` with valid front matter. FNNN is the next number not used by any lane, any `limen/*` branch or any job label. Default lane is `planned`. Use `--touches` only with place IDs confirmed in the Picture map. |
| `limen ticket check [BRANCH]` | Runs the same ticket check `land` runs: front matter, dates, and that every `touches` ID exists in the map. Use it before a manual `git merge`. |
| `limen ticket-author <path>` | Reads Git history and prints who created the ticket (name, email, commit, and a GitHub `@login` for a noreply email). Follows renames. Writes nothing. Spawn uses it to route finish webhooks. |

### 5.3 Starting work (C)

**`limen spawn …`**

| Variant | Purpose |
|---|---|
| `spawn "instruction"` | Worker on a new branch `limen/<id>` in a new worktree. Hosted inside Herdr, otherwise detached. |
| `--tab` / `--detached` | Force hosted (needs Herdr, no `--timeout`) or force background (gets a log-tail tab). |
| `--review --detached --branch B [--base SHA] [--head SHA]` | Fresh reviewer that gives a verdict. It does not commit. `--base`/`--head` pin the range reviewed. |
| `--branch limen/<id>` (without `--review`) | Repair or resume on an existing branch and worktree, keeping uncommitted files. |
| `--repo R` | Workspace mode: run in one child repository. |
| `--role NAME` | Use a different role preamble (`worker`, `reviewer`, `picture`, `scout`, `researcher`, …). `coordinator` and `lead` are refused. |
| `--task-file F\|-` | Task text comes from a file or stdin; the positional words become the label. |
| `--label L` | Human name, change first and feature last: `"session handler · F001"`. |
| `--timeout 20m` | Detached time limit (default 90m). |
| `--prepare CMD` | Runs in the new worktree before the engine starts (for example `npm ci`). |
| `--extension PATH …` | Pi only: load these trusted local Pi extensions. |

The last line of output is the job ID. Spawn returns within seconds; a background
wrapper or supervisor owns the job after that.

**`limen continue <job> "follow-up" […]`**: resumes a finished job's conversation
(copying its session) as a new linked job in the same worktree. If the worktree
was pruned, it is rebuilt from the branch, but uncommitted work is lost. The
engine must stay the same. Can add `--review`, change the label, or replace the
extension list. From a shell with no wake route, the wake goes to the parent's
coordinator.

### 5.4 Inspecting (C)

| Command | What it does |
|---|---|
| `limen status [--all]` | The inbox: Running / Candidates to inspect (done, unlanded commits) / Needs a decision (failed or stopped, unlanded commits) / coordinator tabs. Last 7 days; `--all` includes older. An open group appears as one line. |
| `limen jobs [--running\|--active\|--all\|--label PREFIX]` | Lists job records. A table in a terminal, compact in a pipe (`LIMEN_VIEW=human\|compact`). Hides empty jobs older than 7 days unless `--all`. |
| `limen jobs <job>` | Detail: state, stop reason, model used vs requested, tokens, commits, wake result, webhook receipts, notes (blocked, errored, idle, ownership). |
| `limen diff <job>` | The job branch's diff against its base. |
| `limen open <job>` | Opens or focuses the job in a Herdr tab (a log view if the original tab is closed). |
| `limen wait <job>` | Blocks until the job ends, then prints the result. For scripts. Refused for running jobs inside a coordinator. |

### 5.5 Controlling running jobs (C)

| Command | What it does |
|---|---|
| `limen steer <job> "correction"` | Drops a message into `steer/inbox/`; the job reads it between tool calls. The first thing to try. |
| `limen steer --running "…"` | Steer every running job this coordinator watches. |
| `limen stop <job> [reason]` | TERM, then a stronger signal, to the job's process group. Marks it `stopped`. Use only after a steer was ignored or the job is clearly dead. |
| `limen watch <job>` | Subscribe this coordinator to the job's wake (use it to take over a job). For OMP it moves the job's single wake pane to yours. |
| `limen watch --running` | Subscribe to every running job (not a takeover). |
| `limen unwatch <job>\|--all` | Remove the subscription. |

### 5.6 Finishing and cleanup (C)

| Command | What it does |
|---|---|
| `limen keeper <ticket> (--job ID … \| --group GID) [--candidate BRANCH] <model flags> [--timeout D]` | Short detached job (default 20 min) that fixes spec bookkeeping (ticket front matter, board line, map links) on branch `limen/keeper-<fnnn>-<tip>` from the candidate tip. Its task includes each job's transcript and diff info. Refuses while a listed job runs. Then land the keeper job; it carries the work and the fixes. |
| `limen land <job> [--onto BRANCH] [--yes]` | Merges a done job onto the current branch (or `--onto`). The ticket check runs first; errors block and print the `keeper` command. Safe next to someone else's uncommitted files: refuses only if the merge would touch them or the index has staged changes, and aborts cleanly on failure. |
| `limen close <FNNN>` | Closes all Herdr tabs of a feature. Does nothing to jobs, branches or Git. |
| `limen prune` | Removes worktrees of finished jobs. Records stay. |
| `limen prune --retire [--dry-run]` | Deletes job records whose branch is landed (ancestor or cherry-pick) or deleted. Members of an open group are protected. |

### 5.7 Team groups (C, lead pane only)

| Command | What it does |
|---|---|
| `limen group start FEATURE --teams N --workers-per-team N --timeout D --worker-timeout D <model flags> --worker-thinking T […]` | From the lead pane (needs a live `group-peer` hook), starts N team coordinator jobs on one feature. Each team has a launch allowance and there is a fixed deadline. `--team-model team-2=prov/model`, `--team-extension` (Pi). Re-running returns the existing run; `--new-run` starts a fresh one after a failed launch. Prints the group ID last. |
| `limen group status [GID] [--json]` | Roster, deadline and minutes left, flags, member states. `--json` gives the full record, events and receipts. |
| `limen group publish [GID] [--team team-N] "finding"` | Post a finding or question. Members leave out GID; the lead supplies it. |
| `limen group wait [GID] [--timeout D]` | Wait for group events, at most 20 s per call. Idle team coordinators call it in a loop. |
| `limen group stop [GID]` | Blocks new launches and stops members. Keeps branches, worktrees and findings. Writes `stop-report.json`. |
| `limen group close [GID]` | Lets member worktrees and records be pruned again. Refuses while any member is live or uncertain, or any worktree is dirty. |

### 5.8 Picture (C; O for watch)

| Command | What it does |
|---|---|
| `limen picture build [--dir D] [--out F] [--json F] [--strict]` | Offline `map.html` from `.limen/picture/` plus tickets and the board. No model call. `--strict` exits 1 on ticket errors. |
| `limen picture serve [--dir D] [--port N]` | Serves on `127.0.0.1:4747` with a live job strip over SSE. Read-only. |
| `limen picture tick <model flags> [--dry-run]` | One refresh pass. Starts a detached `--role picture` job only when files were added, removed or renamed, or a cited file changed. |
| `limen picture watch [off \| on <model flags>]` | Installs or removes a Git `reference-transaction` hook: one tick per move of the top branch. Off by default. |

The first map comes from a hand-started `limen spawn --role picture --tab …` job.

### 5.9 Notifications (O / S)

| Command | What it does |
|---|---|
| `limen sweep` | One pass over `~/.limen/projects`: finalizes dead jobs, sends `coordinator.exited` for crashed coordinators, and (if no live coordinator hook ran recently) shows a seat notification for unheard terminal jobs and standing advisories. Each event rings once. |
| `limen sweep --install\|--uninstall` | launchd agent that runs sweep every 60 s (macOS). On Linux use the systemd units in `docs/seat/`. |
| `limen webhook test` | Sends one `webhook.test` event to this plant's finish webhook targets; one line per target, without URLs or secrets. |

### 5.10 External integrations

**`limen linear [on [--team T --project P] | off | status]`** (O): only a toggle.
It renames `spec/linear.md` ↔ `spec/linear.md.off`, or writes a fresh config.
The mirroring itself is coordinator work, following `templates/linear.md`.
Limen has no Linear API code.

**`limen github …`** (the doorbell):

| Subcommand | Run by | What it does |
|---|---|---|
| `connect` | O, in the coordinator pane | Binds this repo (from `origin`) to this live Herdr coordinator pane in `.limen/github/binding.json`. Refuses a privileged account. |
| `disconnect` | O | Removes the binding and waits for an in-flight poll. Run before moving seats. |
| `status` | O / C | Binding and latest claims and deliveries (an unverified local copy). |
| `doctor` | O | Seat safety checks (ownership, permissions, ACLs, sudoers, binaries, timer) with `FIX` lines. |
| `ensure [root]` | S (poller via sudo) | Fails unless a live, registered Herdr coordinator exists. |
| `poll` | S (systemd, `limen-github` user) | One pass: reads `@limen`/`/limen` comments and issues, checks the author's write role, records claims, hands off, posts start and finish replies. The only component that writes to GitHub. |
| `deliver <root> <claim> <nonce>` | S (poller only) | Prompts the coordinator pane with PR or issue context (marked untrusted). |
| `review <root> <claim> <model flags>` | C | Hosted review of the pinned PR head against the real base. PR claims only. |
| `work <root> <claim> <model flags> --task "…"` | C | Hosted task on a separate branch, for a PR or an issue. |
| `resolve <root> <claim> <nonce> "answer"` | C | Answer without a job; the poller posts it, never as an approval. |

### 5.11 Non-obvious points

- Nothing approves or merges by itself. `land` is the only command that merges, and the human decides when it runs.
- `stop` kills a job; `close` only closes tabs; `prune` removes worktrees; `prune --retire` removes records.
- `wait` blocks a shell; `watch` subscribes the coordinator to an asynchronous wake.
- `LIMEN_INTERNAL_RUN=1` / `LIMEN_INTERNAL_HOSTED=1` are internal entry points (wrapper/supervisor), not commands.
- The daily core is about 10 commands: `init`, `ticket new`, `spawn`, `status`, `jobs`, `steer`, `continue`, `keeper`, `land`, `prune`.

---

## 6. Design themes

- **Files and Git are the truth.** A Herdr `done` tab, a toast, or a clean exit proves nothing. Job state `done` does not mean approved or merge-ready.
- **Fails closed and records evidence.** Claims are never re-taken; receipts are separate from outcomes; ambiguous states are kept visible as `uncertain`, not guessed away.
- **No hidden workflow gates.** The harness informs; the human or the coordinator decides.
- **Judgment travels as prose.** Behavior comes from the prompts (shop manual, register, vision, styleguide); new machinery only where prose cannot reach.
- **The claim/receipt pattern repeats** in wake, steer, webhook, seat notifications and groups. Learn it once and all five make sense.
- **Not a sandbox.** Workers run with your account's permissions (`--auto-approve`). Worktrees organize work; they do not contain hostile code. The GitHub doorbell key setup is the one area that is seriously hardened (separate Unix user, root-owned binaries, narrow sudo).
