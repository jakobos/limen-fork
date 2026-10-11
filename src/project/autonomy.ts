import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type Permission = "canCommit" | "canPush" | "canOpenPr" | "canMerge";
export type Level = "deny" | "ask" | "allow";
export type Source = "profile" | "project" | "role ceiling" | "config error";
export type Effective = {
	readonly profile: string;
	readonly rule: string;
	readonly role: string;
	readonly values: Readonly<Record<Permission, { level: Level; source: Source }>>;
	readonly protected: readonly string[];
	readonly mergeMethod: "squash" | "merge" | "rebase";
	readonly error?: string;
};

export const PERMISSIONS: readonly Permission[] = ["canCommit", "canPush", "canOpenPr", "canMerge"];
const LEVELS: readonly Level[] = ["deny", "ask", "allow"];
const MERGE_METHODS = ["squash", "merge", "rebase"] as const;
const PROJECT_FILE = ".agents/limen/autonomy.json";
// Roles that commit on their job branch (design §4.4, C7, C8); every other job role is denied all four.
const COMMIT_ROLES: Record<string, true> = {
	worker: true,
	repair: true,
	quality: true,
	keeper: true,
	coordinator: true,
};

type Profile = Readonly<Record<Permission, Level>>;
type Narrowing = Readonly<Partial<Record<Permission, Level>>>;
type Rule = {
	readonly match: string;
	readonly profile: string;
	readonly protected: readonly string[];
	readonly mergeMethod: Effective["mergeMethod"];
};
type Config = {
	readonly profiles: ReadonlyMap<string, Profile>;
	readonly repos: readonly Rule[];
	readonly default: string;
};

/** The personal file: `LIMEN_AUTONOMY_FILE`, else `~/.config/limen/autonomy.json`. */
export function autonomyFile(env: NodeJS.ProcessEnv): string {
	return env.LIMEN_AUTONOMY_FILE || join(env.HOME || homedir(), ".config/limen/autonomy.json");
}

/** Strictest of the personal profile, the project narrowing and the role ceiling; a config error denies all four. */
export function effectivePermissions(root: string, role: string, interactiveCoordinator: boolean): Effective {
	let config: Config;
	let narrowing: Narrowing;
	try {
		config = parseConfig(readFileSync(autonomyFile(process.env), "utf8"));
		narrowing = readNarrowing(root);
	} catch (error) {
		return deniedAll(role, error instanceof Error ? error.message : String(error));
	}
	const rule = matchRule(config, root);
	const profile = config.profiles.get(rule.profile);
	if (!profile) {
		return deniedAll(role, `unknown profile ${rule.profile}`);
	}
	const coordinator = interactiveCoordinator && role === "coordinator";
	const values = {} as Record<Permission, { level: Level; source: Source }>;
	for (const permission of PERMISSIONS) {
		let value: { level: Level; source: Source } = { level: profile[permission], source: "profile" };
		const project = narrowing[permission];
		if (project && LEVELS.indexOf(project) < LEVELS.indexOf(value.level)) {
			value = { level: project, source: "project" };
		}
		const capped = !coordinator && (permission !== "canCommit" || !Object.hasOwn(COMMIT_ROLES, role));
		if (capped && value.level !== "deny") {
			value = { level: "deny", source: "role ceiling" };
		}
		values[permission] = value;
	}
	return {
		profile: rule.profile,
		rule: rule.match,
		role,
		values,
		protected: rule.protected,
		mergeMethod: rule.mergeMethod,
	};
}

/**
 * Who is asking. A job (`LIMEN_JOB=1`) reads its recorded role, default worker, and never gets the coordinator
 * ceiling (C7). No job means the interactive coordinator or a human shell. Job records live under the plant root
 * (`LIMEN_CONTEXT_ROOT` when set), not under a job worktree.
 */
export function callerRole(env: NodeJS.ProcessEnv, root: string): { role: string; interactiveCoordinator: boolean } {
	if (env.LIMEN_JOB !== "1") {
		return { role: "coordinator", interactiveCoordinator: true };
	}
	const id = env.LIMEN_JOB_ID ?? "";
	if (!/^[A-Za-z0-9._-]+$/.test(id)) {
		return { role: "worker", interactiveCoordinator: false };
	}
	const file = join(env.LIMEN_CONTEXT_ROOT || root, ".limen/jobs", id, "role");
	const role = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
	return { role: role || "worker", interactiveCoordinator: false };
}

/** The block the communication hook appends to the system prompt and `limen permissions` prints (design §4.5 A). */
export function renderPermissions(e: Effective): string {
	const file = displayPath(autonomyFile(process.env));
	const head = e.error
		? `Permissions for this repo (config error in ${file}: ${e.error}; every permission is deny; role ${e.role}):`
		: `Permissions for this repo (profile "${e.profile}", rule "${e.rule}" in ${file}; role ${e.role}):`;
	const lines = PERMISSIONS.map((permission) => {
		const { level, source } = e.values[permission];
		return level === "allow" ? `- ${permission}: allow` : `- ${permission}: ${level} (${source})`;
	});
	const tail =
		"Push, PRs, and merges go only through `limen push|pr|merge`. Direct `git push` and `gh pr` are blocked.";
	return [head, ...lines, tail].join("\n");
}

/** `git@host:o/r.git`, `https://host/o/r`, `ssh://user@host/o/r.git` → `host/o/r`. */
export function normalizeRemote(url: string): string {
	let text = url
		.trim()
		.replace(/\/+$/, "")
		.replace(/\.git$/, "");
	const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(text);
	if (scheme) {
		text = text.slice(scheme[0].length);
	} else {
		text = text.replace(/^([^/@]+@)?([^/:]+):/, "$1$2/");
	}
	text = text.replace(/^[^/@]+@/, "");
	const slash = text.indexOf("/");
	const host = (slash < 0 ? text : text.slice(0, slash)).replace(/:\d+$/, "").toLowerCase();
	return slash < 0 ? host : `${host}${text.slice(slash)}`;
}

