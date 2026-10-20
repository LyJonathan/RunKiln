/**
 * Local discovery of skills and prompt templates (no package manager).
 *
 * Sources, highest precedence first: project settings entries, project auto-discovery
 * (`.runkiln/skills`, `.runkiln/prompts`, `.agents/skills` up to the git root; trusted
 * projects only), user settings entries, user auto-discovery (`~/.runkiln/agent/skills`,
 * `~/.runkiln/agent/prompts`, `~/.agents/skills`). There are no packages, extensions or themes.
 *
 * Project files are loaded only when the project is trusted. Auto-discovery does not follow a
 * symlink or junction out of its root, and a trusted project's own settings cannot name a path
 * outside that project. Without a git root, ancestor `.agents/skills` directories are not walked.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import ignore from "ignore";
import { minimatch } from "minimatch";
import { CONFIG_DIR_NAME } from "../config.ts";
import { canonicalizePath, normalizePath, resolvePath } from "../utils/paths.ts";
import { isInsideProject } from "./runkiln/approval.ts";
import type { SettingsManager } from "./settings-manager.ts";

/** Directory entries in a fixed order (readdir order depends on the filesystem; the prompt must not). */
const byName = (a: { name: string }, b: { name: string }): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

type SourceScope = "user" | "project" | "temporary";

export interface PathMetadata {
	source: string;
	scope: SourceScope;
	origin: "package" | "top-level";
	baseDir?: string;
}

export interface ResolvedResource {
	path: string;
	enabled: boolean;
	metadata: PathMetadata;
}

export interface ResolvedPaths {
	skills: ResolvedResource[];
	prompts: ResolvedResource[];
}

type ResourceType = "skills" | "prompts";
type ResourceMap = Map<string, { metadata: PathMetadata; enabled: boolean }>;

const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

type IgnoreMatcher = ReturnType<typeof ignore>;

function toPosixPath(p: string): string {
	return p.split(sep).join("/");
}

function getHomeDir(): string {
	return process.env.HOME || homedir();
}

function prefixIgnorePattern(line: string, prefix: string): string | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;

	let pattern = line;
	let negated = false;

	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith("\\!")) {
		pattern = pattern.slice(1);
	}

	if (pattern.startsWith("/")) {
		pattern = pattern.slice(1);
	}

	const prefixed = prefix ? `${prefix}${pattern}` : pattern;
	return negated ? `!${prefixed}` : prefixed;
}

function addIgnoreRules(ig: IgnoreMatcher, dir: string, rootDir: string): void {
	const relativeDir = relative(rootDir, dir);
	const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : "";

	for (const filename of IGNORE_FILE_NAMES) {
		const ignorePath = join(dir, filename);
		if (!existsSync(ignorePath)) continue;
		try {
			const content = readFileSync(ignorePath, "utf-8");
			const patterns = content
				.split(/\r?\n/)
				.map((line) => prefixIgnorePattern(line, prefix))
				.filter((line): line is string => Boolean(line));
			if (patterns.length > 0) {
				ig.add(patterns);
			}
		} catch {}
	}
}

function isPattern(s: string): boolean {
	return s.startsWith("!") || s.startsWith("+") || s.startsWith("-") || s.includes("*") || s.includes("?");
}

function splitPatterns(entries: string[]): { plain: string[]; patterns: string[] } {
	const plain: string[] = [];
	const patterns: string[] = [];
	for (const entry of entries) {
		if (isPattern(entry)) {
			patterns.push(entry);
		} else {
			plain.push(entry);
		}
	}
	return { plain, patterns };
}

