import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { resolveJob } from "../job/lookup.ts";
import {
	abortMerge,
	commitList,
	currentBranch,
	dirtyPaths,
	limenRoot,
	mergeBranch,
	mergePaths,
	workspaceRepository,
} from "../project/git.ts";
import { changeCheck } from "./change-check.ts";
import { parseFlags } from "./flags.ts";

export async function landCommand(args: readonly string[], cwd: string): Promise<void> {
	if (process.env.LIMEN_GROUP_ID) {
		throw new Error("group members cannot land; the owner-facing lead owns landing");
	}
	const parsed = parseLandArgs(args);
	const { id, branch, base, repo, label } = await readDoneJob(cwd, parsed.query);
	const root = limenRoot(cwd);
	const repository = repo ? workspaceRepository(root, repo) : root;
	const target = landTarget(repository, parsed.onto, branch);
	const dirty = checkCheckoutBeside(repository, target, { id, branch, base });
	await checkLandGates(repository, root, branch, id);
	if (!parsed.yes && !(await confirm(`Land ${label || id} onto ${target}? [y/N] `))) {
		throw new Error("land cancelled");
	}
	let output: string;
	try {
		output = mergeBranch(repository, branch);
	} catch (error) {
		// A half-done merge beside another session's files would turn its next commit into this merge.
		if (dirty.length) {
			abortMerge(repository);
		}
		throw error;
	}
	if (output) {
		console.log(output);
	}
	console.log(`landed ${id} onto ${target}`);
}
/** The job's recorded branch, base, repo and label; only a done job with a branch and a base lands. */
async function readDoneJob(
	cwd: string,
	query: string,
): Promise<{ id: string; branch: string; base: string; repo: string; label: string }> {
	const { id, jobDir } = await resolveJob(cwd, query, "control");
	const [state, branch, base, repo, label] = await Promise.all([
		text(`${jobDir}/state`),
		text(`${jobDir}/branch`),
		text(`${jobDir}/base`),
		text(`${jobDir}/repo`),
		text(`${jobDir}/label`),
	]);
	if (state !== "done") {
		throw new Error(`job ${id} is ${state || "missing"}; land requires a done job`);
	}
	if (!branch || !base) {
		throw new Error(`job ${id} has no recorded ${branch ? "base" : "branch"}`);
	}
	return { id, branch, base, repo, label };
}
/** Land merges onto the checked-out branch, never onto the job's own branch. */
function landTarget(repository: string, onto: string | undefined, branch: string): string {
	const current = currentBranch(repository);
	const target = onto ?? current;
	if (target !== current) {
		throw new Error(`land merges onto the current branch (${current}); checkout ${target} first`);
	}
	if (target === branch) {
		throw new Error(`already on job branch ${branch}`);
	}
	return target;
}
/**
 * Another session may be editing this checkout. Land merges beside its files and never touches them: no staged
 * change, no uncommitted file the merge would change. Returns the uncommitted paths.
 */
function checkCheckoutBeside(
	repository: string,
	target: string,
	job: { readonly id: string; readonly branch: string; readonly base: string },
): readonly string[] {
	const dirty = dirtyPaths(repository);
	if (dirty.staged.length) {
		throw new Error(
			`target ${target} has staged changes, and a merge would refuse or sweep them in: ${dirty.staged.join(", ")}; commit or unstage them first`,
		);
	}
	const commits = commitList(repository, job.base, job.branch);
	if (!commits) {
		throw new Error(`job ${job.id} has no commits to land`);
	}
	const merged = dirty.paths.length ? mergePaths(repository, job.branch) : new Set<string>();
	const overlap = dirty.paths.filter((path) => merged.has(path));
	if (overlap.length) {
		throw new Error(
			`target ${target} has uncommitted changes in files this land would change: ${overlap.join(", ")}; commit or move them first`,
		);
	}
	if (dirty.paths.length) {
		console.log(
			`land: ${dirty.paths.length} uncommitted file${dirty.paths.length === 1 ? "" : "s"} in ${repository} stay untouched; none is in this merge`,
		);
	}
	return dirty.paths;
}
/** The strict change check and the test/ line cap; either one refuses the land. */
async function checkLandGates(repository: string, root: string, branch: string, id: string): Promise<void> {
	const gate = await changeCheck(repository, root, branch, "HEAD", id);
	if (!gate.ok) {
		throw new Error(`land refused: ${branch} has change folders that fail the strict check\n${gate.lines.join("\n")}`);
	}
	for (const line of gate.lines) {
		console.log(line);
	}
	const cap = landTestCap(repository, branch);
	if (cap) {
		console.log(cap.line);
	}
	if (cap?.refuse) {
		throw new Error(`land refused: ${cap.refuse}`);
	}
}

