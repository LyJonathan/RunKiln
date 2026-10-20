/**
 * `runkiln review [uncommitted|<commit>|<branch>] [--fail-on P0|P1|P2|P3] [other flags]`: the /review command in
 * print mode, for CI. Prints the findings; exits 2 when --fail-on matches a finding, 1 on errors.
 */

import { type Priority, parsePriority } from "../core/runkiln/review.ts";

export interface ReviewCommand {
	target?: string;
	failOn?: Priority;
	/** The other arguments, for the normal parser. */
	rest: string[];
	error?: string;
}

/** Flags of the normal parser that take a value, so their value is not read as the review target. */
const VALUE_FLAGS = new Set([
	"--model",
	"--provider",
	"--permissions",
	"--permission-mode",
	"--thinking",
	"--session",
	"--session-id",
	"--session-dir",
	"--name",
	"-n",
	"--router-mode",
	"--router-model",
	"--router-classifier",
	"--mode",
	"--append-system-prompt",
	"--system-prompt",
	"--tools",
	"-t",
	"--exclude-tools",
	"-xt",
	"--models",
]);

export function parseReviewCommand(args: readonly string[]): ReviewCommand | undefined {
	if (args[0] !== "review") return undefined;
	const rest: string[] = [];
	let target: string | undefined;
	let failOn: Priority | undefined;
	let error: string | undefined;
	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--fail-on") {
			failOn = parsePriority(args[++i]);
			if (!failOn) error = "--fail-on needs P0, P1, P2 or P3";
		} else if (arg.startsWith("--fail-on=")) {
			failOn = parsePriority(arg.slice("--fail-on=".length));
			if (!failOn) error = "--fail-on needs P0, P1, P2 or P3";
		} else if (VALUE_FLAGS.has(arg)) {
			rest.push(arg);
			if (i + 1 < args.length) rest.push(args[++i]);
		} else if (!arg.startsWith("-") && target === undefined) {
			target = arg;
		} else {
			rest.push(arg);
		}
	}
	return { ...(target ? { target } : {}), ...(failOn ? { failOn } : {}), rest, ...(error ? { error } : {}) };
}
