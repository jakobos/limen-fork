import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ChangeRecord, identityPath, readChanges } from "../project/changes.ts";
import { limenRoot } from "../project/git.ts";
import { changePointers } from "../project/planning.ts";

/**
 * `limen drop <id> "<reason>"`: stamp the change or effort `status: dropped` with `archived_at`, add the reason under
 * `## Notes`, and move its folder to `context/archive/<today>-<id>/`. An effort drops each child that is not closed.
 * It refuses while a running job's task names any of them, and it never commits.
 */
export async function dropCommand(args: readonly string[], cwd: string): Promise<void> {
	const [id, reason, ...extra] = args;
	if (!id || !reason?.trim() || extra.length > 0 || /[\r\n]/.test(reason)) {
		throw new Error('drop requires a change or effort id and a one-line reason: limen drop <id> "<reason>"');
	}
	const root = limenRoot(cwd);
	const { records } = await readChanges(root);
	const open = records.filter((record) => !record.path.startsWith("context/archive/"));
	const target = open.find((record) => record.id === id);
	if (!target) {
		const archived = records.find((record) => record.id === id);
		throw new Error(
			archived ? `${id} is already in ${archived.path}` : `no context/changes/${id}/ or context/efforts/${id}/`,
		);
	}
	const children =
		target.kind === "effort"
			? open.filter((record) => record.kind === "change" && record.effort === id && record.status !== "archived")
			: [];
	const dropped = [...children, target];
	await refuseLiveJobs(root, dropped);
	const today = localDate(new Date());
	for (const record of dropped) {
		if (existsSync(join(root, "context", "archive", `${today}-${record.id}`))) {
			throw new Error(`context/archive/${today}-${record.id}/ already exists; nothing was moved`);
		}
	}
	await mkdir(join(root, "context", "archive"), { recursive: true });
	for (const record of dropped) {
		const note = record === target ? reason.trim() : `Its effort ${id} was dropped: ${reason.trim()}`;
		const destination = await dropOne(root, record, today, note);
		console.log(`dropped ${record.id} -> ${destination}`);
	}
}

/** Refuse while any running job's task names one of these ids with a `Change:` pointer; nothing has changed yet. */
async function refuseLiveJobs(root: string, records: readonly ChangeRecord[]): Promise<void> {
	const ids = new Set(records.map((record) => record.id));
	const jobsRoot = join(root, ".limen", "jobs");
	for (const job of await readdir(jobsRoot).catch(() => [] as string[])) {
		const read = (name: string): Promise<string> => readFile(join(jobsRoot, job, name), "utf8").catch(() => "");
		if ((await read("state")).trim() !== "running") {
			continue;
		}
		const named = changePointers(await read("task.md")).find((pointer) => ids.has(pointer.id));
		if (named) {
			throw new Error(`job ${job} is running on ${named.id}; stop it or let it finish before limen drop`);
		}
	}
}

async function dropOne(root: string, record: ChangeRecord, today: string, reason: string): Promise<string> {
	const file = join(root, identityPath(record));
	await writeFile(file, stampDropped(await readFile(file, "utf8"), today, reason));
	const destination = `context/archive/${today}-${record.id}/`;
	const moved = spawnSync("git", ["mv", record.path, destination], { cwd: root, encoding: "utf8" });
	if (moved.status !== 0) {
		// An uncommitted change folder is not under version control; move it on disk, as dx-archive does.
		console.error(`warning: git mv failed (${moved.stderr.trim()}); moved ${record.path} without Git`);
		await rename(join(root, record.path), join(root, destination));
	}
	return destination;
}

/** Sets status, archived_at and updated in the front matter, and appends the dated reason to `## Notes`. */
function stampDropped(text: string, today: string, reason: string): string {
	const end = text.indexOf("\n---", 3);
	if (!text.startsWith("---") || end < 0) {
		throw new Error("the identity file has no front matter fence; fix it before limen drop");
	}
	let head = text.slice(0, end);
	for (const [key, value] of [
		["status", "dropped"],
		["archived_at", today],
		["updated", today],
	] as const) {
		const line = new RegExp(`^${key}:.*$`, "m");
		head = line.test(head) ? head.replace(line, `${key}: ${value}`) : `${head}\n${key}: ${value}`;
	}
	const body = text.slice(end);
	const entry = `Dropped ${today}: ${reason}`;
	const notes = /^## Notes[ \t]*$/m.exec(body);
	if (!notes) {
		return `${head}${body.trimEnd()}\n\n## Notes\n\n${entry}\n`;
	}
	const after = notes.index + notes[0].length;
	const next = body.slice(after).search(/^## /m);
	const cut = next < 0 ? body.length : after + next;
	const section = body.slice(0, cut).trimEnd();
	const rest = body.slice(cut);
	return `${head}${section}\n\n${entry}\n${rest ? `\n${rest}` : ""}`;
}

function localDate(now: Date): string {
	const month = String(now.getMonth() + 1).padStart(2, "0");
	return `${now.getFullYear()}-${month}-${String(now.getDate()).padStart(2, "0")}`;
}
