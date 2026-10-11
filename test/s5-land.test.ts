// S5 · Land. One plant whose main already holds more test lines than its cap. Every refusal must exit 1 and leave main
// where it was; the candidates that pass land by fast-forward and by merge beside another session's uncommitted file.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { CHANGE, git, jobDir, jobFile, limen, type Plant, plant, release, spawnJob, until, waitJob } from "./plant.ts";

let p: Plant;
let main: string;
const job: Record<"a" | "b" | "running" | "empty" | "failed" | "change", string> = {
	a: "",
	b: "",
	running: "",
	empty: "",
	failed: "",
	change: "",
};
const lines = (n: number) => "x\n".repeat(n);

before(async () => {
	p = await plant();
	await appendFile(join(p.root, "context/foundation/vision.md"), "\n`test/` holds at most 5 lines.\n");
	await mkdir(join(p.root, "test"));
	await writeFile(join(p.root, "test/old.test.ts"), lines(8));
	git(p.root, "add", "-A");
	git(p.root, "commit", "-q", "-m", "main is over its test cap");
	main = git(p.root, "rev-parse", "main");
});
after(() => p.cleanup());

// Each test spawns the jobs it needs, so no single test carries every spawn under npm test's per-test limit.
function done(task: string): string {
	const id = spawnJob(p, task);
	assert.equal(waitJob(p, id), "done");
	return id;
}

// Each spawn prunes the worktrees of finished jobs, so a branch gets its extra commit in a worktree of its own.
async function amend(id: string, files: Readonly<Record<string, string>>): Promise<void> {
	const worktree = join(p.parent, `amend-${id}`);
	git(p.root, "worktree", "add", "-q", "--force", worktree, jobFile(p, id, "branch"));
	for (const [path, text] of Object.entries(files)) {
		await mkdir(dirname(join(worktree, path)), { recursive: true });
		await writeFile(join(worktree, path), text);
	}
	git(worktree, "add", "-A");
	git(worktree, "commit", "-q", "-m", "candidate");
	git(p.root, "worktree", "remove", "--force", worktree);
}

/** Lands `id` expecting a refusal that leaves main where it was; returns stderr. */
function refused(id: string, env: Readonly<Record<string, string>> = {}, flags: readonly string[] = ["--yes"]): string {
	const run = limen(p, ["land", id, ...flags], { env });
	assert.equal(run.status, 1, `${id} landed: ${run.stdout}`);
	assert.equal(git(p.root, "rev-parse", "main"), main);
	assert.equal(git(p.root, "rev-parse", "HEAD"), main);
	return run.stderr;
}

/** The files a job's branch adds on top of main. */
function changed(id: string): string[] {
	return git(p.root, "diff", "--name-only", `main...${jobFile(p, id, "branch")}`).split("\n");
}

test("a running, an empty and a failed job are refused", async () => {
	job.running = spawnJob(p, "commit\nblock");
	job.empty = done("say nothing to commit");
	job.failed = spawnJob(p, "commit\nfail 3");
	assert.equal(waitJob(p, job.failed), "failed");
	await until(jobDir(p, job.running), () => existsSync(join(jobDir(p, job.running), "fake-blocked-1")));
	assert.equal(jobFile(p, job.running, "state"), "running");
	refused(job.running);
	await release(jobDir(p, job.running));
	assert.equal(waitJob(p, job.running), "done");
	assert.deepEqual(changed(job.empty), [""]);
	refused(job.empty);
	assert.notDeepEqual(changed(job.failed), [""]);
	refused(job.failed);
});

