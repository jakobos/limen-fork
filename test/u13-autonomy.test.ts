// U13: the autonomy resolver. "coord" is the interactive coordinator; a value is its level initial plus source letter.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { effectivePermissions, normalizeRemote, PERMISSIONS } from "../src/project/autonomy.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "limen-u13-")));
const file = join(dir, "autonomy.json");
Object.assign(process.env, { HOME: dir, LIMEN_AUTONOMY_FILE: file });
const p = (words: string) => Object.fromEntries(words.split(" ").map((level, i) => [PERMISSIONS[i], level]));
const profiles = { local: p("allow deny deny deny"), pr: p("allow ask ask deny"), ship: p("allow allow allow allow") };
const rules = "github.com/jakub/*:ship github.com/acme/**:pr ~/learn/*:local github.com/**:local".split(" ");
const repos = rules.map((rule) => rule.split(":")).map(([match, profile]) => ({ match, profile }));
const config = (extra = {}) => writeFileSync(file, JSON.stringify({ profiles, repos, default: "local", ...extra }));
const setup = `for r in j a x learn/kata other; do git init -q "$r"; done
git -C j remote add origin git@github.com:jakub/app.git && git -C a remote add origin https://github.com/acme/team/app
git -C x remote add origin ssh://git@github.com/jakub/a/b.git && mkdir -p a/.agents/limen
echo '{ "canPush": "deny" }' > a/.agents/limen/autonomy.json`;
const brief = (name: string, who: string) => {
	const e = effectivePermissions(join(dir, name), who === "coord" ? "coordinator" : who, who === "coord");
	const tags = PERMISSIONS.map((k) => `${e.values[k].level[0]}${e.values[k].source.replace("project", "j")[0]}`);
	return [e.rule, e.profile, ...tags, e.error].filter(Boolean).join(" ");
};

test("URL forms, globs, first match, path rules, narrowing, ceilings and broken files", () => {
	const urls = ["git@github.com:acme/app.git", "https://github.com/acme/app", "ssh://git@github.com/acme/app.git"];
	assert.deepEqual([...new Set(urls.map(normalizeRemote))], ["github.com/acme/app"]);
	execFileSync("sh", ["-c", setup], { cwd: dir });
	config();
	const cases = [
		["j", "coord", "github.com/jakub/* ship ap ap ap ap"], // first match beats github.com/**
		["j", "worker", "github.com/jakub/* ship ap dr dr dr"],
		["j", "coordinator", "github.com/jakub/* ship ap dr dr dr"], // job-role coordinator (C7)
		["j", "reviewer", "github.com/jakub/* ship dr dr dr dr"],
		["j", "picture", "github.com/jakub/* ship dr dr dr dr"], // unknown role (C8)
		["x", "coord", "github.com/** local ap dp dp dp"], // * is not **
		["a", "coord", "github.com/acme/** pr ap dj ap dp"], // project narrows canPush
		["learn/kata", "coord", "~/learn/* local ap dp dp dp"],
		["other", "coord", "default local ap dp dp dp"],
	] as const;
	const [got, want] = [cases.map(([name, who]) => brief(name, who)), cases.map((row) => row[2])];
	assert.deepEqual(got, want);
	config({ profiles: { ...profiles, local: p("ask deny deny deny") } });
	assert.match(brief("j", "coord"), /^dc dc dc dc profile "local".canCommit cannot be ask/);
	writeFileSync(file, "{ broken");
	assert.match(brief("j", "coord"), /^dc dc dc dc .*JSON/);
});
