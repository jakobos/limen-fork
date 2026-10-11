import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hasCommit, isGitRepository, NO_COMMIT, repoRoot, workspaceRoot } from "../project/git.ts";
import { formatDrift, isOldManual, listDrift, readOptional, removeHookCopies } from "../project/inherit.ts";
import { registerProject } from "../project/seat.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DX_INSTALL = ["skills", "add", "dikamilo/dx-workflow", "--skill", "*", "-a", "universal", "-y", "--copy"];
const DX_UPDATE = ["skills", "update", "-p", "-y"];
/** The dx skills the role prompts name; upstream may rename one, so a missing name warns. */
const DX_SKILLS = [
	"dx-new",
	"dx-frame",
	"dx-plan",
	"dx-roadmap",
	"dx-implement",
	"dx-tdd",
	"dx-review",
	"dx-review-triage",
	"dx-research",
	"dx-refactor-discover",
	"dx-lesson",
	"dx-archive",
	"dx-init",
] as const;
/** sha256 of the upstream `dx-init/SKILL.md` whose file rules `scaffoldContext` copies. */
const DX_INIT_SHA256 = "e7c5b8c2bb898d39af0c0e5ee16c6430826d313ce0f327e6735187f6cf9bee5d";
const DX_START = "<!-- dx:workflow:start -->";
const DX_END = "<!-- dx:workflow:end -->";
const DX_BLOCK = `${DX_START}\nThis project uses the dx- SDLC framework; workflow state lives under \`context/\`.\n${DX_END}`;
const CONTEXT_DIRS = [
	"foundation/research",
	"standards/global",
	"standards/frontend",
	"standards/backend",
	"standards/testing",
	"efforts",
	"changes",
	"archive",
	"config/review-policies",
	"config/templates",
] as const;
const CONTEXT_HEADERS = [
	["foundation/glossary.md", "# Glossary — ubiquitous language for this project\n"],
	["foundation/lessons.md", "# Lessons — accrued warnings and load-bearing decisions (append-only)\n"],
] as const;
const LOADERS = [".pi/extensions/limen.ts", ".omp/extensions/limen.ts"] as const;
const LEGACY = [
	".control",
	".agents/control",
	".pi/extensions/control-wake.ts",
	".pi/extensions/control-communication.ts",
	".omp/extensions/control-wake.ts",
	".omp/extensions/control-communication.ts",
] as const;

type Status = "created" | "present" | "updated";

export async function initCommand(args: readonly string[], cwd: string): Promise<void> {
	const flag = args[0];
	if (args.length > 1 || (flag !== undefined && flag !== "--drop-leftovers" && flag !== "--update-dx")) {
		throw new Error("init takes no arguments, or only --drop-leftovers or --update-dx");
	}
	if (flag === "--drop-leftovers") {
		await dropLeftovers(cwd);
		return;
	}
	if (!isGitRepository(cwd)) {
		throw new Error(
			"init requires a Git repository; run 'git init' first, or use 'limen workspace init' for a non-Git workspace",
		);
	}
	const root = repoRoot(cwd);
	for (const legacy of LEGACY) {
		if (await pathExists(join(root, legacy))) {
			throw new Error(`legacy ${legacy} exists; leftover Control path — rename or remove it by hand`);
		}
	}
	if (!hasCommit(root)) {
		console.log(NO_COMMIT);
	}
	await installDx(root, flag === "--update-dx");
	for (const name of DX_SKILLS) {
		if (!(await pathExists(join(root, ".agents/skills", name, "SKILL.md")))) {
			console.log(`warning: dx skill ${name} is missing after the install; the role prompts name it`);
		}
	}
	await scaffoldContext(root);
	await ensureIgnored(root);
	await harnessFiles(root, true);
	console.log(
		[
			"next:",
			"- write context/foundation/vision.md",
			"- on an existing codebase, run /dx-standards-discover and /dx-domain-discover",
			"- then /dx-new <idea>",
			"- review the result and commit it; limen init does not commit",
		].join("\n"),
	);
}

export async function workspaceCommand(args: readonly string[], cwd: string): Promise<void> {
	if (args.length !== 1 || args[0] !== "init") {
		throw new Error("workspace requires init");
	}
	if (isGitRepository(cwd)) {
		throw new Error("workspace init requires a non-Git parent directory");
	}
	await harnessFiles(resolve(cwd), false);
	console.log("next: write .agents/limen/workspace.md, then open a coordinator in this folder (docs/setup.md)");
}

