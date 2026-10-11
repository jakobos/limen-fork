// S6 · Change keeper. One plant: place ids, the change check, the keeper's start rules, the board, drop and close,
// picture bytes and change-author path resolution, all through the real CLI.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { CHANGE, git, jobDir, jobFile, limen, plant, release, spawnJob, waitJob } from "./plant.ts";

const p = await plant();
after(p.cleanup);
const ROUTE = ["--engine", "omp", "--provider", "p", "--model", "m", "--thinking", "high"];

// The demo job stays running until the keeper and drop refusals below have been seen.
const worker = spawnJob(p, `block\ncommit\nChange: ${CHANGE}`, ["--label", "keeper proof · demo"]);

test("change check names the file, the line and a fix for each fault", async () => {
	const tree = join(p.parent, "check");
	git(p.root, "worktree", "add", "-q", "-b", "check", tree);
	const folder = "context/changes/bad/";
	await mkdir(join(tree, folder), { recursive: true });
	const text = "---\nchange_id: bad\nstatus: new\ntouches:\n  - nope\nopened: 2026-13-45\n---\n";
	await writeFile(join(tree, folder, "change.md"), text);
	git(tree, "add", ".");
	git(tree, "commit", "-q", "-m", "bad change");
	const check = limen(p, ["change", "check", "check"]);
	assert.equal(check.status, 1);
	const errors = check.stderr.split("\n").filter((line) => line.startsWith("error "));
	const faults = errors.map((line) => /^error (\S+):(\d+): (.+); fix: (.+)$/.exec(line)?.slice(1, 3) ?? line);
	assert.deepEqual(faults.sort(), [
		[`${folder}change.md`, "5"],
		[`${folder}change.md`, "6"],
	]);
	const fix = `fix: limen keeper ${folder} --job <id> --engine <engine> --provider <provider> --model <model> --thinking <level>`;
	assert.ok(check.stderr.split("\n").includes(fix), check.stderr);
});

test("the board shows the live job; drop and close refuse while the change is open", () => {
	assert.match(limen(p, ["board"]).stdout, new RegExp(`· demo \\(planned\\): job ${worker} running`));
	const refused = limen(p, ["drop", "demo", "not needed"]);
	assert.equal(refused.status, 1);
	assert.match(refused.stderr, new RegExp(worker));
	assert.ok(existsSync(join(p.root, CHANGE, "change.md")));
	assert.match(limen(p, ["close", "demo"]).stderr, /demo is not archived or dropped/);
});

test("drop stamps the change, keeps its notes, and moves it to the archive without a commit", async () => {
	await mkdir(join(p.root, "context/changes/spare"), { recursive: true });
	const text = "---\nchange_id: spare\nstatus: new\narchived_at: null\n---\n\n## Notes\n\nFirst idea.\n";
	await writeFile(join(p.root, "context/changes/spare/change.md"), text);
	git(p.root, "add", "context");
	git(p.root, "commit", "-q", "-m", "spare change");
	const head = git(p.root, "rev-parse", "HEAD");
	const dropped = limen(p, ["drop", "spare", "the owner chose another path"]);
	assert.equal(dropped.status, 0, dropped.stderr);
	const day = new Date();
	const today = [day.getFullYear(), day.getMonth() + 1, day.getDate()].map((n) => String(n).padStart(2, "0")).join("-");
	const moved = readFileSync(join(p.root, `context/archive/${today}-spare/change.md`), "utf8");
	assert.match(moved, new RegExp(`status: dropped\narchived_at: ${today}\n`));
	assert.ok(moved.endsWith(`## Notes\n\nFirst idea.\n\nDropped ${today}: the owner chose another path\n`), moved);
	assert.equal(existsSync(join(p.root, "context/changes/spare")), false);
	assert.equal(git(p.root, "rev-parse", "HEAD"), head);
	assert.match(limen(p, ["board"]).stdout, /## RECENT\n- spare · spare \(dropped/);
	assert.match(limen(p, ["close", "spare"]).stderr, /herdr is not available/);
	git(p.root, "commit", "-q", "-m", "drop spare");
});

test("keeper refuses a running job, then starts on a new branch at the candidate tip", async () => {
	const refused = limen(p, ["keeper", CHANGE, "--job", worker, ...ROUTE]);
	assert.equal(refused.status, 1);
	assert.match(refused.stderr, new RegExp(worker));
	assert.equal(git(p.root, "branch", "--list", "limen/keeper-*"), "");
	assert.equal(jobFile(p, worker, "state"), "running");

	await release(jobDir(p, worker));
	assert.equal(waitJob(p, worker), "done");
	const branch = jobFile(p, worker, "branch");
	const tip = git(p.root, "rev-parse", branch);
	assert.notEqual(tip, git(p.root, "rev-parse", "main"));
	const started = limen(p, ["keeper", CHANGE, "--job", worker, ...ROUTE]);
	assert.equal(started.status, 0, started.stderr);
	const keeper = started.stdout.trim().split("\n").at(-1) ?? "";
	const keeperBranch = `limen/keeper-demo-${tip.slice(0, 7)}`;
	assert.equal(jobFile(p, keeper, "branch"), keeperBranch);
	assert.equal(jobFile(p, keeper, "base"), tip);
	assert.equal(jobFile(p, keeper, "role"), "keeper");
	assert.ok(jobFile(p, keeper, "task.md").split("\n").includes(`Change: ${CHANGE}`));
	assert.equal(git(p.root, "rev-parse", branch), tip);
	assert.equal(waitJob(p, keeper), "done");
	const again = limen(p, ["keeper", CHANGE, "--job", worker, ...ROUTE]);
	assert.equal(again.status, 1);
	assert.match(again.stderr, new RegExp(keeperBranch));
});

test("two strict picture builds give identical bytes", () => {
	const dir = join(p.root, ".limen/picture");
	const build = () => {
		const run = limen(p, [
			"picture",
			"build",
			"--dir",
			dir,
			"--out",
			join(p.parent, "map.html"),
			"--json",
			join(p.parent, "map.json"),
			"--strict",
		]);
		assert.equal(run.status, 0, run.stderr);
		return [readFileSync(join(p.parent, "map.html")), readFileSync(join(p.parent, "map.json"))];
	};
	assert.deepEqual(build(), build());
});

test("change-author resolves aliased paths and invents no author for others", async () => {
	const alias = join(p.parent, "alias");
	await symlink(p.root, alias, "dir");
	const commit = git(p.root, "log", "--format=%H", "--diff-filter=A", "--", `${CHANGE}change.md`);
	for (const [cwd, path] of [
		[p.root, join(alias, CHANGE)],
		[join(alias, "context/changes"), "demo/change.md"],
	] as const) {
		const found = limen(p, ["change-author", path], { cwd });
		assert.equal(found.status, 0, found.stderr);
		assert.ok(found.stdout.includes(commit), found.stdout);
	}
	for (const path of ["context/changes/missing/", "missing.md", "context", "../outside"]) {
		const result = limen(p, ["change-author", path]);
		assert.equal(result.status, 1, path);
		assert.equal(result.stdout, "", path);
	}
});
