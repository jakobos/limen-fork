import { basename } from "node:path";
import type { Permission } from "./autonomy.ts";

/** What the tool-call guard looks at in a shell command (design §4.5 B). */
export type BashAction = "commit" | "remote" | "approve" | "harness-remote" | "protected-path";
export type BashFinding = { readonly action: BashAction; readonly command: string; readonly permission?: Permission };
type Found = { readonly action: BashAction; readonly permission?: Permission };

type Words = Readonly<Record<string, true>>;
const set = (text: string): Words => Object.fromEntries(text.split(" ").map((word) => [word, true]));
const SHELLS = set("bash sh zsh dash");
/** Shell words that may stand before a command name: `then git push`, `{ git push; }`, `! git push`. */
const RESERVED = set("if then else elif do while until { ! case");
type Wrapper = { readonly values: Words; readonly operands: number };
const wrapper = (values: string, operands = 0): Wrapper => ({ values: set(values), operands });
/** Commands that run the command after them; `values` are their options that take a value. */
const WRAPPERS: Record<string, Wrapper> = {
	env: wrapper("-u --unset -C --chdir -S --split-string"),
	command: wrapper(""),
	sudo: wrapper("-u -g -C -D -U -r -t -T -h -p"),
	exec: wrapper("-a"),
	nohup: wrapper(""),
	time: wrapper("-o -f --output --format"),
	timeout: wrapper("-s --signal -k --kill-after", 1),
	nice: wrapper("-n --adjustment"),
	stdbuf: wrapper("-i -o -e --input --output --error"),
	xargs: wrapper("-a --arg-file -d --delimiter -E -I -L -n --max-args -P --max-procs -s --max-chars"),
};
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
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
 * Every guarded action a shell command line takes, including inside `$(...)`, backticks, `bash -c` strings and
 * unquoted heredoc bodies. Comments and heredoc text are not commands. Unknown commands add nothing.
 * `home` is the expanded home directory, for protected-path matches.
 */
export function classifyBash(line: string, home: string): BashFinding[] {
	const lexer = tokenize(line);
	return [
		...lexer.inner.flatMap((text) => classifyBash(text, home)),
		...lexer.result.flatMap((words) => classifyWords(words, home)),
	];
}

type Heredoc = { readonly delimiter: string; readonly strip: boolean; readonly expand: boolean };
type Lexer = {
	readonly text: string;
	index: number;
	result: string[][];
	words: string[];
	word: string | undefined;
	inner: string[];
	heredocs: Heredoc[];
};

/**
 * One pass over a command line: splits on unquoted `;`, `&&`, `||`, `|`, `&`, newlines and parentheses, unquotes
 * each word, drops `#` comments, skips heredoc bodies, and collects `$(...)` and backtick bodies in `inner`.
 */
function tokenize(text: string): Lexer {
	const lexer: Lexer = { text, index: 0, result: [], words: [], word: undefined, inner: [], heredocs: [] };
	while (lexer.index < text.length) {
		step(lexer);
	}
	endSegment(lexer);
	lexer.result = lexer.result.filter((entry) => entry.length > 0);
	return lexer;
}

/** Consumes one unquoted token: a character, a quoted string, a substitution, a comment or a heredoc operator. */
function step(lexer: Lexer): void {
	const { text, index } = lexer;
	const char = text[index] ?? "";
	const found = substitutionAt(text, index);
	lexer.index = index + 1;
	if (char === "'") {
		const end = text.indexOf("'", index + 1);
		lexer.word = (lexer.word ?? "") + text.slice(index + 1, end < 0 ? text.length : end);
		lexer.index = end < 0 ? text.length : end + 1;
	} else if (char === '"') {
		doubleQuoted(lexer);
	} else if (char === "\\") {
		const next = text[index + 1] ?? "";
		lexer.word = next === "\n" ? lexer.word : (lexer.word ?? "") + next;
		lexer.index = index + 2;
	} else if (found) {
		lexer.inner.push(found.body);
		lexer.word = `${lexer.word ?? ""}_`;
		lexer.index = found.end + 1;
	} else if (char === "#" && lexer.word === undefined) {
		const end = text.indexOf("\n", index);
		lexer.index = end < 0 ? text.length : end;
	} else if (text.startsWith("<<<", index)) {
		lexer.word = `${lexer.word ?? ""}<<<`;
		lexer.index = index + 3;
	} else if (text.startsWith("<<", index)) {
		heredocOperator(lexer);
	} else {
		plain(lexer, char);
	}
}

/** A character with no quoting or substitution meaning. */
function plain(lexer: Lexer, char: string): void {
	const { text } = lexer;
	const index = lexer.index - 1;
	if (char === " " || char === "\t") {
		endWord(lexer);
	} else if (char === "\n") {
		endSegment(lexer);
		heredocBodies(lexer);
	} else if (char === "&" ? !/[<>]/.test(text[index - 1] ?? "") && text[index + 1] !== ">" : ";|()".includes(char)) {
		endSegment(lexer);
	} else {
		lexer.word = (lexer.word ?? "") + char;
	}
}

