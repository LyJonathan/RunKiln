/**
 * Turn checkpoints for /undo and /rewind.
 *
 * Before the first file mutation of a user turn (edit, write, or a shell command, which may write anything), the
 * store records a checkpoint keyed by the session entry id of that turn's user message. A checkpoint has two layers:
 *
 * - A tree snapshot in a shadow git repository under `<rootDir>/<sessionId>/git`, with its own index and config.
 *   The project folder is only ever its work tree: nothing reads or writes the user's `.git`, index, refs or
 *   stash. When the project is inside the user's repository, the file list comes from a read-only
 *   `git ls-files` there (with GIT_OPTIONAL_LOCKS=0, so the user's index is not refreshed), which applies their
 *   .gitignore, info/exclude and global excludes. Without a user repository, the shadow repository's own
 *   ls-files applies the project's .gitignore files plus a few default excludes (node_modules, virtualenvs).
 *   Symlinks and files over `maxFileBytes` are left out and listed as skipped; a project with more than `maxFiles`
 *   files gets no tree snapshot. This layer covers shell commands (best effort, like Gemini CLI's checkpoints and
 *   Codex's ghost commits).
 * - File backups for edit/write targets: the bytes of the file the first time a turn touches it (or "absent"),
 *   copied under `<rootDir>/<sessionId>/blobs`. This covers ignored files (.env) and projects without git
 *   (like Claude Code's checkpoints, which track only file-tool edits).
 *
 * Restoring computes a plan first (what would be written, recreated or deleted, what changed outside the agent
 * since its last turn, which paths are protected), so the UI can confirm before anything is overwritten. Every
 * restored path must resolve inside the project after following links, so restoring never writes outside it.
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { diffLines } from "diff";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from "../../utils/private-files.ts";
import { isInsideProject, isProtectedProjectPath, SHELL_TOOLS, WRITE_TOOLS } from "./approval.ts";
import {
	countChanges,
	isBinaryContent,
	type SessionChanges,
	type SessionFileVersions,
	totalChanges,
} from "./session-changes.ts";

/** Default size cap: larger files are not snapshotted or backed up. */
export const CHECKPOINT_MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Default cap on the number of files in a tree snapshot. */
export const CHECKPOINT_MAX_FILES = 20_000;
/** Checkpoints kept per session; older ones are pruned. */
export const CHECKPOINT_MAX_PER_SESSION = 100;
const GIT_TIMEOUT_MS = 30_000;
/** Modification times within this window of a checkpoint count as "after it" (coarse file system clocks). */
const MTIME_SLACK_MS = 2_000;
/** Excluded from the shadow repository's own listing when the project has no git repository. */
const DEFAULT_EXCLUDES = ["node_modules/", ".venv/", "venv/", "__pycache__/", ".DS_Store", ".runkiln-checkpoints/"];

/** Tools whose calls start a checkpoint. */
export function isCheckpointTool(toolName: string): boolean {
	return WRITE_TOOLS.has(toolName) || SHELL_TOOLS.has(toolName);
}

export type FileBackupState = "file" | "absent" | "too-large" | "outside" | "symlink" | "unreadable";

export interface FileBackup {
	/** Project-relative path with forward slashes. */
	path: string;
	state: FileBackupState;
	/** Name of the blob in blobs/ when state is "file". */
	blob?: string;
	/** Content when the turn ended: a blob name, null for absent, undefined when not recorded. */
	afterBlob?: string | null;
}

export interface TreeSnapshot {
	commit: string;
	tree: string;
	/** Paths left out because they are symlinks or over the size cap. */
	skipped: string[];
}

export interface CheckpointRecord {
	id: string;
	/** Session entry id of the turn's user message. */
	entryId: string;
	createdAt: number;
	cwd: string;
	/** Tree snapshot before the turn's first mutation, when git is available. */
	before?: TreeSnapshot;
	/** Tree snapshot when the turn ended. */
	after?: TreeSnapshot;
	/** Why there is no tree snapshot, when there is none. */
	note?: string;
	files: FileBackup[];
	tools: string[];
	/** Set when /undo or /rewind restored the files to before this turn. */
	restoredAt?: number;
}

interface Manifest {
	version: 1;
	sessionId: string;
	checkpoints: CheckpointRecord[];
	/** Changes the user kept in the review view: the new baseline of each path (a blob name, null for absent). */
	kept?: Record<string, string | null>;
}

export type FileChangeStatus = "added" | "modified" | "deleted";

export interface FileChange {
	path: string;
	status: FileChangeStatus;
	added: number;
	removed: number;
	binary?: boolean;
}

export interface ChangeSummary {
	files: FileChange[];
	added: number;
	removed: number;
	/** True when the turn has not ended yet (compared with the files as they are now). */
	inProgress: boolean;
	notes: string[];
}

export type RestoreAction = "restore" | "recreate" | "delete";

export interface RestoreItem {
	path: string;
	action: RestoreAction;
	/** Where the old content comes from. */
	source: "tree" | "backup";
	protected?: boolean;
}

export interface RestorePlan {
	/** The checkpoint whose "before" state is restored. */
	targetId: string;
	/** Checkpoints from the target onward, which the restore undoes. */
	checkpointIds: string[];
	items: RestoreItem[];
	/** Paths that will not be restored, with why. */
	skipped: Array<{ path: string; reason: string }>;
	/** Paths in the plan that changed after the agent's last turn ended (edited by the user or another program). */
	changedOutside: string[];
	/** Tree to restore from, when the git layer is used. */
	tree?: string;
	/** Only some of the files (a card's "revert file"): the turns are not marked as undone. */
	partial?: boolean;
}

export interface RestoreResult {
	restored: string[];
	recreated: string[];
	deleted: string[];
	failed: Array<{ path: string; reason: string }>;
	skipped: Array<{ path: string; reason: string }>;
}

