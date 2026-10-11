import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { callerRole, effectivePermissions, renderPermissions } from "../src/project/autonomy.ts";
import { loadBoard, renderBoard } from "../src/project/changes.ts";
import { formatDrift, inheritFile, listDrift, readOptional } from "../src/project/inherit.ts";
import {
	changePointers,
	planningSource,
	privatePlanningGuidance,
	recordedPlanningSource,
} from "../src/project/planning.ts";
import { assistantStopReason } from "../src/runtime/stream.ts";

const CONTEXT_TYPE = "limen-project-context";
const MAX_CONTEXT_LINES = 1000;
const STANDARDS_DIR = "context/standards/global/";
const VISION_FILE = "context/foundation/vision.md";
const WORKING_RULES_FILE = ".agents/limen/working-rules.md";
const MAX_REMINDER_HEADINGS = 8;
const jevgrepSeen = new Map<string, boolean>();

type Context = { readonly cwd: string };
type Message = { readonly customType: string; readonly content: string; readonly display: boolean };
type StartEvent = { readonly prompt?: string; readonly systemPrompt?: string };
type StartResult = { readonly message?: Message; readonly systemPrompt?: string };
type ToolContent = { readonly type: string; readonly text?: string };
type ToolEvent = {
	readonly toolName?: string;
	readonly input?: Record<string, unknown>;
	readonly content?: readonly ToolContent[];
};
type ToolPatch = { readonly content: ToolContent[] };
type PiApi = {
	on(
		event: "before_agent_start",
		handler: (event: StartEvent, context: Context) => Promise<StartResult | undefined>,
	): void;
	on(event: "message_end", handler: (event: unknown) => void): void;
	on(event: "tool_result", handler: (event: ToolEvent, context: Context) => ToolPatch | undefined): void;
};

type ReminderKind = "specs" | "style" | "vision";

/** Stable guidance rides the system prompt once per call. The per-turn note is a short cue; tool results recall the rule that applies. */
export default function limenCommunication(pi: PiApi): void {
	let lastTouch: string | undefined;
	let lastFailure: string | undefined;
	pi.on("before_agent_start", async (event, context) => {
		const root = process.env.LIMEN_CONTEXT_ROOT ?? context.cwd;
		const job = process.env.LIMEN_JOB === "1";
		const touched = lastTouch;
		const failed = lastFailure;
		lastTouch = undefined;
		lastFailure = undefined;
		const extra = await guidancePrompt(root, job);
		const message = {
			customType: CONTEXT_TYPE,
			content: turnCue(root, job, isWakePrompt(event.prompt), touched, failed),
			display: false,
		};
		if (!extra) {
			return { message };
		}
		return {
			message,
			systemPrompt: event.systemPrompt ? `${event.systemPrompt}\n\n${extra}` : extra,
		};
	});
	pi.on("message_end", (event) => {
		if (!event || typeof event !== "object" || !("message" in event)) {
			return;
		}
		const message = event.message;
		if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant") {
			return;
		}
		lastFailure = assistantStopReason(message) || undefined;
	});
	pi.on("tool_result", (event, context) => {
		const kind = reminderKind(event);
		if (!kind) {
			return;
		}
		lastTouch = touchLine(event, kind);
		const root = process.env.LIMEN_CONTEXT_ROOT ?? context.cwd;
		const reminder = kind === "specs" ? registerCue(root, "Specs") : projectReminder(root, kind);
		if (!reminder) {
			return;
		}
		return { content: appendText(event.content, reminder) };
	});
}

function isWakePrompt(prompt: string | undefined): boolean {
	return typeof prompt === "string" && prompt.startsWith("Limen job ");
}

async function guidancePrompt(cwd: string, job: boolean): Promise<string> {
	const parts: string[] = [];
	if (privatePlanning(cwd, job)) {
		parts.push(privatePlanningGuidance(cwd));
	}
	if (!job) {
		parts.push(readInheritedAgents(cwd));
	}
	parts.push(readRegister(cwd));
	if (hasJevgrep()) {
		parts.push(registerCue(cwd, "Search"));
	}
	if (!job) {
		parts.push(boundFile(cwd, VISION_FILE, "Vision"));
	}
	parts.push(boundText(readStandards(cwd), STANDARDS_DIR, "Standards"));
	if (!job) {
		parts.push(boundFile(cwd, WORKING_RULES_FILE, "Working rules"));
		parts.push(boundText(renderBoard(await loadBoard(cwd)), "limen board", "Board"));
	}
	parts.push(permissionsBlock(cwd));
	return parts.filter(Boolean).join("\n\n");
}

