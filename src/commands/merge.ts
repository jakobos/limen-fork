import { requirePermission } from "../project/approval.ts";
import { defaultBranch, onlyJob, ownerRepo, remoteJob, run } from "./push.ts";

/**
 * Sets auto-merge on the job's PR in the origin repository; GitHub merges only after the base branch's required
 * checks pass, and only while the PR head is still the commit the gate checked.
 */
export async function mergeCommand(args: readonly string[], cwd: string): Promise<void> {
	const job = await remoteJob(cwd, onlyJob(args, "merge"));
	requirePermission(job.effective, "canMerge", {
		what: "merge",
		jobDir: job.jobDir,
		head: job.head,
		actions: ["merge"],
	});
	const repo = ownerRepo(job.repository);
	const base = defaultBranch(job.repository);
	if (!requiresChecks(job.repository, repo, base)) {
		throw new Error("merge needs CI; this branch has no required checks");
	}
	const pinned = ["--match-head-commit", job.head, "-R", repo];
	const merge = ["pr", "merge", job.branch, "--auto", `--${job.effective.mergeMethod}`, ...pinned];
	console.log(run(job.repository, "gh", merge, "inherit"));
}

/**
 * Rulesets first: they are readable without admin rights (C15). Then classic branch protection. A failed call
 * counts as no required check, so merge refuses rather than merging without CI.
 */
function requiresChecks(repository: string, repo: string, base: string): boolean {
	const rules = ghJson(repository, `repos/${repo}/rules/branches/${encodeURIComponent(base)}`);
	if (Array.isArray(rules) && rules.some((rule) => field(rule, "type") === "required_status_checks")) {
		return true;
	}
	const protection = ghJson(repository, `repos/${repo}/branches/${encodeURIComponent(base)}/protection`);
	const checks = field(protection, "required_status_checks");
	return ["contexts", "checks"].some((key) => {
		const list = field(checks, key);
		return Array.isArray(list) && list.length > 0;
	});
}

function field(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function ghJson(repository: string, path: string): unknown {
	try {
		return JSON.parse(run(repository, "gh", ["api", path]));
	} catch {
		return undefined;
	}
}
