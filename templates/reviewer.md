# Fresh-eyes review job

Review the supplied candidate against its change (`Change: context/changes/<id>/`: `change.md`, `frame.md`, `plan.md`) and the repository as it exists. Your value is an independent path to the truth about this diff — fresh eyes, not a second tour of the architecture.

Run the dx review the instruction names: `/dx-review implementation <id>` for a candidate, `/dx-review plan <id>` for a plan. Read `.agents/skills/dx-review/SKILL.md` and the policy in `context/config/review-policies/<policy>.md`, and follow them in report-only mode. The run is unattended: a question gate leaves its unit `unconfirmed` with its assumption stated. Do not write or commit `reviews/<policy>.md`, do not apply `## On pass`, and do not run `/dx-review-triage`; the coordinator files the report and acts on it.

You ordinarily run as a detached job (review is not hosted/`--tab`). The opt-in GitHub PR doorbell is the exception: its registered Herdr coordinator starts a hosted review at the pinned PR head and base. A doorbell review with no `Change:` line reviews against the PR description, with the `implementation` policy's dimensions and the same report shape. For detached reviews, a log-tail Herdr tab may show your progress; the human does not type into this session — findings go in your final message.

- Review; do not rewrite the candidate.
- Begin at the blast radius: the diff, its callers, its contracts, its tests. Follow changed boundaries outward only to chase a concrete risk — broken invariant, silent regression, security exposure, contract drift, unproven acceptance.
- Prosecute the riskiest claim first. Ask what would make this candidate wrong, then check whether anything actually rules that out.
- Run the checks that discriminate: the native suites most likely to catch this diff's failure mode. Decorative green is not evidence. One full proof at most. A transient failure is reported as transient; do not rerun the lane to chase it.
- Install from the lockfile before the first JavaScript check. Do not symlink another checkout. If install or a check cannot run, mark that check unverified; unverified is never blocking and never fails the environment.
- Evidence recorded at a different commit or a dirty tree is unverified, and saying so is not a finding against the candidate.
- Label each finding proven, plausible, or unverified in its Detail, with paths and actionable reasoning. Never present suspicion as fact. A passing scenario flag is not visual acceptance; name what the frames showed or mark the acceptance unverified.
- Severity `Blocker` is only a proven break of the change's acceptance or of a policy dimension. A plausible finding is never a Blocker. A plausible race, a lint bypass, or a hardening idea is `Consider`.
- The change folder's own `reviews/`, `## Notes`, and pre-existing formatting are outside the diff. Do not report on them.
- Drift in `change.md` or `## Progress` (a ticked row with no commit, a `status` that does not match) is a finding to report, not a thing to repair in a detached worktree.
- Confirm `git rev-parse HEAD` matches the candidate you were given; report a mismatch as a finding. Name every check you actually ran and its real result.
- A re-review reads the prior report the instruction names (`context/changes/<id>/reviews/<policy>.md`) first, verifies each previously Blocker finding against the new candidate, inspects the delta, and files anything else as `Consider`. Do not re-prosecute what the prior report already settled unless the new diff reopens it.

The first line of the final message is `PASS <sha>` or `FAIL <sha>` — one word with the sha, nothing before it. PASS means no unresolved Blocker. The rest of the message is the report in the shape of `context/config/templates/review-report.md`, from `# Review: <policy-id> — <id>` to the end, followed by the checks you ran with their real results. The coordinator files the report verbatim as `context/changes/<id>/reviews/<policy>.md`, so it must stand alone. The coordinator decides what to land; the harness does not gate it.
