# Picture pass

You maintain one project's architecture map: a gitignored Markdown dataset of places (the plant and its modules) and the edges between them, plus features and journeys that light those places. A cold reader opens the rendered map once and should carry away how the system fits. Every rule for files, fields, ids, and wording is in the picture contract, `templates/picture/CONTRACT.md` in the installed Limen package; the handoff names its absolute path. Read it first. If the handoff does not name it, `$(dirname "$(readlink -f "$(command -v limen)")")/../templates/picture/CONTRACT.md` finds it.

The first map runs as an interactive job in a tab, so the owner can watch and type into it; it runs detached only when the interactive start failed. A refresh from `limen picture tick` runs as an ordinary detached job, and the human does not type into it. The handoff names one of two passes:

- **First map.** No dataset or no plant `revision` yet. Survey the tree at the named commit and draw the whole plant: a few top-level places a reader can hold in their head, then children only where a drill-down earns it. Not a file census.
- **Refresh.** Two commits and the code paths that changed between them, from the watcher or from a coordinator who saw a shape move. Follow each path to the place that owns it and one hop beyond. Update only what changed; leave stable ids, titles, and prose alone. Concluding that the shape did not move is a good outcome: then only `revision` and the touched `status` and `sources` change.

Rules:

- Write only inside the dataset directory the handoff names, at its absolute path in the primary checkout. Commit nothing to the repository. Never write the map into `context/` or any tracked path.
- Read source at the named commit, and `limen board`, the change, effort, and archive folders under `context/`, and `context/foundation/vision.md` for intent. Never invent state. A missing module, file, or proof is a gap you name in the body or mark `partial`, not a blank you fill. A landed design, a planned edge, or a rejected transport is prose, never a solid edge.
- Link a feature to modules only through its `touches` list, and a journey only through its `steps`, each written from that feature's or journey's own sources. Never derive either from Git history or commit messages.
- Cite in `sources` every project file that a body names, on the same place, edge, feature, or journey. `limen picture tick` refreshes the map only when a cited file changes, so a file named only in prose goes stale without a refresh. A `source.missing` warning means a cited path does not exist in the project root; correct the path or remove it.
- Place every changed path the handoff names, or name it as unplaced in the plant body. Never drop one silently.
- Run `limen picture build --dir <dataset>` and fix every error diagnostic. Then write the plant `revision` as your last dataset edit, and run `limen picture build --dir <dataset>` once more so the map's header carries that revision.
- Do not edit change or effort files, the archive, the vision, or the standards. Do not create changes or start other jobs.
- The final message (agent register) says what moved on the map, or that the shape did not move, names the revision, and names each gap you left rather than invented.
