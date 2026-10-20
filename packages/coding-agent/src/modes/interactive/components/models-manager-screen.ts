/**
 * `/models`: RunInfra's catalog with price, context, vision and thinking levels. Turn models on or
 * off (the `disabledModels` setting), pick the default model, and the default thinking level.
 * Every change is saved as soon as it is made.
 */

import type { ThinkingLevel } from "@runkiln/agent-core";
import { type Component, type Focusable, getKeybindings, matchesKey } from "@runkiln/tui";
import { THINKING_LEVEL_OPTIONS } from "../../../core/defaults.ts";
import { effectiveRoleDefaults } from "../../../core/runkiln/model-roles.ts";
import type { ModelsCatalog } from "../../../core/runkiln/models-catalog.ts";
import {
	buildModelRows,
	formatAge,
	formatContext,
	formatPrice,
	type LoadedCatalog,
	loadRunInfraCatalog,
	type ModelRow,
} from "../../../core/runkiln/runinfra-account.ts";
import type { SettingsManager } from "../../../core/settings-manager.ts";
import { theme } from "../theme/theme.ts";
import { fit, hintLine, rule, type StatusKind, statusLine, titleLine } from "./runinfra-ui.ts";

/** What the screen reads and writes. {@link settingsModelsStore} adapts a SettingsManager. */
export interface ModelsSettingsStore {
	getDisabledModels(): string[];
	setDisabledModels(modelIds: string[]): void;
	/** The effective default (code role) model id. */
	getDefaultModel(): string;
	setDefaultModel(modelId: string): void;
	getDefaultThinkingLevel(): ThinkingLevel | undefined;
	setDefaultThinkingLevel(level: ThinkingLevel): void;
}

export function settingsModelsStore(settings: SettingsManager, catalog: ModelsCatalog): ModelsSettingsStore {
	return {
		getDisabledModels: () => settings.getDisabledModels(),
		setDisabledModels: (ids) => settings.setDisabledModels(ids),
		getDefaultModel: () => effectiveRoleDefaults(catalog, settings.getModelRoles()).code,
		setDefaultModel: (id) => settings.setModelRole("code", id),
		getDefaultThinkingLevel: () => settings.getDefaultThinkingLevel(),
		setDefaultThinkingLevel: (level) => settings.setDefaultThinkingLevel(level),
	};
}

export interface ModelsManagerResult {
	changed: boolean;
}

export interface ModelsManagerOptions {
	catalog: ModelsCatalog;
	store: ModelsSettingsStore;
	/** Model ids without quality curves (marked "unbenched"). */
	unbenched?: readonly string[];
	agentDir: string;
	baseUrl: string;
	/** Active key, if any. Only used for the live `/models` request. */
	apiKey: string | undefined;
	fetchImpl?: typeof fetch;
	/** Skip the live request and use the cache / bundled catalog. */
	offline?: boolean;
	/** Use this catalog instead of fetching (tests, previews). */
	preloaded?: LoadedCatalog;
	requestRender?: () => void;
	/** Called after every saved change, so the session can re-read `disabledModels`. */
	onChange?: () => void;
	onClose: (result: ModelsManagerResult) => void;
}

const THINKING_CYCLE: readonly ThinkingLevel[] = THINKING_LEVEL_OPTIONS;
const NAME_WIDTH = 26;

export class ModelsManagerScreen implements Component, Focusable {
	private readonly options: ModelsManagerOptions;
	private readonly requestRender: () => void;
	private loaded: LoadedCatalog | undefined;
	private rows: ModelRow[];
	private cursor = 0;
	private status: { kind: StatusKind; text: string } | undefined;
	private changed = false;
	private busy = false;
	private pending: Promise<void> = Promise.resolve();
	focused = false;

	constructor(options: ModelsManagerOptions) {
		this.options = options;
		this.requestRender = options.requestRender ?? (() => {});
		this.rows = buildModelRows(options.catalog, undefined, options.store.getDisabledModels(), options.unbenched);
		const defaultIndex = this.rows.findIndex((row) => row.id === options.store.getDefaultModel());
		this.cursor = Math.max(0, defaultIndex);
		if (options.preloaded) {
			this.apply(options.preloaded);
		} else {
			this.pending = this.refresh().then(() => this.requestRender());
		}
	}

	invalidate(): void {}

	whenIdle(): Promise<void> {
		return this.pending;
	}

	getRows(): readonly ModelRow[] {
		return this.rows;
	}