test("an unconfirmed land, another target, a group member, a staged target and a dirty file in the merge are refused", async () => {
	job.a = done("commit");
	// Without a TTY only --yes confirms; --onto names a branch that is not checked out.
	refused(job.a, {}, []);
	git(p.root, "branch", "other");
	refused(job.a, {}, ["--onto", "other", "--yes"]);
	assert.equal(git(p.root, "rev-parse", "other"), main);

	// A member of a group whose cabinet names it asks to land its own team's job: only the land rule stops it.
	const record = jobDir(p, job.a);
	await mkdir(join(p.root, ".limen/groups/g1"), { recursive: true });
	await writeFile(
		join(p.root, ".limen/groups/g1/run.json"),
		JSON.stringify({ root: p.root, members: [{ id: job.a, team: "t1" }] }),
	);
	await Promise.all([writeFile(join(record, "group"), "g1\n"), writeFile(join(record, "team"), "t1\n")]);
	refused(job.a, { LIMEN_GROUP_ID: "g1", LIMEN_TEAM_ID: "t1", LIMEN_JOB_ID: job.a, LIMEN_CONTEXT_ROOT: p.root });
	await Promise.all([
		rm(join(p.root, ".limen/groups"), { recursive: true }),
		rm(join(record, "group")),
		rm(join(record, "team")),
	]);

	await writeFile(join(p.root, "staged.txt"), "staged\n");
	git(p.root, "add", "staged.txt");
	assert.match(refused(job.a), /staged\.txt/);
	git(p.root, "rm", "-q", "--cached", "staged.txt");
	await rm(join(p.root, "staged.txt"));

	const [file = ""] = changed(job.a);
	await writeFile(join(p.root, file), "another session\n");
	assert.ok(refused(job.a).includes(file));
	assert.equal(await readFile(join(p.root, file), "utf8"), "another session\n");
	await rm(join(p.root, file));
});

test("a change that fails the strict check is refused with the keeper command", async () => {
	// The job files a change that touches no known place.
	job.change = done("commit");
	const folder = "context/changes/bad/";
	const text = await readFile(join(p.root, CHANGE, "change.md"), "utf8");
	await amend(job.change, {
		[`${folder}change.md`]: text.replace("demo.place", "nope").replace("change_id: demo", "change_id: bad"),
	});
	const stderr = refused(job.change);
	assert.ok(stderr.includes(`${folder}change.md:11`), stderr);
	assert.ok(stderr.includes(`limen keeper ${folder} --job ${job.change}`), stderr);
});

test("a branch that adds test lines past the cap is refused and names the numbers", async () => {
	await amend(job.running, { "test/new.test.ts": lines(1) });
	// main holds 8 lines, the cap is 5, the branch adds 1: 9 lines, 1 to remove.
	assert.match(refused(job.running), /\b9\b[^\n]*\b5\b[^\n]*\b1\b/);
});

test("a done job fast-forwards, and a branch that removes test lines merges beside an uncommitted file", async () => {
	// B starts from the same main as A and removes test lines, leaving test/ still over the cap.
	job.b = done("commit");
	await amend(job.b, { "test/old.test.ts": lines(6) });
	const a = git(p.root, "rev-parse", jobFile(p, job.a, "branch"));
	const first = limen(p, ["land", job.a, "--yes"]);
	assert.equal(first.status, 0, first.stderr);
	assert.equal(git(p.root, "rev-parse", "main"), a);

	await writeFile(join(p.root, "draft.txt"), "another session drafts\n");
	const status = git(p.root, "status", "--porcelain");
	const b = git(p.root, "rev-parse", jobFile(p, job.b, "branch"));
	const second = limen(p, ["land", job.b, "--yes"]);
	assert.equal(second.status, 0, second.stderr);
	assert.deepEqual(git(p.root, "log", "-1", "--format=%P", "main").split(" "), [a, b]);
	assert.equal(git(p.root, "show", "main:test/old.test.ts"), lines(6).trim());
	assert.equal(git(p.root, "status", "--porcelain"), status);
	assert.equal(await readFile(join(p.root, "draft.txt"), "utf8"), "another session drafts\n");
});

test("a land that conflicts beside an uncommitted file aborts and leaves the checkout as it was", async () => {
	await amend(job.empty, { "README.md": "the job's readme\n" });
	await writeFile(join(p.root, "README.md"), "main's readme\n");
	git(p.root, "commit", "-q", "-am", "main edits the readme");
	main = git(p.root, "rev-parse", "main");
	const status = git(p.root, "status", "--porcelain");
	refused(job.empty);
	assert.equal(git(p.root, "status", "--porcelain"), status);
	assert.equal(await readFile(join(p.root, "README.md"), "utf8"), "main's readme\n");
	assert.equal(await readFile(join(p.root, "draft.txt"), "utf8"), "another session drafts\n");
});