/** Read fresh on every turn, so an edit to either autonomy file applies to the next turn. Never throws. */
function permissionsBlock(root: string): string {
	try {
		const caller = callerRole(process.env, root);
		return renderPermissions(effectivePermissions(root, caller.role, caller.interactiveCoordinator));
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return `Permissions for this repo could not be computed (${reason}); treat push, PRs, and merges as denied.`;
	}
}

/** Every global standard in name order, as one text; the caller bounds the total. */
function readStandards(cwd: string): string {
	const dir = join(cwd, STANDARDS_DIR);
	if (!existsSync(dir)) {
		return "";
	}
	return readdirSync(dir)
		.filter((name) => name.endsWith(".md"))
		.sort()
		.map((name) => readOptional(join(dir, name)) ?? "")
		.join("\n\n");
}

/** `jg` is a common name; only Jevgrep's help mentions Jevgrep. Probed once per PATH. */
function hasJevgrep(): boolean {
	const path = process.env.PATH ?? "";
	const seen = jevgrepSeen.get(path);
	if (seen !== undefined) {
		return seen;
	}
	const help = spawnSync("jg", ["--help"], { encoding: "utf8", timeout: 5000 });
	const found = !help.error && help.status === 0 && /Jevgrep/.test(help.stdout ?? "");
	jevgrepSeen.set(path, found);
	return found;
}

function turnCue(
	cwd: string,
	job: boolean,
	wake: boolean,
	lastTouch: string | undefined,
	failed: string | undefined,
): string {
	const lines = [registerCue(cwd, "Shared"), registerCue(cwd, job ? "Agent" : "Human")].filter(Boolean);
	if (failed) {
		lines.push(registerCue(cwd, "Failure").replaceAll("{{failure}}", failed));
	}
	if (wake) {
		lines.push(registerCue(cwd, "Wake"));
	}
	if (job) {
		const change = jobChange(cwd);
		if (change) {
			lines.push(`Change: ${change}`);
		}
		const prefix = privatePlanning(cwd, job) ? `${cwd}/` : "";
		if (readOptional(join(cwd, VISION_FILE)) !== undefined) {
			lines.push(
				`Vision (read-only): \`${prefix}${VISION_FILE}\` — durable intent. Load it before choosing or starting work.`,
			);
		}
	}
	if (lastTouch) {
		lines.push(lastTouch);
	}
	if (!job) {
		const drift = formatDrift(listDrift(cwd));
		if (drift) {
			lines.push(drift);
		}
	}
	return ["<limen-project-context>", ...lines, "</limen-project-context>"].join("\n\n");
}

/** A job follows the planning source recorded at its spawn; the coordinator follows the project setting. */
function privatePlanning(root: string, job: boolean): boolean {
	const id = process.env.LIMEN_JOB_ID;
	const source = job && id ? recordedPlanningSource(join(root, ".limen/jobs", id)) : planningSource(root);
	return source === "private";
}