export interface CheckpointStoreOptions {
	/** Directory holding every session's checkpoints, e.g. ~/.runkiln/agent/checkpoints. */
	rootDir: string;
	sessionId: string;
	/** Project folder (the work tree). */
	cwd: string;
	maxFileBytes?: number;
	maxFiles?: number;
	maxCheckpoints?: number;
	/** git executable, or false to use file backups only. */
	git?: string | false;
	now?: () => number;
}

interface GitResult {
	code: number;
	stdout: Buffer;
	stderr: string;
}

function toPosix(path: string): string {
	return sep === "/" ? path : path.split(sep).join("/");
}

function fromPosix(path: string): string {
	return sep === "/" ? path : path.split("/").join(sep);
}

function splitNul(buffer: Buffer): string[] {
	return buffer
		.toString("utf8")
		.split("\0")
		.filter((part) => part.length > 0);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Environment without inherited GIT_* variables (a hook's GIT_DIR must not redirect our commands). */
function cleanGitEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith("GIT_")) env[key] = value;
	}
	return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", ...extra };
}

function runGit(
	git: string,
	args: string[],
	options: { env: NodeJS.ProcessEnv; cwd: string; input?: Buffer | string },
) {
	return new Promise<GitResult>((resolvePromise, reject) => {
		const child = spawn(git, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
		const out: Buffer[] = [];
		let err = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, GIT_TIMEOUT_MS);
		child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => {
			if (err.length < 8192) err += chunk.toString("utf8");
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			const stderr = timedOut ? `timed out after ${GIT_TIMEOUT_MS / 1000} s` : err.trim();
			resolvePromise({ code: code ?? 1, stdout: Buffer.concat(out), stderr });
		});
		child.stdin.on("error", () => {});
		child.stdin.end(options.input ?? "");
	});
}

/** Count lines in `text` (a final line without newline counts). */
function lineCount(text: string): number {
	if (text.length === 0) return 0;
	const newlines = text.split("\n").length - 1;
	return text.endsWith("\n") ? newlines : newlines + 1;
}

function isBinary(buffer: Buffer): boolean {
	return buffer.subarray(0, 8000).includes(0);
}

export class CheckpointStore {
	readonly sessionId: string;
	readonly cwd: string;
	private readonly dir: string;
	private readonly gitDir: string;
	private readonly blobDir: string;
	private readonly manifestPath: string;
	private readonly maxFileBytes: number;
	private readonly maxFiles: number;
	private readonly maxCheckpoints: number;
	private readonly now: () => number;
	private git: string | false;
	private gitReady: Promise<boolean> | undefined;
	private manifest: Manifest | undefined;
	private queue: Promise<unknown> = Promise.resolve();
	/** Checkpoints created or reopened during the current agent run, finished at its end. */
	private open = new Set<string>();

	constructor(options: CheckpointStoreOptions) {
		this.sessionId = options.sessionId;
		this.cwd = resolve(options.cwd);
		this.dir = sessionCheckpointDir(options.rootDir, options.sessionId);
		this.gitDir = join(this.dir, "git");
		this.blobDir = join(this.dir, "blobs");
		this.manifestPath = join(this.dir, "manifest.json");
		this.maxFileBytes = options.maxFileBytes ?? CHECKPOINT_MAX_FILE_BYTES;
		this.maxFiles = options.maxFiles ?? CHECKPOINT_MAX_FILES;
		this.maxCheckpoints = options.maxCheckpoints ?? CHECKPOINT_MAX_PER_SESSION;
		this.git = options.git ?? "git";
		this.now = options.now ?? Date.now;
	}

	/** Directory of this session's checkpoints. */
	get directory(): string {
		return this.dir;
	}

