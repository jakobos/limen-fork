import { basename } from "node:path";
import type { Permission } from "./autonomy.ts";

/** What the tool-call guard looks at in a shell command (design §4.5 B). */
export type BashAction = "commit" | "remote" | "approve" | "harness-remote" | "protected-path";
export type BashFinding = { readonly action: BashAction; readonly command: string; readonly permission?: Permission };
type Found = { readonly action: BashAction; readonly permission?: Permission };

type Words = Readonly<Record<string, true>>;
const set = (text: string): Words => Object.fromEntries(text.split(" ").map((word) => [word, true]));
const SHELLS = set("bash sh zsh dash");
const WRAPPERS = set("env command sudo exec nohup time");
const WRAPPER_VALUES = set("-u -g -C -D -U -r -t -T -a -o -f");
const GIT_VALUES = set("-C -c --git-dir --work-tree --namespace --config-env");
const COMMIT_VERBS = set("commit merge rebase cherry-pick am revert commit-tree pull");
const GH_VALUES = set(
	"-R --repo -X --method -H --header -f -F --field --raw-field --input -q --jq -t --template " +
		"--hostname --cache -p --preview",
);
const NO_VALUES: Words = {};
const GH_BODY = ["-f", "-F", "--field", "--raw-field", "--input"];
const PR_WRITES: Record<string, Permission> = {
	create: "canOpenPr",
	ready: "canOpenPr",
	reopen: "canOpenPr",
	merge: "canMerge",
};
const CURL_BODY = ["-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--json", "-F", "--form", "-T"];
const WGET_BODY = ["--post-data", "--post-file", "--body-data", "--body-file", "--upload-file"];
const HARNESS: Record<string, Permission> = { push: "canPush", pr: "canOpenPr", merge: "canMerge" };
const READ_ONLY = set("cat less more head tail grep rg ls stat wc file diff");
const PROTECTED = [
	/~\/\.config\/limen(\/|$)/,
	/\$\{?HOME\}?\/\.config\/limen(\/|$)/,
	/\/approvals(\/|$)/,
	/\.(omp|pi)\/extensions\/limen\.ts\b/,
];
const REDIRECT = /^(\d*|&)>/;
const READ_METHOD = /^(GET|HEAD)$/i;

/**
 * Every guarded action a shell command line takes, including inside `$(...)`, backticks and `bash -c` strings.
 * Unknown commands add nothing. `home` is the expanded home directory, for protected-path matches.
 */
export function classifyBash(line: string, home: string): BashFinding[] {
	const { outer, inner } = substitutions(line);
	return [
		...inner.flatMap((text) => classifyBash(text, home)),
		...segments(outer).flatMap((words) => classifyWords(words, home)),
	];
}

/** Pulls `$(...)` and backtick bodies out of a line; single quotes keep them literal. */
function substitutions(line: string): { outer: string; inner: string[] } {
	const inner: string[] = [];
	let outer = "";
	let single = false;
	for (let index = 0; index < line.length; index++) {
		const char = line[index] ?? "";
		const opens = !single && (char === "`" || line.startsWith("$(", index));
		if (!opens) {
			single = char === "'" ? !single : single;
			outer += char === "\\" && !single ? char + (line[++index] ?? "") : char;
			continue;
		}
		const end = char === "`" ? line.indexOf("`", index + 1) : closingParen(line, index + 2);
		const stop = end < 0 ? line.length : end;
		inner.push(line.slice(index + (char === "`" ? 1 : 2), stop));
		outer += " _ ";
		index = stop;
	}
	return { outer, inner };
}

function closingParen(line: string, from: number): number {
	let depth = 1;
	for (let index = from; index < line.length; index++) {
		depth += line[index] === "(" ? 1 : line[index] === ")" ? -1 : 0;
		if (depth === 0) {
			return index;
		}
	}
	return -1;
}

type Lexer = { result: string[][]; words: string[]; word: string | undefined; quote: string };

/** Splits on unquoted `;`, `&&`, `||`, `|`, `&`, newlines and parentheses, and unquotes each word. */
function segments(text: string): string[][] {
	const lexer: Lexer = { result: [], words: [], word: undefined, quote: "" };
	for (let index = 0; index < text.length; index++) {
		index = lexer.quote ? quoted(lexer, text, index) : unquoted(lexer, text, index);
	}
	endSegment(lexer);
	return lexer.result.filter((entry) => entry.length > 0);
}

/** One character inside quotes; returns the last index it consumed. */
function quoted(lexer: Lexer, text: string, index: number): number {
	const char = text[index] ?? "";
	if (char === lexer.quote) {
		lexer.quote = "";
		return index;
	}
	const escaped = lexer.quote === '"' && char === "\\";
	lexer.word = (lexer.word ?? "") + (escaped ? (text[index + 1] ?? "") : char);
	return escaped ? index + 1 : index;
}

/** One character outside quotes; returns the last index it consumed. */
function unquoted(lexer: Lexer, text: string, index: number): number {
	const char = text[index] ?? "";
	if (char === "'" || char === '"') {
		lexer.quote = char;
		lexer.word ??= "";
	} else if (char === "\\") {
		const next = text[index + 1] ?? "";
		lexer.word = next === "\n" ? lexer.word : (lexer.word ?? "") + next;
		return index + 1;
	} else if (char === " " || char === "\t") {
		endWord(lexer);
	} else if (char === "&" ? !/[<>]/.test(text[index - 1] ?? "") && text[index + 1] !== ">" : ";|\n()".includes(char)) {
		endSegment(lexer);
	} else {
		lexer.word = (lexer.word ?? "") + char;
	}
	return index;
}