/** `*` matches inside one segment; a `**` segment matches any number of segments. */
export function globMatch(pattern: string, target: string): boolean {
	return segmentsMatch(pattern.split("/").filter(Boolean), target.split("/").filter(Boolean));
}

function segmentsMatch(pattern: readonly string[], target: readonly string[]): boolean {
	const [head, ...rest] = pattern;
	if (head === undefined) {
		return target.length === 0;
	}
	if (head === "**") {
		return target.some((_, index) => segmentsMatch(rest, target.slice(index))) || segmentsMatch(rest, []);
	}
	const [first, ...others] = target;
	if (first === undefined) {
		return false;
	}
	const parts = head.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
	const regex = new RegExp(`^${parts.join("[^/]*")}$`);
	return regex.test(first) && segmentsMatch(rest, others);
}

function matchRule(config: Config, root: string): Rule {
	const repo = repoId(root);
	const path = canonical(root);
	for (const rule of config.repos) {
		const local = rule.match.startsWith("/") || rule.match.startsWith("~");
		if (local ? globMatch(expandHome(rule.match), path) : repo !== "" && globMatch(rule.match, repo)) {
			return rule;
		}
	}
	return { match: "default", profile: config.default, protected: [], mergeMethod: "squash" };
}

/** The normalized `origin` URL, or "" when the root has none. */
export function repoId(root: string): string {
	const result = spawnSync("git", ["-C", root, "remote", "get-url", "origin"], { encoding: "utf8" });
	return result.status === 0 ? normalizeRemote(result.stdout) : "";
}

function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function expandHome(pattern: string): string {
	if (pattern !== "~" && !pattern.startsWith("~/")) {
		return pattern;
	}
	return `${canonical(process.env.HOME || homedir())}${pattern.slice(1)}`;
}

function displayPath(path: string): string {
	const home = process.env.HOME || homedir();
	return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function deniedAll(role: string, error: string): Effective {
	const value = { level: "deny", source: "config error" } as const;
	return {
		profile: "",
		rule: "",
		role,
		values: { canCommit: value, canPush: value, canOpenPr: value, canMerge: value },
		protected: [],
		mergeMethod: "squash",
		error,
	};
}

function parseConfig(text: string): Config {
	const data = objectOf(JSON.parse(text), "the file");
	const profiles = new Map<string, Profile>();
	for (const [name, value] of Object.entries(objectOf(data.profiles, "profiles"))) {
		profiles.set(name, parseLevels(value, `profile "${name}"`, true) as Profile);
	}
	const fallback = data.default;
	if (typeof fallback !== "string" || !profiles.has(fallback)) {
		throw new Error(`default must name a profile`);
	}
	const repos = data.repos ?? [];
	if (!Array.isArray(repos)) {
		throw new Error("repos must be an array");
	}
	return { profiles, repos: repos.map((entry, index) => parseRule(entry, index, profiles)), default: fallback };
}

function parseRule(entry: unknown, index: number, profiles: ReadonlyMap<string, Profile>): Rule {
	const rule = objectOf(entry, `repos[${index}]`);
	const where = `repos[${index}]`;
	if (typeof rule.match !== "string" || !rule.match) {
		throw new Error(`${where}.match must be a non-empty string`);
	}
	if (typeof rule.profile !== "string" || !profiles.has(rule.profile)) {
		throw new Error(`${where}.profile must name a profile`);
	}
	const branches = rule.protected ?? [];
	if (!Array.isArray(branches) || !branches.every((item) => typeof item === "string")) {
		throw new Error(`${where}.protected must be an array of strings`);
	}
	const method = rule.mergeMethod ?? "squash";
	if (!isMergeMethod(method)) {
		throw new Error(`${where}.mergeMethod must be squash, merge or rebase`);
	}
	return { match: rule.match, profile: rule.profile, protected: branches, mergeMethod: method };
}

function isMergeMethod(value: unknown): value is Effective["mergeMethod"] {
	return MERGE_METHODS.some((method) => method === value);
}

/** Levels per permission; `complete` requires all four. `ask` is never valid for canCommit: local commits have no approval. */
function parseLevels(value: unknown, where: string, complete: boolean): Narrowing {
	const record = objectOf(value, where);
	const levels: Partial<Record<Permission, Level>> = {};
	for (const [key, level] of Object.entries(record)) {
		if (!PERMISSIONS.includes(key as Permission)) {
			throw new Error(`${where}: unknown permission ${key}`);
		}
		if (!LEVELS.includes(level as Level)) {
			throw new Error(`${where}.${key} must be allow, ask or deny`);
		}
		if (key === "canCommit" && level === "ask") {
			throw new Error(`${where}.canCommit cannot be ask; use allow or deny`);
		}
		levels[key as Permission] = level as Level;
	}
	const missing = complete ? PERMISSIONS.filter((permission) => !levels[permission]) : [];
	if (missing.length) {
		throw new Error(`${where} must list ${missing.join(", ")}`);
	}
	return levels;
}

function readNarrowing(root: string): Narrowing {
	const path = join(root, PROJECT_FILE);
	if (!existsSync(path)) {
		return {};
	}
	try {
		return parseLevels(JSON.parse(readFileSync(path, "utf8")), PROJECT_FILE, false);
	} catch (error) {
		throw new Error(`${PROJECT_FILE}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function objectOf(value: unknown, where: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${where} must be a JSON object`);
	}
	return value as Record<string, unknown>;
}