/** The cap on `test/` lines that `context/foundation/vision.md` names, or undefined when it names none. */
export function testLineCap(vision: string): number | undefined {
	const match = /`test\/` holds at most ([\d,]+) lines/.exec(vision);
	return match?.[1] ? Number(match[1].replaceAll(",", "")) : undefined;
}

const VISION = "context/foundation/vision.md";
// The cap is read from the target's vision, the owner's copy, so a branch cannot raise its own cap.
// Only a branch that adds test lines and leaves test/ over the cap is refused; deletions always land.
function landTestCap(
	repository: string,
	branch: string,
): { readonly line: string; readonly refuse?: string } | undefined {
	const vision = spawnSync("git", ["show", `HEAD:${VISION}`], { cwd: repository, encoding: "utf8" });
	const cap = vision.status === 0 ? testLineCap(vision.stdout) : undefined;
	if (cap === undefined) {
		return undefined;
	}
	let added = 0;
	let removed = 0;
	for (const row of gitText(repository, ["diff", "--numstat", `HEAD...${branch}`, "--", "test"]).split("\n")) {
		const [plus = "", minus = ""] = row.split("\t");
		added += Number(plus) || 0;
		removed += Number(minus) || 0;
	}
	const counts = spawnSync("git", ["grep", "-c", "", "HEAD", "--", "test"], {
		cwd: repository,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	}).stdout;
	const lines =
		counts.split("\n").reduce((sum, row) => sum + (Number(row.slice(row.lastIndexOf(":") + 1)) || 0), 0) +
		added -
		removed;
	const line = `land: test/ holds ${lines} lines after this land (cap ${cap}, ${VISION}); this branch +${added} -${removed}`;
	if (lines <= cap || added <= removed) {
		return { line };
	}
	return {
		line,
		refuse: `test/ would hold ${lines} lines; ${VISION} caps it at ${cap}. Remove ${Math.min(lines - cap, added - removed)} test lines in this branch, or ask the owner to raise the cap.`,
	};
}

function gitText(cwd: string, args: readonly string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

function parseLandArgs(args: readonly string[]): {
	readonly query: string;
	readonly yes: boolean;
	readonly onto?: string;
} {
	const { values, positionals } = parseFlags(args, { yes: { type: "boolean" }, onto: { type: "string" } } as const, {
		unknown: (word) => `unknown land option ${word}`,
		missing: () => "--onto requires a branch",
		repeated: (flag) => (flag === "--onto" ? "--onto may be supplied only once" : undefined),
		endOfFlags: false,
	});
	// An empty word, such as an unset shell variable, was never a job id.
	const [query, ...extra] = positionals.filter((word) => word !== "");
	if (!query) {
		throw new Error("land requires a job id");
	}
	if (extra.length > 0) {
		throw new Error("land requires exactly one job id");
	}
	const yes = values.yes ?? false;
	return values.onto !== undefined ? { query, yes, onto: values.onto } : { query, yes };
}

async function confirm(question: string): Promise<boolean> {
	if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
		throw new Error("land requires a TTY confirm, or pass --yes");
	}
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		return /^(y|yes)$/i.test((await rl.question(question)).trim());
	} finally {
		rl.close();
	}
}

function text(path: string): Promise<string> {
	return readFile(path, "utf8").then(
		(value) => value.trim(),
		() => "",
	);
}