	/** Run `fn` after every earlier operation, so parallel tool calls and restores never interleave. */
	private serialize<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.queue.then(fn, fn);
		this.queue = next.catch(() => undefined);
		return next;
	}

	// ---------------------------------------------------------------------------------------------------------------
	// Manifest
	// ---------------------------------------------------------------------------------------------------------------

	private load(): Manifest {
		if (this.manifest) return this.manifest;
		let manifest: Manifest = { version: 1, sessionId: this.sessionId, checkpoints: [] };
		try {
			const parsed = JSON.parse(readFileSync(this.manifestPath, "utf8")) as Manifest;
			if (parsed && parsed.version === 1 && Array.isArray(parsed.checkpoints)) manifest = parsed;
		} catch {
			// No manifest yet, or an unreadable one: start empty.
		}
		this.manifest = manifest;
		return manifest;
	}

	private save(): void {
		const manifest = this.load();
		mkdirSync(this.dir, { recursive: true, mode: PRIVATE_DIR_MODE });
		const tmp = `${this.manifestPath}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(manifest, null, "\t")}\n`, { mode: PRIVATE_FILE_MODE });
		renameSync(tmp, this.manifestPath);
	}

	/** Every checkpoint of the session, oldest first. */
	list(): CheckpointRecord[] {
		return [...this.load().checkpoints];
	}

	get(id: string): CheckpointRecord | undefined {
		return this.load().checkpoints.find((checkpoint) => checkpoint.id === id);
	}

	forEntry(entryId: string): CheckpointRecord | undefined {
		return this.load().checkpoints.find((checkpoint) => checkpoint.entryId === entryId);
	}

	/** Wait for pending snapshots (tests and the UI before reading state). */
	idle(): Promise<void> {
		return this.serialize(async () => undefined);
	}

	// ---------------------------------------------------------------------------------------------------------------
	// Git layer
	// ---------------------------------------------------------------------------------------------------------------

	private shadowEnv(indexFile = join(this.dir, "index")): NodeJS.ProcessEnv {
		return cleanGitEnv({
			GIT_DIR: this.gitDir,
			GIT_WORK_TREE: this.cwd,
			GIT_INDEX_FILE: indexFile,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: join(this.dir, "gitconfig"),
			GIT_AUTHOR_NAME: "RunKiln checkpoints",
			GIT_AUTHOR_EMAIL: "checkpoints@runkiln.invalid",
			GIT_COMMITTER_NAME: "RunKiln checkpoints",
			GIT_COMMITTER_EMAIL: "checkpoints@runkiln.invalid",
			GIT_LITERAL_PATHSPECS: "1",
		});
	}

	private async shadow(args: string[], input?: Buffer | string, indexFile?: string): Promise<Buffer> {
		if (!this.git) throw new Error("git is not available");
		const result = await runGit(this.git, args, { env: this.shadowEnv(indexFile), cwd: this.cwd, input });
		if (result.code !== 0) throw new Error(`git ${args[0]}: ${result.stderr || `exit ${result.code}`}`);
		return result.stdout;
	}

	/** Create the shadow repository once. False when git is missing or unusable. */
	private ensureGit(): Promise<boolean> {
		if (!this.git) return Promise.resolve(false);
		this.gitReady ??= (async () => {
			try {
				mkdirSync(this.dir, { recursive: true, mode: PRIVATE_DIR_MODE });
				if (!existsSync(join(this.dir, "gitconfig"))) writeFileSync(join(this.dir, "gitconfig"), "");
				if (!existsSync(join(this.gitDir, "HEAD"))) {
					// Without GIT_WORK_TREE: git refuses a work tree on init. The project folder is never initialized.
					const init = await runGit(this.git as string, ["init", "--bare", "-q", this.gitDir], {
						env: cleanGitEnv({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(this.dir, "gitconfig") }),
						cwd: this.dir,
					});
					if (init.code !== 0) throw new Error(`git init: ${init.stderr}`);
					const settings: Array<[string, string]> = [
						["core.bare", "false"],
						["core.autocrlf", "false"],
						["core.safecrlf", "false"],
						["core.quotePath", "false"],
						["core.longpaths", "true"],
						["core.fsmonitor", "false"],
						["core.hooksPath", "/dev/null"],
						["gc.auto", "0"],
						["commit.gpgSign", "false"],
					];
					for (const [key, value] of settings) await this.shadow(["config", key, value]);
				}
				mkdirSync(join(this.gitDir, "info"), { recursive: true });
				writeFileSync(join(this.gitDir, "info", "exclude"), `${DEFAULT_EXCLUDES.join("\n")}\n`);
				// info/attributes wins over the project's .gitattributes: store and restore bytes exactly (no
				// line-ending conversion, clean/smudge filters or encodings), so CRLF files and LFS pointers round-trip.
				writeFileSync(
					join(this.gitDir, "info", "attributes"),
					"* -text -eol -filter -ident -working-tree-encoding\n",
				);
				return true;
			} catch {
				this.git = false;
				return false;
			}
		})();
		return this.gitReady;
	}

	/** Whether the project is inside a git work tree of the user's own (read-only check). */
	private async userRepoListing(): Promise<string[] | undefined> {
		if (!this.git) return undefined;
		const env = cleanGitEnv({});
		const inside = await runGit(this.git, ["rev-parse", "--is-inside-work-tree"], { env, cwd: this.cwd }).catch(
			() => undefined,
		);
		if (!inside || inside.code !== 0 || inside.stdout.toString().trim() !== "true") return undefined;
		const listed = await runGit(this.git, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
			env,
			cwd: this.cwd,
		});
		if (listed.code !== 0) throw new Error(`git ls-files: ${listed.stderr}`);
		return splitNul(listed.stdout);
	}

	/** Project files a tree snapshot covers, and the ones left out. */
	private async listProjectFiles(): Promise<{ files: string[]; skipped: string[] }> {
		const candidates =
			(await this.userRepoListing()) ??
			splitNul(await this.shadow(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]));
		const files: string[] = [];
		const skipped: string[] = [];
		for (const path of new Set(candidates)) {
			if (path.endsWith("/")) continue; // a nested repository
			let stats: ReturnType<typeof lstatSync>;
			try {
				stats = lstatSync(join(this.cwd, fromPosix(path)));
			} catch {
				continue; // tracked by the user but deleted from the work tree
			}
			if (stats.isSymbolicLink() || (stats.isFile() && stats.size > this.maxFileBytes)) {
				skipped.push(path);
				continue;
			}
			if (stats.isFile()) files.push(path);
		}
		return { files: files.sort(), skipped: skipped.sort() };
	}

	/** Commit the project files into the shadow repository and pin the commit with a ref. */
	private async snapshot(ref: string, message: string): Promise<TreeSnapshot> {
		// Operations are serialized, so a lock left here is from a git that was killed (timeout): remove it.
		rmSync(join(this.dir, "index.lock"), { force: true });
		const { files, skipped } = await this.listProjectFiles();
		if (files.length > this.maxFiles) {
			throw new Error(`the project has ${files.length} files (more than ${this.maxFiles})`);
		}
		const indexed = new Set(splitNul(await this.shadow(["ls-files", "-z", "--cached"])));
		const wanted = new Set(files);
		const drop = [...indexed].filter((path) => !wanted.has(path));
		const nul = (paths: string[]) => Buffer.from(`${paths.join("\0")}\0`);
		// update-index, not add: add -f walks every ignored folder (node_modules) to match pathspecs, while
		// update-index only stats the listed paths and reuses the index's stat cache for unchanged files.
		if (drop.length > 0) await this.shadow(["update-index", "--force-remove", "-z", "--stdin"], nul(drop));
		if (files.length > 0) await this.shadow(["update-index", "--add", "--remove", "-z", "--stdin"], nul(files));
		const tree = (await this.shadow(["write-tree"])).toString().trim();
		const commit = (await this.shadow(["commit-tree", tree, "-m", message])).toString().trim();
		await this.shadow(["update-ref", ref, commit]);
		return { commit, tree, skipped };
	}

	private async treePaths(tree: string): Promise<Set<string>> {
		return new Set(splitNul(await this.shadow(["ls-tree", "-r", "-z", "--name-only", tree])));
	}

	/** name-status and numstat between two trees. */
	private async treeDiff(from: string, to: string): Promise<FileChange[]> {
		if (from === to) return [];
		const status = splitNul(await this.shadow(["diff-tree", "-r", "-z", "--no-renames", "--name-status", from, to]));
		const statuses = new Map<string, FileChangeStatus>();
		for (let i = 0; i + 1 < status.length; i += 2) {
			const code = status[i];
			statuses.set(status[i + 1], code === "A" ? "added" : code === "D" ? "deleted" : "modified");
		}
		const numstat = splitNul(await this.shadow(["diff-tree", "-r", "-z", "--no-renames", "--numstat", from, to]));
		const changes: FileChange[] = [];
		for (const line of numstat) {
			const [added, removed, ...rest] = line.split("\t");
			const path = rest.join("\t");
			if (!path) continue;
			const binary = added === "-";
			changes.push({
				path,
				status: statuses.get(path) ?? "modified",
				added: binary ? 0 : Number(added),
				removed: binary ? 0 : Number(removed),
				...(binary ? { binary } : {}),
			});
		}
		return changes;
	}

	// ---------------------------------------------------------------------------------------------------------------
	// File layer
	// ---------------------------------------------------------------------------------------------------------------

	private saveBlob(content: Buffer): string {
		const name = createHash("sha256").update(content).digest("hex");
		const path = join(this.blobDir, name);
		if (!existsSync(path)) {
			mkdirSync(this.blobDir, { recursive: true, mode: PRIVATE_DIR_MODE });
			writeFileSync(path, content, { mode: PRIVATE_FILE_MODE });
		}
		return name;
	}

	private readBlob(name: string): Buffer {
		return readFileSync(join(this.blobDir, name));
	}

	/** Project-relative posix path of a tool's path argument, or undefined when it is outside the project. */
	private projectPath(target: string): string | undefined {
		const absolute = isAbsolute(target) ? target : resolve(this.cwd, target);
		if (!isInsideProject(absolute, this.cwd)) return undefined;
		const rel = relative(this.cwd, resolve(absolute));
		if (rel === "" || rel.startsWith("..")) return undefined;
		return toPosix(rel);
	}

	/** Current state of a project file: a blob name, null when absent, or a reason it cannot be read. */
	private captureFile(path: string): { state: FileBackupState; blob?: string } {
		const absolute = join(this.cwd, fromPosix(path));
		let stats: ReturnType<typeof lstatSync>;
		try {
			stats = lstatSync(absolute);
		} catch {
			return { state: "absent" };
		}
		if (stats.isSymbolicLink()) return { state: "symlink" };
		if (!stats.isFile()) return { state: "unreadable" };
		if (stats.size > this.maxFileBytes) return { state: "too-large" };
		try {
			return { state: "file", blob: this.saveBlob(readFileSync(absolute)) };
		} catch {
			return { state: "unreadable" };
		}
	}

	// ---------------------------------------------------------------------------------------------------------------
	// Recording
	// ---------------------------------------------------------------------------------------------------------------

	/**
	 * Record what a mutating tool call is about to change. The first call of a turn creates the checkpoint and its
	 * tree snapshot; edit/write also back up their target file the first time the turn touches it. Never throws:
	 * a failed snapshot is noted on the checkpoint and the tool runs anyway.
	 */
	beforeMutation(entryId: string, toolName: string, args: unknown): Promise<CheckpointRecord | undefined> {
		if (!isCheckpointTool(toolName)) return Promise.resolve(undefined);
		return this.serialize(async () => {
			try {
				return await this.recordMutation(entryId, toolName, args);
			} catch {
				return undefined;
			}
		});
	}

	private async recordMutation(entryId: string, toolName: string, args: unknown): Promise<CheckpointRecord> {
		const manifest = this.load();
		let checkpoint = manifest.checkpoints.find((candidate) => candidate.entryId === entryId);
		if (!checkpoint) {
			const id = `${this.now().toString(36)}-${randomUUID().slice(0, 8)}`;
			checkpoint = { id, entryId, createdAt: this.now(), cwd: this.cwd, files: [], tools: [] };
			if (await this.ensureGit()) {
				try {
					checkpoint.before = await this.snapshot(`refs/runkiln/${id}/before`, `before turn ${entryId}`);
				} catch (error) {
					checkpoint.note = `No project snapshot: ${errorText(error)}`;
				}
			} else {
				checkpoint.note = "No project snapshot: git is not available, so only edit and write changes are tracked";
			}
			manifest.checkpoints.push(checkpoint);
			this.prune();
		} else if (checkpoint.after || checkpoint.restoredAt) {
			// The turn continues (a retry, or a new run on the same message): its end state is recorded again.
			checkpoint.after = undefined;
			checkpoint.restoredAt = undefined;
			for (const file of checkpoint.files) file.afterBlob = undefined;
		}
		this.open.add(checkpoint.id);
		if (!checkpoint.tools.includes(toolName)) checkpoint.tools.push(toolName);
		if (WRITE_TOOLS.has(toolName)) {
			const target = (args as { path?: unknown } | undefined)?.path;
			if (typeof target === "string" && target.length > 0) {
				const path = this.projectPath(target);
				const key = path ?? target;
				if (!checkpoint.files.some((file) => file.path === key)) {
					checkpoint.files.push(path ? { path, ...this.captureFile(path) } : { path: target, state: "outside" });
				}
			}
		}
		this.save();
		return checkpoint;
	}

	/** Record the end state of every checkpoint this run created or continued. Called when an agent run ends. */
	finishRun(): Promise<void> {
		return this.serialize(async () => {
			if (this.open.size === 0) return;
			const ids = [...this.open];
			this.open.clear();
			const manifest = this.load();
			const checkpoints = manifest.checkpoints.filter((checkpoint) => ids.includes(checkpoint.id));
			let endSnapshot: TreeSnapshot | undefined;
			for (const checkpoint of checkpoints) {
				const index = manifest.checkpoints.indexOf(checkpoint);
				const next = manifest.checkpoints[index + 1];
				if (checkpoint.before) {
					if (next?.before && ids.includes(next.id)) {
						checkpoint.after = next.before;
					} else {
						try {
							endSnapshot ??= await this.snapshot(
								`refs/runkiln/${checkpoint.id}/after`,
								`after turn ${checkpoint.entryId}`,
							);
							checkpoint.after = endSnapshot;
						} catch {
							// Summaries fall back to the next checkpoint or the current files.
						}
					}
				}
				for (const file of checkpoint.files) {
					if (file.state !== "file" && file.state !== "absent") continue;
					const now = this.captureFile(file.path);
					file.afterBlob = now.state === "file" ? (now.blob ?? null) : now.state === "absent" ? null : undefined;
				}
			}
			this.save();
		});
	}

	/** Mark checkpoints as restored (their turns' file changes were undone). */
	markRestored(ids: string[]): void {
		const manifest = this.load();
		for (const checkpoint of manifest.checkpoints) {
			if (ids.includes(checkpoint.id)) checkpoint.restoredAt = this.now();
		}
		this.save();
	}

	private prune(): void {
		const manifest = this.load();
		const excess = manifest.checkpoints.length - this.maxCheckpoints;
		if (excess <= 0) return;
		const removed = manifest.checkpoints.splice(0, excess);
		const kept = new Set<string>();
		for (const checkpoint of manifest.checkpoints) {
			for (const file of checkpoint.files) {
				if (file.blob) kept.add(file.blob);
				if (file.afterBlob) kept.add(file.afterBlob);
			}
		}
		for (const checkpoint of removed) {
			for (const file of checkpoint.files) {
				for (const blob of [file.blob, file.afterBlob]) {
					if (blob && !kept.has(blob)) rmSync(join(this.blobDir, blob), { force: true });
				}
			}
			if (this.git) {
				for (const side of ["before", "after"]) {
					void this.shadow(["update-ref", "-d", `refs/runkiln/${checkpoint.id}/${side}`]).catch(() => undefined);
				}
			}
		}
	}

	// ---------------------------------------------------------------------------------------------------------------
	// Summaries
	// ---------------------------------------------------------------------------------------------------------------

	/** What a turn changed: its end state against its start, or the current files when it has not ended. */
	summarize(id: string): Promise<ChangeSummary | undefined> {
		return this.serialize(async () => {
			const checkpoint = this.get(id);
			if (!checkpoint) return undefined;
			const notes: string[] = [];
			const changes = new Map<string, FileChange>();
			let inProgress = false;
			if (checkpoint.before && this.git) {
				let after = checkpoint.after?.tree;
				if (!after) {
					inProgress = this.open.has(checkpoint.id);
					after = (await this.snapshot("refs/runkiln/summary", "summary")).tree;
				}
				for (const change of await this.treeDiff(checkpoint.before.tree, after)) changes.set(change.path, change);
			} else if (checkpoint.note) {
				notes.push(checkpoint.note);
			}
			for (const file of checkpoint.files) {
				if (changes.has(file.path)) continue;
				if (file.state !== "file" && file.state !== "absent") {
					notes.push(`${file.path}: ${describeState(file.state)}`);
					continue;
				}
				let afterBlob = file.afterBlob;
				if (afterBlob === undefined) {
					const now = this.captureFile(file.path);
					afterBlob = now.state === "file" ? (now.blob ?? null) : null;
				}
				const change = compareBlobs(
					file.path,
					file.state === "file" ? this.readBlob(file.blob!) : undefined,
					afterBlob ? this.readBlob(afterBlob) : undefined,
				);
				if (change) changes.set(file.path, change);
			}
			const files = [...changes.values()].sort((a, b) => a.path.localeCompare(b.path));
			return {
				files,
				added: files.reduce((sum, change) => sum + change.added, 0),
				removed: files.reduce((sum, change) => sum + change.removed, 0),
				inProgress,
				notes,
			};
		});
	}

	// ---------------------------------------------------------------------------------------------------------------
	// Session changes (changes tray and review view)
	// ---------------------------------------------------------------------------------------------------------------

	/** Blob ids of every file in a tree. */
	private async treeBlobs(tree: string): Promise<Map<string, string>> {
		const blobs = new Map<string, string>();
		for (const entry of splitNul(await this.shadow(["ls-tree", "-r", "-z", "--full-tree", tree]))) {
			const tab = entry.indexOf("\t");
			const [, type, sha] = entry.slice(0, tab).split(" ");
			if (type === "blob" && sha) blobs.set(entry.slice(tab + 1), sha);
		}
		return blobs;
	}

	/**
	 * Both sides of every file the checkpoints `ids` (oldest first) changed: the content before the first turn that
	 * touched it (or the content the user kept), and the file as it is now. Files that match are left out, and so
	 * are files whose old content is unknown or that cannot be read now (symlinks, over the size cap).
	 */
	private async collectSessionVersions(ids: string[], only?: string): Promise<SessionFileVersions[]> {
		const checkpoints = ids
			.map((id) => this.get(id))
			.filter((checkpoint): checkpoint is CheckpointRecord => !!checkpoint && resolve(checkpoint.cwd) === this.cwd);
		if (checkpoints.length === 0) return [];
		const useGit = checkpoints.some((checkpoint) => checkpoint.before) && (await this.ensureGit());
		const trees = new Map<string, Map<string, string>>();
		const blobsOf = async (tree: string) => {
			let blobs = trees.get(tree);
			if (!blobs) {
				blobs = await this.treeBlobs(tree);
				trees.set(tree, blobs);
			}
			return blobs;
		};
		let current: TreeSnapshot | undefined;
		const addedIn = new Map<string, Set<string>>();
		const paths = new Set<string>();
		for (const checkpoint of checkpoints) {
			if (useGit && checkpoint.before) {
				let after = checkpoint.after?.tree;
				if (!after) {
					current ??= await this.snapshot("refs/runkiln/summary", "summary");
					after = current.tree;
				}
				const added = new Set<string>();
				for (const change of await this.treeDiff(checkpoint.before.tree, after)) {
					paths.add(change.path);
					if (change.status === "added") added.add(change.path);
				}
				addedIn.set(checkpoint.id, added);
			}
			for (const file of checkpoint.files) {
				if (file.state === "file" || file.state === "absent") paths.add(file.path);
			}
		}
		const kept = this.load().kept ?? {};
		const versions: SessionFileVersions[] = [];
		for (const path of [...paths].sort()) {
			if (only !== undefined && path !== only) continue;
			let known = false;
			let before: Buffer | undefined;
			if (Object.hasOwn(kept, path)) {
				const blob = kept[path];
				known = true;
				before = blob ? this.readBlob(blob) : undefined;
			} else {
				for (const checkpoint of checkpoints) {
					if (useGit && checkpoint.before) {
						const sha = (await blobsOf(checkpoint.before.tree)).get(path);
						if (sha) {
							before = await this.shadow(["cat-file", "blob", sha]);
							known = true;
							break;
						}
					}
					const backup = checkpoint.files.find(
						(file) => file.path === path && (file.state === "file" || file.state === "absent"),
					);
					if (backup) {
						before = backup.state === "file" && backup.blob ? this.readBlob(backup.blob) : undefined;
						known = true;
						break;
					}
					if (addedIn.get(checkpoint.id)?.has(path)) {
						known = true;
						break;
					}
				}
			}
			if (!known) continue;
			const now = this.captureFile(path);
			if (now.state !== "file" && now.state !== "absent") continue;
			const after = now.state === "file" && now.blob ? this.readBlob(now.blob) : undefined;
			if (!before && !after) continue;
			if (before && after && before.equals(after)) continue;
			versions.push({ path, before, after });
		}
		return versions;
	}

	/** Per-file counts of what the checkpoints `ids` (the session's turns, oldest first) changed and still differ. */
	sessionChanges(ids: string[]): Promise<SessionChanges> {
		return this.serialize(async () => {
			const files = (await this.collectSessionVersions(ids)).map(({ path, before, after }) => {
				const status = !before ? "added" : !after ? "deleted" : "modified";
				if (isBinaryContent(before) || isBinaryContent(after)) {
					return { path, status, added: 0, removed: 0, binary: true } as const;
				}
				const counts = countChanges(before?.toString("utf8") ?? "", after?.toString("utf8") ?? "");
				return { path, status, ...counts } as const;
			});
			return totalChanges(files);
		});
	}

	/** Both sides of one changed file, or undefined when it no longer differs. */
	sessionFileVersions(ids: string[], path: string): Promise<SessionFileVersions | undefined> {
		return this.serialize(async () => (await this.collectSessionVersions(ids, path))[0]);
	}

	/** Keep a change: `content` (undefined for absent) becomes the baseline of `path` in the tray and review view. */
	keepBaseline(path: string, content: Buffer | undefined): Promise<void> {
		return this.serialize(async () => {
			if (!this.projectPath(path)) throw new Error(`${path} is outside the project`);
			const manifest = this.load();
			manifest.kept ??= {};
			manifest.kept[path] = content ? this.saveBlob(content) : null;
			this.save();
		});
	}

	/** Write (or delete, for undefined) one project file: a review-view revert. Never writes outside the project. */
	writeProjectFile(path: string, content: Buffer | undefined): Promise<void> {
		return this.serialize(async () => {
			if (!this.projectPath(path)) throw new Error(`${path} is outside the project`);
			const absolute = join(this.cwd, fromPosix(path));
			const stats = lstatSync(absolute, { throwIfNoEntry: false });
			if (stats?.isDirectory()) throw new Error(`${path} is a folder`);
			if (content === undefined) {
				if (stats) unlinkSync(absolute);
				this.removeEmptyParents(dirname(absolute));
				return;
			}
			if (stats?.isSymbolicLink()) unlinkSync(absolute);
			mkdirSync(dirname(absolute), { recursive: true });
			writeFileSync(absolute, content);
		});
	}

	// ---------------------------------------------------------------------------------------------------------------
	// Restore
	// ---------------------------------------------------------------------------------------------------------------

	/**
	 * What restoring the files to before checkpoint `ids[0]` would do. `ids` are the checkpoints from the target
	 * onward on the conversation's current branch, oldest first. Takes a snapshot of the current files (kept under a
	 * ref, so the state before the restore stays in the shadow repository).
	 */
	planRestore(ids: string[]): Promise<RestorePlan | undefined> {
		return this.serialize(async () => {
			const checkpoints = ids
				.map((id) => this.get(id))
				.filter((checkpoint): checkpoint is CheckpointRecord => !!checkpoint);
			const target = checkpoints[0];
			if (!target) return undefined;
			const plan: RestorePlan = {
				targetId: target.id,
				checkpointIds: checkpoints.map((checkpoint) => checkpoint.id),
				items: [],
				skipped: [],
				changedOutside: [],
			};
			if (resolve(target.cwd) !== this.cwd) {
				plan.skipped.push({ path: target.cwd, reason: "this checkpoint was made in another folder" });
				return plan;
			}
			const planned = new Set<string>();
			const add = (item: RestoreItem) => {
				if (planned.has(item.path)) return;
				planned.add(item.path);
				if (!this.projectPath(item.path)) {
					plan.skipped.push({ path: item.path, reason: "outside the project" });
					return;
				}
				if (isProtectedProjectPath(fromPosix(item.path))) item.protected = true;
				plan.items.push(item);
			};

			// Git layer: the tree before the target turn against the files now.
			let covered = new Set<string>();
			let current: TreeSnapshot | undefined;
			if (target.before && this.git) {
				current = await this.snapshot(`refs/runkiln/restore/${this.now().toString(36)}`, "before restore");
				const beforePaths = await this.treePaths(target.before.tree);
				covered = new Set([...beforePaths, ...(await this.treePaths(current.tree))]);
				const skippedBefore = new Set(target.before.skipped);
				for (const change of await this.treeDiff(target.before.tree, current.tree)) {
					if (change.status === "added") {
						// Present now, absent before. Only delete it when it is not a file the snapshot left out, and it
						// was written after the checkpoint.
						if (skippedBefore.has(change.path)) continue;
						if (!this.modifiedSince(change.path, target.createdAt)) {
							plan.skipped.push({ path: change.path, reason: "not changed since this turn, kept" });
							planned.add(change.path);
							continue;
						}
						add({ path: change.path, action: "delete", source: "tree" });
					} else {
						add({
							path: change.path,
							action: change.status === "deleted" ? "recreate" : "restore",
							source: "tree",
						});
					}
				}
				plan.tree = target.before.tree;
			}

			// File layer: the first backup of each path from the target onward, for paths the tree does not cover.
			for (const checkpoint of checkpoints) {
				for (const file of checkpoint.files) {
					if (covered.has(file.path) || planned.has(file.path)) continue;
					if (file.state === "outside") {
						planned.add(file.path);
						plan.skipped.push({ path: file.path, reason: "outside the project, not tracked" });
						continue;
					}
					if (file.state !== "file" && file.state !== "absent") {
						planned.add(file.path);
						plan.skipped.push({ path: file.path, reason: describeState(file.state) });
						continue;
					}
					const now = this.captureFile(file.path);
					const nowBlob = now.state === "file" ? now.blob : undefined;
					if (file.state === "absent") {
						if (now.state === "absent") {
							planned.add(file.path);
							continue;
						}
						add({ path: file.path, action: "delete", source: "backup" });
					} else if (nowBlob !== file.blob) {
						add({ path: file.path, action: now.state === "absent" ? "recreate" : "restore", source: "backup" });
					} else {
						planned.add(file.path);
					}
				}
			}

			plan.changedOutside = await this.changedOutside(plan, current);
			return plan;
		});
	}

	/** Paths in the plan whose current content differs from how the agent's last turn left them. */
	private async changedOutside(plan: RestorePlan, current: TreeSnapshot | undefined): Promise<string[]> {
		const manifest = this.load();
		const paths = new Set(plan.items.map((item) => item.path));
		const outside = new Set<string>();
		const last = [...manifest.checkpoints].reverse().find((checkpoint) => checkpoint.after);
		if (last?.after && current && this.git) {
			for (const change of await this.treeDiff(last.after.tree, current.tree)) {
				if (paths.has(change.path)) outside.add(change.path);
			}
		}
		// File layer: compare with the latest recorded end state of each backed-up path.
		const latestAfter = new Map<string, string | null>();
		for (const checkpoint of manifest.checkpoints) {
			for (const file of checkpoint.files) {
				if (file.afterBlob !== undefined) latestAfter.set(file.path, file.afterBlob);
			}
		}
		for (const item of plan.items) {
			if (item.source !== "backup" || !latestAfter.has(item.path)) continue;
			const now = this.captureFile(item.path);
			const nowBlob = now.state === "file" ? (now.blob ?? null) : null;
			if (nowBlob !== latestAfter.get(item.path)) outside.add(item.path);
		}
		return [...outside].sort();
	}

	private modifiedSince(path: string, time: number): boolean {
		try {
			return lstatSync(join(this.cwd, fromPosix(path))).mtimeMs >= time - MTIME_SLACK_MS;
		} catch {
			return false;
		}
	}

	/** Apply a plan from planRestore. Paths are checked again: nothing outside the project is written or deleted. */
	applyRestore(plan: RestorePlan): Promise<RestoreResult> {
		return this.serialize(async () => {
			const result: RestoreResult = {
				restored: [],
				recreated: [],
				deleted: [],
				failed: [],
				skipped: [...plan.skipped],
			};
			const checkpoints = plan.checkpointIds
				.map((id) => this.get(id))
				.filter((checkpoint): checkpoint is CheckpointRecord => !!checkpoint);
			const done = (item: RestoreItem) => {
				if (item.action === "delete") result.deleted.push(item.path);
				else if (item.action === "recreate") result.recreated.push(item.path);
				else result.restored.push(item.path);
			};
			const fromTree: RestoreItem[] = [];
			for (const item of plan.items) {
				const absolute = join(this.cwd, fromPosix(item.path));
				if (!this.projectPath(item.path)) {
					result.skipped.push({ path: item.path, reason: "outside the project" });
					continue;
				}
				try {
					if (item.action === "delete") {
						const stats = lstatSync(absolute, { throwIfNoEntry: false });
						if (stats && !stats.isDirectory()) unlinkSync(absolute);
						this.removeEmptyParents(dirname(absolute));
						done(item);
					} else if (item.source === "tree") {
						fromTree.push(item);
					} else {
						const backup = checkpoints
							.flatMap((checkpoint) => checkpoint.files)
							.find((file) => file.path === item.path && file.state === "file");
						if (!backup?.blob) throw new Error("no backup");
						const content = this.readBlob(backup.blob);
						const stats = lstatSync(absolute, { throwIfNoEntry: false });
						if (stats?.isSymbolicLink()) unlinkSync(absolute);
						mkdirSync(dirname(absolute), { recursive: true });
						writeFileSync(absolute, content);
						done(item);
					}
				} catch (error) {
					result.failed.push({ path: item.path, reason: errorText(error) });
				}
			}
			if (fromTree.length > 0 && plan.tree) {
				const indexFile = join(this.dir, `restore-index-${process.pid}`);
				try {
					await this.shadow(["read-tree", plan.tree], undefined, indexFile);
					await this.shadow(
						["checkout-index", "-f", "-z", "--stdin"],
						Buffer.from(`${fromTree.map((item) => item.path).join("\0")}\0`),
						indexFile,
					);
					for (const item of fromTree) done(item);
				} catch (error) {
					for (const item of fromTree) result.failed.push({ path: item.path, reason: errorText(error) });
				} finally {
					rmSync(indexFile, { force: true });
				}
			}
			if (result.failed.length === 0 && !plan.partial) this.markRestoredUnlocked(plan.checkpointIds);
			return result;
		});
	}

	private markRestoredUnlocked(ids: string[]): void {
		const manifest = this.load();
		// Files went back to before these turns: baselines kept since then no longer apply.
		manifest.kept = undefined;
		for (const checkpoint of manifest.checkpoints) {
			if (ids.includes(checkpoint.id)) checkpoint.restoredAt = this.now();
		}
		this.save();
	}

	/** Remove directories left empty by a deletion, up to (not including) the project folder. */
	private removeEmptyParents(directory: string): void {
		let current = directory;
		while (current.startsWith(this.cwd + sep) && current !== this.cwd) {
			try {
				if (readdirSync(current).length > 0) return;
				rmdirSync(current);
			} catch {
				return;
			}
			current = dirname(current);
		}
	}
}

