/**
 * Backward compatibility for environment variables from before the RunKiln rename.
 *
 * Each RUNKILN_* variable below used to be read as PI_*. When the RUNKILN_* name is unset and the
 * legacy name is set, the legacy value is copied over, so older shell profiles keep working.
 * Import this module first in every entry point so the copy happens before any module reads
 * the environment at load time.
 */

/** Variable names without their prefix: RUNKILN_<name>, formerly PI_<name>. */
export const LEGACY_ENV_NAMES = [
	"CODING_AGENT_DIR",
	"CODING_AGENT_SESSION_DIR",
	"PACKAGE_DIR",
	"OFFLINE",
	"SHARE_VIEWER_URL",
	"PARENT_SESSION_ID",
	"EXPERIMENTAL",
	"TIMING",
	"STARTUP_BENCHMARK",
	"CLEAR_ON_SHRINK",
	"HARDWARE_CURSOR",
	"CLIPBOARD_OSC52",
	"HYPERLINKS",
	"IMAGE_PROTOCOL",
	"TRUE_COLOR",
	"PROGRAM_STATUS",
	"TUI_ESC_TIMEOUT",
	"TUI_WRITE_LOG",
	"TUI_DEBUG",
	"TUI_DEBUG_REDRAW",
] as const;

/** Copy legacy PI_* values into unset RUNKILN_* variables. Returns the names it filled. */
export function applyLegacyEnv(env: NodeJS.ProcessEnv = process.env): string[] {
	const filled: string[] = [];
	for (const name of LEGACY_ENV_NAMES) {
		const current = `RUNKILN_${name}`;
		const legacy = env[`PI_${name}`];
		if (env[current] === undefined && legacy !== undefined) {
			env[current] = legacy;
			filled.push(current);
		}
	}
	return filled;
}

applyLegacyEnv();