function readRegister(cwd: string): string {
	const inherited = inheritFile(cwd, ".agents/limen/communication.md", "templates/communication.md");
	if (!inherited) {
		return "";
	}
	const cueStart = inherited.text.search(/^## Cue: /m);
	const text = cueStart < 0 ? inherited.text : inherited.text.slice(0, cueStart);
	return boundText(text, inherited.path, "Communication");
}

/** Cue sections belong to the selected register; absent sections have no package fallback. */
function registerCue(cwd: string, heading: string): string {
	const inherited = inheritFile(cwd, ".agents/limen/communication.md", "templates/communication.md");
	if (!inherited) {
		return "";
	}
	const section = markdownSection(
		trimmedLines(inherited.text).slice(0, MAX_CONTEXT_LINES).join("\n"),
		`Cue: ${heading}`,
	);
	return section.split("\n").slice(1).join("\n").trim();
}

function readInheritedAgents(cwd: string): string {
	const inherited = inheritFile(cwd, ".agents/limen/agents.md", "templates/agents.md");
	return inherited ? boundText(inherited.text, inherited.path, "Shop manual") : "";
}

function boundFile(cwd: string, relative: string, label: string): string {
	const text = readOptional(join(cwd, relative));
	return text === undefined ? "" : boundText(text, relative, label);
}

function boundText(text: string, path: string, label: string): string {
	const lines = trimmedLines(text);
	if (!lines.length) {
		return "";
	}
	const content = lines.slice(0, MAX_CONTEXT_LINES).join("\n");
	const notice =
		lines.length > MAX_CONTEXT_LINES
			? `\n\n[${path} truncated to ${MAX_CONTEXT_LINES} of ${lines.length} lines; read it for remaining context.]`
			: "";
	return `## ${label} (${path})\n${content}${notice}`;
}

function markdownSection(text: string, heading: string): string {
	const lines = text.replaceAll("\r\n", "\n").split("\n");
	const start = lines.findIndex((line) => /^##\s+/.test(line) && line.replace(/^##\s+/, "").trim() === heading);
	if (start < 0) {
		return "";
	}
	let end = lines.length;
	for (let index = start + 1; index < lines.length; index++) {
		if (/^##\s+/.test(lines[index] ?? "")) {
			end = index;
			break;
		}
	}
	return lines.slice(start, end).join("\n").trim();
}

function jobChange(cwd: string): string {
	const id = process.env.LIMEN_JOB_ID?.trim();
	if (!id) {
		return "";
	}
	const task = readOptional(join(cwd, ".limen/jobs", id, "task.md"));
	if (task === undefined) {
		return "";
	}
	return changePointers(task)[0]?.path ?? "";
}

function reminderKind(event: ToolEvent): ReminderKind | undefined {
	const name = event.toolName ?? "";
	if (name === "write" || name === "edit") {
		const path = toolPath(event);
		if (isSpecPath(path)) {
			return "specs";
		}
		if (isCodePath(path)) {
			return "style";
		}
		return;
	}
	if ((name === "bash" || name === "powershell") && isVisionCommand(stringField(event.input, "command"))) {
		return "vision";
	}
}

function touchLine(event: ToolEvent, kind: ReminderKind): string {
	if (kind === "specs") {
		const verb = event.toolName === "edit" ? "edited" : "wrote";
		return `Last turn ${verb} ${toolPath(event)}.`;
	}
	if (kind === "style") {
		const verb = event.toolName === "edit" ? "edited" : "wrote";
		return `Last turn ${verb} ${toolPath(event)}.`;
	}
	return "Last turn started or merged work.";
}

function toolPath(event: ToolEvent): string {
	return stringField(event.input, "path") || stringField(event.input, "file_path");
}

function stringField(input: Record<string, unknown> | undefined, key: string): string {
	const value = input?.[key];
	return typeof value === "string" ? value : "";
}

function posixPath(path: string): string {
	return path.replaceAll("\\", "/");
}

function isSpecPath(path: string): boolean {
	return /(?:^|\/)context\/(?:changes|efforts|foundation)\//.test(posixPath(path));
}

function isCodePath(path: string): boolean {
	if (!path) {
		return false;
	}
	return !/\.md$/i.test(posixPath(path));
}

function projectReminder(cwd: string, kind: "style" | "vision"): string {
	const relative = kind === "style" ? STANDARDS_DIR : VISION_FILE;
	const label = kind === "style" ? "Standards" : "Vision";
	const text = kind === "style" ? readStandards(cwd) : (readOptional(join(cwd, relative)) ?? "");
	if (!text.trim()) {
		return `[limen] ${label}: no project file at ${relative}.`;
	}
	const headings = markdownHeadings(text);
	if (!headings.length) {
		return `[limen] ${label} (${relative}): no headings; read the file.`;
	}
	const shown = headings.slice(0, MAX_REMINDER_HEADINGS);
	const more = headings.length > MAX_REMINDER_HEADINGS ? "; read the file" : "";
	return `[limen] ${label} (${relative}): ${shown.join("; ")}${more}.`;
}

function markdownHeadings(text: string): readonly string[] {
	const headings: string[] = [];
	for (const line of text.replaceAll("\r\n", "\n").split("\n")) {
		const match = /^#{1,6}\s+(\S.*)$/.exec(line.trim());
		if (!match) {
			continue;
		}
		const title = (match[1] ?? "").replace(/\s+#+\s*$/, "").trim();
		if (title) {
			headings.push(title);
		}
	}
	return headings;
}

function isVisionCommand(command: string): boolean {
	if (/\blimen\s+spawn\b/.test(command)) {
		return true;
	}
	if (/\bgit\s+merge\b/.test(command)) {
		return true;
	}
	return /\b(?:mkdir|cp|mv|touch|install)\b/.test(command) && /context\/changes\//.test(command);
}

function appendText(content: readonly ToolContent[] | undefined, text: string): ToolContent[] {
	const parts: ToolContent[] = content ? content.map((part) => ({ ...part })) : [];
	const last = parts.at(-1);
	if (last?.type === "text" && typeof last.text === "string") {
		parts[parts.length - 1] = { type: "text", text: `${last.text}\n\n${text}` };
		return parts;
	}
	parts.push({ type: "text", text });
	return parts;
}

function trimmedLines(text: string): readonly string[] {
	const lines = text.replaceAll("\r\n", "\n").split("\n");
	while (lines[0]?.trim() === "") {
		lines.shift();
	}
	while (lines.at(-1)?.trim() === "") {
		lines.pop();
	}
	return lines;
}