	handleInput(data: string): void {
		this.pending = this.pending.then(() => this.onInput(data)).then(() => this.requestRender());
	}

	private apply(loaded: LoadedCatalog): void {
		this.loaded = loaded;
		this.rows = buildModelRows(
			this.options.catalog,
			loaded.models,
			this.options.store.getDisabledModels(),
			this.options.unbenched,
		);
	}

	private async refresh(): Promise<void> {
		this.busy = true;
		this.status = { kind: "muted", text: "Fetching the RunInfra catalog…" };
		this.requestRender();
		try {
			const loaded = await loadRunInfraCatalog({
				agentDir: this.options.agentDir,
				baseUrl: this.options.baseUrl,
				apiKey: this.options.apiKey,
				fetchImpl: this.options.fetchImpl,
				offline: this.options.offline,
			});
			this.apply(loaded);
			this.status =
				loaded.failure?.status === 401
					? { kind: "error", text: `${loaded.error} Replace it in /setup keys.` }
					: undefined;
		} finally {
			this.busy = false;
		}
	}

	private async onInput(data: string): Promise<void> {
		if (this.busy) return;
		const kb = getKeybindings();
		if (matchesKey(data, "escape") || kb.matches(data, "tui.select.cancel")) {
			this.options.onClose({ changed: this.changed });
			return;
		}
		if (matchesKey(data, "up") || kb.matches(data, "tui.select.up")) {
			this.cursor = (this.cursor + this.rows.length - 1) % this.rows.length;
			return;
		}
		if (matchesKey(data, "down") || kb.matches(data, "tui.select.down")) {
			this.cursor = (this.cursor + 1) % this.rows.length;
			return;
		}
		const row = this.rows[this.cursor];
		if (!row) return;
		if (data === " ") {
			this.toggle(row);
			return;
		}
		if (data === "\r" || data === "\n" || kb.matches(data, "tui.input.submit")) {
			this.makeDefault(row);
			return;
		}
		if (data === "t" || data === "T") {
			this.cycleThinking(data === "T" ? -1 : 1);
			return;
		}
		if (data === "r") {
			await this.refresh();
		}
	}

	private save(disabled: string[]): void {
		this.options.store.setDisabledModels(disabled);
		this.rows = buildModelRows(this.options.catalog, this.loaded?.models, disabled, this.options.unbenched);
		this.changed = true;
		this.options.onChange?.();
	}

	private toggle(row: ModelRow): void {
		const disabled = new Set(this.options.store.getDisabledModels());
		if (row.enabled) {
			if (row.id === this.options.store.getDefaultModel()) {
				this.status = {
					kind: "warning",
					text: `${row.name} is the default model. Make another model the default first.`,
				};
				return;
			}
			if (this.rows.filter((entry) => entry.enabled).length <= 1) {
				this.status = { kind: "warning", text: "Keep at least one model enabled." };
				return;
			}
			disabled.add(row.id);
			this.status = { kind: "muted", text: `${row.name} hidden from the selector, cycling and routing.` };
		} else {
			disabled.delete(row.id);
			this.status = { kind: "success", text: `${row.name} enabled.` };
		}
		this.save([...disabled]);
	}

	private makeDefault(row: ModelRow): void {
		if (row.newInCatalog) {
			this.status = {
				kind: "warning",
				text: `${row.name} is new in the RunInfra catalog (not in models.yaml): pick it with /model ${row.id}; it can't be the default yet.`,
			};
			return;
		}
		const disabled = this.options.store.getDisabledModels();
		if (disabled.includes(row.id)) this.save(disabled.filter((id) => id !== row.id));
		this.options.store.setDefaultModel(row.id);
		this.changed = true;
		this.options.onChange?.();
		const paused = row.status === "paused" ? " It is paused right now; RunKiln falls back until it returns." : "";
		this.status = {
			kind: row.status === "paused" ? "warning" : "success",
			text: `Default model: ${row.name}.${paused}`,
		};
	}

	private cycleThinking(delta: number): void {
		const current = this.options.store.getDefaultThinkingLevel();
		const index = current ? THINKING_CYCLE.indexOf(current) : -1;
		const next = THINKING_CYCLE[(index + delta + THINKING_CYCLE.length) % THINKING_CYCLE.length] ?? "off";
		this.options.store.setDefaultThinkingLevel(next);
		this.changed = true;
		this.options.onChange?.();
		this.status = { kind: "success", text: `Default thinking level: ${next}.` };
	}

