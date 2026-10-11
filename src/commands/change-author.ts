import { GITHUB_NOREPLY } from "../integrations/finish-receipt.ts";
import { changeAuthor } from "../project/git.ts";

export async function changeAuthorCommand(args: readonly string[], cwd: string): Promise<void> {
	const change = args[0];
	if (!change || args.length !== 1) {
		throw new Error("change-author requires one change folder, or its change.md or effort.md");
	}
	const author = changeAuthor(cwd, change);
	const github = GITHUB_NOREPLY.exec(author.email)?.[1];
	console.log(`Change: ${author.path}\nAuthor: ${author.name} <${author.email}>`);
	if (github) {
		console.log(`GitHub: @${github} (from recorded noreply email)`);
	}
	console.log(
		`Creation commit: ${author.commit}\nSource: creation author in HEAD history, following renames; not verified human identity.`,
	);
}
