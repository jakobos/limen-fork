# Limen — high-level granularity plan

Personal study notes. A proposal for restructuring Limen into a small kernel plus
replaceable modules (specs workflow, context injection, surface, notifications,
forge, picture, model policy). Builds on `local/overview.md`. File references are
from a read-only trace of `src/` and `hook/` at the time of writing.

Contents:

1. [Where the coupling actually is](#1-where-the-coupling-actually-is)
2. [Target shape: kernel + ports + modules](#2-target-shape-kernel--ports--modules)
3. [Ports](#3-ports)
4. [Lifecycle events](#4-lifecycle-events)
5. [Configuration and layout](#5-configuration-and-layout)
6. [The prompt problem](#6-the-prompt-problem)
7. [Suggested order](#7-suggested-order)
8. [Open questions](#8-open-questions)

---

## 1. Where the coupling actually is

```
 spec layout hardcoded ("spec/features", "spec/build.md", "spec/vision.md")
 ───────────────────────────────────────────────────────────────────────────
  src/commands/land.ts      ticket check, board lint, AND a test/ line cap
                            read from vision.md  ◄── Limen's own repo policy
                                                     leaking into the product
  src/commands/keeper.ts    ticket path regex, "Board: spec/build.md"
  src/commands/group.ts     feature must live under spec/features/
  src/commands/spawn.ts     spec/ paths checked against the base commit
  src/commands/github.ts    the delivery prompt says "read spec/build.md"
  src/commands/init.ts      scaffolds the whole spec tree
  src/picture/{board,tickets}.ts, src/project/{planning,picture-tick}.ts
  hook/communication.ts     VISION_FILE, STYLE_FILE, board digest

 herdr imported directly by 20 files: record.ts, reap.ts, supervisor.ts,
 spawn, stop, status, jobs, diff, open, close, group, github, wake.ts, hosted.ts ...
```

The **specs workflow** and the **visual surface** are spread through the kernel.
Those are the two seams that need fixing first. The others (GitHub, picture,
notifications) are already fairly self-contained.

---

## 2. Target shape: kernel + ports + modules

```
                ┌────────────────────────────────────────────────┐
                │                   limen CLI                    │
                │  command registry: kernel cmds + module cmds   │
                └───────────────────────┬────────────────────────┘
                                        │
 ┌──────────────────────────────────────▼───────────────────────────────────┐
 │ KERNEL  (not replaceable; it's what Limen *is*)                           │
 │                                                                           │
 │  cabinet      job record, publish/finalize, lookup, claim/receipt prims  │
 │  runtime      wrapper, supervisor, reap, contain, stream parser          │
 │  engines      omp | pi adapters (EnginePort; arguably a module too)      │
 │  git          worktree, branch, land mechanics (merge only, no policy)   │
 │  lifecycle    emits events: job.published, job.finalized, land.before,   │
 │               land.after, ref.moved, turn.start, tool.result             │
 │                                                                           │
 │  PORTS:  Planning · Context · Surface · Notify · Forge · Map · Policy    │
 └───┬────────┬─────────┬─────────┬─────────┬─────────┬─────────┬───────────┘
     │        │         │         │         │         │         │
 ┌───▼───┐┌───▼────┐┌───▼───┐┌────▼───┐┌────▼───┐┌────▼───┐┌────▼────┐
 │specs- ││context-││herdr  ││webhook ││github  ││picture ││board-   │
 │classic││classic ││       ││seat-   ││doorbell││        ││models   │
 │       ││        ││(or    ││bell    ││        ││        ││         │
 │tickets││shop    ││tmux,  ││ntfy    ││(or     ││        ││(or env, │
 │lanes  ││manual, ││none)  ││        ││gitlab) ││        ││ config) │
 │board  ││register││       ││        ││        ││        ││         │
 │vision ││style-  ││       ││        ││        ││        ││         │
 │keeper ││guide   ││       ││        ││        ││        ││         │
 └───────┘└────────┘└───────┘└────────┘└────────┘└────────┘└─────────┘
   groups  ── a module too: it builds on the cabinet, but nothing in the kernel needs it
```

**Dependency rule:** modules depend on the kernel, never on each other. When one
module needs another, it asks the kernel for an *optional capability*.

```
   specs-classic ──✘──► picture          (today: ticket check validates
   specs-classic ──►  kernel.capability("map")?.hasPlace(id)    `touches` IDs
                              │                                 against the map)
                              └─ absent? skip the check, emit "info: no map module"
```

---

## 3. Ports

### 3.1 Planning (the specs module)

The one most worth making swappable. Today it covers tickets, lanes, the board,
vision, the keeper and the land ticket check.

```
 interface PlanningPort {
   resolve(ref)            → WorkItem { id, title, path?, url?, state }
   allocateId()            → "F042"            // ticket new
   create(outcome, opts)   → WorkItem
   landChecks(branch)      → Diagnostic[]      // error blocks, warn informs
   bookkeepingTask(items, jobs) → string | null   // what keeper does; null = no keeper
   contextFragments(aud)   → Fragment[]        // vision/board digest, see 3.2
   promptSection(role)     → string            // see section 6
   commands                → { ticket, ... }   // CLI contributions
   scaffold(root)          → files for `limen init`
 }
```

Possible replacements:

```
  specs-classic     spec/features/{planned,active,done}/FNNN/ticket.md + build.md
  specs-issues      WorkItem = GitHub issue; landChecks = "PR references #N"
  specs-linear      WorkItem = Linear ticket (today only a mirror, done as prompt work)
  specs-adr         docs/adr + one-line backlog; no lanes, no keeper
  specs-none        resolve() returns a free-text task; landChecks = []
```

**Acceptance test for the seam:** `specs-none` must work. If the kernel runs
without any planning module, the seam is real.

### 3.2 Context (what the injection hooks do today)

`hook/communication.ts` currently mixes three concerns:

- the **mechanics** of injection: stable prefix, per-turn cue, tool-result reminder
- the **content**: AGENTS, register, vision, styleguide, board
- the **audience rules**: coordinator vs worker

Split them into a host plus fragment providers:

```
                 hook/context-host.ts  (kernel; the only hook that injects)
                          │
       asks each module:  fragments(audience, cwd)
                          │
   ┌──────────────────────┼─────────────────────────────────────┐
   ▼                      ▼                                     ▼
 context-classic       specs-classic                         groups
 ┌──────────────┐      ┌───────────────────────┐            ┌──────────────┐
 │shop manual   │ S    │vision      (coord)  S │            │member events │ T
 │register      │ S    │vision ptr  (worker) S │            └──────────────┘
 │styleguide    │ S    │board digest(coord)  V │
 │style reminder│ R    │Ticket: ptr (worker) T │
 └──────────────┘      │spec-edit reminder   R │
                       └───────────────────────┘

 tier:  S = stable prefix (cached)   V = volatile tail of system prompt
        T = per-turn hidden cue      R = tool_result reminder (with a trigger glob)

 host assembles:  [ all S, ordered by priority ] [ all V ] ; T per turn ; R on match
```

```ts
type Fragment = {
  id: "specs.vision";
  audience: ("coordinator" | "worker" | "reviewer" | string)[];
  tier: "stable" | "volatile" | "turn" | "reminder";
  priority: number;          // order inside the tier = cache stability
  trigger?: string[];        // globs, for the "reminder" tier
  text: () => string | undefined;
};
```

The cache-ordering knowledge stays in the host, written once. Modules only
declare tiers. Users can disable a fragment (`"disable": ["specs.board-digest"]`)
or replace it without forking the hook.

### 3.3 Surface (Herdr)

```
 interface SurfacePort {
   openTab(job) / closeTab(job) / focus(job)
   promptPane(pane, text, {waitUntil})   // OMP wake route
   agentStart(pane, argv) / agentStatus(pane)  // hosted supervisor
   identifyCaller() → { paneId? }        // HERDR_PANE_ID today
   supportsHosted: boolean
 }

   herdr    ── full
   tmux     ── tabs = windows, prompt = send-keys, hosted = yes
   none     ── supportsHosted=false → spawn forces --detached;
               OMP wake needs a hook-based route, or falls back to the seat bell
```

The most expensive extraction (20 files). It's also where "files are the truth"
pays off: the cabinet never depended on Herdr for *truth*, only for *delivery*.

### 3.4 Notify, Forge, Map, Policy

```
 Notify   sinks subscribe to lifecycle events; each keeps its own receipt dir
          (already true: finish-webhook, coordinator-signal, seat bell)
          → just formalise:  on("job.finalized", sink) + receipts/<sink>/

 Forge    inbound:  poll → Claim (untrusted)  → deliver to coordinator
          outbound: reply(claim, text), review(claim) → spawn args
          github today; gitlab / gitea later. Trust boundary stays module-owned.

 Map      picture: build/serve/tick/watch + capability "map" { hasPlace(id) }

 Policy   "which engine/model/thinking for role X". Today it's prose in
          spec/build.md that the coordinator copies into flags. That's planning
          content and runtime config fused into one file. Make it its own small
          port, so that replacing specs doesn't lose model policy.
```

---

## 4. Lifecycle events

How modules hook in without editing the kernel:

```
 limen spawn ──► publish ──► [job.published] ──► surface.openTab, notify.subscribe
                   │
 wrapper/super ──► run  ───► [job.started]
                   │
 finalizeJob ────────────► [job.finalized] ──► wake, webhook, surface.settleTab,
                   │                            groups.syncLifecycle
 limen land ─────► [land.before] ─► planning.landChecks + other gates → Diagnostic[]
                   │                 (error = refuse + print the fix command)
                   merge
                   └───► [land.after]  ─► map tick, specs move-to-done?, forge reply
 git ref hook ───► [ref.moved]     ─► picture.tick
```

Two ways to implement the bus:

```
  A) in-process        modules = TS files loaded by main.ts from config
                       + fast, typed, easy for context fragments
                       − a broken module breaks every command

  B) out-of-process    modules = executables; events = files in .limen/events/
                       (the claim/receipt pattern already exists)
                       + fits "files + git + one CLI", language-agnostic,
                         failures stay isolated and recorded
                       − slower; context injection can't wait on a subprocess per turn

  Hybrid (preferred): in-process for synchronous ports (Planning, Context,
  Surface, Policy); file events + receipts for async sinks (Notify, Forge,
  Map refresh). That matches what's already there.
```

---

## 5. Configuration and layout

```
 .limen/modules.json   (committed: it's project policy, like the board)
 {
   "planning": "limen:specs-classic",        // or "./tools/limen-issues.ts"
   "surface":  "limen:herdr",                // "limen:tmux" | "none"
   "policy":   "limen:board-models",
   "context":  { "use": ["limen:context-classic"], "disable": ["specs.board-digest"] },
   "notify":   ["limen:finish-webhook", "limen:seat-bell"],
   "forge":    ["limen:github"],
   "map":      "limen:picture",
   "groups":   true
 }

 repo layout
 ├─ src/kernel/      cabinet/ runtime/ engines/ git/ lifecycle/ ports.ts
 ├─ modules/
 │   ├─ specs-classic/   index.ts  commands/ticket.ts  land-checks.ts  keeper.ts
 │   │                    fragments.ts  templates/  (spec tree, ticket template)
 │   ├─ context-classic/ fragments.ts templates/agents.md register.md styleguide.md
 │   ├─ herdr/  tmux/  picture/  github/  groups/  finish-webhook/  seat-bell/
 └─ hook/context-host.ts  wake.ts  steering.ts  hosted.ts   (kernel hooks only)
```

- `limen init` creates the kernel files, then asks every configured module to `scaffold()`.
- `limen --help` lists kernel commands followed by module commands, grouped by module.

Kernel vs module commands (first cut):

| Owner | Commands |
|---|---|
| kernel | `spawn`, `continue`, `steer`, `stop`, `jobs`, `status`, `diff`, `land`, `prune`, `watch`, `unwatch`, `wait`, `sweep`, `init` |
| specs-classic | `ticket new`, `ticket check`, `ticket-author`, `keeper`, `planning`, `workspace init` |
| herdr | `open`, `close` |
| picture | `picture build/serve/tick/watch` |
| groups | `group start/status/publish/wait/stop/close` |
| github | `github *` |
| finish-webhook | `webhook test` |
| linear (mirror) | `linear` |

---

## 6. The prompt problem

"Judgment travels as prose." Much of the specs workflow lives in
`templates/coordinator.md`, the shop manual, the keeper prompt and the GitHub
delivery text, not in TS. Swapping the planning module without swapping that
prose leaves a coordinator that still says "open spec/features/active/...".

```
  role prompt = kernel core        (how to spawn, steer, land; claims; wake)
              + module sections    ← planning.promptSection("coordinator")
              + project overlay    (.agents/limen/<role>.md, as today)
```

Each port contributes **prompt sections**, not only code. This is probably the
most important design decision: if it's done badly, "replaceable specs" exists
only on paper.

---

## 7. Suggested order

Limen is a minimal tool, so pay for seams only where they're needed.

```
 1. Internal seam, no plugin API:   move all spec/ knowledge into src/planning/
                                    behind PlanningPort. Delete the vision.md
                                    test-cap check from land (move it to a
                                    project-local land gate). Prove specs-none.
 2. Context fragments:              split communication.ts into host + fragments.
 3. Prompt sections:                templatise coordinator/worker prompts per port.
 4. Lifecycle events:               land.before/after, job.finalized fan-out.
 5. Surface port:                   extract herdr (largest diff), add "none".
 6. modules.json + external loading: only once 1–5 have stable shapes.
```

---

## 8. Open questions

1. **What's in the kernel?** Is the engine (omp/pi) a module or core? Are groups
   core (they reuse the cabinet heavily) or a module?
2. **Granularity:** do users replace a whole module (`planning: specs-issues`),
   or override slots inside one (keep tickets, drop the board, drop the keeper)?
   Slots are friendlier but multiply the contract surface.
3. **Is the land gate allowed to block?** "No hidden workflow gates" suggests
   gates should be declared in `modules.json` and listed by
   `limen land --explain`, rather than shipped silently by a module.
4. **Trust:** modules run in-process with your permissions. Is that fine for
   local `./tools/*.ts`? The GitHub poller's isolation is the exception, and it
   should stay owned by the forge module.