function collectFiles(
	dir: string,
	filePattern: RegExp,
	skipNodeModules = true,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
): string[] {
	const files: string[] = [];
	if (!existsSync(dir)) return files;

	const root = rootDir ?? dir;
	const ig = ignoreMatcher ?? ignore();
	addIgnoreRules(ig, dir, root);

	try {
		const entries = readdirSync(dir, { withFileTypes: true }).sort(byName);
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			if (skipNodeModules && entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			if (!isInsideProject(fullPath, root)) continue;
			let isDir = entry.isDirectory();
			let isFile = entry.isFile();

			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isDir = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			const ignorePath = isDir ? `${relPath}/` : relPath;
			if (ig.ignores(ignorePath)) continue;

			if (isDir) {
				files.push(...collectFiles(fullPath, filePattern, skipNodeModules, ig, root));
			} else if (isFile && filePattern.test(entry.name)) {
				files.push(fullPath);
			}
		}
	} catch {
		// Ignore errors
	}

	return files;
}

type SkillDiscoveryMode = "runkiln" | "agents";

function collectSkillEntries(
	dir: string,
	mode: SkillDiscoveryMode,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
): string[] {
	const entries: string[] = [];
	if (!existsSync(dir)) return entries;

	const root = rootDir ?? dir;
	const ig = ignoreMatcher ?? ignore();
	addIgnoreRules(ig, dir, root);

	try {
		const dirEntries = readdirSync(dir, { withFileTypes: true }).sort(byName);

		for (const entry of dirEntries) {
			if (entry.name !== "SKILL.md") {
				continue;
			}

			const fullPath = join(dir, entry.name);
			if (!isInsideProject(fullPath, root)) continue;
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					isFile = statSync(fullPath).isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			if (isFile && !ig.ignores(relPath)) {
				entries.push(fullPath);
				return entries;
			}
		}

		for (const entry of dirEntries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			if (!isInsideProject(fullPath, root)) continue;
			let isDir = entry.isDirectory();
			let isFile = entry.isFile();

			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isDir = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			const shouldIncludeMarkdownFile =
				isFile &&
				entry.name.endsWith(".md") &&
				!ig.ignores(relPath) &&
				((mode === "runkiln" && dir === root) || (mode === "agents" && dir !== root));
			if (shouldIncludeMarkdownFile) {
				entries.push(fullPath);
				continue;
			}

			if (!isDir) continue;
			if (ig.ignores(`${relPath}/`)) continue;

			entries.push(...collectSkillEntries(fullPath, mode, ig, root));
		}
	} catch {
		// Ignore errors
	}

	return entries;
}

function collectAutoSkillEntries(dir: string, mode: SkillDiscoveryMode): string[] {
	return collectSkillEntries(dir, mode);
}

/** Empty when `dir` exists and its real path leaves `boundary` (a junction out of the project or repo). */
function collectInside(dir: string, boundary: string, collect: () => string[]): string[] {
	if (existsSync(dir) && !isInsideProject(dir, boundary)) return [];
	return collect();
}

function findGitRepoRoot(startDir: string): string | null {
	let dir = resolve(startDir);
	while (true) {
		if (existsSync(join(dir, ".git"))) {
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			return null;
		}
		dir = parent;
	}
}

function collectAncestorAgentsSkillDirs(startDir: string): string[] {
	const skillDirs: string[] = [];
	const resolvedStartDir = resolve(startDir);
	const gitRepoRoot = findGitRepoRoot(resolvedStartDir);
	// No git root: only this directory. Do not walk parents up to the drive root.
	const stopAt = gitRepoRoot ?? resolvedStartDir;

	let dir = resolvedStartDir;
	while (true) {
		skillDirs.push(join(dir, ".agents", "skills"));
		if (dir === stopAt) break;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	return skillDirs;
}

function collectAutoPromptEntries(dir: string): string[] {
	const entries: string[] = [];
	if (!existsSync(dir)) return entries;

	const ig = ignore();
	addIgnoreRules(ig, dir, dir);

	try {
		const dirEntries = readdirSync(dir, { withFileTypes: true }).sort(byName);
		for (const entry of dirEntries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			if (!isInsideProject(fullPath, dir)) continue;
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					isFile = statSync(fullPath).isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(dir, fullPath));
			if (ig.ignores(relPath)) continue;

			if (isFile && entry.name.endsWith(".md")) {
				entries.push(fullPath);
			}
		}
	} catch {
		// Ignore errors
	}

	return entries;
}

