// `limen init` scaffolds dx and harness files with a fake `npx` that installs a local dx fixture; no network.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { LIMEN, repository } from "./plant.ts";

let parent = "";
let env: Record<string, string> = {};
const init = (cwd: string, ...args: string[]) =>
	spawnSync(process.execPath, [LIMEN, "init", ...args], { cwd, env, encoding: "utf8" });

before(async () => {
	parent = await realpath(await mkdtemp(join(tmpdir(), "limen-init-")));
	const files = {
		"dx-init/SKILL.md": "# dx-init\n",
		"dx-init/assets/standards/global/a.md": "# A\n",
		"dx-init/assets/config/review-policies/p.md": "# P\n",
		"dx-new/SKILL.md": "# dx-new\n",
	};
	for (const [path, text] of Object.entries(files)) {
		await mkdir(dirname(join(parent, "dx", path)), { recursive: true });
		await writeFile(join(parent, "dx", path), text);
	}
	await mkdir(join(parent, "bin"));
	const lock = JSON.stringify({ version: 1, skills: { "dx-init": {}, "dx-new": {} } });
	const npx = `#!/bin/sh\necho "$*" >> ${parent}/npx.log\nmkdir -p .agents/skills\ncp -R ${parent}/dx/. .agents/skills/\necho '${lock}' > skills-lock.json\n`;
	await writeFile(join(parent, "bin/npx"), npx);
	await chmod(join(parent, "bin/npx"), 0o755);
	const path = `${join(parent, "bin")}:${dirname(process.execPath)}:/usr/bin:/bin`;
	env = { PATH: path, HOME: parent, LIMEN_HOME: parent, LIMEN_HERDR: "0", GIT_CONFIG_GLOBAL: "/dev/null" };
});
after(() => rm(parent, { recursive: true, force: true }));

test("a first init creates every artifact and a second changes nothing", async () => {
	const repo = join(parent, "fresh");
	await repository(repo);
	const first = init(repo);
	assert.equal(first.status, 0, first.stderr);
	for (const path of [
		"skills-lock.json",
		".agents/skills/dx-* (2 skills)",
		"context/changes/",
		"context/standards/global/a.md",
		"context/config/review-policies/p.md",
		"CLAUDE.md (dx block)",
		".gitignore .worktrees/",
		"context/foundation/vision.md",
		".agents/limen/models.json",
		".agents/limen/working-rules.md",
		".omp/extensions/limen.ts",
	]) {
		assert.ok(first.stdout.includes(`created ${path}\n`), `created ${path}\n${first.stdout}`);
	}
	assert.match(first.stdout, /warning: dx skill dx-plan is missing/);
	execFileSync("sh", ["-c", "git add -A && git commit -qm init"], { cwd: repo });
	const second = init(repo);
	assert.equal(second.status, 0, second.stderr);
	assert.doesNotMatch(second.stdout, /^(created|updated) /m);
	assert.match(second.stdout, /^present skills-lock.json$/m);
	assert.equal(readFileSync(join(parent, "npx.log"), "utf8").split("\n").length, 2, "one install");
	assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }), "");
});

test("existing standards, an old root manual, and a stale loader", async () => {
	const repo = join(parent, "existing");
	await repository(repo);
	await mkdir(join(repo, "context/standards/global"), { recursive: true });
	await mkdir(join(repo, ".omp/extensions"), { recursive: true });
	writeFileSync(join(repo, ".omp/extensions/limen.ts"), "// old loader\n");
	copyFileSync(new URL("../templates/agents.md", import.meta.url), join(repo, "AGENTS.md"));
	const run = init(repo);
	assert.equal(run.status, 0, run.stderr);
	assert.equal(existsSync(join(repo, "context/standards/global/a.md")), false);
	assert.match(run.stdout, /not copied \(context\/standards\/ already existed\): context\/standards\/global\/a.md/);
	assert.match(run.stdout, /^updated \.omp\/extensions\/limen\.ts$/m);
	assert.match(run.stdout, /^created CLAUDE\.md \(dx block\)$/m);
	assert.match(run.stdout, /root AGENTS.md is an old Limen manual/);
	const drop = init(repo, "--drop-leftovers");
	assert.match(drop.stdout, /^dropped AGENTS.md$/m);
});
