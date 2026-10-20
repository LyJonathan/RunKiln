import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export const workspaceSourcePaths = {
	aiIndex: src("./packages/ai/src/index.ts"),
	aiCompat: src("./packages/ai/src/compat.ts"),
	aiApi: src("./packages/ai/src/api"),
	aiProviders: src("./packages/ai/src/providers"),
	aiUtils: src("./packages/ai/src/utils"),
	agentIndex: src("./packages/agent/src/index.ts"),
	codingAgentIndex: src("./packages/coding-agent/src/index.ts"),
	tuiIndex: src("./packages/tui/src/index.ts"),
} as const;

/** Resolve @runkiln/* imports to workspace sources so tests run without a build. */
export default defineConfig({
	resolve: {
		alias: [
			{ find: /^@runkiln\/ai$/, replacement: workspaceSourcePaths.aiIndex },
			{ find: /^@runkiln\/ai\/compat$/, replacement: workspaceSourcePaths.aiCompat },
			{ find: /^@runkiln\/ai\/utils\/(.+)$/, replacement: `${workspaceSourcePaths.aiUtils}/$1.ts` },
			{ find: /^@runkiln\/ai\/api\/(.+)$/, replacement: `${workspaceSourcePaths.aiApi}/$1.ts` },
			{ find: /^@runkiln\/ai\/providers\/(.+)$/, replacement: `${workspaceSourcePaths.aiProviders}/$1.ts` },
			{ find: /^@runkiln\/agent-core$/, replacement: workspaceSourcePaths.agentIndex },
			{ find: /^@runkiln\/tui$/, replacement: workspaceSourcePaths.tuiIndex },
		],
	},
});
