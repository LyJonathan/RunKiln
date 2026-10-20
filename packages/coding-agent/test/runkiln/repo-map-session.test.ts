import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type Context,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	type Model,
	registerFauxProvider,
	type SimpleStreamOptions,
	streamSimple,
} from "@runkiln/ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REPO_MAP_HINT_TYPE } from "../../src/core/agent-session.ts";
import type { ModelRuntime } from "../../src/core/model-runtime.ts";
import { resetRepoMaps } from "../../src/core/repo-map/repo-map.ts";
import { createAutoModels } from "../../src/core/router/index.ts";
import { ModelRouter } from "../../src/core/router/router.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { classification, MockClassifier, testCatalog } from "./router-fixtures.ts";

/** router.sessionModel and the repo map in a real session (faux provider). */
describe("repo map and session model in a session", () => {
	let root: string;
	let faux: FauxProviderRegistration;
	let classifier: MockClassifier;
	let requests: Array<{ model: string; context: Context }>;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "runkiln-repo-map-session-"));
		for (const dir of ["agent", "project/src", "sessions"]) mkdirSync(join(root, dir), { recursive: true });
		writeFileSync(
			join(root, "project/src/cart.ts"),
			"export function cartTotal(prices: number[]): number {\n\treturn prices.reduce((a, b) => a + b, 0);\n}\n",
		);
		writeFileSync(
			join(root, "project/src/receipt.ts"),
			'import { cartTotal } from "./cart";\nexport function receipt(prices: number[]): string {\n\treturn `TOTAL ${cartTotal(prices)}`;\n}\n',
		);
		faux = registerFauxProvider({
			models: [
				{ id: "cheap", reasoning: true, cost: { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0 } },
				{ id: "strong", reasoning: true, cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0 } },
			],
		});
		classifier = new MockClassifier((input) =>
			classification({ difficulty: input.request.includes("hard") ? 0.8 : 0.1 }),
		);
		requests = [];
		resetRepoMaps();
		process.env.RUNKILN_CODING_AGENT_DIR = join(root, "agent");
	});

	afterEach(() => {
		faux.unregister();
		delete process.env.RUNKILN_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	});

	async function openSession(settings: object, tools?: string[]) {
		writeFileSync(join(root, "agent", "settings.json"), JSON.stringify(settings));
		const autoModels = createAutoModels(faux.models as Model<Api>[]);
		const runtime = {
			autoModel: autoModels.medium,
			autoModelFor: (mode: "low" | "medium" | "high" = "medium") => autoModels[mode],
			getAvailableSnapshot: () => [...(faux.models as Model<Api>[]), ...Object.values(autoModels)],
			getModelById: () => undefined,
			hasConfiguredAuth: () => true,
			checkAuth: async () => ({ type: "api_key" }),
			streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
				requests.push({ model: model.id, context });
				return streamSimple(model, context, options);
			},
		} as unknown as ModelRuntime;
		const router = new ModelRouter({
			catalog: testCatalog(),
			classifier,
			getModels: () => faux.models as Model<Api>[],
			defaultModelId: () => "cheap",
		});
		const { session } = await createAgentSession({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			modelRuntime: runtime,
			model: faux.getModel("cheap"),
			sessionManager: SessionManager.create(join(root, "project"), join(root, "sessions")),
			thinkingLevel: "off",
			...(tools ? { tools } : { noTools: "all" as const }),
			router,
		});
		return { session, autoModel: autoModels.medium };
	}

	it("routes every request by default, and only the first one with router.sessionModel", async () => {
		const perRequest = await openSession({});
		await perRequest.session.setModel(perRequest.autoModel);
		faux.setResponses([fauxAssistantMessage("ok")]);
		await perRequest.session.prompt("an easy question");
		faux.setResponses([fauxAssistantMessage("done")]);
		await perRequest.session.prompt("a hard refactor");
		expect(requests.map((r) => r.model)).toEqual(["cheap", "strong"]);
		perRequest.session.dispose();

		requests = [];
		const sticky = await openSession({ router: { sessionModel: true } });
		await sticky.session.setModel(sticky.autoModel);
		faux.setResponses([fauxAssistantMessage("ok")]);
		await sticky.session.prompt("an easy question");
		const calls = classifier.calls.length;
		faux.setResponses([fauxAssistantMessage("done")]);
		await sticky.session.prompt("a hard refactor");
		expect(requests.map((r) => r.model)).toEqual(["cheap", "cheap"]);
		// The pinned session does not ask the classifier again.
		expect(classifier.calls.length).toBe(calls);
		sticky.session.dispose();
	});

	it("activates repo_map with repoMap.enabled and appends a first-turn map once, outside the system prompt", async () => {
		const { session } = await openSession({ repoMap: { enabled: true, firstTurnTokens: 512 } }, ["read", "repo_map"]);
		expect(session.getActiveToolNames()).toContain("repo_map");
		faux.setResponses([fauxAssistantMessage("first")]);
		await session.prompt("where is cartTotal used?");
		faux.setResponses([fauxAssistantMessage("second")]);
		await session.prompt("thanks");
		expect(requests).toHaveLength(2);
		const [first, second] = requests;
		expect(first!.context.systemPrompt ?? "").not.toContain("Repo map");
		const text = JSON.stringify(first!.context.messages);
		expect(text).toContain("[Repo map, not from the user");
		expect(text).toContain("export function cartTotal(prices: number[]): number");
		// The second request starts with exactly the first request's messages (the cached prefix holds).
		expect(JSON.stringify(second!.context.messages.slice(0, first!.context.messages.length))).toBe(
			JSON.stringify(first!.context.messages),
		);
		expect(first!.context.systemPrompt).toBe(second!.context.systemPrompt);
		const hints = session.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom_message" && entry.customType === REPO_MAP_HINT_TYPE);
		expect(hints).toHaveLength(1);
		session.dispose();
	});

	it("leaves the repo_map tool out and adds no map by default", async () => {
		const { session } = await openSession({}, undefined);
		expect(session.getActiveToolNames()).not.toContain("repo_map");
		faux.setResponses([fauxAssistantMessage("ok")]);
		await session.prompt("where is cartTotal used?");
		expect(JSON.stringify(requests[0]!.context.messages)).not.toContain("Repo map");
		session.dispose();
	});
});
