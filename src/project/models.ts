import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const MODEL_FIELDS = ["engine", "provider", "model", "thinking"] as const;
export type ModelField = (typeof MODEL_FIELDS)[number];
/** Where one field came from; `parent job` is a continuation keeping its parent's engine. */
export type ModelSource =
	| "flag"
	| "parent job"
	| "project role"
	| "project default"
	| "personal role"
	| "personal default"
	| "package role"
	| "package default";
export type ModelEntry = Partial<Record<ModelField, string>>;
export type ModelChoice = {
	readonly values: Readonly<Record<ModelField, string>>;
	readonly sources: Readonly<Record<ModelField, ModelSource>>;
};
type ModelsFile = { readonly default: ModelEntry; readonly roles: Readonly<Record<string, ModelEntry>> };
type Layer = { readonly name: "project" | "personal" | "package"; readonly file: ModelsFile | undefined };

const PACKAGE_FILE = fileURLToPath(new URL("../../templates/models.json", import.meta.url));

/**
 * Engine, provider, model and reasoning for a role. Per field the first source that sets it wins: flag, project
 * role, project default, personal role, personal default, package role, package default. The personal file is
 * `~/.config/limen/models.json` (`LIMEN_MODELS_FILE` names another path for tests). Invalid JSON refuses.
 */
export function resolveModels(
	root: string,
	role: string,
	flags: Readonly<Partial<Record<ModelField, string | undefined>>>,
	env: NodeJS.ProcessEnv = process.env,
): ModelChoice {
	const layers: Layer[] = [
		{ name: "project", file: readModels(join(root, ".agents", "limen", "models.json")) },
		{
			name: "personal",
			file: readModels(env.LIMEN_MODELS_FILE?.trim() || join(homedir(), ".config/limen/models.json")),
		},
		{ name: "package", file: readModels(PACKAGE_FILE) },
	];
	const values: Partial<Record<ModelField, string>> = {};
	const sources: Partial<Record<ModelField, ModelSource>> = {};
	for (const field of MODEL_FIELDS) {
		const found = pickField(field, role, flags, layers);
		if (!found) {
			throw new Error(`no ${field} for role ${role}; set default.${field} in ${PACKAGE_FILE}`);
		}
		values[field] = found.value;
		sources[field] = found.source;
	}
	const choice = { values, sources } as ModelChoice;
	if (choice.values.engine !== "pi" && choice.values.engine !== "omp") {
		throw new Error(
			choice.sources.engine === "flag"
				? "--engine must be pi or omp"
				: `engine ${choice.values.engine} from ${choice.sources.engine} must be pi or omp`,
		);
	}
	return choice;
}

/** The route `limen jobs <id>` compares with the served model: `provider/model`, or the model when it names one. */
export function requestedModel(choice: ModelChoice): string {
	const { provider, model } = choice.values;
	return model.includes("/") ? model : `${provider}/${model}`;
}

/** One line per field, `<field> <value> (<source>)`, as recorded in a job's `model-source`. */
export function modelSourceText(choice: ModelChoice): string {
	return `${MODEL_FIELDS.map((field) => `${field} ${choice.values[field]} (${choice.sources[field]})`).join("\n")}\n`;
}

function pickField(
	field: ModelField,
	role: string,
	flags: Readonly<Partial<Record<ModelField, string | undefined>>>,
	layers: readonly Layer[],
): { value: string; source: ModelSource } | undefined {
	const flag = flags[field]?.trim();
	if (flag) {
		return { value: flag, source: "flag" };
	}
	for (const { name, file } of layers) {
		const fromRole = file?.roles[role]?.[field];
		if (fromRole) {
			return { value: fromRole, source: `${name} role` };
		}
		const fromDefault = file?.default[field];
		if (fromDefault) {
			return { value: fromDefault, source: `${name} default` };
		}
	}
	return undefined;
}

function readModels(path: string): ModelsFile | undefined {
	if (!existsSync(path)) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const top = objectIn(parsed, path, "the file");
	const roles: Record<string, ModelEntry> = {};
	for (const [role, entry] of Object.entries(objectIn(top.roles ?? {}, path, "roles"))) {
		roles[role] = modelEntry(entry, path, `roles.${role}`);
	}
	return { default: modelEntry(top.default ?? {}, path, "default"), roles };
}

function modelEntry(value: unknown, path: string, where: string): ModelEntry {
	const entry: ModelEntry = {};
	for (const [key, field] of Object.entries(objectIn(value, path, where))) {
		if (!(MODEL_FIELDS as readonly string[]).includes(key) || typeof field !== "string" || !field.trim()) {
			throw new Error(`${path}: ${where}.${key} must be one of ${MODEL_FIELDS.join(", ")} with a non-empty string`);
		}
		entry[key as ModelField] = field.trim();
	}
	return entry;
}

function objectIn(value: unknown, path: string, where: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${path}: ${where} must be a JSON object`);
	}
	return value as Record<string, unknown>;
}