async function dropLeftovers(cwd: string): Promise<void> {
	const root = workspaceRoot(cwd) ?? (isGitRepository(cwd) ? repoRoot(cwd) : undefined);
	if (!root) {
		throw new Error("init --drop-leftovers requires a Limen project or workspace");
	}
	for (const path of removeHookCopies(root)) {
		console.log(`removed ${path}`);
	}
	const leftovers = listDrift(root).filter((item) => item.kind === "leftover" || item.kind === "old manual");
	if (!leftovers.length) {
		console.log("no leftover copies");
	}
	for (const item of leftovers) {
		await rm(join(root, item.path));
		console.log(`dropped ${item.path}`);
	}
}

/** Step 2: the latest dx skills, copied into this repository; skipped when the lock already lists dx-init. */
async function installDx(root: string, update: boolean): Promise<void> {
	const lockPath = join(root, "skills-lock.json");
	const before = readOptional(lockPath);
	const args = update ? DX_UPDATE : DX_INSTALL;
	const result =
		!update && before !== undefined && locksDxInit(before)
			? undefined
			: spawnSync("npx", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	if (result && (result.error || result.status !== 0)) {
		const detail = (result.error?.message ?? `${result.stdout}${result.stderr}`).trim().split("\n").slice(-5);
		console.log(`warning: npx ${args.join(" ")} failed (exit ${result.status ?? "none"})\n${detail.join("\n")}`);
	}
	const after = readOptional(lockPath);
	if (after === undefined) {
		return;
	}
	const status: Status = before === undefined ? "created" : before === after ? "present" : "updated";
	console.log(`${status} skills-lock.json`);
	const skills = (await readdir(join(root, ".agents/skills")).catch(() => [])).filter((name) => name.startsWith("dx-"));
	console.log(`${status} .agents/skills/dx-* (${skills.length} skills)`);
	if (!update) {
		return;
	}
	const skill = readOptional(join(root, ".agents/skills/dx-init/SKILL.md")) ?? "";
	if (createHash("sha256").update(skill, "utf8").digest("hex") !== DX_INIT_SHA256) {
		console.log(
			"warning: .agents/skills/dx-init/SKILL.md differs from the version limen init's scaffold copies; compare its rules with src/commands/init.ts",
		);
	}
}

function locksDxInit(text: string): boolean {
	try {
		const lock = JSON.parse(text) as { skills?: Record<string, unknown> };
		return Boolean(lock.skills?.["dx-init"]);
	} catch {
		return false;
	}
}

/** Step 4: the `dx-init/SKILL.md` rules, applied in code from the installed skill's assets. */
async function scaffoldContext(root: string): Promise<void> {
	const assets = join(root, ".agents/skills/dx-init/assets");
	const freshStandards = !(await pathExists(join(root, "context/standards")));
	for (const dir of CONTEXT_DIRS) {
		const exists = await pathExists(join(root, "context", dir));
		await mkdir(join(root, "context", dir), { recursive: true });
		console.log(`${exists ? "present" : "created"} context/${dir}/`);
	}
	for (const name of (await listFiles(join(assets, "standards/global"))).filter((item) => item.endsWith(".md"))) {
		const target = `context/standards/global/${name}`;
		if (freshStandards) {
			await copyMissing(root, join(assets, "standards/global", name), target);
		} else if (await pathExists(join(root, target))) {
			console.log(`present ${target}`);
		} else {
			console.log(`not copied (context/standards/ already existed): ${target}`);
		}
	}
	for (const name of await listFiles(join(assets, "config"))) {
		await copyMissing(root, join(assets, "config", name), `context/config/${name}`);
	}
	for (const [path, header] of CONTEXT_HEADERS) {
		const exists = await pathExists(join(root, "context", path));
		if (!exists) {
			await writeFile(join(root, "context", path), header, { flag: "wx" });
		}
		console.log(`${exists ? "present" : "created"} context/${path}`);
	}
	await writeDxBlock(root);
}

/** The managed dx block goes to AGENTS.md when it is the repo's own file and CLAUDE.md is absent or a pointer. */
async function writeDxBlock(root: string): Promise<void> {
	const agents = readOptional(join(root, "AGENTS.md"));
	const claude = readOptional(join(root, "CLAUDE.md"))?.trim();
	const pointer = claude === undefined || claude === "@AGENTS.md" || claude === "@./AGENTS.md";
	const name = agents !== undefined && pointer && !isOldManual(root) ? "AGENTS.md" : "CLAUDE.md";
	const text = readOptional(join(root, name));
	const start = text?.indexOf(DX_START) ?? -1;
	const end = text?.indexOf(DX_END, start) ?? -1;
	if (start >= 0 && end < 0) {
		console.log(`warning: ${name} has ${DX_START} without ${DX_END}; fix the block by hand`);
		return;
	}
	let next = `${DX_BLOCK}\n`;
	if (text && start >= 0) {
		next = `${text.slice(0, start)}${DX_BLOCK}${text.slice(end + DX_END.length)}`;
	} else if (text) {
		next = `${text}${text.endsWith("\n") ? "\n" : "\n\n"}${DX_BLOCK}\n`;
	}
	if (next !== text) {
		await writeFile(join(root, name), next);
	}
	const status: Status = text === undefined ? "created" : next === text ? "present" : "updated";
	console.log(`${status} ${name} (dx block)`);
}

/** `.worktrees/` for dx auto mode and `.limen/` for job records; the last matching line decides, negations count. */
async function ensureIgnored(root: string): Promise<void> {
	const path = join(root, ".gitignore");
	let content = readOptional(path) ?? "";
	for (const entry of [".worktrees/", ".limen/"]) {
		const relevant = content
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => [entry, `/${entry}`, `!${entry}`, `!/${entry}`].includes(line));
		const present = [entry, `/${entry}`].includes(relevant.at(-1) ?? "");
		if (!present) {
			content = `${content}${content && !content.endsWith("\n") ? "\n" : ""}${entry}\n`;
		}
		console.log(`${present ? "present" : "created"} .gitignore ${entry}`);
	}
	if (content !== (readOptional(path) ?? "")) {
		await writeFile(path, content);
	}
}

