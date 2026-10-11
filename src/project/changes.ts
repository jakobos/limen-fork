import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Frontmatter, parseFrontmatter } from "../picture/frontmatter.ts";
import type { Diagnostic } from "../picture/picture-model.ts";
import { unlandedBranches, workspaceRepository } from "./git.ts";
import { changePointers } from "./planning.ts";

/** One dx change or effort, read from its identity file's front matter. Prose is never parsed. */
export type ChangeRecord = {
	readonly kind: "change" | "effort";
	readonly id: string;
	/** Root-relative folder, ending with "/". */
	readonly path: string;
	readonly title: string;
	readonly status: string;
	readonly effort?: string;
	readonly archivedAt?: string;
	/** Map place ids; with the other picture fields, optional extra front matter keys. */
	readonly touches: readonly string[];
	/** The front matter line of each place id, for diagnostics. */
	readonly touchLines: Readonly<Record<string, number>>;
	readonly opened?: string;
	readonly needsOwner?: { readonly ask: string; readonly on: string };
	readonly wrong?: { readonly problem: string; readonly on: string };
	readonly landed?: string;
};
export type BoardRow = {
	readonly kind: ChangeRecord["kind"];
	readonly id: string;
	readonly title: string;
	readonly status: string;
	readonly note: string;
};
export type Board = { now: BoardRow[]; next: BoardRow[]; recent: BoardRow[] };
/** A job record as the board reads it: the change ids come from its task's `Change:` pointers. */
export type BoardJob = {
	readonly id: string;
	readonly state: string;
	readonly branch: string;
	readonly changes: readonly string[];
};

type Kind = ChangeRecord["kind"];
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Report = (level: Diagnostic["level"], code: string, problem: string, fix: string, line: number) => void;

const FOLDERS = ["changes", "efforts", "archive"] as const;
const IDENTITY: Readonly<Record<Kind, string>> = { change: "change.md", effort: "effort.md" };
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CLOSED: Readonly<Record<string, true>> = { archived: true, dropped: true };
const WORKING: Readonly<Record<string, true>> = { implementing: true, implemented: true, reviewed: true };
const RECENT_ROWS = 10;

/** Every change and effort under `context/changes`, `context/efforts` and `context/archive`, with its diagnostics. */
export function readChanges(root: string): Promise<{ records: ChangeRecord[]; diagnostics: Diagnostic[] }> {
	return Promise.resolve(scanChanges(root));
}

/** Ids of changes and efforts whose status is archived or dropped. */
export function closedChanges(root: string): ReadonlySet<string> {
	return new Set(
		scanChanges(root)
			.records.filter((record) => Object.hasOwn(CLOSED, record.status))
			.map((record) => record.id),
	);
}

/** Unknown map place ids are errors at the touches line, never silent links. */
export function checkTouches(records: readonly ChangeRecord[], placeIds: ReadonlySet<string>): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	for (const record of records) {
		for (const place of record.touches.filter((id) => !placeIds.has(id))) {
			diagnostics.push({
				level: "error",
				code: "change.unknown-touch",
				message: `unknown place id "${place}"; fix: replace it with the id: of a module or plant file in the map's nodes/ folder`,
				source: identityPath(record),
				id: record.id,
				line: record.touchLines[place] ?? 1,
			});
		}
	}
	return diagnostics;
}

export function identityPath(record: Pick<ChangeRecord, "kind" | "path">): string {
	return `${record.path}${IDENTITY[record.kind]}`;
}

function scanChanges(root: string): { records: ChangeRecord[]; diagnostics: Diagnostic[] } {
	const records: ChangeRecord[] = [];
	const diagnostics: Diagnostic[] = [];
	for (const folder of FOLDERS) {
		for (const name of directories(join(root, "context", folder))) {
			const record = readRecord(root, `context/${folder}/${name}/`, folder === "archive", diagnostics);
			if (record) {
				records.push(record);
			}
		}
	}
	return { records, diagnostics };
}