function describeState(state: FileBackupState): string {
	switch (state) {
		case "too-large":
			return "too large to back up";
		case "symlink":
			return "a symlink, not tracked";
		case "outside":
			return "outside the project, not tracked";
		case "unreadable":
			return "could not be read";
		default:
			return state;
	}
}

function compareBlobs(path: string, before: Buffer | undefined, after: Buffer | undefined): FileChange | undefined {
	if (!before && !after) return undefined;
	if (before && after && before.equals(after)) return undefined;
	const status: FileChangeStatus = !before ? "added" : !after ? "deleted" : "modified";
	if ((before && isBinary(before)) || (after && isBinary(after))) {
		return { path, status, added: 0, removed: 0, binary: true };
	}
	const oldText = before?.toString("utf8") ?? "";
	const newText = after?.toString("utf8") ?? "";
	let added = 0;
	let removed = 0;
	for (const part of diffLines(oldText, newText)) {
		if (part.added) added += lineCount(part.value);
		else if (part.removed) removed += lineCount(part.value);
	}
	return { path, status, added, removed };
}

/** One-line summary such as "3 files  +42 −7", or "no file changes". */
export function formatChangeSummary(summary: ChangeSummary | undefined): string {
	if (!summary || summary.files.length === 0) return "no file changes";
	const count = `${summary.files.length} file${summary.files.length === 1 ? "" : "s"}`;
	return `${count}  +${summary.added} −${summary.removed}`;
}

