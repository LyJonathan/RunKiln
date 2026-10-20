import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

let standalone: boolean | undefined;

/** True inside the standalone executable (a Node single executable application). */
export function isStandaloneBinary(): boolean {
	if (standalone === undefined) {
		try {
			standalone = (createRequire(import.meta.url)("node:sea") as { isSea(): boolean }).isSea();
		} catch {
			standalone = false;
		}
	}
	return standalone;
}

let nodeOnPath: string | null | undefined;

/**
 * A Node executable for running `node <flags> <file>`. The standalone binary is not one (it ignores Node
 * flags), so there this is the `node` on PATH, or undefined when there is none.
 */
export function getNodeExecutable(): string | undefined {
	if (!isStandaloneBinary()) return process.execPath;
	if (nodeOnPath === undefined) {
		const finder = process.platform === "win32" ? "where" : "which";
		const result = spawnSync(finder, ["node"], { encoding: "utf8", timeout: 5000, windowsHide: true });
		nodeOnPath = result.status === 0 ? (result.stdout.split(/\r?\n/)[0]?.trim() ?? null) || null : null;
	}
	return nodeOnPath ?? undefined;
}
