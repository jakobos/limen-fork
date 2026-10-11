import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import type { Effective, Permission } from "./autonomy.ts";

/** A remote action an owner can approve for one job at one commit. */
export type ApprovalAction = "push" | "pr" | "merge";
export const APPROVAL_ACTIONS: readonly ApprovalAction[] = ["push", "pr", "merge"];

export function approvalPath(jobDir: string, action: ApprovalAction): string {
	return `${jobDir}/approvals/${action}`;
}

/** Records the owner's approval of `action` for the job's branch head `sha`. */
export async function writeApproval(jobDir: string, action: ApprovalAction, sha: string): Promise<void> {
	await mkdir(`${jobDir}/approvals`, { recursive: true });
	const record = { sha, at: new Date().toISOString() };
	await writeFile(approvalPath(jobDir, action), `${JSON.stringify(record)}\n`);
}

/** An approval holds only for the commit it names: a new commit on the branch makes it invalid. */
export function approvalValid(jobDir: string, action: ApprovalAction, head: string): boolean {
	try {
		const record: unknown = JSON.parse(readFileSync(approvalPath(jobDir, action), "utf8"));
		return typeof record === "object" && record !== null && "sha" in record && record.sha === head;
	} catch {
		return false;
	}
}

/**
 * Refuses unless `permission` is `allow`, or `ask` with a valid approval for one of `actions` at `head`.
 * `what` names the refused step, such as `push`.
 */
export function requirePermission(
	effective: Effective,
	permission: Permission,
	gate: {
		readonly what: string;
		readonly jobDir: string;
		readonly head: string;
		readonly actions: readonly ApprovalAction[];
	},
): void {
	const { level, source } = effective.values[permission];
	if (level === "allow") {
		return;
	}
	const reason = effective.error ? `; ${effective.error}` : "";
	const where = `profile "${effective.profile}", role ${effective.role}`;
	if (level === "deny") {
		throw new Error(`${gate.what} refused: ${permission} is deny (${source}; ${where})${reason}`);
	}
	if (gate.actions.some((action) => approvalValid(gate.jobDir, action, gate.head))) {
		return;
	}
	const job = gate.jobDir.split("/").at(-1) ?? "";
	throw new Error(
		`${gate.what} refused: ${permission} is ask (${source}; ${where}) and no approval holds for ${gate.head.slice(0, 12)}.` +
			` The owner runs: limen approve ${job} ${gate.actions[0] ?? gate.what}`,
	);
}
