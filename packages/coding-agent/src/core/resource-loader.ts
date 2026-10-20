import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import chalk from "chalk";
import { CONFIG_DIR_NAME } from "../config.ts";
import type { Theme } from "../modes/interactive/theme/theme.ts";
import { canonicalizePath, isLocalPath, resolvePath } from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";
import { createExtensionRuntime } from "./extensions/runtime.ts";
import type { LoadExtensionsResult } from "./extensions/types.ts";
import { findGitPaths } from "./footer-data-provider.ts";
import type { PromptTemplate } from "./prompt-templates.ts";
import { loadPromptTemplates } from "./prompt-templates.ts";
import { type PathMetadata, type ResolvedResource, ResourceDiscovery } from "./resource-discovery.ts";
import { SettingsManager } from "./settings-manager.ts";
import type { Skill } from "./skills.ts";
import { loadSkills } from "./skills.ts";
import { createSourceInfo, getSyntheticPathSource, isSyntheticPath, type SourceInfo } from "./source-info.ts";

export type { ResourceCollision, ResourceDiagnostic } from "./diagnostics.ts";

export interface ResourceExtensionPaths {
	skillPaths?: Array<{ path: string; metadata: PathMetadata }>;
	promptPaths?: Array<{ path: string; metadata: PathMetadata }>;
}

export interface ResourceLoaderReloadOptions {
	resolveProjectTrust?: (input: { extensionsResult: LoadExtensionsResult }) => Promise<boolean>;
}

/**
 * Loads the resources that shape the system prompt: skills, prompt templates, context files
 * (AGENTS.md / CLAUDE.md) and SYSTEM.md / APPEND_SYSTEM.md overrides. RunKiln has no extensions
 * or custom themes, so those accessors return empty results.
 */
export interface ResourceLoader {
	getExtensions(): LoadExtensionsResult;
	getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] };
	getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] };
	getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] };
	getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> };
	getSystemPrompt(): string | undefined;
	getSystemPromptSource(): { path: string } | undefined;
	getAppendSystemPrompt(): string[];
	getAppendSystemPromptSources(): Array<{ path: string }>;
	extendResources(paths: ResourceExtensionPaths): void;
	reload(options?: ResourceLoaderReloadOptions): Promise<void>;
}

function resolvePromptInput(input: string | undefined, description: string): string | undefined {
	if (!input) {
		return undefined;
	}

	if (existsSync(input)) {
		try {
			return stripBom(readFileSync(input, "utf-8"));
		} catch (error) {
			console.error(chalk.yellow(`Warning: Could not read ${description} file ${input}: ${error}`));
			return input;
		}
	}

	return input;
}

function loadContextFileFromDir(dir: string): { path: string; content: string } | null {
	const candidates = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
	for (const filename of candidates) {
		const filePath = join(dir, filename);
		if (existsSync(filePath)) {
			try {
				if (!statSync(filePath).isFile()) {
					continue;
				}
				return {
					path: filePath,
					content: stripBom(readFileSync(filePath, "utf-8")),
				};
			} catch (error) {
				console.error(chalk.yellow(`Warning: Could not read ${filePath}: ${error}`));
			}
		}
	}
	return null;
}

/**
 * The main repo's context file that a nested linked worktree's own copy shadows: both
 * occupy the same logical repository scope, so loading both applies that context twice. Returns
 * undefined when nothing is shadowed, leaving normal ancestor inheritance alone.
 *
 * Returned canonicalized (realpath), because `git worktree add` writes the `.git`
 * file's `gitdir:` target in realpath form while cwd may still be symlinked
 * (macOS `/tmp` -> `/private/tmp`).
 */
