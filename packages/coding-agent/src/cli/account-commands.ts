/**
 * `runkiln setup [section]` and `runkiln key [set|remove|test] [runinfra|jev|openrouter]`: manage keys and
 * setup from the shell. `runkiln login` and `runkiln logout` still work as hidden aliases of `key set` and
 * `key remove` (with their old `--router` flag), and say the new name once. None of these print a key.
 */

import { RUNINFRA_API_KEY_ENV } from "@runkiln/ai/providers/runinfra";
import chalk from "chalk";
import { APP_NAME } from "../config.ts";
import { CLASSIFIER_KEY_ENV } from "../core/router/classifiers.ts";
import { getCachedDecisionModels, getDecisionModels } from "../core/router/decision-models.ts";
import {
	checkRouterKey,
	getActiveRouterKey,
	getRouterKeyStatus,
	isRouterBackend,
	loadRouterClassifierSettings,
	ROUTER_BACKEND_LABELS,
	ROUTER_BACKENDS,
	ROUTER_KEY_URLS,
	ROUTER_KEYS_DISPLAY_PATH,
	removeRouterKey,
	saveRouterClassifier,
	saveRouterKey,
	validateOpenRouterDecisionModel,
} from "../core/router/keys.ts";
import type { ClassifierBackend } from "../core/router/types.ts";
import { loadModelsCatalog } from "../core/runkiln/models-catalog.ts";
import {
	getActiveRunInfraKey,
	getRunInfraKeyStatus,
	RUNINFRA_API_KEYS_URL,
	removeRunInfraApiKey,
	saveCatalogCache,
} from "../core/runkiln/runinfra-account.ts";
import { loadRunInfraConfig } from "../core/runkiln/runinfra-config.ts";
import { checkRunInfraKey, saveRunInfraApiKey } from "../core/runkiln/setup.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import {
	type HubKey,
	type HubSection,
	parseHubSection,
	type SetupHubResult,
} from "../modes/interactive/components/setup/setup-hub.ts";
import { runFirstRunSetup, runSetupHub } from "./run-setup.ts";

/** `setup` and `key` are listed; `login` and `logout` are hidden aliases. */
export const ACCOUNT_COMMANDS = ["setup", "key", "login", "logout"] as const;
export type AccountCommand = (typeof ACCOUNT_COMMANDS)[number];

const KEY_ACTIONS = ["set", "remove", "test"] as const;
type KeyAction = (typeof KEY_ACTIONS)[number];
const KEY_NAMES: readonly HubKey[] = ["runinfra", "jev", "openrouter"];

/** Flags that take a value as the next argument. */
const VALUE_FLAGS = new Set(["--router", "--router-model"]);

export interface ParsedAccountCommand {
	command: AccountCommand;
	flags: string[];
	/** Words after the command (`key set jev`, `setup keys`). Absent when there are none. */
	positionals?: string[];
}

/** A positional word each command accepts. Anything else means the line is a prompt, not a command. */
function acceptsWord(command: AccountCommand, word: string): boolean {
	const lower = word.toLowerCase();
	if (command === "setup") return parseHubSection(lower) !== undefined;
	if (command === "key")
		return (KEY_ACTIONS as readonly string[]).includes(lower) || KEY_NAMES.includes(lower as HubKey);
	return false;
}

export function parseAccountCommand(args: readonly string[]): ParsedAccountCommand | undefined {
	const [first, ...rest] = args;
	if (!first || !(ACCOUNT_COMMANDS as readonly string[]).includes(first)) return undefined;
	const command = first as AccountCommand;
	const flags: string[] = [];
	const positionals: string[] = [];
	for (const [index, arg] of rest.entries()) {
		if (arg.startsWith("-")) {
			flags.push(arg);
			continue;
		}
		if (index > 0 && VALUE_FLAGS.has(rest[index - 1] ?? "")) {
			flags.push(arg);
			continue;
		}
		if (!acceptsWord(command, arg)) return undefined;
		positionals.push(arg.toLowerCase());
	}
	if (command === "setup" && positionals.length > 1) return undefined;
	if (command === "key" && positionals.length > 2) return undefined;
	return positionals.length > 0 ? { command, flags, positionals } : { command, flags };
}

