import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPicture } from "../picture/picture-build.ts";
import type { Diagnostic } from "../picture/picture-model.ts";
import { type ChangeRecord, checkTouches, readChanges } from "../project/changes.ts";
import { currentBranch, limenRoot, repoRoot } from "../project/git.ts";

const HELP =
	"limen change check [BRANCH]  # the land gate for change folders BRANCH adds or changes; default: this branch";
/** A change, effort or archive folder, as a root-relative path ending with "/". */
const FOLDER = /^context\/(?:changes|efforts|archive)\/[^/]+\//;
const IDENTITY = /^context\/(?:changes|efforts|archive)\/[^/]+\/(?:change|effort)\.md$/;

/** `limen change check [BRANCH]`: the land gate on demand, before a hand merge or as the keeper's last step. */
export async function changeCommand(args: readonly string[], cwd: string): Promise<void> {
	const [mode, ...rest] = args;
	if (mode !== "check" || rest.length > 1 || rest[0]?.startsWith("-")) {
		throw new Error(HELP);
	}
	const repository = repoRoot(cwd);
	const plant = process.env.LIMEN_CONTEXT_ROOT ?? limenRoot(cwd);
	const target = currentBranch(plant);
	const branch = rest[0] ?? currentBranch(repository);
	if (branch === target) {
		throw new Error(
			`change check compares a branch with ${target}; name the branch to check: limen change check BRANCH`,
		);
	}
	const job =
		branch.startsWith("limen/") && existsSync(join(plant, ".limen", "jobs", branch.slice("limen/".length)))
			? branch.slice("limen/".length)
			: "<id>";
	const gate = await changeCheck(repository, plant, branch, target, job);
	for (const line of gate.lines) {
		(gate.ok ? console.log : console.error)(line);
	}
	if (!gate.ok) {
		process.exitCode = 1;
		return;
	}
	const count = gate.folders.length;
	console.log(`change check: ${count} changed folder${count === 1 ? "" : "s"} on ${branch} pass against ${target}`);
}

/**
 * The strict check for change, effort and archive folders that `branch` adds, changes or moves against `target`, read
 * at the branch tip. `lines` is print-ready: the no-map note, warnings, errors, then the keeper command on a refusal.
 */
export async function changeCheck(
	repository: string,
	root: string,
	branch: string,
	target = "HEAD",
	job = "<id>",
): Promise<{ readonly ok: boolean; readonly folders: readonly string[]; readonly lines: readonly string[] }> {
	const folders = changedFolders(repository, branch, target);
	if (folders.length === 0) {
		return { ok: true, folders, lines: [] };
	}
	const tip = await mkdtemp(join(tmpdir(), "limen-change-check-"));
	try {
		extractIdentities(repository, branch, tip);
		const read = await readChanges(tip);
		const changed = read.records.filter((record) => folders.includes(record.path));
		const lines: string[] = [];
		const placeIds = await checkPictureSources(repository, root, branch, changed, lines);
		const diagnostics: Diagnostic[] = [
			...read.diagnostics.filter((d) => folders.some((folder) => d.source?.startsWith(folder))),
			...(placeIds ? checkTouches(changed, placeIds) : []),
		];
		const errors = [
			...diagnostics.filter((d) => d.level === "error").map((d) => `error ${d.source}:${d.line ?? 1}: ${d.message}`),
			...folderErrors(folders, read.records),
		];
		lines.push(
			...diagnostics.filter((d) => d.level === "warn").map((d) => `warn ${d.source}:${d.line ?? 1}: ${d.message}`),
		);
		lines.push(...errors);
		if (errors.length === 0) {
			return { ok: true, folders, lines };
		}
		const bad = folders.find((folder) => errors.some((error) => error.startsWith(`error ${folder}`))) ?? folders[0];
		lines.push(
			`fix: limen keeper ${bad} --job ${job} --engine <engine> --provider <provider> --model <model> --thinking <level>`,
		);
		return { ok: false, folders, lines };
	} finally {
		await rm(tip, { recursive: true, force: true });
	}
}

