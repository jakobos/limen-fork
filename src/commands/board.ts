import { loadBoard, renderBoard } from "../project/changes.ts";
import { limenRoot } from "../project/git.ts";

/** `limen board`: NOW, NEXT and RECENT, derived from change front matter and job records. */
export async function boardCommand(args: readonly string[], cwd: string): Promise<void> {
	if (args.length > 0) {
		throw new Error("board takes no arguments");
	}
	const text = renderBoard(await loadBoard(limenRoot(cwd)));
	console.log(text ? text.trimEnd() : "board: no open or recent change under context/");
}