	private sourceLine(): string {
		const loaded = this.loaded;
		if (!loaded) return theme.fg("muted", "loading…");
		const count = loaded.models.length;
		if (loaded.source === "live") return theme.fg("success", `live - ${count} models listed for this key`);
		if (loaded.source === "cache") {
			const age = loaded.fetchedAt ? formatAge(loaded.fetchedAt) : "earlier";
			return (
				theme.fg("warning", `offline - cached ${age}`) + (loaded.error ? theme.fg("dim", ` - ${loaded.error}`) : "")
			);
		}
		return (
			theme.fg("warning", "offline - bundled catalog") + (loaded.error ? theme.fg("dim", ` - ${loaded.error}`) : "")
		);
	}

	private renderRow(row: ModelRow, selected: boolean, defaultId: string): string {
		const pointer = selected ? theme.fg("accent", "→ ") : "  ";
		const check = row.enabled ? theme.fg("success", "✓ ") : theme.fg("dim", "- ");
		const star = row.id === defaultId ? theme.fg("accent", "★ ") : "  ";
		const nameText =
			row.name.length > NAME_WIDTH ? `${row.name.slice(0, NAME_WIDTH - 1)}…` : row.name.padEnd(NAME_WIDTH);
		const name = !row.enabled
			? theme.fg("dim", nameText)
			: selected
				? theme.fg("accent", theme.bold(nameText))
				: nameText;
		const price = `${formatPrice(row.priceIn)}/${formatPrice(row.priceOut)}`.padEnd(12);
		const context = formatContext(row.context).padEnd(6);
		const vision = (row.vision ? "vision" : "text").padEnd(7);
		const efforts = row.efforts.length > 0 ? row.efforts.join(" ") : "fixed";
		const state =
			row.status === "paused"
				? theme.fg("warning", "  paused")
				: row.status === "unlisted"
					? theme.fg("dim", "  not listed for this key")
					: "";
		const bench = row.unbenched ? theme.fg("warning", row.newInCatalog ? "  new - unbenched" : "  unbenched") : "";
		const dimIf = (text: string) => (row.enabled ? theme.fg("muted", text) : theme.fg("dim", text));
		return `${pointer}${check}${star}${name} ${dimIf(price)}${dimIf(context)}${dimIf(vision)}${dimIf(efforts)}${state}${bench}`;
	}

	render(width: number): string[] {
		const store = this.options.store;
		const defaultId = store.getDefaultModel();
		const enabledCount = this.rows.filter((row) => row.enabled).length;
		const lines: string[] = [
			titleLine("RunInfra", `Models - ${enabledCount}/${this.rows.length} enabled`),
			this.sourceLine(),
			rule(width),
			theme.fg(
				"dim",
				`      ${"Model".padEnd(NAME_WIDTH)} ${"$/M in/out".padEnd(12)}${"Ctx".padEnd(6)}${"Input".padEnd(7)}Thinking levels`,
			),
		];
		for (const [index, row] of this.rows.entries()) {
			lines.push(this.renderRow(row, index === this.cursor, defaultId));
		}
		lines.push(rule(width));
		const defaultRow = this.rows.find((row) => row.id === defaultId);
		const thinking = store.getDefaultThinkingLevel();
		lines.push(
			`${theme.fg("muted", "Default model ")}${theme.fg("accent", defaultRow?.name ?? defaultId)}${theme.fg("muted", "   Default thinking ")}${theme.fg("accent", thinking ?? "not set")}`,
		);
		const selected = this.rows[this.cursor];
		if (selected) {
			const effort = selected.harnessEffort
				? `sends effort ${selected.harnessEffort} by default`
				: "no effort sent by default";
			const paused =
				selected.status === "paused" && selected.pausedUntil ? ` - paused until ${selected.pausedUntil}` : "";
			const bench = selected.unbenched ? " - unbenched: auto picks it only when no benched model fits" : "";
			lines.push(theme.fg("dim", `${selected.id} - ${effort}${paused}${bench}`));
		}
		if (this.status) lines.push(statusLine(this.status.kind, this.status.text));
		lines.push("");
		lines.push(
			hintLine([
				["↑↓", "move"],
				["space", "on/off"],
				["enter", "default"],
				["t", "thinking"],
				["r", "refresh"],
				["esc", "close"],
			]),
		);
		return lines.map((line) => fit(line, width));
	}
}
