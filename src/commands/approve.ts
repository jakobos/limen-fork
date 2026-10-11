import { createReadStream, createWriteStream, openSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { APPROVAL_ACTIONS, writeApproval } from "../project/approval.ts";
import { remoteJob } from "./push.ts";

/**
 * `limen approve <job> <push|pr|merge>`: the owner types the job id again on `/dev/tty`, and the approval holds for
 * the branch head of this moment. An agent's tool shell has no terminal, so it cannot answer.
 */
export async function approveCommand(args: readonly string[], cwd: string): Promise<void> {
	if (process.env.LIMEN_JOB === "1") {
		throw new Error("limen approve is for the owner's own terminal, not a job session");
	}
	const [query, action, ...extra] = args.filter((word) => word !== "");
	const known = APPROVAL_ACTIONS.find((each) => each === action);
	if (!query || !known || extra.length > 0) {
		throw new Error(`usage: limen approve <job> <${APPROVAL_ACTIONS.join("|")}>`);
	}
	const job = await remoteJob(cwd, query);
	const typed = await askTerminal(
		`Approve ${known} for job ${job.id}, branch ${job.branch} at ${job.head.slice(0, 12)}.\n` +
			"Type the job id again to approve: ",
	);
	if (typed !== job.id) {
		throw new Error("approval cancelled: the typed id does not match the job id");
	}
	await writeApproval(job.jobDir, known, job.head);
	console.log(`approved ${known} for ${job.id} at ${job.head.slice(0, 12)}`);
}

async function askTerminal(question: string): Promise<string> {
	let fd: number;
	try {
		fd = openSync("/dev/tty", "r+");
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`limen approve needs a terminal; run it yourself in a shell (${reason})`);
	}
	const input = createReadStream("", { fd });
	const output = createWriteStream("", { fd, autoClose: false });
	const rl = createInterface({ input, output });
	try {
		return (await rl.question(question)).trim();
	} finally {
		rl.close();
		input.destroy();
	}
}