function matchesAnyPattern(filePath: string, patterns: string[], baseDir: string): boolean {
	const rel = toPosixPath(relative(baseDir, filePath));
	const name = basename(filePath);
	const filePathPosix = toPosixPath(filePath);
	const isSkillFile = name === "SKILL.md";
	const parentDir = isSkillFile ? dirname(filePath) : undefined;
	const parentRel = isSkillFile ? toPosixPath(relative(baseDir, parentDir!)) : undefined;
	const parentName = isSkillFile ? basename(parentDir!) : undefined;
	const parentDirPosix = isSkillFile ? toPosixPath(parentDir!) : undefined;

	return patterns.some((pattern) => {
		const normalizedPattern = toPosixPath(normalizePath(pattern));
		if (
			minimatch(rel, normalizedPattern) ||
			minimatch(name, normalizedPattern) ||
			minimatch(filePathPosix, normalizedPattern)
		) {
			return true;
		}
		if (!isSkillFile) return false;
		return (
			minimatch(parentRel!, normalizedPattern) ||
			minimatch(parentName!, normalizedPattern) ||
			minimatch(parentDirPosix!, normalizedPattern)
		);
	});
}

function normalizeExactPattern(pattern: string): string {
	const normalized = pattern.startsWith("./") || pattern.startsWith(".\\") ? pattern.slice(2) : pattern;
	return toPosixPath(normalizePath(normalized));
}

function matchesAnyExactPattern(filePath: string, patterns: string[], baseDir: string): boolean {
	if (patterns.length === 0) return false;
	const rel = toPosixPath(relative(baseDir, filePath));
	const name = basename(filePath);
	const filePathPosix = toPosixPath(filePath);
	const isSkillFile = name === "SKILL.md";
	const parentDir = isSkillFile ? dirname(filePath) : undefined;
	const parentRel = isSkillFile ? toPosixPath(relative(baseDir, parentDir!)) : undefined;
	const parentDirPosix = isSkillFile ? toPosixPath(parentDir!) : undefined;

	return patterns.some((pattern) => {
		const normalized = normalizeExactPattern(pattern);
		if (normalized === rel || normalized === filePathPosix) {
			return true;
		}
		if (!isSkillFile) return false;
		return normalized === parentRel || normalized === parentDirPosix;
	});
}

function getOverridePatterns(entries: string[]): string[] {
	return entries.filter((pattern) => pattern.startsWith("!") || pattern.startsWith("+") || pattern.startsWith("-"));
}

function isEnabledByOverrides(filePath: string, patterns: string[], baseDir: string): boolean {
	const overrides = getOverridePatterns(patterns);
	const excludes = overrides.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1));
	const forceIncludes = overrides.filter((pattern) => pattern.startsWith("+")).map((pattern) => pattern.slice(1));
	const forceExcludes = overrides.filter((pattern) => pattern.startsWith("-")).map((pattern) => pattern.slice(1));

	let enabled = true;
	if (excludes.length > 0 && matchesAnyPattern(filePath, excludes, baseDir)) {
		enabled = false;
	}
	if (forceIncludes.length > 0 && matchesAnyExactPattern(filePath, forceIncludes, baseDir)) {
		enabled = true;
	}
	if (forceExcludes.length > 0 && matchesAnyExactPattern(filePath, forceExcludes, baseDir)) {
		enabled = false;
	}
	return enabled;
}

/**
 * Apply patterns to paths and return a Set of enabled paths.
 * Pattern types:
 * - Plain patterns: include matching paths
 * - `!pattern`: exclude matching paths
 * - `+path`: force-include exact path (overrides exclusions)
 * - `-path`: force-exclude exact path (overrides force-includes)
 */