const ACTION_MARK: Record<RestoreAction, string> = { restore: "~", recreate: "+", delete: "−" };
const ACTION_WORD: Record<RestoreAction, string> = { restore: "restore", recreate: "recreate", delete: "delete" };

/** The confirmation text for a plan: one line per path (up to `max`), then warnings. */
export function formatRestorePlan(plan: RestorePlan, max = 8): string[] {
	const lines = plan.items
		.slice(0, max)
		.map(
			(item) =>
				`  ${ACTION_MARK[item.action]} ${ACTION_WORD[item.action]} ${item.path}${item.protected ? " (protected file)" : ""}`,
		);
	if (plan.items.length > max) lines.push(`  … and ${plan.items.length - max} more`);
	if (plan.changedOutside.length > 0) {
		const names = plan.changedOutside.slice(0, 3).join(", ");
		const more = plan.changedOutside.length > 3 ? ` and ${plan.changedOutside.length - 3} more` : "";
		lines.push("", `! Changed outside RunKiln since the agent's last turn, and will be overwritten: ${names}${more}`);
	}
	if (plan.skipped.length > 0) {
		const first = plan.skipped[0];
		const more = plan.skipped.length > 1 ? ` (+${plan.skipped.length - 1} more)` : "";
		lines.push("", `Not restored: ${first.path}, ${first.reason}${more}`);
	}
	return lines;
}