function directories(path: string): string[] {
	if (!existsSync(path)) {
		return [];
	}
	return readdirSync(path, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
}

function readRecord(
	root: string,
	path: string,
	archived: boolean,
	diagnostics: Diagnostic[],
): ChangeRecord | undefined {
	const kind: Kind | undefined = existsSync(join(root, path, IDENTITY.change))
		? "change"
		: existsSync(join(root, path, IDENTITY.effort))
			? "effort"
			: undefined;
	if (!kind) {
		return undefined;
	}
	const source = identityPath({ kind, path });
	const name = path.split("/").at(-2) ?? "";
	const folderId = archived ? name.replace(/^\d{4}-\d{2}-\d{2}-/, "") : name;
	const report: Report = (level, code, problem, fix, line) => {
		diagnostics.push({ level, code, message: `${problem}; fix: ${fix}`, source, id: folderId, line });
	};
	const text = readFileSync(join(root, source), "utf8");
	if (!text.replace(/^\uFEFF/, "").startsWith("---")) {
		report("error", "change.no-front-matter", `${source} has no front matter`, "add the dx front matter block", 1);
		return undefined;
	}
	const fm = parseFrontmatter(text);
	for (const error of fm.errors) {
		report(
			"error",
			"change.bad-field",
			error.message,
			"write this line as `key: value`, or as a YAML list",
			error.line,
		);
	}
	if (!fm.ok) {
		return undefined;
	}
	const record = identity(fm, kind, path, folderId, name, archived, report);
	pictureFields(fm, record, report);
	return record;
}

function identity(
	fm: Frontmatter,
	kind: Kind,
	path: string,
	folderId: string,
	name: string,
	archived: boolean,
	report: Report,
): Mutable<ChangeRecord> {
	const key = kind === "change" ? "change_id" : "effort_id";
	const value = fm.data[key];
	const line = (field: string): number => fm.lines[field] ?? 1;
	let id = folderId;
	if (typeof value !== "string" || !ID.test(value)) {
		report(
			"error",
			"change.bad-id",
			`${key} is missing or not a kebab-case id`,
			`set "${key}: ${folderId}"`,
			line(key),
		);
	} else if (value !== folderId) {
		const want = archived ? `<date>-${value}` : value;
		report(
			"error",
			"change.bad-id",
			`folder ${name} does not match ${key} ${value}`,
			`rename the folder to ${want}`,
			line(key),
		);
		id = value;
	} else {
		id = value;
	}
	const status = typeof fm.data.status === "string" ? fm.data.status : "";
	const record: Mutable<ChangeRecord> = {
		kind,
		id,
		path,
		title: typeof fm.data.title === "string" && fm.data.title.trim() ? fm.data.title.trim() : id,
		status,
		touches: [],
		touchLines: {},
	};
	if (typeof fm.data.effort === "string" && fm.data.effort) {
		record.effort = fm.data.effort;
	}
	const archivedAt = fm.data.archived_at;
	if (typeof archivedAt === "string" && validDate(archivedAt)) {
		record.archivedAt = archivedAt;
	}
	closedPlace(record, archived, line, report);
	return record;
}

/** Closed work (status archived or dropped, with archived_at) lives in context/archive/, and only there. */
function closedPlace(record: ChangeRecord, archived: boolean, line: (field: string) => number, report: Report): void {
	if (!archived) {
		if (Object.hasOwn(CLOSED, record.status)) {
			const fix = `move it with /dx-archive ${record.id} or limen drop ${record.id}`;
			report("error", "change.archive", `status ${record.status} outside context/archive/`, fix, line("status"));
		}
		return;
	}
	if (!Object.hasOwn(CLOSED, record.status)) {
		const problem = `an archived ${record.kind} has status "${record.status}"`;
		report("error", "change.archive", problem, 'set "status: archived" or "status: dropped"', line("status"));
	}
	if (!record.archivedAt) {
		report(
			"error",
			"change.archive",
			"archived_at is not a real date",
			'set "archived_at: YYYY-MM-DD"',
			line("archived_at"),
		);
	}
}

function pictureFields(fm: Frontmatter, record: Mutable<ChangeRecord>, report: Report): void {
	const date = (key: string): string | undefined => {
		const value = fm.data[key];
		if (value === undefined || value === null) {
			return undefined;
		}
		if (typeof value !== "string" || !validDate(value)) {
			report(
				"error",
				"change.bad-field",
				`${key} must be a real YYYY-MM-DD date`,
				`set "${key}" to a real date`,
				fm.lines[key] ?? 1,
			);
			return undefined;
		}
		return value;
	};
	const opened = date("opened") ?? date("created");
	const landed = date("landed");
	if (opened) {
		record.opened = opened;
	}
	if (landed) {
		record.landed = landed;
	}
	touchList(fm, record, report);
	const needs = datedLine(fm, "needs-owner", date, report);
	if (needs) {
		record.needsOwner = { ask: needs.text, on: needs.on };
	}
	const wrong = datedLine(fm, "wrong", date, report);
	if (wrong) {
		record.wrong = { problem: wrong.text, on: wrong.on };
	}
	if (record.status === "implementing" && record.touches.length === 0) {
		const fix = 'add a "touches:" list with verified map place ids when known';
		report("warn", "change.no-touches", `${record.kind} in implementing has no touches`, fix, 1);
	}
}

function touchList(fm: Frontmatter, record: Mutable<ChangeRecord>, report: Report): void {
	const touches = fm.data.touches;
	if (touches === undefined) {
		return;
	}
	const first = fm.lines.touches ?? 1;
	if (!Array.isArray(touches)) {
		report("error", "change.bad-field", "touches must be a list of place ids", "write touches as a YAML list", first);
		return;
	}
	const lines: Record<string, number> = {};
	for (const [index, value] of touches.entries()) {
		const line = fm.lines[`touches.${index}`] ?? first;
		if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
			report("error", "change.bad-field", "touches entries must be place ids", "write one place id per entry", line);
		} else if (Object.hasOwn(lines, value)) {
			report("error", "change.bad-field", `duplicate place id "${value}"`, "remove the repeated entry", line);
		} else {
			lines[value] = line;
		}
	}
	record.touches = Object.keys(lines);
	record.touchLines = lines;
}

