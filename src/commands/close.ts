import { closeChangeTabs } from "../integrations/herdr.ts";
import { limenRoot } from "../project/git.ts";

export async function closeCommand(args: readonly string[], cwd: string): Promise<void> {
	const change = args[0];
	if (!change || args.length !== 1) {
		throw new Error("close requires a change id like oauth-login");
	}
	console.log(await closeChangeTabs({ root: limenRoot(cwd), change }));
}
