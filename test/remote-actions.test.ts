import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { writeApproval } from "../src/project/approval.ts";
import { CHANGE, git, jobDir, LIMEN, limen, plant } from "./plant.ts";

test("push, pr and merge follow permissions, approvals at the branch head, and required checks", async (t) => {
	const p = await plant();
	t.after(() => p.cleanup());
	const log = join(p.parent, "gh.log");
	const rules = join(p.parent, "rules.json");
	const remote = join(p.parent, "remote.git");
	const body = join(p.parent, "body.md");
	const gh = `echo "$*" >> ${log}\ncase "$*" in\n"repo view"*) echo main ;;\n"api repos/"*/rules/branches/main) cat ${rules} ;;\n`;
	await writeFile(join(p.bin, "gh"), `#!/bin/sh\n${gh}"api "*) exit 1 ;;\nesac\n`, { mode: 0o755 });
	git(p.parent, "init", "-q", "--bare", remote);
	git(p.root, "config", `url.${remote}.pushInsteadOf`, "https://github.com/acme/demo");
	git(p.root, "remote", "add", "origin", "https://github.com/acme/demo");
	const base = git(p.root, "rev-parse", "HEAD");
	git(p.root, "switch", "-q", "-c", "limen/demo");
	git(p.root, "commit", "-q", "--allow-empty", "-m", "first");
	const id = "20261011-demo-1a2b";
	const dir = jobDir(p, id);
	await mkdir(dir, { recursive: true });
	const record = { branch: "limen/demo", base, label: "demo job", "task.md": `Do it. Change: ${CHANGE}` };
	await Promise.all(Object.entries(record).map(([name, value]) => writeFile(join(dir, name), `${value}\n`)));

	const propose = { canCommit: "allow", canPush: "ask", canOpenPr: "ask", canMerge: "deny" };
	const file = join(p.parent, "propose.json");
	await writeFile(file, JSON.stringify({ profiles: { propose }, repos: [], default: "propose" }));
	const asPropose = { env: { LIMEN_AUTONOMY_FILE: file } };
	assert.match(limen(p, ["push", id], asPropose).stderr, /canPush is ask/);
	await writeApproval(dir, "push", git(p.root, "rev-parse", "HEAD"));
	assert.equal(limen(p, ["push", id], asPropose).status, 0);
	assert.equal(git(remote, "rev-parse", "limen/demo"), git(p.root, "rev-parse", "HEAD"));
	git(p.root, "commit", "-q", "--allow-empty", "-m", "second");
	assert.match(limen(p, ["push", id], asPropose).stderr, /no approval holds/);

	const template = limen(p, ["pr", "--template", id]).stdout;
	assert.ok(template.includes(`Change \`demo\` · job \`${id}\` · branch \`limen/demo\` · permissions \`ship\``));
	assert.match(template, /^- [0-9a-f]+ second\n- [0-9a-f]+ first$/m);
	await writeFile(body, template);
	assert.equal(limen(p, ["pr", id, "--body-file", body]).status, 0);
	const create = `pr create --head limen/demo --base main --title The demo plant has one change --body-file ${body} -R acme/demo`;
	assert.ok((await readFile(log, "utf8")).includes(create));

	assert.equal(limen(p, ["merge", id]).stderr.trim(), "merge needs CI; this branch has no required checks");
	await writeFile(rules, JSON.stringify([{ type: "required_status_checks", parameters: {} }]));
	assert.equal(limen(p, ["merge", id]).status, 0);
	const head = git(p.root, "rev-parse", "HEAD");
	assert.match(
		await readFile(log, "utf8"),
		new RegExp(`^pr merge limen/demo --auto --squash --match-head-commit ${head} -R acme/demo$`, "m"),
	);

	const options = { cwd: p.root, env: p.env, encoding: "utf8", stdio: "pipe" } as const;
	const approve = spawnSync("setsid", ["-w", process.execPath, LIMEN, "approve", id, "push"], options);
	assert.equal(approve.status, 1);
	assert.match(approve.stderr, /approve needs a terminal/);
});