interface RouterFlags {
	/** `--router` was given. */
	present: boolean;
	/** Its value, when one was given. */
	value?: string;
	model?: string;
}

function readRouterFlags(flags: readonly string[]): RouterFlags {
	const result: RouterFlags = { present: false };
	for (const [index, flag] of flags.entries()) {
		if (flag === "--router" || flag.startsWith("--router=")) {
			result.present = true;
			const inline = flag.startsWith("--router=") ? flag.slice("--router=".length) : undefined;
			const next = flags[index + 1];
			result.value = inline ?? (next && !next.startsWith("-") ? next : undefined);
		} else if (flag === "--router-model" || flag.startsWith("--router-model=")) {
			const inline = flag.startsWith("--router-model=") ? flag.slice("--router-model=".length) : undefined;
			const next = flags[index + 1];
			result.model = inline ?? (next && !next.startsWith("-") ? next : undefined);
		}
	}
	return result;
}

export interface AccountCommandIo {
	stdinIsTTY: boolean;
	stdoutIsTTY: boolean;
	readStdin: () => Promise<string>;
	log: (line: string) => void;
	error: (line: string) => void;
	env: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
	/** Interactive screens, injected so tests can skip the TUI. */
	runSetup: () => Promise<{ lines: string[] } | undefined>;
	runHub: (options: {
		section?: HubSection;
		keyAction?: { key: HubKey; action: "set" | "remove" };
	}) => Promise<Pick<SetupHubResult, "keyChanged" | "routerChanged">>;
}

const HELP = `Usage:
  ${APP_NAME} setup                              Full-screen setup: key, model, classifier (if needed), permissions, theme
  ${APP_NAME} setup keys|model|routing|permissions|look|footer
                                             Open the setup hub on one section
  ${APP_NAME} key                                Which keys are set and where they come from
  ${APP_NAME} key set [runinfra|jev|openrouter]  Enter a key (default runinfra), check it, and save it
      [--stdin] [--router-model <id>]        Read the key from stdin; pick the OpenRouter decision model
  ${APP_NAME} key remove runinfra|jev|openrouter Remove a saved key
  ${APP_NAME} key test [runinfra|jev|openrouter] Check the active keys live (all when none is named)
`;

function envNote(env: NodeJS.ProcessEnv): string | undefined {
	return env[RUNINFRA_API_KEY_ENV]?.trim()
		? `${RUNINFRA_API_KEY_ENV} is set in this shell and overrides the saved key.`
		: undefined;
}

function routerEnvNote(backend: ClassifierBackend, env: NodeJS.ProcessEnv): string | undefined {
	const name = CLASSIFIER_KEY_ENV[backend];
	return env[name]?.trim() ? `${name} is set in this shell and overrides the saved router key.` : undefined;
}

export async function runAccountCommand(
	command: AccountCommand,
	flags: readonly string[],
	agentDir: string,
	io: AccountCommandIo,
	positionals: readonly string[] = [],
): Promise<number> {
	if (flags.includes("--help") || flags.includes("-h")) {
		io.log(HELP);
		return 0;
	}
	if (command === "login" || command === "logout") return runLegacyCommand(command, flags, agentDir, io);
	if (command === "key") return runKeyCommand(positionals, flags, agentDir, io);

	// setup
	const section = parseHubSection(positionals[0]);
	if (!io.stdinIsTTY || !io.stdoutIsTTY) {
		io.error(
			`${APP_NAME} setup needs a terminal. Use \`${APP_NAME} key set --stdin\` or set ${RUNINFRA_API_KEY_ENV}. Keys: ${RUNINFRA_API_KEYS_URL}`,
		);
		return 1;
	}
	if (section) {
		const result = await io.runHub({ section });
		io.log(result.keyChanged || result.routerChanged ? "Setup saved." : "Setup closed.");
		return 0;
	}
	const result = await io.runSetup();
	if (!result) return 1;
	for (const line of result.lines) io.log(line);
	return 0;
}