/** A `"..."` string from its opening quote; `$(...)` and backticks inside it still run. */
function doubleQuoted(lexer: Lexer): void {
	const { text } = lexer;
	let word = lexer.word ?? "";
	let index = lexer.index;
	while (index < text.length && text[index] !== '"') {
		const found = substitutionAt(text, index);
		if (text[index] === "\\") {
			word += text[index + 1] ?? "";
			index += 2;
		} else if (found) {
			lexer.inner.push(found.body);
			word += "_";
			index = found.end + 1;
		} else {
			word += text[index];
			index++;
		}
	}
	lexer.word = word;
	lexer.index = index + 1;
}

/** `$(...)` or a backtick body starting at `index`; `end` is the index of its closing character. */
function substitutionAt(text: string, index: number): { body: string; end: number } | undefined {
	const tick = text[index] === "`";
	if (!tick && !text.startsWith("$(", index)) {
		return undefined;
	}
	const close = tick ? text.indexOf("`", index + 1) : closingParen(text, index + 2);
	const end = close < 0 ? text.length : close;
	return { body: text.slice(index + (tick ? 1 : 2), end), end };
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

/** `<<WORD`, `<<-WORD`, `<<'WORD'`: records the delimiter; the body starts after the next unquoted newline. */
function heredocOperator(lexer: Lexer): void {
	const { text } = lexer;
	endWord(lexer);
	let index = lexer.index + 1;
	const strip = text[index] === "-";
	index += strip ? 1 : 0;
	while (text[index] === " " || text[index] === "\t") {
		index++;
	}
	let delimiter = "";
	let expand = true;
	for (; index < text.length && !/[\s;|&<>()]/.test(text[index] ?? ""); index++) {
		const char = text[index] ?? "";
		const end = char === "'" || char === '"' ? text.indexOf(char, index + 1) : index;
		delimiter += char === "\\" ? "" : end === index ? char : text.slice(index + 1, end < 0 ? text.length : end);
		expand &&= end === index && char !== "\\";
		index = end < 0 ? text.length : end;
	}
	lexer.heredocs.push({ delimiter, strip, expand });
	lexer.index = index;
}

/** Skips the pending heredoc bodies; an unquoted delimiter still runs `$(...)` and backticks in its body. */
function heredocBodies(lexer: Lexer): void {
	const { text } = lexer;
	for (const { delimiter, strip, expand } of lexer.heredocs) {
		const body: string[] = [];
		while (lexer.index < text.length) {
			const newline = text.indexOf("\n", lexer.index);
			const stop = newline < 0 ? text.length : newline;
			const line = text.slice(lexer.index, stop);
			lexer.index = stop + 1;
			if ((strip ? line.replace(/^\t+/, "") : line) === delimiter) {
				break;
			}
			body.push(line);
		}
		lexer.inner.push(...(expand ? bodySubstitutions(body.join("\n")) : []));
	}
	lexer.heredocs = [];
}

/** `$(...)` and backtick bodies in heredoc text, where quotes are literal and `\` escapes. */
function bodySubstitutions(body: string): string[] {
	const inner: string[] = [];
	for (let index = 0; index < body.length; index++) {
		const found = body[index] === "\\" ? undefined : substitutionAt(body, index);
		if (body[index] === "\\") {
			index++;
		} else if (found) {
			inner.push(found.body);
			index = found.end;
		}
	}
	return inner;
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

/** Drops leading reserved words, `VAR=value`, and wrappers such as `env`, `timeout 120` or `xargs -n1`. */
function withoutPrefixes(words: readonly string[]): readonly string[] {
	let current: Wrapper | undefined;
	let operands = 0;
	for (let index = 0; index < words.length; index++) {
		const word = words[index] ?? "";
		const name = basename(word);
		if (Object.hasOwn(RESERVED, word) || ASSIGNMENT.test(word)) {
			continue;
		}
		if (Object.hasOwn(WRAPPERS, name)) {
			current = WRAPPERS[name];
			operands = current?.operands ?? 0;
		} else if (current && word.startsWith("-")) {
			index += Object.hasOwn(current.values, word) ? 1 : 0;
		} else if (operands > 0) {
			operands--;
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
	const mutation = args.join(" ");
	if (verb === "graphql" && /\bmutation\b/.test(mutation)) {
		const merge = /\b(mergePullRequest|enablePullRequestAutoMerge)\b/.test(mutation);
		const pr = /\bcreatePullRequest\b/.test(mutation);
		return { action: "remote", permission: merge ? "canMerge" : pr ? "canOpenPr" : "canPush" };
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
