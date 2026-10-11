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
	const hidden = [
		"# Let's push the branch\ngit push origin HEAD",
		"if git diff --quiet; then git push; fi",
		"for b in a b; do git push origin $b; done",
		"while true; do git push && break; done",
		"{ git push; }",
		"timeout 120 git push",
		"nice -n 5 stdbuf -oL nohup xargs -n1 git push",
		"cat <<EOF > f\ndon't\nEOF\ngit push",
		"cat <<EOF\n$(git push)\nEOF",
		`echo "it's done"; echo "$(git push)"`,
		"gh api graphql -f query='mutation { mergePullRequest }'",
		`echo "$(printf '(')" && git push`,
		"git push>/dev/null",
		"git push&>log",
		"git push>log 2>&1",
		"2>/dev/null git push",
		"gh pr create>/dev/null -t x -b y",
		"(( y = 1 << 2 ))\ngit push",
		"function f { git push; }; f",
	];
	assert.deepEqual(hidden.map(actions), Array(hidden.length).fill("remote"));
	const substitutions = [
		`git commit -m "$(cat <<'EOF'\nFix :( sad path\nEOF\n)" && git push`,
		`msg=$(cat <<'EOF'\nFix: 1) don't push\nEOF\n)\ngit commit -m "$msg" && git push`,
		"msg=$(cat <<'EOF'\nSteps: 1) build\ngit push is now blocked\nEOF\n)",
	];
	assert.deepEqual(substitutions.map(actions), ["commit,remote", "commit,remote", ""]);
	const heredocs = [
		"git commit -F - <<'EOF'\nGuard\n\ngit push now returns the block reason.\nEOF",
		"cat > notes.md <<'EOF'\nRun: make && git push\nEOF",
	];
	assert.deepEqual(heredocs.map(actions), ["commit", ""]);
	const others = ["git -c a=b commit -m x", "limen approve j push", "rm ~/.config/limen/autonomy.json"];
	const writes = ["cat x >~/.config/limen/a", "cat x > ~/.config/limen/a"];
	assert.deepEqual([...others, ...writes].map(actions), ["commit", "approve", ...Array(3).fill("protected-path")]);
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
	assert.match(call("github", { op: "pr_create" }), /`github pr_create` is blocked/);
});

test("a detached worker's git push returns the block reason as the tool result", async (context) => {
	const p = await plant();
	context.after(p.cleanup);
	const id = spawnJob(p, `tool git push origin HEAD\nChange: ${CHANGE}`, ["--engine", "pi", "--detached"]);
	assert.equal(waitJob(p, id), "done");
	const result = engineEvents(jobDir(p, id)).find((entry) => entry.event === "tool_result");
	assert.match(result?.text ?? "", /`git push origin HEAD` is blocked.*canPush is deny \(role ceiling.*limen push/);
});
