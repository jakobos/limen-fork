import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseFrontmatter } from "../picture/frontmatter.ts";
import { requirePermission } from "../project/approval.ts";
import { packageRoot } from "../project/inherit.ts";
import { changePointers } from "../project/planning.ts";
import { parseFlags } from "./flags.ts";
import { defaultBranch, ownerRepo, pushJob, type RemoteJob, remoteJob, run, text } from "./push.ts";

/** `limen pr <job> --body-file F [--title T]` opens the PR; `limen pr --template <job>` prints the filled template. */
export async function prCommand(args: readonly string[], cwd: string): Promise<void> {
	const { values, positionals } = parseFlags(
		args,
		{ template: { type: "boolean" }, "body-file": { type: "string" }, title: { type: "string" } } as const,
		{
			unknown: (word) => `unknown pr option ${word}`,
			missing: (flag) => `${flag} requires a value`,
			repeated: (flag) => `${flag} may be supplied only once`,
			dashValues: ["title"],
		},
	);
	const [query, ...extra] = positionals.filter((word) => word !== "");
	if (!query || extra.length > 0) {
		throw new Error("usage: limen pr <job> --body-file F [--title T] | limen pr --template <job>");
	}
	const job = await remoteJob(cwd, query);
	if (values.template) {
		console.log(await filledTemplate(job));
		return;
	}
	const bodyFile = values["body-file"];
	if (!bodyFile) {
		throw new Error("limen pr needs --body-file F; start from limen pr --template <job>");
	}
	requirePermission(job.effective, "canOpenPr", { what: "pr", jobDir: job.jobDir, head: job.head, actions: ["pr"] });
	pushJob(job, ["pr", "push"]);
	const title = values.title ?? (await changeTitle(job)) ?? job.label;
	const base = defaultBranch(job.repository);
	const create = ["pr", "create", "--head", job.branch, "--base", base, "--title", title || job.branch];
	const body = ["--body-file", resolve(cwd, bodyFile), "-R", ownerRepo(job.repository)];
	console.log(run(job.repository, "gh", [...create, ...body], "inherit"));
}

/** The first template found (§4.7) with its tokens filled. */
async function filledTemplate(job: RemoteJob): Promise<string> {
	const template = [
		resolve(job.root, ".agents/limen/pr-template.md"),
		resolve(job.repository, ".github/pull_request_template.md"),
		resolve(packageRoot(), "templates/pr.md"),
	].find((file) => existsSync(file));
	const change = (await jobChange(job)) ?? { id: "", path: "" };
	const base = job.base || defaultBranch(job.repository);
	const commits = run(job.repository, "git", ["log", "--format=- %h %s", `${base}..${job.branch}`]);
	const tokens: Record<string, string> = {
		change_id: change.id,
		change_path: change.path,
		job_id: job.id,
		branch: job.branch,
		commits,
		profile: job.effective.profile,
	};
	const body = template ? readFileSync(template, "utf8") : "";
	return body.replace(/\{\{(\w+)\}\}/g, (token, name: string) => tokens[name] ?? token).trimEnd();
}

/** The change the job's task points at with `Change:`, or undefined when it names none. */
async function jobChange(job: RemoteJob): Promise<{ id: string; path: string; file: string } | undefined> {
	const [pointer] = changePointers(await text(`${job.jobDir}/task.md`));
	return pointer && { id: pointer.id, path: pointer.path, file: resolve(job.root, pointer.path, `${pointer.kind}.md`) };
}

/** The `title` front matter of the job's change, when there is one. */
async function changeTitle(job: RemoteJob): Promise<string | undefined> {
	const change = await jobChange(job);
	if (!change || !existsSync(change.file)) {
		return undefined;
	}
	const title = parseFrontmatter(readFileSync(change.file, "utf8")).data.title;
	return typeof title === "string" && title.trim() ? title.trim() : undefined;
}
