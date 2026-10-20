import * as path from "node:path";
import {
	type Component,
	MouseRegion,
	Text,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
} from "@runkiln/tui";
import { theme } from "../theme/theme.ts";
import type { ToolExecutionComponent } from "./tool-execution.ts";

/** Tools that only look at the workspace; consecutive calls fold into one line. */
export const READ_ONLY_GROUP_TOOLS = new Set(["read", "grep", "find", "ls"]);

export function isGroupableTool(toolName: string): boolean {
	return READ_ONLY_GROUP_TOOLS.has(toolName);
}

export interface ToolGroupCall {
	toolName: string;
	args: any;
	status: "pending" | "success" | "error";
}

function argPath(args: any): string | undefined {
	const value = args?.path ?? args?.file_path;
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function relativePath(p: string, cwd: string): string {
	if (!path.isAbsolute(p)) return p.replace(/^\.\//, "");
	const rel = path.relative(cwd, p);
	return rel === "" ? "." : rel.startsWith("..") ? p : rel;
}

/** The deepest directory shared by all paths ("src/core" for src/core/a.ts and src/core/x/b.ts). */
export function commonScope(paths: string[]): string | undefined {
	if (paths.length === 0) return undefined;
	if (paths.length === 1) return paths[0];
	const split = paths.map((p) => p.split(/[\\/]/).filter(Boolean));
	const first = split[0];
	let shared = 0;
	while (shared < first.length && split.every((parts) => parts[shared] === first[shared])) shared++;
	// A path that is entirely shared is a file or directory itself; scope to its parent when others go deeper.
	const scope = first.slice(0, shared).join("/");
	return scope.length > 0 ? scope : undefined;
}

/** `read 4 files, grep 2×, ls 1× (src/core…)` and the error / pending markers, without styling. */
export function summarizeToolGroup(
	calls: ToolGroupCall[],
	cwd: string,
): { text: string; errors: number; pending: number } {
	const readPaths = new Set<string>();
	const counts = new Map<string, number>();
	const paths: string[] = [];
	let errors = 0;
	let pending = 0;
	for (const call of calls) {
		if (call.status === "error") errors++;
		if (call.status === "pending") pending++;
		const p = argPath(call.args);
		const rel = p ? relativePath(p, cwd) : undefined;
		if (rel && rel !== ".") paths.push(rel);
		if (call.toolName === "read") {
			readPaths.add(rel ?? `#${readPaths.size}`);
		} else {
			counts.set(call.toolName, (counts.get(call.toolName) ?? 0) + 1);
		}
	}
	const parts: string[] = [];
	if (readPaths.size > 0) parts.push(`read ${readPaths.size} file${readPaths.size === 1 ? "" : "s"}`);
	for (const tool of ["grep", "find", "ls"]) {
		const count = counts.get(tool);
		if (count) parts.push(`${tool} ${count}×`);
	}
	const distinct = [...new Set(paths)];
	const scope = commonScope(distinct);
	let text = parts.join(", ");
	if (scope) text += distinct.length > 1 ? ` (${scope}…)` : ` (${scope})`;
	return { text, errors, pending };
}

/**
 * Consecutive read-only tool calls shown as one line, `⌕ read 4 files, grep 2× (src/core…)`. A click (or the
 * tool expand key) shows the individual cards. With a single call the card is shown as is.
 */
export class ToolGroupComponent implements Component {
	private readonly tools: ToolExecutionComponent[] = [];
	private expanded = false;
	private selectMarker: string | undefined;
	private readonly cwd: string;
	private readonly onToggle?: () => void;
	private readonly header: MouseRegion;
	private readonly headerText: Text;

	constructor(cwd: string, outputPad: number, onToggle?: () => void) {
		this.cwd = cwd;
		this.onToggle = onToggle;
		this.headerText = new Text("", outputPad, 0);
		this.header = new MouseRegion(this.headerText, (event) => {
			if (event.type !== "click" || event.button !== "left") return undefined;
			this.setGroupExpanded(!this.expanded);
			this.onToggle?.();
			return { handled: true };
		});
	}

	/** Card select mode: show or hide the group's cards, like a click on its line. */
	toggleSelected(): void {
		if (this.tools.length === 1) this.tools[0].toggleSelected();
		else this.setGroupExpanded(!this.expanded);
	}

	setSelectMarker(marker: string | undefined): void {
		this.selectMarker = marker;
		if (this.tools.length === 1) this.tools[0].setSelectMarker(marker);
	}

	addTool(tool: ToolExecutionComponent): void {
		if (this.tools.length === 1) this.tools[0].setSelectMarker(undefined);
		this.tools.push(tool);
	}

	getTools(): readonly ToolExecutionComponent[] {
		return this.tools;
	}

	get size(): number {
		return this.tools.length;
	}

	isExpanded(): boolean {
		return this.expanded;
	}

	/** Show or hide the individual cards without changing how each card is expanded. */
	setGroupExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	/** The global toggle: expands the group and every card in it. */
	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		for (const tool of this.tools) tool.setExpanded(expanded);
	}

	setOutputPad(outputPad: number): void {
		this.headerText.setPaddingX(outputPad);
		for (const tool of this.tools) tool.setOutputPad(outputPad);
	}

	setShowImages(show: boolean): void {
		for (const tool of this.tools) tool.setShowImages(show);
	}

	setImageWidthCells(width: number): void {
		for (const tool of this.tools) tool.setImageWidthCells(width);
	}

	summaryLine(): string {
		const { text, errors, pending } = summarizeToolGroup(
			this.tools.map((tool) => ({ toolName: tool.getToolName(), args: tool.getArgs(), status: tool.getStatus() })),
			this.cwd,
		);
		let line = `${theme.fg("toolTitle", theme.bold("⌕"))} ${theme.fg("muted", text)}`;
		if (errors > 0) line += theme.fg("error", ` - ${errors} failed`);
		if (pending > 0) line += theme.fg("dim", " …");
		line += theme.fg("dim", this.expanded ? "  ▾" : "  ▸");
		return line;
	}

	render(width: number): string[] {
		if (this.tools.length === 1) return this.tools[0].render(width);
		this.headerText.setText(this.summaryLine());
		const marker = this.selectMarker === undefined ? "" : truncateToWidth(this.selectMarker, width, "…");
		const lines = [marker, ...this.header.render(width).map((line) => truncateToWidth(line, width, "…"))];
		if (this.expanded) {
			for (const tool of this.tools) lines.push(...tool.render(width));
		}
		return lines;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.tools.length === 1) return this.tools[0].handleMouse(event);
		if (event.type === "leave") {
			let render = false;
			for (const tool of this.tools) render = Boolean(tool.handleMouse(event)?.render) || render;
			return render ? { handled: true, render: true } : undefined;
		}
		if (event.type === "move") {
			// The group is the hover target for all its cards: tell the others the pointer left them.
			const target = this.toolAt(event);
			let render = false;
			for (const tool of this.tools) {
				if (tool !== target?.tool)
					render = Boolean(tool.handleMouse({ ...event, type: "leave" })?.render) || render;
			}
			const result = target ? target.tool.handleMouse({ ...event, y: target.y, height: target.height }) : undefined;
			if (!result && !render) return undefined;
			return { ...(result ?? {}), handled: true, render: render || Boolean(result?.render) };
		}
		// Row 0 is the blank spacer, row 1 the summary line, then the cards when expanded.
		if (event.y === 1) return this.header.handleMouse({ ...event, y: 0, height: 1 });
		if (!this.expanded || event.y < 2) return undefined;
		let offset = 2;
		for (const tool of this.tools) {
			const height = tool.render(event.width).length;
			if (event.y < offset + height) {
				return tool.handleMouse({ ...event, y: event.y - offset, height });
			}
			offset += height;
		}
		return undefined;
	}

	/** The expanded card under the pointer, with local coordinates. */
	private toolAt(event: TuiMouseEvent): { tool: ToolExecutionComponent; y: number; height: number } | undefined {
		if (!this.expanded || event.y < 2) return undefined;
		let offset = 2;
		for (const tool of this.tools) {
			const height = tool.render(event.width).length;
			if (event.y < offset + height) return { tool, y: event.y - offset, height };
			offset += height;
		}
		return undefined;
	}

	invalidate(): void {
		this.headerText.invalidate();
		for (const tool of this.tools) tool.invalidate();
	}
}
