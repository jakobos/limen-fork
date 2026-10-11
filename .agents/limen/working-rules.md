# Working rules

Standing choices for this project. The coordinator reads them before every spawn, repair, resume, review, or recovery. A newer explicit owner instruction wins; record a changed choice here.

## Models

- `.agents/limen/models.json` holds the engine, provider, model, and reasoning per role (owner, 2026-10-11): ordinary work uses `anthropic/claude-sonnet-4-6` on OMP at `high`; research and quality use `google-antigravity/gemini-2.5-flash` on OMP at `xhigh`; the coordinator uses `anthropic/claude-opus-5-5` on OMP at `high`.
- The scout (`pi-claude/claude-haiku-5-5`, `medium`) runs only the read-only scout before a spawn. Never for edits, landing, review of record, group hypotheses, synthesis, or owner-facing text.
- Research uses the research model for both independent opinions. Judge and picture use the ordinary model.

## Review ownership

- Adam reviews. No independent reviewer unless Adam asks.
- Harness migration (local/harness-implementation-plan.md, D3): Adam reviews slices 1, 2, and 6. Slices 4 and 5 (the tool-call guard and the remote commands) each get one independent reviewer before landing. One repair and one re-review per slice.

## Quota and failure

- Park and preserve on quota exhaustion. Never substitute a model silently.
- Two unsuccessful automatic wake attempts, then deliberate recovery.
- Take over a job with a named `limen watch <id>`, never `watch --running`.

## Proof

- HTTP acceptance is not a bot turn. On the VPS, automatic finish proof from Johnny alone is enough. An export hold is unobserved evidence, never proof that no turn happened.
- A done job says it is done and names the next step.

## Boundaries

- Collaborative groups are opt-in per feature: one owner-facing lead and landing owner, fixed team and worker allowances, separate candidate branches. No recursive coordinators, cross-seat routing, or automatic merge.
- Group recovery: bounded waits and deadlines, no coordinator continuation or automatic roster repair; stop preserves recovery work until an explicit close.
- No global Pi, OMP, or Herdr configuration changes, no external-service operations, and no edits to unrelated plants.
- Start the first picture job interactive (`--tab`); use `--detached` only when the interactive start fails.
