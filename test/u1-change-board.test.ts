// U1: change front matter faults each give the file, the line and a fix; the board derives NOW, NEXT and RECENT from
// status and job records. `limen change check`, land and `limen board` read these.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	type ChangeRecord,
	checkTouches,
	closedChanges,
	deriveBoard,
	readChanges,
	renderBoard,
} from "../src/project/changes.ts";

const change = (id: string, status: string, extra = "") =>
	`---\nchange_id: ${id}\ntitle: ${id} title\nstatus: ${status}\ncreated: 2026-10-01\narchived_at: null\n${extra}---\n`;
const folders: Record<string, string> = {
	"changes/place": change("place", "planned", "touches: [plant.viewer, plant.misspelled]\n"),
	"changes/fields": change(
		"fields",
		"implementing",
		'opened: 2026-02-30\nneeds-owner: "First\\nsecond"\nwrong: This is wrong.\nwrong-on: 2026-10-06\n',
	),
	"changes/flags": change("flags", "new", "needs-owner: Decide today.\nwrong-on: 2026-10-05\n"),
	"changes/renamed": change("other", "new"),
	"changes/legacy": "# Legacy change\n",
	"changes/dupes": change(
		"dupes",
		"new",
		"touches:\n  - plant.viewer\n  - plant.viewer\nneeds-owner: Keep?\nneeds-owner-on: 2026-10-05\n",
	),
	"changes/stray": change("stray", "dropped"),
	"archive/2026-10-02-old": change("old", "implemented"),
	"archive/2026-10-03-gone": change("gone", "dropped").replace("archived_at: null", "archived_at: 2026-10-03"),
	"efforts/pay": "---\neffort_id: pay\ntitle: Pay\nstatus: in-progress\n---\n",
};

test("each change fault is reported at its own file and line with a fix, and the valid fields still load", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "u1-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	for (const [folder, text] of Object.entries(folders)) {
		await mkdir(join(root, "context", folder), { recursive: true });
		await writeFile(join(root, "context", folder, folder.startsWith("efforts") ? "effort.md" : "change.md"), text);
	}
	const read = await readChanges(root);
	const diagnostics = [...read.diagnostics, ...checkTouches(read.records, new Set(["plant.viewer"]))];
	const at = (level: string, code: string, folder: string, line: number) =>
		`${level} ${code} context/${folder}/change.md:${line}`;
	assert.deepEqual(diagnostics.map((d) => `${d.level} ${d.code} ${d.source}:${d.line}`).sort(), [
		at("error", "change.archive", "archive/2026-10-02-old", 4),
		at("error", "change.archive", "archive/2026-10-02-old", 6),
		at("error", "change.archive", "changes/stray", 4),
		at("error", "change.bad-field", "changes/dupes", 9),
		at("error", "change.bad-field", "changes/fields", 7),
		at("error", "change.bad-field", "changes/fields", 8),
		at("error", "change.bad-field", "changes/flags", 7),
		at("error", "change.bad-field", "changes/flags", 8),
		at("error", "change.bad-id", "changes/renamed", 2),
		at("error", "change.no-front-matter", "changes/legacy", 1),
		at("error", "change.unknown-touch", "changes/place", 7),
		at("warn", "change.no-touches", "changes/fields", 1),
	]);
	for (const item of diagnostics) {
		assert.match(item.message, /; fix: \S/);
	}
	const byId = new Map(read.records.map((record) => [record.id, record]));
	assert.deepEqual(byId.get("place")?.touches, ["plant.viewer", "plant.misspelled"]);
	assert.deepEqual(byId.get("fields")?.wrong, { problem: "This is wrong.", on: "2026-10-06" });
	assert.equal(byId.get("fields")?.opened, "2026-10-01");
	assert.deepEqual(byId.get("dupes")?.needsOwner, { ask: "Keep?", on: "2026-10-05" });
	assert.equal(byId.get("other")?.path, "context/changes/renamed/");
	assert.deepEqual([...closedChanges(root)].sort(), ["gone", "stray"]);
});

test("the board lists live and landed-unarchived work in NOW, unstarted changes in NEXT, and archive in RECENT", () => {
	const record = (id: string, status: string, path = `context/changes/${id}/`): ChangeRecord => {
		const archived = path.startsWith("context/archive/") ? { archivedAt: "2026-10-03" } : {};
		return { kind: "change", id, path, title: `${id} title`, status, touches: [], touchLines: {}, ...archived };
	};
	const records = [record("idea", "new"), record("live", "implementing"), record("built", "implemented")];
	records.push(record("shipped", "archived", "context/archive/2026-10-03-shipped/"));
	const jobs = [{ id: "job-1", state: "running", branch: "limen/job-1", changes: ["live"] }];
	assert.equal(
		renderBoard(deriveBoard(records, jobs, new Set())),
		`## NOW
- live title · live (implementing): job job-1 running
- built title · built (implemented): archive with /dx-archive built

## NEXT
- idea title · idea (new)

## RECENT
- shipped title · shipped (landed 2026-10-03)
`,
	);
	assert.equal(renderBoard(deriveBoard([], [], new Set())), "");
});
