import { APP_NAME } from "../config.ts";

export function setupCli(): void {
	process.title = APP_NAME;
	process.env.RUNKILN_CODING_AGENT = "true";
	process.emitWarning = (() => {}) as typeof process.emitWarning;
	// main() installs the undici dispatcher before the first request (commands without HTTP skip loading it).
}