function applyPatterns(allPaths: string[], patterns: string[], baseDir: string): Set<string> {
	const includes: string[] = [];
	const excludes: string[] = [];
	const forceIncludes: string[] = [];
	const forceExcludes: string[] = [];

	for (const p of patterns) {
		if (p.startsWith("+")) {
			forceIncludes.push(p.slice(1));
		} else if (p.startsWith("-")) {
			forceExcludes.push(p.slice(1));
		} else if (p.startsWith("!")) {
			excludes.push(p.slice(1));
		} else {
			includes.push(p);
		}
	}

	// Step 1: Apply includes (or all if no includes)
	let result: string[];
	if (includes.length === 0) {
		result = [...allPaths];
	} else {
		result = allPaths.filter((filePath) => matchesAnyPattern(filePath, includes, baseDir));
	}

	// Step 2: Apply excludes
	if (excludes.length > 0) {
		result = result.filter((filePath) => !matchesAnyPattern(filePath, excludes, baseDir));
	}

	// Step 3: Force-include (add back from allPaths, overriding exclusions)
	if (forceIncludes.length > 0) {
		for (const filePath of allPaths) {
			if (!result.includes(filePath) && matchesAnyExactPattern(filePath, forceIncludes, baseDir)) {
				result.push(filePath);
			}
		}
	}

	// Step 4: Force-exclude (remove even if included or force-included)
	if (forceExcludes.length > 0) {
		result = result.filter((filePath) => !matchesAnyExactPattern(filePath, forceExcludes, baseDir));
	}

	return new Set(result);
}

/** Lower rank = higher precedence; name collisions resolve "first wins". */
function resourcePrecedenceRank(m: PathMetadata): number {
	const scopeBase = m.scope === "project" ? 0 : 2;
	return scopeBase + (m.source === "local" ? 0 : 1);
}

function collectResourceFiles(dir: string, resourceType: ResourceType): string[] {
	return resourceType === "skills" ? collectSkillEntries(dir, "runkiln") : collectFiles(dir, /.md$/);
}

export class ResourceDiscovery {
	private readonly cwd: string;
	private readonly agentDir: string;
	private readonly settingsManager: SettingsManager;

	constructor(options: { cwd: string; agentDir: string; settingsManager: SettingsManager }) {
		this.cwd = options.cwd;
		this.agentDir = options.agentDir;
		this.settingsManager = options.settingsManager;
	}

