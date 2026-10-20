/**
 * The post-edit pipeline: check a file before and after an edit/write and report only the diagnostics the edit
 * introduced, condensed to about 20 lines, for the tool result.
 *
 * The "before" run is the baseline. Its result is cached by file content, so a run of edits to one file pays for
 * one baseline: each "after" run is the next edit's baseline.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { condenseOutput } from "../tools/condense-output.ts";
import {
	type CheckerSpec,
	configuredCheckers,
	type Diagnostic,
	detectCheckers,
	newDiagnostics,
	runCheckers,
	toProjectPath,
} from "./diagnostics.ts";

export const DEFAULT_CHECK_TIMEOUT_MS = 4000;
/** tsc and cargo check the whole project: kept only while a run stays under this. */
export const PROJECT_CHECK_FAST_MS = 3000;
export const MAX_DIAGNOSTIC_LINES = 20;
/** The tool-result marker the router counts as a failure signal. */
export const DIAGNOSTICS_MARKER = "Diagnostics after edit";

export interface PostEditSettings {
	enabled: boolean;
	autoDetect: boolean;
	timeoutMs: number;
	commands?: Record<string, string>;
}

export interface PostEditReport {
	/** Checkers that ran (both runs). */
	checkers: string[];
	newErrors: number;
	newWarnings: number;
	/** The text appended to the tool result, starting with the marker; undefined when nothing new. */
	text?: string;
	diagnostics: Diagnostic[];
	/** Checkers skipped because they timed out or proved slow. */
	skipped: string[];
}

export interface PostEditHost {
	cwd: () => string;
	settings: () => PostEditSettings;
	/** False in plan mode: no checks run. */
	isActive: () => boolean;
	/**
	 * Whether a configured (non auto-detected) check command may run. Goes through the permission gate like any
	 * shell command. Defaults to allowed.
	 */
	approveCommand?: (command: string, signal?: AbortSignal) => Promise<boolean>;
}

/** The handle edit/write call around their write. */
export interface PostEditHook {
	/** Runs the baseline (or reuses the cached one). Call before writing. */
	before(absPath: string, signal?: AbortSignal): Promise<PostEditBaseline | undefined>;
	/** Runs the checks on the new content and returns what the edit introduced. */
	after(
		baseline: PostEditBaseline | undefined,
		absPath: string,
		signal?: AbortSignal,
	): Promise<PostEditReport | undefined>;
}

export interface PostEditBaseline {
	absPath: string;
	checkers: CheckerSpec[];
	diagnostics: Diagnostic[];
}

function hashFile(absPath: string): string | undefined {
	try {
		return createHash("sha1").update(readFileSync(absPath)).digest("hex");
	} catch {
		return undefined;
	}
}

/** Errors first, then by line. */
export function sortDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
	return [...diagnostics].sort(
		(a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1) || a.line - b.line,
	);
}

export function formatDiagnostic(d: Diagnostic): string {
	const where = `${d.file}:${d.line}${d.col ? `:${d.col}` : ""}`;
	return `${where} ${d.severity}${d.code ? ` ${d.code}` : ""}: ${d.message} (${d.source})`;
}

export function formatReport(file: string, fresh: readonly Diagnostic[], checkers: readonly string[]): string {
	const errors = fresh.filter((d) => d.severity === "error").length;
	const warnings = fresh.length - errors;
	const counts = [
		errors > 0 ? `${errors} new error${errors === 1 ? "" : "s"}` : "",
		warnings > 0 ? `${warnings} new warning${warnings === 1 ? "" : "s"}` : "",
	]
		.filter(Boolean)
		.join(", ");
	const body = sortDiagnostics(fresh).map(formatDiagnostic).join("\n");
	const condensed = condenseOutput(body, {
		maxLines: MAX_DIAGNOSTIC_LINES - 1,
		headLines: 14,
		tailLines: 2,
		maxErrorLines: 2,
	});
	const text = condensed.condensed ? condensed.text.replace(/\n\n\[Output condensed:[^\]]*\]$/, "") : condensed.text;
	return `${DIAGNOSTICS_MARKER} (${checkers.join(", ")}): ${counts} in ${file}. Fix them unless they are expected.\n${text}`;
}

export class PostEditChecks implements PostEditHook {
	private readonly host: PostEditHost;
	/** Diagnostics by "path\0content hash\0checker ids". */
	private readonly cache = new Map<string, Diagnostic[]>();
	/** Checkers dropped for the session: project-wide ones that were slow, and any that timed out. */
	private readonly slow = new Set<string>();
	/** Configured commands the gate refused (asked once per session). */
	private readonly refused = new Set<string>();
	private readonly allowed = new Set<string>();

