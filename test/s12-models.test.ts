// S12 · Models: per field the first of flag, project, personal, package wins; jobs show the source; env is ignored.
import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { jobFile, limen, type Plant, plant, spawnJob, waitJob } from "./plant.ts";

let p: Plant;
before(async () => {
	p = await plant();
});
after(() => p.cleanup());

test("spawn resolves each model field per source and records where it came from", async () => {
	const personal = join(p.parent, "personal-models.json");
	const project = join(p.root, ".agents/limen/models.json");
	const env = { LIMEN_MODELS_FILE: personal, LIMEN_WORKER_MODEL: "env/ignored" };
	await writeFile(project, JSON.stringify({ default: { provider: "proj" }, roles: { worker: { model: "proj-w" } } }));
	await writeFile(personal, JSON.stringify({ default: { model: "own", thinking: "low" } }));
	const run = (flags: readonly string[] = []) => {
		const id = spawnJob(p, "say hi", ["--detached", ...flags], { env });
		waitJob(p, id, { env });
		return id;
	};
	const first = run();
	assert.equal(jobFile(p, first, "model"), "proj/proj-w");
	assert.match(jobFile(p, first, "model-source"), /proj \(project default\)\n.*proj-w \(project role\)\n.*\(personal/);
	assert.equal(jobFile(p, run(["--model", "flagged"]), "model"), "proj/flagged");
	await rm(project);
	assert.equal(jobFile(p, run(), "model"), "openai-codex/own");
	await rm(personal);
	assert.match(limen(p, ["jobs", run()], { env }).stdout, /model gpt-6-astra \(package default\)/);
	await writeFile(project, "{ broken");
	assert.match(limen(p, ["spawn", "--detached", "say hi"], { env }).stderr, /invalid JSON in .*models\.json/);
});