	resolve(): ResolvedPaths {
		const skills: ResourceMap = new Map();
		const prompts: ResourceMap = new Map();
		const globalSettings = this.settingsManager.getGlobalSettings();
		const projectSettings = this.settingsManager.getProjectSettings();
		const globalBaseDir = this.agentDir;
		const projectBaseDir = join(this.cwd, CONFIG_DIR_NAME);
		const projectTrusted = this.settingsManager.isProjectTrusted();

		for (const [type, target] of [
			["skills", skills],
			["prompts", prompts],
		] as const) {
			if (projectTrusted) {
				this.resolveLocalEntries(
					(projectSettings[type] ?? []) as string[],
					type,
					target,
					{ source: "local", scope: "project", origin: "top-level" },
					projectBaseDir,
				);
			}
			this.resolveLocalEntries(
				(globalSettings[type] ?? []) as string[],
				type,
				target,
				{ source: "local", scope: "user", origin: "top-level" },
				globalBaseDir,
			);
		}

		const userMetadata: PathMetadata = { source: "auto", scope: "user", origin: "top-level", baseDir: globalBaseDir };
		const projectMetadata: PathMetadata = {
			source: "auto",
			scope: "project",
			origin: "top-level",
			baseDir: projectBaseDir,
		};
		const userOverrides = {
			skills: (globalSettings.skills ?? []) as string[],
			prompts: (globalSettings.prompts ?? []) as string[],
		};
		const projectOverrides = {
			skills: (projectSettings.skills ?? []) as string[],
			prompts: (projectSettings.prompts ?? []) as string[],
		};
		const add = (
			target: ResourceMap,
			paths: string[],
			metadata: PathMetadata,
			overrides: string[],
			baseDir: string,
		) => {
			for (const path of paths) addResource(target, path, metadata, isEnabledByOverrides(path, overrides, baseDir));
		};

		const userAgentsSkillsDir = join(getHomeDir(), ".agents", "skills");
		if (projectTrusted) {
			const repoBoundary = findGitRepoRoot(this.cwd) ?? this.cwd;
			add(
				skills,
				collectInside(join(projectBaseDir, "skills"), this.cwd, () =>
					collectAutoSkillEntries(join(projectBaseDir, "skills"), "runkiln"),
				),
				projectMetadata,
				projectOverrides.skills,
				projectBaseDir,
			);
			for (const agentsSkillsDir of collectAncestorAgentsSkillDirs(this.cwd).filter(
				(dir) => resolve(dir) !== resolve(userAgentsSkillsDir),
			)) {
				const agentsBaseDir = dirname(agentsSkillsDir);
				add(
					skills,
					collectInside(agentsSkillsDir, repoBoundary, () => collectAutoSkillEntries(agentsSkillsDir, "agents")),
					{ ...projectMetadata, baseDir: agentsBaseDir },
					projectOverrides.skills,
					agentsBaseDir,
				);
			}
			add(
				prompts,
				collectInside(join(projectBaseDir, "prompts"), this.cwd, () =>
					collectAutoPromptEntries(join(projectBaseDir, "prompts")),
				),
				projectMetadata,
				projectOverrides.prompts,
				projectBaseDir,
			);
		}

		add(
			skills,
			collectAutoSkillEntries(join(globalBaseDir, "skills"), "runkiln"),
			userMetadata,
			userOverrides.skills,
			globalBaseDir,
		);
		const userAgentsBaseDir = dirname(userAgentsSkillsDir);
		add(
			skills,
			collectAutoSkillEntries(userAgentsSkillsDir, "agents"),
			{ ...userMetadata, baseDir: userAgentsBaseDir },
			userOverrides.skills,
			userAgentsBaseDir,
		);
		add(
			prompts,
			collectAutoPromptEntries(join(globalBaseDir, "prompts")),
			userMetadata,
			userOverrides.prompts,
			globalBaseDir,
		);

		return { skills: toResolved(skills), prompts: toResolved(prompts) };
	}

	private resolveLocalEntries(
		entries: string[],
		resourceType: ResourceType,
		target: ResourceMap,
		metadata: PathMetadata,
		baseDir: string,
	): void {
		if (entries.length === 0) return;
		const { plain, patterns } = splitPatterns(entries);
		const resolvedPlain = plain
			.map((p) => resolvePath(p, baseDir, { homeDir: getHomeDir(), trim: true }))
			.filter((p) => metadata.scope !== "project" || isInsideProject(p, this.cwd));
		const allFiles: string[] = [];
		for (const p of resolvedPlain) {
			if (!existsSync(p)) continue;
			try {
				const stats = statSync(p);
				if (stats.isFile()) allFiles.push(p);
				else if (stats.isDirectory()) allFiles.push(...collectResourceFiles(p, resourceType));
			} catch {
				// Ignore unreadable entries
			}
		}
		const enabledPaths = applyPatterns(allFiles, patterns, baseDir);
		for (const f of allFiles) addResource(target, f, metadata, enabledPaths.has(f));
	}
}

function addResource(map: ResourceMap, path: string, metadata: PathMetadata, enabled: boolean): void {
	if (path && !map.has(path)) map.set(path, { metadata, enabled });
}

function toResolved(entries: ResourceMap): ResolvedResource[] {
	const resolved = Array.from(entries.entries()).map(([path, { metadata, enabled }]) => ({ path, enabled, metadata }));
	resolved.sort((a, b) => resourcePrecedenceRank(a.metadata) - resourcePrecedenceRank(b.metadata));
	const seen = new Set<string>();
	return resolved.filter((entry) => {
		const canonicalPath = canonicalizePath(entry.path);
		if (seen.has(canonicalPath)) return false;
		seen.add(canonicalPath);
		return true;
	});
}
