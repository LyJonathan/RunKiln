/**
 * `/map`: the repo map in a bordered panel, colored with the theme (paths, signatures with the defined name
 * highlighted, keywords dimmed).
 */

import { type Component, Container, Spacer, truncateToWidth } from "@runkiln/tui";
import type { RepoMapStyle } from "../../../core/repo-map/render.ts";
import type { RepoMapRequest, RepoMapResult } from "../../../core/repo-map/repo-map.ts";
import type { DefTag } from "../../../core/repo-map/tags.ts";
import { repoMapHeader } from "../../../core/repo-map/tool.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { ThemedText } from "./themed-text.ts";

const KEYWORDS =
	/\b(export|default|async|function|class|interface|type|enum|const|let|var|def|fn|pub|struct|trait|impl|func|abstract|static|public|private|protected|override|readonly|extends|implements|mod|module)\b/g;

function styleSignature(text: string, def: DefTag): string {
	const at = text.indexOf(def.name);
	const color = (part: string) => part.replace(KEYWORDS, (word) => theme.fg("syntaxKeyword", word));
	if (at < 0) return color(text);
	const nameColor =
		def.kind === "class" || def.kind === "interface" || def.kind === "type" || def.kind === "enum"
			? "syntaxType"
			: "syntaxFunction";
	return `${color(text.slice(0, at))}${theme.bold(theme.fg(nameColor, def.name))}${theme.fg("muted", text.slice(at + def.name.length))}`;
}

export function themedRepoMapStyle(): RepoMapStyle {
	return {
		path: (text) => theme.bold(theme.fg("accent", text)),
		gutter: (text) => theme.fg("borderMuted", text),
		signature: styleSignature,
		dim: (text) => theme.fg("dim", text),
	};
}

/** `/map [tokens] [path ...] [words ...]`: numbers set the budget, existing paths focus, other words are a query. */
export function parseMapArgs(arg: string, isPath: (path: string) => boolean): RepoMapRequest {
	const request: RepoMapRequest = {};
	const words: string[] = [];
	const paths: string[] = [];
	for (const word of arg.split(/\s+/).filter(Boolean)) {
		if (/^\d+k?$/i.test(word))
			request.tokens = word.toLowerCase().endsWith("k") ? Number(word.slice(0, -1)) * 1000 : Number(word);
		else if (isPath(word)) paths.push(word);
		else words.push(word);
	}
	if (paths.length > 0) request.focusPaths = paths;
	if (words.length > 0) request.query = words.join(" ");
	return request;
}

/**
 * The map body, one terminal row per map line: a long signature is cut with "…" at the panel width
 * instead of wrapping to column 0, which would break the "│" gutter. Rebuilt after invalidation (theme changes).
 */
class MapLines implements Component {
	private lines: string[] | undefined;

	private readonly build: () => string;

	constructor(build: () => string) {
		this.build = build;
	}

	invalidate(): void {
		this.lines = undefined;
	}

	render(width: number): string[] {
		this.lines ??= this.build().split("\n");
		const inner = Math.max(1, width - 2);
		return this.lines.map((line) => ` ${truncateToWidth(line, inner, "…")}`);
	}
}

/** The panel: border, title with the map's size, the colored map, a hint line, border. */
export function buildRepoMapPanel(result: RepoMapResult, styledMap: () => string): Container {
	const panel = new Container();
	panel.addChild(new Spacer(1));
	panel.addChild(new DynamicBorder((text) => theme.fg("borderAccent", text)));
	panel.addChild(new ThemedText(() => theme.bold(theme.fg("accent", repoMapHeader(result))), 1, 0));
	panel.addChild(
		new ThemedText(
			() =>
				theme.fg(
					"dim",
					`${result.parser === "regex" ? "regex fallback" : result.parser} - HEAD ${result.head.slice(0, 7)} - ${result.reparsed} file${result.reparsed === 1 ? "" : "s"} parsed in ${result.buildMs} ms${result.fromDiskCache ? " - disk cache" : ""}`,
				),
			1,
			0,
		),
	);
	panel.addChild(new Spacer(1));
	panel.addChild(
		result.text.length > 0
			? new MapLines(styledMap)
			: new ThemedText(
					() =>
						theme.fg("muted", "No source files found (TS/JS, Python, Go, Rust, Java, Ruby, C#, C/C++, PHP, …)."),
					1,
					0,
				),
	);
	panel.addChild(new Spacer(1));
	panel.addChild(
		new ThemedText(
			() => theme.fg("dim", "/map [tokens] [paths…] [words…] - the agent gets the same map from the repo_map tool"),
			1,
			0,
		),
	);
	panel.addChild(new DynamicBorder((text) => theme.fg("borderAccent", text)));
	return panel;
}