function findShadowedContextFile(cwd: string): string | undefined {
	const gitPaths = findGitPaths(cwd);
	if (!gitPaths) return undefined;
	const commonGitDir = canonicalizePath(gitPaths.commonGitDir);
	const worktreeRoot = canonicalizePath(gitPaths.repoDir);
	const mainRepoRoot = dirname(commonGitDir);
	// False for an ordinary repo, where the two are the same dir, and for a sibling
	// worktree (`git worktree add ../feat`), whose main repo is not an ancestor.
	if (!worktreeRoot.startsWith(`${mainRepoRoot}${sep}`)) return undefined;
	// dirname of the common git dir is the main worktree root only when that dir is
	// itself checked out from the same repo. In a bare layout (`proj/.bare` +
	// `proj/main`) it is just the directory holding `.bare`, which tracks nothing; a
	// submodule's gitdir has no `commondir`, so it lands under `.git/modules`.
	if (canonicalizePath(join(mainRepoRoot, ".git")) !== commonGitDir) return undefined;
	const worktreeContextFile = loadContextFileFromDir(worktreeRoot);
	return worktreeContextFile ? join(mainRepoRoot, basename(worktreeContextFile.path)) : undefined;
}

export function loadProjectContextFiles(options: {
	cwd: string;
	agentDir: string;
}): Array<{ path: string; content: string }> {
	const resolvedCwd = resolvePath(options.cwd);
	const resolvedAgentDir = resolvePath(options.agentDir);

	const contextFiles: Array<{ path: string; content: string }> = [];
	const seenPaths = new Set<string>();

	const globalContext = loadContextFileFromDir(resolvedAgentDir);
	if (globalContext) {
		contextFiles.push(globalContext);
		seenPaths.add(globalContext.path);
	}

	const ancestorContextFiles: Array<{ path: string; content: string }> = [];

	const shadowedContextFile = findShadowedContextFile(resolvedCwd);
	let currentDir = resolvedCwd;

	while (true) {
		const contextFile = loadContextFileFromDir(currentDir);
		// Compare the directory's real path, not the file's: a worktree AGENTS.md that
		// symlinks to the main repo's file resolves to the shadowed path itself.
		const isShadowed =
			shadowedContextFile !== undefined &&
			contextFile !== null &&
			join(canonicalizePath(currentDir), basename(contextFile.path)) === shadowedContextFile;
		if (contextFile && !isShadowed && !seenPaths.has(contextFile.path)) {
			ancestorContextFiles.unshift(contextFile);
			seenPaths.add(contextFile.path);
		}

		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}

	contextFiles.push(...ancestorContextFiles);

	return contextFiles;
}

export interface DefaultResourceLoaderOptions {
	cwd: string;
	agentDir: string;
	settingsManager?: SettingsManager;
	additionalSkillPaths?: string[];
	additionalPromptTemplatePaths?: string[];
	noSkills?: boolean;
	noPromptTemplates?: boolean;
	noContextFiles?: boolean;
	systemPrompt?: string;
	appendSystemPrompt?: string[];
	skillsOverride?: (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
		skills: Skill[];
		diagnostics: ResourceDiagnostic[];
	};
	promptsOverride?: (base: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }) => {
		prompts: PromptTemplate[];
		diagnostics: ResourceDiagnostic[];
	};
	agentsFilesOverride?: (base: { agentsFiles: Array<{ path: string; content: string }> }) => {
		agentsFiles: Array<{ path: string; content: string }>;
	};
	systemPromptOverride?: (base: string | undefined) => string | undefined;
	appendSystemPromptOverride?: (base: string[]) => string[];
}

export class DefaultResourceLoader implements ResourceLoader {
	private readonly cwd: string;
	private readonly agentDir: string;
	private readonly settingsManager: SettingsManager;
	private readonly discovery: ResourceDiscovery;
	private readonly options: DefaultResourceLoaderOptions;
	private readonly extensionsResult: LoadExtensionsResult = {
		extensions: [],
		errors: [],
		runtime: createExtensionRuntime(),
	};

	private skills: Skill[] = [];
	private skillDiagnostics: ResourceDiagnostic[] = [];
	private prompts: PromptTemplate[] = [];
	private promptDiagnostics: ResourceDiagnostic[] = [];
	private agentsFiles: Array<{ path: string; content: string }> = [];
	private systemPrompt?: string;
	private systemPromptSourcePath?: string;
	private appendSystemPrompt: string[] = [];
	private appendSystemPromptSourcePaths: string[] = [];
	private lastSkillPaths: string[] = [];
	private lastPromptPaths: string[] = [];
	private resourceMetadataByPath = new Map<string, PathMetadata>();
	private extraSourceInfos = new Map<string, SourceInfo>();

