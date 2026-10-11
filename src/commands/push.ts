import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolveJob } from "../job/lookup.ts";
import { type ApprovalAction, requirePermission } from "../project/approval.ts";
import { callerRole, type Effective, effectivePermissions, globMatch, repoId } from "../project/autonomy.ts";
import { limenRoot, workspaceRepository } from "../project/git.ts";

/** A job as the remote commands see it: its branch head now and the caller's effective permissions. */
export type RemoteJob = {
	readonly id: string;
	readonly jobDir: string;
	readonly root: string;
	readonly repository: string;
	readonly branch: string;
	readonly base: string;
	readonly label: string;
	readonly head: string;
	readonly effective: Effective;
};

export async function pushCommand(args: readonly string[], cwd: string): Promise<void> {
	const job = await remoteJob(cwd, onlyJob(args, "push"));
	pushJob(job, ["push"]);
}

/** Resolves the job and computes permissions for the caller's role (C6): a job session gets its own ceiling. */
export async function remoteJob(cwd: string, query: string): Promise<RemoteJob> {
	const { id, jobDir } = await resolveJob(cwd, query, "control");
	const [branch, base, repo, label] = await Promise.all(
		["branch", "base", "repo", "label"].map((name) => text(`${jobDir}/${name}`)),
	);
	if (!branch) {
		throw new Error(`job ${id} has no recorded branch`);
	}
	const root = limenRoot(cwd);
	const repository = repo ? workspaceRepository(root, repo) : root;
	const caller = callerRole(process.env, root);
	const effective = effectivePermissions(repository, caller.role, caller.interactiveCoordinator);
	const head = run(repository, "git", ["rev-parse", "--verify", `${branch}^{commit}`]);
	return { id, jobDir, root, repository, branch, base: base ?? "", label: label ?? "", head, effective };
}

/**
 * `git push -u origin <branch>` once the gate holds. A protected branch (the default branch or a `protected`
 * pattern of the matched rule) needs canMerge instead of canPush. `approvals` lists the actions whose approval
 * at the branch head lets an `ask` through.
 */
export function pushJob(job: RemoteJob, approvals: readonly ApprovalAction[]): void {
	const protectedBranch =
		job.branch === defaultBranch(job.repository) ||
		job.effective.protected.some((pattern) => globMatch(pattern, job.branch));
	const permission = protectedBranch ? "canMerge" : "canPush";
	requirePermission(job.effective, permission, {
		what: "push",
		jobDir: job.jobDir,
		head: job.head,
		actions: approvals,
	});
	run(job.repository, "git", ["push", "-u", "origin", job.branch], "inherit");
	console.log(`pushed ${job.branch} at ${job.head.slice(0, 12)}`);
}

/** The repository's default branch, as GitHub reports it. */
export function defaultBranch(repository: string): string {
	const name = run(repository, "gh", ["repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"]);
	if (!name) {
		throw new Error("gh repo view reported no default branch");
	}
	return name;
}

/** `owner/repo` from the `origin` URL. */
export function ownerRepo(repository: string): string {
	const parts = repoId(repository).split("/");
	if (parts.length < 3) {
		throw new Error("origin is not a GitHub repository URL");
	}
	return parts.slice(-2).join("/");
}

/** Runs a tool in the repository and returns its trimmed stdout; `inherit` shows its stderr to the user. */
export function run(cwd: string, file: string, args: readonly string[], stderr: "pipe" | "inherit" = "pipe"): string {
	return execFileSync(file, args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", stderr],
		maxBuffer: 64 * 1024 * 1024,
	}).trim();
}

/** The single job argument of `limen <command> <job>`. */
export function onlyJob(args: readonly string[], command: string): string {
	const words = args.filter((word) => word !== "");
	const [query] = words;
	if (!query || words.length > 1 || query.startsWith("--")) {
		throw new Error(`usage: limen ${command} <job>`);
	}
	return query;
}

export function text(path: string): Promise<string> {
	return readFile(path, "utf8").then(
		(value) => value.trim(),
		() => "",
	);
}
