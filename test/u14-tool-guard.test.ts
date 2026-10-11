// U14: the bash classifier, the permissions hook, and a detached worker's blocked `git push`.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import permissions from "../hook/permissions.ts";
import { classifyBash } from "../src/project/bash-classify.ts";
import { CHANGE, engineEvents, jobDir, plant, spawnJob, waitJob } from "./plant.ts";

type ToolCall = { toolName: string; input: Record<string, unknown> };

test("the classifier finds actions through prefixes, git options, substitutions and shell strings", () => {
	const actions = (line: string) => `${classifyBash(line, "/h").map((found) => found.action)}`;
	const remote = ["git push", "FOO=1 git -C x push", "echo $(git push)", "bash -c 'git push'", "gh pr create"];
	assert.deepEqual([...remote, "gh api -X PUT repos/o/r/pulls/1/merge"].map(actions), Array(6).fill("remote"));
	const allowed = ["gh pr view 1", "gh api repos/o/r/pulls", "cat ~/.config/limen/autonomy.json"];
	assert.deepEqual(allowed.map(actions), ["", "", ""]);
	const others = ["git -c a=b commit -m x", "limen approve j push", "rm ~/.config/limen/autonomy.json"];
	assert.deepEqual(others.map(actions), ["commit", "approve", "protected-path"]);
});

test("the hook follows canCommit, fails closed on a broken file, and guards permission files", () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "limen-u14-")));
	const file = join(dir, "autonomy.json");
	Object.assign(process.env, { HOME: dir, LIMEN_AUTONOMY_FILE: file, LIMEN_JOB: "" });
	let handler = (_event: ToolCall, _context: { cwd: string }): { reason: string } | undefined => undefined;
	permissions({ on: (_name, registered) => (handler = registered) });
	const call = (toolName: string, input: ToolCall["input"]) => handler({ toolName, input }, { cwd: dir })?.reason ?? "";
	const commit = (canCommit: string) => {
		const p = { canCommit, canPush: "deny", canOpenPr: "deny", canMerge: "deny" };
		writeFileSync(file, canCommit ? JSON.stringify({ profiles: { p }, repos: [], default: "p" }) : "{ broken");
		return call("bash", { command: "git commit -m x" });
	};
	const reasons = [commit("allow"), commit("deny"), commit("")].map(
		(r) => /canCommit is deny \(([a-z ]+)/.exec(r)?.[1],
	);
	assert.deepEqual(reasons, [undefined, "profile", "config error"]);
	assert.match(call("write", { path: ".limen/jobs/j/approvals/push" }), /is blocked/);
	assert.match(call("edit", { input: "[~/.config/limen/a.json#AB12]\nPUT 1:\n+x" }), /is blocked/);
});

test("a detached worker's git push returns the block reason as the tool result", async (context) => {
	const p = await plant();
	context.after(p.cleanup);
	const id = spawnJob(p, `tool git push origin HEAD\nChange: ${CHANGE}`, ["--engine", "pi", "--detached"]);
	assert.equal(waitJob(p, id), "done");
	const result = engineEvents(jobDir(p, id)).find((entry) => entry.event === "tool_result");
	assert.match(result?.text ?? "", /`git push origin HEAD` is blocked.*canPush is deny \(role ceiling.*limen push/);
});