/** A one-line text field with its `<key>-on` date: `needs-owner` with `needs-owner-on`, `wrong` with `wrong-on`. */
function datedLine(
	fm: Frontmatter,
	key: string,
	date: (key: string) => string | undefined,
	report: Report,
): { readonly text: string; readonly on: string } | undefined {
	const dateKey = `${key}-on`;
	const value = fm.data[key];
	const on = date(dateKey);
	if (value === undefined) {
		if (fm.data[dateKey] !== undefined) {
			report(
				"error",
				"change.bad-field",
				`${dateKey} needs ${key}`,
				`add "${key}" as one line`,
				fm.lines[dateKey] ?? 1,
			);
		}
		return undefined;
	}
	if (typeof value !== "string" || !value.trim() || value !== value.trim() || /[\r\n]/.test(value)) {
		report(
			"error",
			"change.bad-field",
			`${key} must be one nonempty line`,
			`write "${key}" as one line`,
			fm.lines[key] ?? 1,
		);
		return undefined;
	}
	if (!on) {
		if (fm.data[dateKey] === undefined) {
			report(
				"error",
				"change.bad-field",
				`${key} needs ${dateKey}`,
				`add "${dateKey}: YYYY-MM-DD"`,
				fm.lines[key] ?? 1,
			);
		}
		return undefined;
	}
	return { text: value, on };
}

function validDate(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		return false;
	}
	const timestamp = Date.parse(`${value}T00:00:00Z`);
	return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

/**
 * NOW: open work with a live or unlanded job, every change in implementing, implemented or reviewed, and efforts in
 * progress. NEXT: changes in new or planned with no such job. RECENT: the newest archive entries.
 */