/** `login` / `logout`: the old shapes, mapped onto `key set` / `key remove` after a one-line note. */
async function runLegacyCommand(
	command: "login" | "logout",
	flags: readonly string[],
	agentDir: string,
	io: AccountCommandIo,
): Promise<number> {
	const router = readRouterFlags(flags);
	const replacement = command === "login" ? "key set" : "key remove";
	io.error(chalk.dim(`\`${APP_NAME} ${command}\` is now \`${APP_NAME} ${replacement}\`.`));
	if (router.present && router.value !== undefined && !isRouterBackend(router.value)) {
		io.error(chalk.red(`Unknown classifier "${router.value}". Use --router jev or --router openrouter.`));
		return 1;
	}
	const backend = router.value as ClassifierBackend | undefined;
	if (command === "logout") {
		if (!router.present) return removeKeys(["runinfra"], agentDir, io);
		return removeKeys(backend ? [backend] : [...ROUTER_BACKENDS], agentDir, io);
	}
	if (router.present && !backend) {
		io.error(chalk.red("Name the classifier: --router jev or --router openrouter."));
		return 1;
	}
	return setKey(backend ?? "runinfra", flags, router.model, agentDir, io);
}

async function runKeyCommand(
	positionals: readonly string[],
	flags: readonly string[],
	agentDir: string,
	io: AccountCommandIo,
): Promise<number> {
	const action = positionals.find((word): word is KeyAction => (KEY_ACTIONS as readonly string[]).includes(word));
	const name = positionals.find((word): word is HubKey => KEY_NAMES.includes(word as HubKey));
	const router = readRouterFlags(flags);
	if (!action) {
		printKeyStatus(agentDir, io);
		return 0;
	}
	if (action === "remove") {
		if (!name) {
			io.error(chalk.red("Name the key: runinfra, jev or openrouter."));
			return 1;
		}
		return removeKeys([name], agentDir, io);
	}
	if (action === "test") return testKeys(name ? [name] : [...KEY_NAMES], agentDir, io);
	return setKey(name ?? "runinfra", flags, router.model, agentDir, io);
}

function keySourceLabel(key: HubKey, agentDir: string, env: NodeJS.ProcessEnv): string {
	try {
		return key === "runinfra"
			? getRunInfraKeyStatus(agentDir, env).label
			: getRouterKeyStatus(agentDir, key, env).label;
	} catch {
		return "unreadable key file";
	}
}

function keyLabel(key: HubKey): string {
	return key === "runinfra" ? "RunInfra" : ROUTER_BACKEND_LABELS[key];
}

function printKeyStatus(agentDir: string, io: AccountCommandIo): void {
	const width = Math.max(...KEY_NAMES.map((key) => keyLabel(key).length));
	for (const key of KEY_NAMES) io.log(`${keyLabel(key).padEnd(width)}  ${keySourceLabel(key, agentDir, io.env)}`);
	io.log(chalk.dim(`Change them with \`${APP_NAME} key set <name>\` or /setup keys.`));
}

function removeKeys(keys: readonly HubKey[], agentDir: string, io: AccountCommandIo): number {
	let removedAny = false;
	for (const key of keys) {
		let removed: boolean;
		try {
			removed = key === "runinfra" ? removeRunInfraApiKey(agentDir) : removeRouterKey(agentDir, key);
		} catch (error) {
			io.error(
				chalk.red(
					key === "runinfra"
						? error instanceof Error
							? error.message
							: "Could not update runinfra.json"
						: "Could not update router-keys.json.",
				),
			);
			return 1;
		}
		removedAny = removedAny || removed;
		if (removed) io.log(chalk.green(`✓ Saved ${keyLabel(key)} key removed.`));
		const note = key === "runinfra" ? envNote(io.env) : routerEnvNote(key, io.env);
		if (note) io.log(chalk.yellow(note));
	}
	if (!removedAny) {
		if (keys.length === 1) io.log(`No saved ${keyLabel(keys[0] ?? "runinfra")} key.`);
		else io.log("No saved router key.");
	}
	return 0;
}