	constructor(host: PostEditHost) {
		this.host = host;
	}

	/** Checkers left out for the rest of the session (slow or timed out). */
	get skippedCheckers(): readonly string[] {
		return [...this.slow];
	}

	private enabled(): boolean {
		return this.host.settings().enabled && this.host.isActive();
	}

	private async checkersFor(absPath: string, signal?: AbortSignal): Promise<CheckerSpec[]> {
		const settings = this.host.settings();
		const root = this.host.cwd();
		const configured = configuredCheckers(absPath, root, settings.commands);
		const approved: CheckerSpec[] = [];
		for (const checker of configured) {
			if (this.refused.has(checker.command)) continue;
			if (!this.allowed.has(checker.command)) {
				const ok = this.host.approveCommand ? await this.host.approveCommand(checker.command, signal) : true;
				if (!ok) {
					this.refused.add(checker.command);
					continue;
				}
				this.allowed.add(checker.command);
			}
			approved.push(checker);
		}
		const auto = settings.autoDetect ? detectCheckers(absPath, root, { skip: this.slow }) : [];
		// A configured command for the file replaces auto-detection of the same tool.
		const configuredIds = new Set(approved.map((checker) => checker.id));
		return [...approved, ...auto.filter((checker) => !configuredIds.has(checker.id))];
	}

	private async run(checkers: CheckerSpec[], absPath: string, signal?: AbortSignal) {
		const settings = this.host.settings();
		const ids = checkers.map((c) => c.id).join(",");
		const hash = hashFile(absPath);
		const key = hash ? `${absPath}\0${hash}\0${ids}` : undefined;
		const cached = key ? this.cache.get(key) : undefined;
		if (cached) return { diagnostics: cached, ran: checkers.map((c) => c.id), timedOut: [] as string[] };
		const result = await runCheckers(checkers, absPath, this.host.cwd(), { timeoutMs: settings.timeoutMs, signal });
		for (const id of result.timedOut) this.slow.add(id);
		for (const checker of checkers) {
			if (checker.scope === "project" && (result.durations[checker.id] ?? 0) > PROJECT_CHECK_FAST_MS) {
				this.slow.add(checker.id);
			}
		}
		if (key && result.timedOut.length === 0 && !signal?.aborted) {
			if (this.cache.size > 200) this.cache.clear();
			this.cache.set(key, result.diagnostics);
		}
		return result;
	}

	async before(absPath: string, signal?: AbortSignal): Promise<PostEditBaseline | undefined> {
		if (!this.enabled()) return undefined;
		const checkers = await this.checkersFor(absPath, signal);
		if (checkers.length === 0) return undefined;
		// A new file has no baseline.
		if (!hashFile(absPath)) return { absPath, checkers, diagnostics: [] };
		const result = await this.run(checkers, absPath, signal);
		// A checker that timed out on the baseline would report every old problem as new: drop it.
		const usable = checkers.filter((c) => result.ran.includes(c.id) && !this.slow.has(c.id));
		const ids = new Set(usable.map((c) => c.id));
		return { absPath, checkers: usable, diagnostics: result.diagnostics.filter((d) => ids.has(d.source)) };
	}

	async after(
		baseline: PostEditBaseline | undefined,
		absPath: string,
		signal?: AbortSignal,
	): Promise<PostEditReport | undefined> {
		if (!baseline || baseline.checkers.length === 0 || !this.enabled() || signal?.aborted) return undefined;
		const checkers = baseline.checkers.filter((c) => !this.slow.has(c.id));
		if (checkers.length === 0) return undefined;
		const result = await this.run(checkers, absPath, signal);
		const ran = checkers.filter((c) => result.ran.includes(c.id)).map((c) => c.id);
		const fresh = sortDiagnostics(
			newDiagnostics(
				baseline.diagnostics,
				result.diagnostics.filter((d) => ran.includes(d.source)),
			),
		);
		const newErrors = fresh.filter((d) => d.severity === "error").length;
		const report: PostEditReport = {
			checkers: ran,
			newErrors,
			newWarnings: fresh.length - newErrors,
			diagnostics: fresh,
			skipped: result.timedOut,
		};
		if (fresh.length > 0) report.text = formatReport(toProjectPath(absPath, this.host.cwd()), fresh, ran);
		return report;
	}
}
