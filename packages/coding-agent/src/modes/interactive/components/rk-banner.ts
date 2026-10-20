import { foregroundAnsi, rgbColor } from "@runkiln/tui";
import { theme } from "../theme/theme.ts";

/**
 * The RunKiln startup banner: "RK" in shadowed block letters with the name beside it. Plain text only:
 * no images or fonts are loaded at startup. The faces (█) are the glowing bricks, the box-drawing edges
 * their shadow.
 */
export const RK_BANNER_ART: readonly string[] = [
	"██████╗ ██╗  ██╗",
	"██╔══██╗██║ ██╔╝",
	"██████╔╝█████╔╝     RunKiln",
	"██╔══██╗██╔═██╗",
	"██║  ██║██║  ██╗",
];

/** Zero-based column where the name starts, so the version can line up under it. */
export const RK_BANNER_NAME_COLUMN = 20;

/** Ember faces, top to bottom: #FF6A1A to #C9420A, one shade per line. */
const EMBER = [
	{ r: 255, g: 106, b: 26 },
	{ r: 241, g: 96, b: 22 },
	{ r: 228, g: 86, b: 18 },
	{ r: 214, g: 76, b: 14 },
	{ r: 201, g: 66, b: 10 },
];
/** Shadow edges: a deep coal-red, so the faces read as lit bricks. */
const SHADOW = { r: 122, g: 38, b: 8 };
const RESET = "\x1b[0m";

const rgb = (color: { r: number; g: number; b: number }) => rgbColor(color.r, color.g, color.b);

/**
 * The banner colored with ANSI escapes: ember faces, darker shadow edges, the name in bright ember and
 * `version` dimmed under it. The brand colors stay fixed across themes; they follow the terminal's color mode.
 */
export function rkBannerLines(version?: string): string[] {
	const mode = theme.getColorMode();
	const shadow = foregroundAnsi(rgb(SHADOW), mode);
	const name = foregroundAnsi(rgb(EMBER[0]), mode);
	return RK_BANNER_ART.map((line, row) => {
		const face = foregroundAnsi(rgb(EMBER[row]), mode);
		const art = line.slice(0, RK_BANNER_NAME_COLUMN).trimEnd();
		// Group runs of faces and of edges so each run carries a single escape.
		const colored = art.replace(/█+|[^█ ]+/g, (run) => `${run.startsWith("█") ? face : shadow}${run}${RESET}`);
		const padding = " ".repeat(RK_BANNER_NAME_COLUMN - art.length);
		const label = line.slice(RK_BANNER_NAME_COLUMN);
		if (label) return `${colored}${padding}${name}${label}${RESET}`;
		if (row === 3 && version) return `${colored}${padding}${theme.fg("dim", `v${version}`)}`;
		return colored;
	});
}