async function testKeys(keys: readonly HubKey[], agentDir: string, io: AccountCommandIo): Promise<number> {
	let failed = false;
	let tested = 0;
	const settings = loadRouterClassifierSettings(agentDir);
	for (const key of keys) {
		const value =
			key === "runinfra" ? getActiveRunInfraKey(agentDir, io.env) : getActiveRouterKey(agentDir, key, io.env);
		if (!value) {
			if (keys.length === 1) io.log(`No ${keyLabel(key)} key.`);
			continue;
		}
		tested++;
		let ok: boolean;
		let message: string;
		try {
			if (key === "runinfra") {
				const config = loadRunInfraConfig(agentDir);
				const check = await checkRunInfraKey({
					baseUrl: config.baseUrl,
					apiKey: value,
					catalog: loadModelsCatalog(),
					fetchImpl: io.fetchImpl,
				});
				ok = check.ok;
				message = check.ok ? `${check.models.length} models` : check.message;
			} else {
				const check = await checkRouterKey({
					backend: key,
					apiKey: value,
					baseUrl: key === "jev" ? settings.jevBaseUrl : settings.openrouterBaseUrl,
					model: key === "jev" ? settings.jevModel : settings.openrouterModel,
					fetchImpl: io.fetchImpl,
				});
				ok = check.ok;
				message = check.message.replace(/^✓\s*/, "");
			}
		} catch {
			ok = false;
			message = "couldn't reach it. Check your connection.";
		}
		failed = failed || !ok;
		const line = `${ok ? "✓" : "✗"} ${keyLabel(key)} - ${message}`;
		io.log(ok ? chalk.green(line) : chalk.red(line));
	}
	if (tested === 0 && keys.length > 1) io.log("No keys are set.");
	return failed ? 1 : 0;
}

/** `key set <name>`: from stdin, or in the setup hub on a terminal. */
async function setKey(
	key: HubKey,
	flags: readonly string[],
	routerModel: string | undefined,
	agentDir: string,
	io: AccountCommandIo,
): Promise<number> {
	if (key !== "runinfra") return setRouterKey(key, flags, routerModel, agentDir, io);
	if (flags.includes("--stdin")) {
		const value = (await io.readStdin()).trim();
		if (!value) {
			io.error(chalk.red("No key on stdin."));
			return 1;
		}
		const config = loadRunInfraConfig(agentDir);
		const check = await checkRunInfraKey({
			baseUrl: config.baseUrl,
			apiKey: value,
			catalog: loadModelsCatalog(),
			fetchImpl: io.fetchImpl,
		});
		if (!check.ok) {
			io.error(chalk.red(`✗ ${check.message} Nothing was saved.`));
			return 1;
		}
		const warning = saveRunInfraApiKey(agentDir, value);
		saveCatalogCache(agentDir, config.baseUrl, check.remote);
		io.log(chalk.green("✓ Key works and is saved to ~/.runkiln/agent/runinfra.json."));
		if (warning) io.log(chalk.yellow(warning));
		const note = envNote(io.env);
		if (note) io.log(chalk.yellow(note));
		return 0;
	}
	if (!io.stdinIsTTY || !io.stdoutIsTTY) {
		io.error(
			`${APP_NAME} key set needs a terminal. Use \`${APP_NAME} key set --stdin\` or set ${RUNINFRA_API_KEY_ENV}. Keys: ${RUNINFRA_API_KEYS_URL}`,
		);
		return 1;
	}
	const result = await io.runHub({ section: "keys", keyAction: { key: "runinfra", action: "set" } });
	const status = getRunInfraKeyStatus(agentDir, io.env);
	io.log(
		result.keyChanged
			? `RunInfra key updated. Active: ${status.label}.`
			: `RunInfra key unchanged. Active: ${status.label}.`,
	);
	return 0;
}

