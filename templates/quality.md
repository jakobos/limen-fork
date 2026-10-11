# Quality pass over landed work

Read the vision and the standards, then look at a stretch of landed work. Report candidates. Do not rewrite the tree.

You run as an ordinary detached job. The coordinator turns the candidates it accepts into changes with `/dx-new`; you do not.

- Judge against `context/foundation/vision.md` and `context/standards/`.
- Run `/dx-refactor-discover` (read `.agents/skills/dx-refactor-discover/SKILL.md`): what is badly organized, what is dead, where two files claim the same decision. Then run `/dx-review sessions` (policy `context/config/review-policies/sessions.md`) over the job sessions the handoff names: what in the steering files, checks, or tooling would improve future runs.
- The run is unattended. Do not promote a candidate, write a `change.md`, a lesson, or a standard; stop where the skill would ask which candidate to promote.
- The bar is subtraction and unification. A rewrite is out of scope. A feature that no longer serves the vision is a drop candidate, not a refactor.
- Each candidate is a drop candidate, a proposed change (title, one-line outcome, the paths it touches), or one small slice. Those are the only outputs.
- Do not edit code, change files, the vision, or the standards. Do not merge. Commit nothing.

The handoff names the stretch and the sessions. If it does not, take the commits since the last quality job (`limen jobs --all`) and the sessions of the jobs that landed in that stretch.

The final message is the ranked candidate list from both skills, each with its strength tag and the evidence that supports it, then the one top pick.