	constructor(options: DefaultResourceLoaderOptions) {
		this.options = options;
		this.cwd = resolvePath(options.cwd);
		this.agentDir = resolvePath(options.agentDir);
		this.settingsManager = options.settingsManager ?? SettingsManager.create(this.cwd, this.agentDir);
		this.discovery = new ResourceDiscovery({
			cwd: this.cwd,
			agentDir: this.agentDir,
			settingsManager: this.settingsManager,
		});
	}

	getExtensions(): LoadExtensionsResult {
		return this.extensionsResult;
	}

	getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
		return { skills: this.skills, diagnostics: this.skillDiagnostics };
	}

	getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
		return { prompts: this.prompts, diagnostics: this.promptDiagnostics };
	}

	getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] } {
		return { themes: [], diagnostics: [] };
	}

	getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> } {
		return { agentsFiles: this.agentsFiles };
	}

	getSystemPrompt(): string | undefined {
		return this.systemPrompt;
	}

	getSystemPromptSource(): { path: string } | undefined {
		return this.systemPromptSourcePath ? { path: this.systemPromptSourcePath } : undefined;
	}

	getAppendSystemPrompt(): string[] {
		return this.appendSystemPrompt;
	}

	getAppendSystemPromptSources(): Array<{ path: string }> {
		return this.appendSystemPromptSourcePaths.map((path) => ({ path }));
	}

	extendResources(paths: ResourceExtensionPaths): void {
		const normalize = (entries: Array<{ path: string; metadata: PathMetadata }>) =>
			entries.map((entry) => ({ path: this.resolveResourcePath(entry.path), metadata: entry.metadata }));
		const skillPaths = normalize(paths.skillPaths ?? []);
		const promptPaths = normalize(paths.promptPaths ?? []);
		for (const entry of [...skillPaths, ...promptPaths]) {
			this.extraSourceInfos.set(entry.path, createSourceInfo(entry.path, entry.metadata));
		}
		if (skillPaths.length > 0) {
			this.lastSkillPaths = this.mergePaths(
				this.lastSkillPaths,
				skillPaths.map((entry) => entry.path),
			);
			this.updateSkillsFromPaths(this.lastSkillPaths);
		}
		if (promptPaths.length > 0) {
			this.lastPromptPaths = this.mergePaths(
				this.lastPromptPaths,
				promptPaths.map((entry) => entry.path),
			);
			this.updatePromptsFromPaths(this.lastPromptPaths);
		}
	}

	async reload(options?: ResourceLoaderReloadOptions): Promise<void> {
		if (options?.resolveProjectTrust) {
			this.settingsManager.setProjectTrusted(false);
			await this.settingsManager.reload();
			const projectTrusted = await options.resolveProjectTrust({ extensionsResult: this.extensionsResult });
			this.settingsManager.setProjectTrusted(projectTrusted);
		}
		// reload() preserves SettingsManager.projectTrusted and reloads settings for that trust state.
		await this.settingsManager.reload();

		const resolved = this.discovery.resolve();
		this.resourceMetadataByPath = new Map();
		this.extraSourceInfos = new Map();
		const enabled = (resources: ResolvedResource[]): ResolvedResource[] => {
			for (const resource of resources) {
				if (!this.resourceMetadataByPath.has(resource.path)) {
					this.resourceMetadataByPath.set(resource.path, resource.metadata);
				}
			}
			return resources.filter((resource) => resource.enabled);
		};

		const additionalSkillPaths = this.options.additionalSkillPaths ?? [];
		const enabledSkills = this.options.noSkills ? [] : enabled(resolved.skills).map((r) => this.mapSkillPath(r));
		this.lastSkillPaths = this.mergePaths(enabledSkills, additionalSkillPaths);
		this.updateSkillsFromPaths(this.lastSkillPaths);
		this.reportMissing(additionalSkillPaths, this.skillDiagnostics, "Skill path does not exist");

		const additionalPromptPaths = this.options.additionalPromptTemplatePaths ?? [];
		const enabledPrompts = this.options.noPromptTemplates ? [] : enabled(resolved.prompts).map((r) => r.path);
		this.lastPromptPaths = this.mergePaths(enabledPrompts, additionalPromptPaths);
		this.updatePromptsFromPaths(this.lastPromptPaths);
		this.reportMissing(additionalPromptPaths, this.promptDiagnostics, "Prompt template path does not exist");

		const agentsFiles = {
			agentsFiles: this.options.noContextFiles
				? []
				: loadProjectContextFiles({ cwd: this.cwd, agentDir: this.agentDir }),
		};
		this.agentsFiles = (this.options.agentsFilesOverride?.(agentsFiles) ?? agentsFiles).agentsFiles;

		const systemPromptSource = this.options.systemPrompt ?? this.discoverPromptFile("SYSTEM.md");
		const baseSystemPrompt = resolvePromptInput(systemPromptSource, "system prompt");
		this.systemPrompt = this.options.systemPromptOverride
			? this.options.systemPromptOverride(baseSystemPrompt)
			: baseSystemPrompt;
		this.systemPromptSourcePath =
			systemPromptSource && existsSync(systemPromptSource) ? resolvePath(systemPromptSource) : undefined;

		let appendSources = this.options.appendSystemPrompt;
		if (!appendSources) {
			const discovered = this.discoverPromptFile("APPEND_SYSTEM.md");
			appendSources = discovered ? [discovered] : [];
		}
		const baseAppend = appendSources
			.map((source) => resolvePromptInput(source, "append system prompt"))
			.filter((source): source is string => source !== undefined);
		this.appendSystemPrompt = this.options.appendSystemPromptOverride
			? this.options.appendSystemPromptOverride(baseAppend)
			: baseAppend;
		this.appendSystemPromptSourcePaths = appendSources
			.filter((source) => existsSync(source))
			.map((source) => resolvePath(source));
	}

	private reportMissing(paths: string[], diagnostics: ResourceDiagnostic[], message: string): void {
		for (const p of paths) {
			if (!isLocalPath(p)) continue;
			const resolved = this.resolveResourcePath(p);
			if (!existsSync(resolved) && !diagnostics.some((d) => d.path === resolved)) {
				diagnostics.push({ type: "error", message, path: resolved });
			}
		}
	}

	private mapSkillPath(resource: ResolvedResource): string {
		if (resource.metadata.source !== "auto") return resource.path;
		try {
			if (!statSync(resource.path).isDirectory()) return resource.path;
		} catch {
			return resource.path;
		}
		const skillFile = join(resource.path, "SKILL.md");
		if (!existsSync(skillFile)) return resource.path;
		if (!this.resourceMetadataByPath.has(skillFile)) this.resourceMetadataByPath.set(skillFile, resource.metadata);
		return skillFile;
	}

	private updateSkillsFromPaths(skillPaths: string[]): void {
		const base =
			this.options.noSkills && skillPaths.length === 0
				? { skills: [], diagnostics: [] }
				: loadSkills({ cwd: this.cwd, agentDir: this.agentDir, skillPaths, includeDefaults: false });
		const result = this.options.skillsOverride ? this.options.skillsOverride(base) : base;
		this.skills = result.skills.map((skill) => ({
			...skill,
			sourceInfo:
				this.findSourceInfoForPath(skill.filePath) ?? skill.sourceInfo ?? this.defaultSourceInfo(skill.filePath),
		}));
		this.skillDiagnostics = result.diagnostics;
	}

	private updatePromptsFromPaths(promptPaths: string[]): void {
		let base: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] };
		if (this.options.noPromptTemplates && promptPaths.length === 0) {
			base = { prompts: [], diagnostics: [] };
		} else {
			const loaded = loadPromptTemplates({
				cwd: this.cwd,
				agentDir: this.agentDir,
				promptPaths,
				includeDefaults: false,
			});
			const deduped = dedupePrompts(loaded.templates);
			base = { prompts: deduped.prompts, diagnostics: [...loaded.diagnostics, ...deduped.diagnostics] };
		}
		const result = this.options.promptsOverride ? this.options.promptsOverride(base) : base;
		this.prompts = result.prompts.map((prompt) => ({
			...prompt,
			sourceInfo:
				this.findSourceInfoForPath(prompt.filePath) ?? prompt.sourceInfo ?? this.defaultSourceInfo(prompt.filePath),
		}));
		this.promptDiagnostics = result.diagnostics;
	}

	private findSourceInfoForPath(resourcePath: string): SourceInfo | undefined {
		if (!resourcePath) return undefined;
		if (isSyntheticPath(resourcePath)) return this.defaultSourceInfo(resourcePath);
		const normalized = resolve(resourcePath);
		const under = (root: string) => normalized === resolve(root) || normalized.startsWith(`${resolve(root)}${sep}`);
		for (const [sourcePath, sourceInfo] of this.extraSourceInfos) {
			if (under(sourcePath)) return { ...sourceInfo, path: resourcePath };
		}
		const exact = this.resourceMetadataByPath.get(normalized) ?? this.resourceMetadataByPath.get(resourcePath);
		if (exact) return createSourceInfo(resourcePath, exact);
		for (const [sourcePath, metadata] of this.resourceMetadataByPath) {
			if (under(sourcePath)) return createSourceInfo(resourcePath, metadata);
		}
		return undefined;
	}

	private defaultSourceInfo(filePath: string): SourceInfo {
		const syntheticSource = getSyntheticPathSource(filePath);
		if (syntheticSource) return { path: filePath, source: syntheticSource, scope: "temporary", origin: "top-level" };
		const normalized = resolve(filePath);
		const isUnder = (root: string) => normalized === resolve(root) || normalized.startsWith(`${resolve(root)}${sep}`);
		for (const root of [join(this.agentDir, "skills"), join(this.agentDir, "prompts")]) {
			if (isUnder(root))
				return { path: filePath, source: "local", scope: "user", origin: "top-level", baseDir: root };
		}
		for (const root of [join(this.cwd, CONFIG_DIR_NAME, "skills"), join(this.cwd, CONFIG_DIR_NAME, "prompts")]) {
			if (isUnder(root)) {
				return { path: filePath, source: "local", scope: "project", origin: "top-level", baseDir: root };
			}
		}
		return {
			path: filePath,
			source: "local",
			scope: "temporary",
			origin: "top-level",
			baseDir: statSync(normalized).isDirectory() ? normalized : resolve(normalized, ".."),
		};
	}

	private mergePaths(primary: string[], additional: string[]): string[] {
		const merged: string[] = [];
		const seen = new Set<string>();
		for (const p of [...primary, ...additional]) {
			const resolved = this.resolveResourcePath(p);
			const canonicalPath = canonicalizePath(resolved);
			if (seen.has(canonicalPath)) continue;
			seen.add(canonicalPath);
			merged.push(resolved);
		}
		return merged;
	}

	private resolveResourcePath(p: string): string {
		return isSyntheticPath(p) ? p : resolvePath(p, this.cwd, { trim: true });
	}

	/** Project file (trusted projects only) wins over the user file in the agent dir. */
	private discoverPromptFile(name: "SYSTEM.md" | "APPEND_SYSTEM.md"): string | undefined {
		const projectPath = join(this.cwd, CONFIG_DIR_NAME, name);
		if (this.settingsManager.isProjectTrusted() && existsSync(projectPath)) return projectPath;
		const globalPath = join(this.agentDir, name);
		return existsSync(globalPath) ? globalPath : undefined;
	}
}

function dedupePrompts(prompts: PromptTemplate[]): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
	const seen = new Map<string, PromptTemplate>();
	const diagnostics: ResourceDiagnostic[] = [];
	for (const prompt of prompts) {
		const existing = seen.get(prompt.name);
		if (existing) {
			diagnostics.push({
				type: "collision",
				message: `name "/${prompt.name}" collision`,
				path: prompt.filePath,
				collision: {
					resourceType: "prompt",
					name: prompt.name,
					winnerPath: existing.filePath,
					loserPath: prompt.filePath,
				},
			});
		} else {
			seen.set(prompt.name, prompt);
		}
	}
	return { prompts: Array.from(seen.values()), diagnostics };
}