export function deriveBoard(
	records: readonly ChangeRecord[],
	jobs: readonly BoardJob[],
	unlanded: ReadonlySet<string>,
): Board {
	const board: Board = { now: [], next: [], recent: [] };
	for (const record of records.filter((each) => !each.path.startsWith("context/archive/"))) {
		const row = { kind: record.kind, id: record.id, title: record.title, status: record.status };
		const job = jobs.find((each) => each.changes.includes(record.id) && each.state === "running");
		const pending = jobs.find(
			(each) => each.changes.includes(record.id) && each.state !== "running" && unlanded.has(each.branch),
		);
		if (record.kind === "effort") {
			if (record.status === "in-progress") {
				board.now.push({ ...row, note: effortNote(record, records) });
			}
		} else if (job || pending) {
			board.now.push({ ...row, note: job ? `job ${job.id} running` : `job ${pending?.id} unlanded` });
		} else if (Object.hasOwn(WORKING, record.status)) {
			const note = record.status === "implementing" ? "no live job" : `archive with /dx-archive ${record.id}`;
			board.now.push({ ...row, note });
		} else if (record.status === "new" || record.status === "planned") {
			board.next.push({ ...row, note: "" });
		}
	}
	board.recent = records
		.filter((record) => record.path.startsWith("context/archive/") && Object.hasOwn(CLOSED, record.status))
		.sort((a, b) => (b.archivedAt ?? "").localeCompare(a.archivedAt ?? "") || b.path.localeCompare(a.path))
		.slice(0, RECENT_ROWS)
		.map((record) => ({
			kind: record.kind,
			id: record.id,
			title: record.title,
			status: record.status === "archived" ? "landed" : record.status,
			note: record.archivedAt ?? "",
		}));
	return board;
}

function effortNote(effort: ChangeRecord, records: readonly ChangeRecord[]): string {
	const children = records.filter((record) => record.kind === "change" && record.effort === effort.id);
	const archived = children.filter((record) => record.status === "archived").length;
	return `${archived} of ${children.length} changes archived`;
}

/** The Markdown digest: `## NOW`, `## NEXT`, `## RECENT`, each only when it has a row; "" when all are empty. */
export function renderBoard(board: Board): string {
	const sections: string[] = [];
	for (const [heading, rows] of [
		["NOW", board.now],
		["NEXT", board.next],
		["RECENT", board.recent],
	] as const) {
		if (rows.length > 0) {
			sections.push([`## ${heading}`, ...rows.map(boardLine)].join("\n"));
		}
	}
	return sections.length > 0 ? `${sections.join("\n\n")}\n` : "";
}

function boardLine(row: BoardRow): string {
	const status = row.kind === "effort" ? `effort, ${row.status}` : row.status;
	if (!row.note) {
		return `- ${row.title} · ${row.id} (${status})`;
	}
	return row.note.match(/^\d{4}-\d{2}-\d{2}$/)
		? `- ${row.title} · ${row.id} (${status} ${row.note})`
		: `- ${row.title} · ${row.id} (${status}): ${row.note}`;
}

/** The board for this project: changes, job records under `.limen/jobs`, and which job branches are unlanded. */
export async function loadBoard(root: string): Promise<Board> {
	try {
		const { records } = await readChanges(root);
		if (records.length === 0) {
			return { now: [], next: [], recent: [] };
		}
		const jobs = await readBoardJobs(root);
		return deriveBoard(records, jobs, unlandedJobBranches(root, jobs));
	} catch {
		// The board informs a prompt; a broken job record or a Git failure leaves it empty, never fails the turn.
		return { now: [], next: [], recent: [] };
	}
}

async function readBoardJobs(root: string): Promise<(BoardJob & { readonly repo: string })[]> {
	const jobsRoot = join(root, ".limen", "jobs");
	const names = await readdir(jobsRoot).catch(() => [] as string[]);
	const jobs = await Promise.all(
		names.map(async (id) => {
			const read = (name: string): Promise<string> =>
				readFile(join(jobsRoot, id, name), "utf8").then(
					(value) => value.trim(),
					() => "",
				);
			const [state, branch, task, repo] = await Promise.all([
				read("state"),
				read("branch"),
				read("task.md"),
				read("repo"),
			]);
			return { id, state, branch, repo, changes: changePointers(task).map((pointer) => pointer.id) };
		}),
	);
	return jobs.filter((job) => job.state && job.changes.length > 0);
}

function unlandedJobBranches(
	root: string,
	jobs: readonly (BoardJob & { readonly repo: string })[],
): ReadonlySet<string> {
	const unlanded = new Set<string>();
	const finished = jobs.filter((job) => job.state !== "running" && job.branch);
	for (const [repo, group] of Map.groupBy(finished, (job) => job.repo)) {
		try {
			const repository = repo ? workspaceRepository(root, repo) : root;
			for (const branch of unlandedBranches(
				repository,
				group.map((job) => job.branch),
			)) {
				unlanded.add(branch);
			}
		} catch {
			// A repository Git cannot read lands nothing on the board.
		}
	}
	return unlanded;
}
