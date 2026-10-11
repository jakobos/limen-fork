import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Effective, Permission } from "../src/project/autonomy.ts";
import { autonomyFile, callerRole, effectivePermissions } from "../src/project/autonomy.ts";
import type { BashFinding } from "../src/project/bash-classify.ts";
import { classifyBash } from "../src/project/bash-classify.ts";

type Context = { readonly cwd: string };
type ToolCall = { readonly toolName: string; readonly input?: Readonly<Record<string, unknown>> };
type Block = { block: true; reason: string };
type PiApi = { on(event: "tool_call", handler: (event: ToolCall, context: Context) => Block | undefined): void };

const HARNESS: Record<Permission, string> = {
	canCommit: "limen permissions",
	canPush: "limen push <job>",
	canOpenPr: "limen pr <job> --body-file F",
	canMerge: "limen merge <job>",
};
const PROTECTED_ADVICE =
	"Agents cannot change permissions, approvals, or the limen loader. " +
	"Ask the owner to edit it; `limen permissions` shows the current values.";
const HASHLINE_HEADER = /^\s*(?:\[(.+)#[0-9A-Fa-f]{4}\]|¶+(.+?)(?:#[0-9A-Fa-f]{4})?|MV\s+(.+?))\s*$/;

/**
 * The tool-call guard (design §4.5 B). Commits follow canCommit; direct remote actions, `limen approve`, a job's
 * `limen push|pr|merge` and writes to permission files are always blocked. It fails closed: an error blocks the call.
 */
export default function permissions(pi: PiApi): void {
	pi.on("tool_call", (event, context) => {
		try {
			return guard(event, context.cwd);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { block: true, reason: `limen permission guard failed closed: ${message}` };
		}
	});
}

function guard(event: ToolCall, cwd: string): Block | undefined {
	const input = event.input ?? {};
	const home = process.env.HOME || homedir();
	if (event.toolName === "bash") {
		const findings = typeof input.command === "string" ? classifyBash(input.command, home) : [];
		return findings.length > 0 ? bashBlock(findings, cwd) : undefined;
	}
	if (event.toolName !== "write" && event.toolName !== "edit") {
		return undefined;
	}
	const target = targetPaths(input)
		.map((path) => resolve(cwd, path.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, home)))
		.find(
			(path) =>
				path === autonomyFile(process.env) ||
				path.startsWith(join(home, ".config/limen/")) ||
				/\/\.limen\/jobs\/[^/]+\/approvals(\/|$)/.test(path) ||
				/\/\.(omp|pi)\/extensions\/limen\.ts$/.test(path),
		);
	return target
		? {
				block: true,
				reason: `${event.toolName} to ${target} is blocked: ${PROTECTED_ADVICE}`,
			}
		: undefined;
}

/** `path`, OMP's derived `paths`, and hashline `[PATH#TAG]` / `MV DEST` lines of an edit. */
function targetPaths(input: Readonly<Record<string, unknown>>): string[] {
	const paths = [input.path, input.file_path, ...(Array.isArray(input.paths) ? input.paths : [])];
	for (const text of [input.input, input._input]) {
		for (const line of typeof text === "string" ? text.split("\n") : []) {
			const match = HASHLINE_HEADER.exec(line);
			paths.push(match?.[1] ?? match?.[2] ?? match?.[3]?.replace(/^(["'])(.*)\1$/, "$2"));
		}
	}
	return paths.filter((path): path is string => typeof path === "string" && path.length > 0);
}

function bashBlock(findings: readonly BashFinding[], cwd: string): Block | undefined {
	const root = process.env.LIMEN_CONTEXT_ROOT || cwd;
	let effective: Effective | undefined;
	const resolveEffective = (): Effective => {
		if (!effective) {
			const { role, interactiveCoordinator } = callerRole(process.env, root);
			effective = effectivePermissions(root, role, interactiveCoordinator);
		}
		return effective;
	};
	for (const finding of findings) {
		const reason = refusal(finding, resolveEffective);
		if (reason) {
			return { block: true, reason };
		}
	}
	return undefined;
}

function refusal(finding: BashFinding, resolveEffective: () => Effective): string | undefined {
	const job = process.env.LIMEN_JOB === "1";
	const blocked = `\`${finding.command}\` is blocked`;
	if (finding.action === "approve") {
		return (
			`${blocked}: only the human records approvals, whatever the permissions say. ` +
			"Ask the owner to run `limen approve <job> <push|pr|merge>` in their terminal."
		);
	}
	if (finding.action === "protected-path") {
		return `${blocked}: it writes ${autonomyFile(process.env)}, job approvals, or a limen loader. ${PROTECTED_ADVICE}`;
	}
	if (finding.action === "harness-remote" && !job) {
		return undefined;
	}
	const effective = resolveEffective();
	const permission = finding.permission ?? "canPush";
	const { level, source } = effective.values[permission];
	if (finding.action === "commit" && level === "allow") {
		return undefined;
	}
	const error = effective.error ? `: ${effective.error}` : "";
	const file = autonomyFile(process.env);
	const detail = `${permission} is ${level} (${source}${error}; ${file}) for role ${effective.role}`;
	if (finding.action === "commit") {
		return `${blocked}: ${detail}. Run \`limen permissions\` to see why.`;
	}
	const harness = HARNESS[permission];
	return finding.action === "harness-remote"
		? `${blocked} in job sessions: ${detail}. Finish with a handoff; the coordinator runs \`${harness}\`.`
		: `${blocked}: agents never push, open PRs, or merge directly; ${detail}. ` +
				`Use \`${harness}\`${job ? " from the coordinator (finish with a handoff)" : ""}.`;
}