async function setRouterKey(
	backend: ClassifierBackend,
	flags: readonly string[],
	routerModel: string | undefined,
	agentDir: string,
	io: AccountCommandIo,
): Promise<number> {
	const settings = loadRouterClassifierSettings(agentDir);
	let model = routerModel?.trim() || undefined;
	if (model && backend === "openrouter") {
		// Only decision models: checked against the live list (cached 24 h, built-in list when offline).
		const problem = validateOpenRouterDecisionModel(
			model,
			await getDecisionModels(agentDir, { fetch: io.fetchImpl }).catch(() => getCachedDecisionModels(agentDir)),
		);
		if (problem) {
			io.error(chalk.red(problem));
			return 1;
		}
	}
	if (backend === "openrouter") model = model ?? settings.openrouterModel;

	if (flags.includes("--stdin")) {
		const key = (await io.readStdin()).trim();
		if (!key) {
			io.error(chalk.red("No key on stdin."));
			return 1;
		}
		const check = await checkRouterKey({
			backend,
			apiKey: key,
			baseUrl: backend === "jev" ? settings.jevBaseUrl : settings.openrouterBaseUrl,
			model: backend === "jev" ? (model ?? settings.jevModel) : model,
			fetchImpl: io.fetchImpl,
		});
		if (!check.ok) {
			io.error(chalk.red(`✗ ${check.message} Nothing was saved.`));
			return 1;
		}
		let warning: string | undefined;
		try {
			warning = saveRouterKey(agentDir, backend, key);
			saveRouterClassifier(agentDir, backend, model);
		} catch {
			io.error(chalk.red("Could not save the router key."));
			return 1;
		}
		io.log(chalk.green(`✓ ${ROUTER_BACKEND_LABELS[backend]} key works and is saved to ${ROUTER_KEYS_DISPLAY_PATH}.`));
		io.log(`Router classifier: ${backend}${backend === "openrouter" && model ? ` (${model})` : ""}.`);
		if (check.detail) io.log(chalk.dim(check.detail));
		if (warning) io.log(chalk.yellow(warning));
		const note = routerEnvNote(backend, io.env);
		if (note) io.log(chalk.yellow(note));
		return 0;
	}

	if (!io.stdinIsTTY || !io.stdoutIsTTY) {
		io.error(
			`${APP_NAME} key set ${backend} needs a terminal. Use \`${APP_NAME} key set ${backend} --stdin\` or set ${CLASSIFIER_KEY_ENV[backend]}. Keys: ${ROUTER_KEY_URLS[backend]}`,
		);
		return 1;
	}
	const result = await io.runHub({ section: "keys", keyAction: { key: backend, action: "set" } });
	io.log(result.routerChanged ? "Router key updated." : "Router key unchanged.");
	return 0;
}

/** Wire the real terminal, stdin, and screens. */
export function defaultAccountCommandIo(settingsManager: SettingsManager, agentDir: string): AccountCommandIo {
	return {
		stdinIsTTY: !!process.stdin.isTTY,
		stdoutIsTTY: !!process.stdout.isTTY,
		readStdin: async () => {
			const chunks: Buffer[] = [];
			for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
			return Buffer.concat(chunks).toString("utf8");
		},
		log: (line) => console.log(line),
		error: (line) => console.error(line),
		env: process.env,
		runSetup: () => runFirstRunSetup({ settingsManager, agentDir }),
		runHub: (options) => runSetupHub({ settingsManager, agentDir, ...options }),
	};
}