/** The short notice after a restore, e.g. "Restored 3 files (2 reverted, 1 deleted)". */
export function formatRestoreNotice(result: RestoreResult): string {
	const reverted = result.restored.length + result.recreated.length;
	const total = reverted + result.deleted.length;
	const parts: string[] = [];
	if (result.restored.length) parts.push(`${result.restored.length} reverted`);
	if (result.recreated.length) parts.push(`${result.recreated.length} recreated`);
	if (result.deleted.length) parts.push(`${result.deleted.length} deleted`);
	let notice =
		total === 0
			? "No files needed restoring"
			: `Restored ${total} file${total === 1 ? "" : "s"} (${parts.join(", ")})`;
	if (result.failed.length > 0) {
		notice += `; ${result.failed.length} failed: ${result.failed[0].path} (${result.failed[0].reason})`;
	}
	if (result.skipped.length > 0) notice += `; ${result.skipped.length} not restored`;
	return notice;
}

/** The checkpoint folder of one session under `rootDir`. */
export function sessionCheckpointDir(rootDir: string, sessionId: string): string {
	return join(rootDir, sessionId.replace(/[^A-Za-z0-9._-]/g, "_"));
}

/**
 * Delete a session's checkpoints (its shadow git repository and blob copies, which can hold .env and other ignored
 * files). Called when the session itself is deleted. Returns whether a folder was removed. Never throws.
 */
export function pruneSessionCheckpoints(rootDir: string, sessionId: string): boolean {
	if (!sessionId || /^[._]*$/.test(sessionId.replace(/[^A-Za-z0-9._-]/g, "_"))) return false;
	const dir = sessionCheckpointDir(rootDir, sessionId);
	try {
		if (!existsSync(dir)) return false;
		rmSync(dir, { recursive: true, force: true });
		return true;
	} catch {
		return false;
	}
}
