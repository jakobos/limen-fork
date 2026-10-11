# Jobs

[README](../README.md) · [Command reference](commands.md)

Use this guide to start, inspect, review, and recover coding jobs.

![A coordinator starts workers and reviewers in separate Git worktrees](https://raw.githubusercontent.com/overment/limen/main/docs/limen.gif)

## How work runs

1. Tell the coordinator the outcome that you want.
2. The coordinator shapes it with you into a change: `/dx-new`, then `/dx-frame` and `/dx-plan` under `context/changes/<id>/`.
3. The coordinator commits the change folder, so that the worker can see it.
4. The coordinator starts a job. `limen board` shows the work derived from the change files and job records.
5. Stay in that conversation. A wake comes when a job ends.

Speak only when something looks wrong, or when the coordinator asks you. The coordinator asks about product ambiguity, a real tradeoff, credentials, or a merge.

### Requests

A good request names the outcome and the first artifact. It does not describe the whole repository. The coordinator changes the request into a short spawn with a `Change:` pointer. It does not paste the plan into the prompt.

### Wakes

The type of coordinator controls how the wake comes:

| Coordinator | How the wake comes |
|---|---|
| **Pi** | The coordinator subscribes its session at spawn. The wake hook then puts the completion into that session. |
| **Herdr, without a Pi session (OMP)** | The job records the coordinator pane as `origin-pane`. When the job ends, Limen runs `herdr agent prompt` on that pane. Then Limen waits until Herdr sees the pane at work. |
| **Group lead** | A team coordinator's finish reaches the lead as a group event through `hook/group-peer.ts`. When that hook is not live for the lead session, Limen prompts the lead pane through Herdr instead, with the group status and the reload hint. Workers inside a team never wake the lead. |

For a Herdr wake, `limen jobs <id>` shows the result as `herdr-wake`: `turn observed`, `submitted …; no turn observed`, or `failed …`.

`limen continue` from a shell with no wake route (no Pi session and no Herdr pane), for example a remote executor, keeps the parent's route: the parent's coordinator gets the continuation's wake.

Both routes carry the same completion facts: the task, branch and repository, stop reason, bounded commit and final-message excerpts, and undelivered steers when present. A job with zero recorded tool calls and no commits says that it produced nothing. Missing evidence files remain absent from the wake; the route-specific next-step instruction may differ.

### Job states

| State | Meaning |
|---|---|
| `done` | The run ended cleanly. The selected engine exited 0, or a hosted session ended, and the last stop reason was not `error` or `aborted`. |
| `failed` | The run had a provider error, and Limen records the reason. A limit also records `failed` (see [Limits](#limits)). A failed job keeps its worktree and transcript. |

Failed rows use the recorded `stop-reason`, not a later webhook or tab-close log line. Rate-limit rows show the HTTP status and approximate retry minutes; `jobs <id>` retains the full provider reason. Older records without `stop-reason` use the last `failed:` or `stopped:` log entry.

**Neither state is approval.** Neither state means that the change is finished or that the branch is safe to merge, because `done` only means that the run exited cleanly. The coordinator reads the record, the diff, and the checks. Then, under the review policy of the project, it merges, or resumes a repair, or asks you.

### Reviews

When a mistake would be expensive, the coordinator starts a new reviewer on the candidate. The reviewer runs `/dx-review implementation <id>` and reports. The reviewer does not change the branch. The coordinator files the report as `context/changes/<id>/reviews/implementation.md` on the branch; a repair job runs `/dx-review-triage`.

## What the coordinator runs

These commands are the harness. The coordinator types them. This list helps you recognize a job ID, a wake, or a recovery step. It is not a daily script.

```bash
# Start a worker
limen spawn --engine <engine> --provider <provider> --model <model> --thinking <level> \
  --label "session handler · auth-restart" \
  'Implement auth-restart: run /dx-implement --manual until ## Progress is done. Start with the failing session test. Change: context/changes/auth-restart/'

# Change pointers accept whitespace after Change: and strip closing sentence punctuation.

# Inspect
limen status
limen jobs
limen jobs <id|suffix|label>
git diff HEAD...<branch>

# Review
limen spawn --engine <engine> --provider <provider> --model <model> --thinking <level> \
  --review --detached --branch limen/<job-id> --label "session handler review 1 · auth-restart" \
  'Run /dx-review implementation auth-restart. Change: context/changes/auth-restart/'

# Correct, stop, repair, or continue
limen steer <id> "stay on the session test; do not widen"
limen stop <id> "reason"
limen spawn --engine <engine> --provider <provider> --model <model> --thinking <level> \
  --branch limen/<job-id> --label "session handler repair 1 · auth-restart" \
  'Run /dx-review-triage auth-restart implementation; fix the Blocker findings. Change: context/changes/auth-restart/'
limen continue <id> 'Follow-up instruction'

# Follow and land
limen watch <id|label>
# When the work changed a change file, fix it on a keeper branch first, then land the keeper job
limen keeper context/changes/auth-restart/ --job <id> \
  --engine <engine> --provider <provider> --model <model> --thinking <level>
limen land <id>

# Close
/dx-archive auth-restart                   # in the coordinator, after the land
limen drop auth-restart "reason"           # or: stop the work and archive it as dropped
limen board                                # NOW / NEXT / RECENT, derived from change files and jobs
```

### Job IDs and labels

- **Job ID:** The last line of `spawn` output is the durable job ID.
- **Labels:** A label names the change in plain words first and ends with ` · <change-id>`. A follow-up for two changes names both: `token refresh · auth-restart session-store`. A repair label or a review label names its round. The job ID and the agent name take the first change id.
- **Hosted labels:** Ordinary text such as `Fix the lead-in paragraph · docs-intro` is allowed. Lead ownership comes from the coordinator pane, not the label; `--role coordinator` and `--role lead` remain refused.
- **Group labels:** Team jobs read `team-2 coordinator · quality-scan`, so jobs on the same change remain distinct.

### Steer, stop, and resume

Use these steps in this order:

1. **Steer.** A running job reads a steer between tool calls.
2. **Stop.** Stop a job only after it ignores a steer, or when it is clearly dead. Stop sends TERM, and then a stronger signal.
3. **Resume.** A resume uses the same branch and worktree, with the uncommitted files, so the coordinator reads that state first.

### Watch and land

- **Watch:** To take over a job that another coordinator started, watch that job by name. `watch --running` subscribes to every running job, but it is not a takeover.
- **Land:** `limen land` merges a `done` job onto the current branch. Read [Job states](#job-states) first.
- **Change check on land:** before it merges, `limen land` checks every change and effort file the branch adds, moves or changes, at the branch tip, including `touches` against the plant map's place ids. An error refuses the land and prints the `limen keeper` command that fixes it. A warning prints and does not block. Without a map, land skips the place ids and says so. `limen change check <branch>` runs the same check before an ordinary `git merge`.

### Change keeper

`limen keeper <context/changes/<id>/|context/efforts/<id>/> (--job <id> [--job <id> …] | --group <id>) [--candidate <branch>]` starts a short detached job (default timeout 20 minutes) that fixes the change files of finished work and the map sources that cite them. `--group` adds every member job of that group. The coordinator starts it; no hook does.

- It refuses while a listed job is still running, so it never races a worker. In a group, only the lead starts it.
- It creates `limen/keeper-<id>-<sha7>` at the candidate tip: the single job's branch, or `--candidate` for several jobs on one integration branch. The keeper commits only there.
- It checks that a folder name matches its `change_id`, that `status: implemented` has every `## Progress` box ticked, that an archive entry has `archived_at` and `status` `archived` or `dropped`, that roadmap slices name existing changes, and that map links to changes resolve.
- Its task is a packet: the change and map paths, the candidate, the changed change files, the current land check, and per job the label, state, branch with base and tip, worktree, session transcript and task. Both engines write the transcript as `.limen/jobs/<id>/session/<time>_<uuid>.jsonl`; the packet names the newest one.
- The keeper edits only `context/changes/**`, `context/efforts/**`, and map files that cite a changed change. Map edits apply in place and do not land.
- Land the keeper job: it carries the work and the fixes. If the keeper commits nothing, land the original job.

### Finished jobs

Finished jobs keep their files in `.limen/jobs/`, but not their worktrees. The next spawn removes finished worktrees. A resume with `--branch` keeps that worktree.

| Command | Effect |
|---|---|
| `limen prune` | Removes finished worktrees, as the next spawn does. |
| `limen prune --retire` | Deletes finished, failed, or stopped job records whose branch is landed (ancestor or cherry-pick) or deleted. |
| `limen prune --retire --dry-run` | Prints the IDs and removes nothing. |

Spawn and sweep never retire records.

### Continue a finished job

To keep the conversation of a finished job, run:

```bash
limen continue <job-id> "Follow-up instruction"
```

Limen copies the saved session into a new linked job. The new job keeps the worktree safe from prune. If prune removed the old checkout before then, Limen restores it at the recorded path from the local branch. If Limen cannot create the new job, the parent job and its saved session do not change.

**Only committed branch contents come back.** Uncommitted files that prune removed are lost. Recovery is not possible without the branch or the transcript. Limen does not take over a branch that is checked out in a different place.

### Limits

| Limit | Detached job | Hosted job |
|---|---|---|
| Time | 90 minutes (change it with `--timeout 20m`) | None |
| Tool-start events | 900 (`LIMEN_MAX_TOOL_CALLS`) | None |

**Stalled tools.** Detached jobs retain the three-minute CPU-idle tool containment rule; `LIMEN_TOOL_STALL_MS` changes that confirmation time. Hosted observation never signals an engine or its children: a quiet external wait is not proof of a stuck tool. Explicit stops and configured group deadlines still apply.

**Hosted ownership.** On Linux, Limen checks that a hosted Pi job still owns its pane. While it does, the job shows no ownership note. A pane reload keeps that proof, and a reload is not completion. When Limen loses the proof, the job shows an `ownership` note. See [How it works](#how-it-works) for what counts as proof.

**Engine and platform limit.** Only hosted Pi on Linux binds its pane. Hosted OMP jobs, and every hosted job on macOS, never bind, so Limen cannot prove which process owns their pane. They get an ownership note only when their pane moves to a place Limen cannot verify; the absence of a note is not proof of ownership.

**Job notes.** A running row in `limen jobs` and `limen status` names the kind of its note: `blocked`, `errored`, `idle`, or `ownership`. A healthy running job shows no note. A blocked, errored, or idle note hides an ownership note. An ownership note appears when a bound job loses its ownership proof, or when its pane moves to a place Limen cannot verify. When an ownership note stays for one minute, each coordinator that follows the job gets one wake about it. The note clears when the job ends or Limen proves ownership again.

### Seat notifications

`limen sweep` scans registered projects for terminal jobs that nobody heard, hosted-stall advisories and persistent ownership uncertainty. A running job's notification title names its note kind, for example `limen: fix login · blocked`. Changes to an unresolved uncertainty diagnostic keep the same seat receipt and do not ring again. Each event gets one seat notification, also across restarts and concurrent sweeps. Old timestamp receipts stay valid. When an advisory clears and a new one starts, the new one can send a notification again.

If a notification fails in an unclear way, the sweep logs an error and does not send that event again automatically. Seat notifications do not use up coordinator wakes or finish webhooks.

## Change authorship

`limen change-author` shows the name, email, and commit that first added a change. It takes a change folder, its `change.md`, or an effort's `effort.md`. Collaborators who share a project can run it:

```bash
limen change-author context/changes/auth-restart/
```

It follows renames, such as the move into `context/archive/`, when Git recognizes them. Paths are relative to the current directory. Absolute paths in the repository also work. The lookup reads the committed `HEAD` of the current branch. It never reads the Git config or the GitHub session of the current operator, and it writes nothing.

### What the result means

The result is the **author** of the creation commit. It is not the committer or the latest editor. It is **evidence from Git, not a verified human identity**. Shared bot credentials identify the bot, not the person who asked the bot to create the change. So if collaborators need different attribution, use different authors on the commits that add changes.

For a GitHub noreply email, the lookup also gives the recorded login. A usual email is still a usable identity, without a GitHub account or network access. Spawn records that creation `@login` on the job for finish routing. If no login is available, spawn records the reason.

### When authorship is not available

For uncommitted paths and shallow history, the lookup says that authorship is not available. It does not guess. So commit a new change before you look it up, and fetch the full history for a shallow clone.

A move that Git cannot recognize, a squash, or changed history can lose the original attribution. If you delete a path and create it again, a new history starts. Limen adds no author tags to change Markdown.

## Recovery

The coordinator does this. You need it only if you look at a stuck tab yourself.

| Symptom | Safe next step |
|---|---|
| The job is quiet or repeats itself | Read `limen jobs <id>`, the log, and the worktree. Stop only on evidence. Then resume with a narrower task. |
| The worker has a real question | Read its durable note. Answer it. Resume the branch. |
| The wrapper is dead, but the state says `running` | Check the recorded PID. Correct the plain `state` file. Then resume. |
| A completion wake did not come | Read `.limen/jobs/` and Git. The job files stay the source of truth when a notification does not come. |

## How it works

You do not need these mechanics to run jobs. They explain the notes and records above.

- **Binding:** the launch record of a hosted Pi job on Linux. At launch, the Pi hook writes exclusive records of the controlled launch, the canonical job and session, the initial pane, the shell parent, the engine PID and start time, and the boot ID (the kernel's ID for the current boot). Reload keeps the binding.
- **Ownership proof:** the check that the bound job still owns its pane. It needs the saved process identity and a fresh check that this exact PID is in the foreground of the current verified pane. Visible launch arguments do not count. A foreign session, an old record with only a PID, a failed pane query, or a pane move that Limen cannot verify leaves the job unowned.
- **Ownership wake:** the wake about a standing `ownership` note. After one minute, each subscribed recipient can receive one confirmed wake for that condition. Its recipients share at most two unsuccessful attempts. The wake waits for an idle recipient; it never queues text into a running turn as a follow-up. Tool and thinking changes and supervisor recovery keep the original timestamp and receipts. Only proven recovery rearms the wake; engine recovery alone cannot clear an unavailable child observation. Real failures and completion use separate wake allowances. A terminal state retires the condition.
- **Publication:** how spawn and continue create a job. Limen writes the complete starting record in a hidden directory, then publishes it with one rename. A publication failure removes the hidden record and leaves the parent record and saved session unchanged.
- **Seat receipt:** the job file `notify/seat`. The sweep writes it before it sends a notification, so one event rings once, also across restarts and concurrent sweeps.