function endWord(lexer: Lexer): void {
	if (lexer.word !== undefined) {
		lexer.words.push(lexer.word);
		lexer.word = undefined;
	}
}

function endSegment(lexer: Lexer): void {
	endWord(lexer);
	lexer.result.push(lexer.words);
	lexer.words = [];
}

function classifyWords(raw: readonly string[], home: string): BashFinding[] {
	const words = withoutPrefixes(raw);
	const [head = "", ...args] = words;
	const name = basename(head);
	const command = raw.join(" ");
	if (Object.hasOwn(SHELLS, name)) {
		const flag = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
		const script = flag < 0 ? undefined : args[flag + 1];
		return script === undefined ? [] : classifyBash(script, home);
	}
	const found = action(name, args);
	const findings: BashFinding[] = found ? [{ ...found, command }] : [];
	const readOnly =
		Object.hasOwn(READ_ONLY, name) || (name === "limen" && positionals(args, NO_VALUES)[0] === "permissions");
	const touches = words.some(
		(word, index) =>
			(PROTECTED.some((pattern) => pattern.test(word)) || word.includes(`${home}/.config/limen`)) &&
			(!readOnly || REDIRECT.test(word) || REDIRECT.test(words[index - 1] ?? "")),
	);
	if (touches) {
		findings.push({ action: "protected-path", command });
	}
	return findings;
}

/** Drops `VAR=value`, and `env`, `command`, `sudo`, `exec`, `nohup`, `time` with their options. */
function withoutPrefixes(words: readonly string[]): readonly string[] {
	let wrapped = false;
	for (let index = 0; index < words.length; index++) {
		const word = words[index] ?? "";
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || Object.hasOwn(WRAPPERS, basename(word))) {
			wrapped ||= Object.hasOwn(WRAPPERS, basename(word));
		} else if (wrapped && word.startsWith("-")) {
			index += Object.hasOwn(WRAPPER_VALUES, word) ? 1 : 0;
		} else {
			return words.slice(index);
		}
	}
	return [];
}

function action(name: string, args: readonly string[]): Found | undefined {
	if (name === "git") {
		const verb = positionals(args, GIT_VALUES)[0] ?? "";
		return verb === "push"
			? { action: "remote", permission: "canPush" }
			: Object.hasOwn(COMMIT_VERBS, verb)
				? { action: "commit", permission: "canCommit" }
				: undefined;
	}
	if (name === "gh") {
		return ghAction(args);
	}
	if (name === "curl" || name === "wget") {
		return httpAction(name, args);
	}
	if (name === "limen") {
		const verb = positionals(args, NO_VALUES)[0] ?? "";
		const permission = Object.hasOwn(HARNESS, verb) ? HARNESS[verb] : undefined;
		return verb === "approve"
			? { action: "approve" }
			: permission
				? { action: "harness-remote", permission }
				: undefined;
	}
	return undefined;
}

function ghAction(args: readonly string[]): Found | undefined {
	const [group, verb = "", path = ""] = positionals(args, GH_VALUES);
	const permission = Object.hasOwn(PR_WRITES, verb) ? PR_WRITES[verb] : undefined;
	if (group === "pr" && permission) {
		return { action: "remote", permission };
	}
	if (group !== "api") {
		return undefined;
	}
	const method = flagValue(args, "-X", "--method") ?? (args.some((arg) => hasFlag(arg, GH_BODY)) ? "POST" : "GET");
	const target = `${verb}/${path}`;
	return !READ_METHOD.test(method) && /(^|\/)(pulls|merges)(\/|$|\?)/.test(target)
		? { action: "remote", permission: remotePermission(target) }
		: undefined;
}

function httpAction(name: string, args: readonly string[]): Found | undefined {
	const url = args.find((arg) => arg.includes("api.github.com"));
	if (!url) {
		return undefined;
	}
	const method = name === "curl" ? flagValue(args, "-X", "--request") : flagValue(args, "--method", "--method");
	const body = args.some((arg) => hasFlag(arg, name === "curl" ? CURL_BODY : WGET_BODY));
	return !READ_METHOD.test(method ?? (body ? "POST" : "GET"))
		? { action: "remote", permission: remotePermission(url) }
		: undefined;
}

function remotePermission(path: string): Permission {
	return /\/merges?(\/|$|\?)/.test(path) ? "canMerge" : /\/pulls(\/|$|\?)/.test(path) ? "canOpenPr" : "canPush";
}

function hasFlag(arg: string, flags: readonly string[]): boolean {
	return flags.some((flag) => arg === flag || arg.startsWith(flag.startsWith("--") ? `${flag}=` : flag));
}

/** `-X PUT`, `-XPUT`, `-X=PUT`, `--method PUT`, `--method=PUT`. */
function flagValue(args: readonly string[], short: string, long: string): string | undefined {
	for (const [index, arg] of args.entries()) {
		if (arg === short || arg === long) {
			return args[index + 1];
		}
		if (arg.startsWith(`${long}=`)) {
			return arg.slice(long.length + 1);
		}
		if (arg.startsWith(short) && !short.startsWith("--")) {
			return arg.slice(short.length).replace(/^=/, "");
		}
	}
	return undefined;
}

/** Arguments that are not options, skipping the values of `valued` options. */
function positionals(args: readonly string[], valued: Words): string[] {
	const result: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] ?? "";
		if (!arg.startsWith("-")) {
			result.push(arg);
		} else if (Object.hasOwn(valued, arg)) {
			index++;
		}
	}
	return result;
}
