import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { callerRole, type Effective, effectivePermissions, renderPermissions, repoId } from "../project/autonomy.ts";
import { limenRoot } from "../project/git.ts";
import { parseFlags } from "./flags.ts";

const LOADERS = [".omp/extensions/limen.ts", ".pi/extensions/limen.ts"];

/** `limen permissions [--repo R] [--role X] [--check-remote]`: the effective autonomy values and their sources. */
export async function permissionsCommand(args: readonly string[], cwd: string): Promise<void> {
	const { values } = parseFlags(
		args,
		{ repo: { type: "string" }, role: { type: "string" }, "check-remote": { type: "boolean" } },
		{
			unknown: (word) =>
				`permissions: unknown argument ${word}; usage: limen permissions [--repo R] [--role X] [--check-remote]`,
			missing: (flag) => `permissions: ${flag} needs a value`,
			positionals: false,
		},
	);
	const root = values.repo ? resolve(cwd, values.repo) : limenRoot(cwd);
	const caller = values.role
		? { role: values.role, interactiveCoordinator: values.role === "coordinator" }
		: callerRole(process.env, root);
	const effective = effectivePermissions(root, caller.role, caller.interactiveCoordinator);
	console.log(renderPermissions(effective));
	if (!effective.error) {
		const branches = ["default branch", ...effective.protected].join(", ");
		console.log(`Protected: ${branches}. Merge method: ${effective.mergeMethod}.`);
	}
	for (const loader of LOADERS) {
		const path = join(root, loader);
		if (existsSync(path) && !readFileSync(path, "utf8").includes("permissions")) {
			console.warn(`warning: ${loader} does not load the permissions guard; run limen init to update it`);
		}
	}
	if (values["check-remote"]) {
		checkRemote(root, effective);
	}
}

/** Read-only: compare the GitHub rulesets on each protected branch with canMerge (design §4.6). */
function checkRemote(root: string, effective: Effective): void {
	const [host, owner, repo] = repoId(root).split("/");
	if (host !== "github.com" || !owner || !repo) {
		console.warn("warning: --check-remote needs a github.com origin");
		return;
	}
	const head = gh(root, ["repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"]);
	const branches = [head.ok ? head.text : "", ...effective.protected.filter((name) => !name.includes("*"))];
	if (!head.ok) {
		console.warn(`warning: cannot read the default branch: ${head.text}`);
	}
	const canMerge = effective.values.canMerge.level;
	for (const branch of branches.filter(Boolean)) {
		const rules = gh(root, ["api", `repos/${owner}/${repo}/rules/branches/${encodeURIComponent(branch)}`]);
		if (!rules.ok) {
			console.warn(`warning: cannot read rules for ${branch}: ${rules.text}`);
			continue;
		}
		const types = ruleTypes(rules.text);
		if (canMerge !== "allow" && !types.has("pull_request")) {
			console.warn(`warning: canMerge is ${canMerge} but ${branch} has no pull_request rule on GitHub`);
		}
		if (canMerge === "allow" && !types.has("required_status_checks")) {
			console.warn(`warning: canMerge is allow but ${branch} has no required_status_checks rule on GitHub`);
		}
		console.log(`remote ${branch}: ${[...types].join(", ") || "no rules"}`);
	}
}

function gh(cwd: string, args: readonly string[]): { ok: boolean; text: string } {
	const result = spawnSync("gh", args, { cwd, encoding: "utf8" });
	if (result.error) {
		return { ok: false, text: result.error.message };
	}
	return result.status === 0 ? { ok: true, text: result.stdout.trim() } : { ok: false, text: result.stderr.trim() };
}

function ruleTypes(json: string): ReadonlySet<string> {
	const data: unknown = JSON.parse(json);
	const rules = Array.isArray(data) ? data : [];
	const types = rules.map((rule) => (rule && typeof rule === "object" && "type" in rule ? String(rule.type) : ""));
	return new Set(types.filter(Boolean));
}