/** Folders under context/changes, context/efforts and context/archive with a file the branch adds, changes or moves. */
function changedFolders(repository: string, branch: string, target: string): string[] {
	const folders = new Set<string>();
	for (const row of gitText(repository, ["diff", "--name-status", "-M", `${target}...${branch}`]).split("\n")) {
		const [status = "", ...paths] = row.split("\t");
		const folder = FOLDER.exec(paths.at(-1) ?? "")?.[0];
		if (/^[AMR]/.test(status) && folder) {
			folders.add(folder);
		}
	}
	return [...folders].sort();
}

/** Writes every change.md and effort.md at the branch tip into `tip`, so the reader sees the branch, not the checkout. */
function extractIdentities(repository: string, branch: string, tip: string): void {
	const files = gitText(repository, ["ls-tree", "-r", "--name-only", branch, "--", "context"])
		.split("\n")
		.filter((path) => IDENTITY.test(path));
	if (files.length === 0) {
		return;
	}
	const archive = execFileSync("git", ["archive", branch, "--", ...files], {
		cwd: repository,
		maxBuffer: 256 * 1024 * 1024,
	});
	execFileSync("tar", ["-x", "-C", tip], { input: archive });
}

/** A changed folder needs its identity file, and its id may name only one folder at the tip. */
function folderErrors(folders: readonly string[], records: readonly ChangeRecord[]): string[] {
	const errors: string[] = [];
	for (const folder of folders) {
		const record = records.find((each) => each.path === folder);
		if (!record) {
			errors.push(`error ${folder}: no change.md or effort.md with front matter; fix: add the dx identity file`);
			continue;
		}
		const other = records.find((each) => each.id === record.id && each.path !== folder);
		if (other) {
			const fix = `keep one folder for ${record.id}; archive with /dx-archive or remove the copy`;
			errors.push(`error ${folder}: id ${record.id} is also used by ${other.path}; fix: ${fix}`);
		}
	}
	return errors;
}

/**
 * Warns about picture sources that cite a changed change's id at a path that does not exist at the branch. Returns
 * the place ids a change may touch, or undefined when the project has no picture map.
 */
async function checkPictureSources(
	repository: string,
	root: string,
	branch: string,
	changed: readonly ChangeRecord[],
	lines: string[],
): Promise<ReadonlySet<string> | undefined> {
	const map = `${root}/.limen/picture`;
	if (!existsSync(map)) {
		lines.push(`land: no picture map at ${map}; touches place ids not checked`);
		return undefined;
	}
	const model = await readPicture(map);
	const placeIds = new Set([
		...model.nodes.filter((node) => node.kind === "module").map((node) => node.id),
		...(model.project.rootId ? [model.project.rootId] : []),
	]);
	for (const record of [...model.nodes, ...model.edges, ...model.features, ...model.journeys]) {
		for (const source of record.sources) {
			const name = /^context\/(?:changes|efforts|archive)\/([^/]+)/.exec(source)?.[1] ?? "";
			const current = changed.find((each) => each.id === name.replace(/^\d{4}-\d{2}-\d{2}-/, ""));
			if (current && !gitOk(repository, ["cat-file", "-e", `${branch}:${source.replace(/\/$/, "")}`])) {
				const text = await readFile(join(map, record.source), "utf8");
				const at = text.split("\n").findIndex((line) => line.includes(source)) + 1;
				lines.push(
					`warn ${map}/${record.source}:${at || 1}: source "${source}" does not exist at ${branch}; fix: change it to ${current.path}`,
				);
			}
		}
	}
	return placeIds;
}

function gitText(cwd: string, args: readonly string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

function gitOk(cwd: string, args: readonly string[]): boolean {
	return spawnSync("git", args, { cwd, stdio: "ignore" }).status === 0;
}
