import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRun } from "../job/group-cabinet.ts";
import { resolveJob } from "../job/lookup.ts";
import { branchCommit, branchExists, commitHasFile, limenRoot, workspaceRepository } from "../project/git.ts";
import { ownerAlive } from "../runtime/reap.ts";
import { changeCheck } from "./change-check.ts";
import { parseFlags } from "./flags.ts";
import { spawnCommand } from "./spawn.ts";

type KeeperOptions = {
	readonly change: string;
	readonly jobs: readonly string[];
	readonly candidate?: string;
	readonly group?: string;
	readonly route: readonly string[];
	readonly timeout: string;
};

type KeeperJob = {
	readonly id: string;
	readonly jobDir: string;
	readonly state: string;
	readonly branch: string;
	readonly repo: string;
};

// Every keeper flag takes a value. `--job` may repeat.
const FLAGS = {
	job: { type: "string", multiple: true },
	candidate: { type: "string" },
	group: { type: "string" },
	timeout: { type: "string", default: "20m" },
	engine: { type: "string" },
	provider: { type: "string" },
	model: { type: "string" },
	thinking: { type: "string" },
} as const;

const ROUTE = ["engine", "provider", "model", "thinking"] as const;

/** A change, effort or archive folder; the id is the folder name without an archive date. */
const FOLDER = /^context\/(?:changes|efforts|archive)\/(?:\d{4}-\d{2}-\d{2}-)?([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/;

/** After the work: a short job on its own branch at the candidate tip fixes the change folder and map links. */
export async function keeperCommand(args: readonly string[], cwd: string): Promise<void> {
	if (process.env.LIMEN_GROUP_ID) {
		throw new Error(
			"group members cannot start a keeper; the owner-facing lead starts one after it merges the team branches",
		);
	}
	const options = parseKeeperArgs(args);
	const id = FOLDER.exec(options.change)?.[1];
	if (!id) {
		throw new Error(`keeper needs a change folder like context/changes/ID/, not ${options.change}`);
	}
	const root = limenRoot(cwd);
	const jobs = await finishedJobs(root, options);
	const [first] = jobs;
	if (!first) {
		throw new Error("keeper requires --job ID or --group GROUP-ID");
	}
	if (!options.candidate && jobs.length > 1) {
		throw new Error("several jobs need one candidate; pass --candidate <integration branch>");
	}
	const candidate = options.candidate ?? first.branch;
	if (!candidate) {
		throw new Error(`job ${first.id} has no recorded branch; pass --candidate BRANCH`);
	}
	const repository = first.repo ? workspaceRepository(root, first.repo) : root;
	if (!branchExists(repository, candidate)) {
		throw new Error(`candidate branch ${candidate} does not exist`);
	}
	const tip = branchCommit(repository, candidate);
	const change = changeAtTip(repository, tip, options.change, id, candidate);
	const keeperBranch = `limen/keeper-${id}-${tip.slice(0, 7)}`;
	if (branchExists(repository, keeperBranch)) {
		throw new Error(`keeper branch ${keeperBranch} already exists; land or delete it first`);
	}

	const gate = await changeCheck(repository, root, candidate, "HEAD", first.id);
	// The fix line names limen keeper; the keeper itself must not start another one.
	const gateLines = gate.lines.filter((line) => !line.startsWith("fix: ")).map((line) => `  ${line}`);
	const map = `${root}/.limen/picture`;
	const blocks = await Promise.all(jobs.map((job) => jobBlock(repository, job)));
	const packet = [
		`Change keeper for ${id}. Fix the change folder and map links for this work; commit on this branch.`,
		"",
		`Change: ${change}`,
		`Map: ${existsSync(map) ? map : "none"}`,
		`Group: ${options.group ?? "none"}`,
		`Candidate: ${candidate} at ${tip}`,
		`Changed folders: ${gate.folders.length > 0 ? gate.folders.join(", ") : "none"}`,
		"Land check now:",
		...(gate.ok && gate.lines.length === 0 ? ["no error"] : gateLines),
		"",
		...blocks,
		"",
	].join("\n");

	execFileSync("git", ["branch", keeperBranch, tip], { cwd: repository, stdio: "ignore" });
	const scratch = await mkdtemp(join(tmpdir(), "limen-keeper-"));
	try {
		const packetFile = `${scratch}/task.md`;
		await writeFile(packetFile, packet);
		const repo = first.repo ? ["--repo", first.repo] : [];
		const label = `change keeper · ${id}`;
		await spawnCommand(
			[
				...options.route,
				...["--role", "keeper", "--detached", "--branch", keeperBranch, "--timeout", options.timeout],
				...["--label", label, "--task-file", packetFile, ...repo],
			],
			cwd,
		);
	} catch (error) {
		execFileSync("git", ["branch", "-D", keeperBranch], { cwd: repository, stdio: "ignore" });
		throw error;
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

function parseKeeperArgs(args: readonly string[]): KeeperOptions {
	const { values, positionals } = parseFlags(args, FLAGS, {
		unknown: (word) => `unknown keeper option ${word}`,
		missing: (flag) => `${flag} requires a value`,
	});
	const [change, ...extra] = positionals;
	if (!change || extra.length > 0) {
		throw new Error("keeper requires exactly one <change-folder>");
	}
	const jobs = values.job ?? [];
	if (jobs.length === 0 && !values.group) {
		throw new Error("keeper requires --job ID or --group GROUP-ID");
	}
	// A missing model flag falls back to `.agents/limen/models.json` for the keeper role in spawn.
	const route: string[] = [];
	for (const name of ROUTE) {
		const value = values[name];
		if (value) {
			route.push(`--${name}`, value);
		}
	}
	return {
		change,
		jobs,
		route,
		timeout: values.timeout,
		...(values.candidate ? { candidate: values.candidate } : {}),
		...(values.group ? { group: values.group } : {}),
	};
}

/** The jobs the keeper reads. A group's keeper reads every member; the lead names the group, not each member. */
async function finishedJobs(root: string, options: KeeperOptions): Promise<KeeperJob[]> {
	const queries = new Set(options.jobs);
	if (options.group) {
		for (const member of (await readRun(root, options.group)).members) {
			queries.add(member.id);
		}
	}
	const jobs: KeeperJob[] = [];
	for (const query of queries) {
		const { id, jobDir } = await resolveJob(root, query, "control");
		const state = await text(`${jobDir}/state`);
		if (state === "running" || (await ownerAlive(jobDir))) {
			throw new Error(`job ${id} is still running. A keeper never commits beside a live job. Wait for it, or stop it.`);
		}
		jobs.push({ id, jobDir, state, branch: await text(`${jobDir}/branch`), repo: await text(`${jobDir}/repo`) });
	}
	return jobs;
}

/** A change archived on the branch leaves its old path in the job's task. Follow the one archive folder with its id. */
function changeAtTip(repository: string, tip: string, change: string, id: string, candidate: string): string {
	const folder = change.endsWith("/") ? change : `${change}/`;
	if (["change.md", "effort.md"].some((name) => commitHasFile(repository, tip, `${folder}${name}`))) {
		return folder;
	}
	// A tip with no archive folder lists nothing.
	const tree = spawnSync("git", ["ls-tree", "-d", "--name-only", `${tip}:context/archive`], {
		cwd: repository,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	}).stdout;
	const moved = tree
		.split("\n")
		.filter((name) => name.replace(/^\d{4}-\d{2}-\d{2}-/, "") === id)
		.map((name) => `context/archive/${name}/`);
	const [only] = moved;
	if (moved.length !== 1 || !only) {
		const found = moved.length > 0 ? `; ${id} is at ${moved.join(", ")}` : "";
		throw new Error(`change ${folder} is missing at ${candidate} (${tip.slice(0, 7)})${found}`);
	}
	console.log(`change moved: ${folder} -> ${only}`);
	return only;
}

async function jobBlock(repository: string, job: KeeperJob): Promise<string> {
	const [label, base, worktree] = await Promise.all(
		["label", "base", "worktree"].map((name) => text(`${job.jobDir}/${name}`)),
	);
	const jobTip = job.branch && branchExists(repository, job.branch) ? branchCommit(repository, job.branch) : "none";
	const sessions = await readdir(`${job.jobDir}/session`).catch(() => [] as string[]);
	const session = sessions
		.filter((name) => name.endsWith(".jsonl"))
		.sort()
		.at(-1);
	return [
		`Job: ${job.id}`,
		`  Label: ${label || job.id}`,
		`  State: ${job.state || "missing"}`,
		`  Branch: ${job.branch || "none"} (base ${base || "none"}, tip ${jobTip})`,
		`  Worktree: ${worktree || "none"}`,
		`  Session: ${session ? `${job.jobDir}/session/${session}` : "none"}`,
		`  Task: ${job.jobDir}/task.md`,
	].join("\n");
}

function text(path: string): Promise<string> {
	return readFile(path, "utf8").then(
		(value) => value.trim(),
		() => "",
	);
}