/** Step 5: Limen's own files, missing only; the loaders are package code and follow the template. */
async function harnessFiles(root: string, repository: boolean): Promise<void> {
	const copies = [
		repository
			? (["templates/vision.md", "context/foundation/vision.md"] as const)
			: (["templates/workspace.md", ".agents/limen/workspace.md"] as const),
		["templates/models.json", ".agents/limen/models.json"],
		["templates/working-rules.md", ".agents/limen/working-rules.md"],
	] as const;
	for (const [source, target] of copies) {
		await copyMissing(root, join(ROOT, source), target);
	}
	const loader = readOptional(join(ROOT, "templates/limen-extension.ts")) ?? "";
	for (const path of LOADERS) {
		const current = readOptional(join(root, path));
		if (current !== loader) {
			await mkdir(dirname(join(root, path)), { recursive: true });
			await writeFile(join(root, path), loader);
		}
		const status: Status = current === undefined ? "created" : current === loader ? "present" : "updated";
		console.log(`${status} ${path}`);
	}
	for (const path of removeHookCopies(root)) {
		console.log(`removed ${path}`);
	}
	const jobs = await pathExists(join(root, ".limen/jobs"));
	await mkdir(join(root, ".limen/jobs"), { recursive: true });
	console.log(`${jobs ? "present" : "created"} .limen/jobs/`);
	await registerProject(root);
	const drift = formatDrift(listDrift(root));
	if (drift) {
		console.log(drift);
	}
}

async function copyMissing(root: string, source: string, target: string): Promise<void> {
	const exists = await pathExists(join(root, target));
	if (!exists) {
		await mkdir(dirname(join(root, target)), { recursive: true });
		await copyFile(source, join(root, target), constants.COPYFILE_EXCL);
	}
	console.log(`${exists ? "present" : "created"} ${target}`);
}

/** Files under `dir`, relative and sorted; an absent directory has none. */
async function listFiles(dir: string): Promise<readonly string[]> {
	const entries = await readdir(dir, { recursive: true }).catch(() => []);
	const files: string[] = [];
	for (const entry of entries.sort()) {
		if ((await stat(join(dir, entry))).isFile()) {
			files.push(entry);
		}
	}
	return files;
}

async function pathExists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	);
}
