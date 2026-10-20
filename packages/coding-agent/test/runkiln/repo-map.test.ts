import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { languageForPath } from "../../src/core/repo-map/languages.ts";
import { rankRepo } from "../../src/core/repo-map/rank.ts";
import { estimateTokens, renderRepoMap } from "../../src/core/repo-map/render.ts";
import {
	conversationText,
	getRepoMap,
	listSourceFiles,
	mentionsIn,
	RepoMap,
	resetRepoMaps,
} from "../../src/core/repo-map/repo-map.ts";
import { extractTags, type FileTags, regexTags, treeSitterAvailable } from "../../src/core/repo-map/tags.ts";
import { createRepoMapToolDefinition } from "../../src/core/repo-map/tool.ts";
import { approvalRequestForToolCall } from "../../src/core/runkiln/approval.ts";
import { parseMapArgs } from "../../src/modes/interactive/components/repo-map-view.ts";

const TS_SOURCE = `import { Store } from "./store";

export interface CartLine {
	sku: string;
	qty: number;
}

export type Money = number;

export const TAX_RATE = 0.2;

export function cartTotal(lines: CartLine[], rate: number = TAX_RATE): Money {
	return lines.reduce((sum, line) => sum + line.qty, 0) * (1 + rate);
}

export const applyCode = (total: Money, code?: string): Money => total;

export class Cart extends Store {
	private lines: CartLine[] = [];
	add(line: CartLine): void {
		this.lines.push(line);
	}
	total(): Money {
		return cartTotal(this.lines);
	}
}
`;

const PY_SOURCE = `import os

MAX_RETRIES = 3

class Resolver(Base):
    def resolve(self, graph, targets=()):
        return plan(graph)

def plan(graph):
    return sorted(graph)
`;

const GO_SOURCE = `package store

type Store struct { items map[string]int }

func NewStore() *Store { return &Store{} }

func (s *Store) Get(key string) (int, bool) {
	v, ok := s.items[key]
	return v, ok
}
`;

const RUST_SOURCE = `pub struct Ledger { entries: Vec<Entry> }

pub trait Account { fn balance(&self) -> i64; }

impl Ledger {
    pub fn post(&mut self, entry: Entry) -> Result<(), Error> {
        validate(&entry)?;
        Ok(())
    }
}

fn validate(entry: &Entry) -> Result<(), Error> { Ok(()) }
`;

function write(root: string, files: Record<string, string>): void {
	for (const [rel, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, rel)), { recursive: true });
		writeFileSync(join(root, rel), content);
	}
}

let hasTreeSitter = false;
beforeAll(async () => {
	hasTreeSitter = await treeSitterAvailable();
});

describe("repo map tags", () => {
	it("knows the languages by extension", () => {
		expect(languageForPath("src/a.ts")).toBe("typescript");
		expect(languageForPath("src/a.tsx")).toBe("tsx");
		expect(languageForPath("a/b.mjs")).toBe("javascript");
		expect(languageForPath("pkg/x.py")).toBe("python");
		expect(languageForPath("main.go")).toBe("go");
		expect(languageForPath("lib.rs")).toBe("rust");
		expect(languageForPath("README.md")).toBeUndefined();
		expect(languageForPath("dir.v2/Makefile")).toBeUndefined();
	});

	it("parses TypeScript with tree-sitter: definitions with signatures, containers and references", async () => {
		expect(hasTreeSitter).toBe(true);
		const tags = await extractTags("typescript", TS_SOURCE);
		expect(tags.parser).toBe("tree-sitter");
		const byName = Object.fromEntries(tags.defs.map((def) => [def.name, def]));
		expect(byName.CartLine).toMatchObject({ kind: "interface", signature: "export interface CartLine" });
		expect(byName.Money).toMatchObject({ kind: "type" });
		expect(byName.cartTotal).toMatchObject({
			kind: "function",
			line: 12,
			signature: "export function cartTotal(lines: CartLine[], rate: number = TAX_RATE): Money",
		});
		expect(byName.applyCode!.signature).toBe("export const applyCode = (total: Money, code?: string): Money =>");
		expect(byName.Cart!.signature).toBe("export class Cart extends Store");
		expect(byName.add).toMatchObject({ kind: "method", container: "Cart", signature: "add(line: CartLine): void" });
		expect(byName.TAX_RATE).toMatchObject({ kind: "const" });
		expect(tags.refs.cartTotal).toBe(1);
		expect(tags.refs.Store).toBeGreaterThanOrEqual(1);
		expect(tags.refs.CartLine).toBeGreaterThanOrEqual(3);
		// A method call on an object is kept apart (it cannot reach a free function) and counts a quarter.
		expect(tags.refs[".push"]).toBe(0.25);
		expect(tags.refs.push).toBeUndefined();
	});

	it("parses Python, Go and Rust", async () => {
		const py = await extractTags("python", PY_SOURCE);
		expect(py.defs.map((d) => `${d.kind}:${d.name}`)).toEqual([
			"const:MAX_RETRIES",
			"class:Resolver",
			"method:resolve",
			"function:plan",
		]);
		expect(py.defs[1]!.signature).toBe("class Resolver(Base)");
		expect(py.defs[2]).toMatchObject({ container: "Resolver", signature: "def resolve(self, graph, targets=())" });
		expect(py.refs.plan).toBeGreaterThanOrEqual(1);
		expect(py.refs.Base).toBe(1);

		const go = await extractTags("go", GO_SOURCE);
		const goNames = Object.fromEntries(go.defs.map((d) => [d.name, d]));
		expect(goNames.Store).toMatchObject({ kind: "type" });
		expect(goNames.NewStore!.signature).toBe("func NewStore() *Store");
		expect(goNames.Get).toMatchObject({ kind: "method", container: "Store" });
		expect(go.refs.Store).toBeGreaterThanOrEqual(1);

		const rust = await extractTags("rust", RUST_SOURCE);
		const rsNames = Object.fromEntries(rust.defs.map((d) => [d.name, d]));
		expect(rsNames.Ledger).toMatchObject({ kind: "class" });
		expect(rsNames.Account).toMatchObject({ kind: "interface" });
		expect(rsNames.post).toMatchObject({ kind: "method", container: "Ledger" });
		expect(rsNames.post!.signature).toBe("pub fn post(&mut self, entry: Entry) -> Result<(), Error>");
		expect(rust.refs.validate).toBe(1);
	});

	it("falls back to regexes", () => {
		const ts = regexTags("typescript", TS_SOURCE);
		expect(ts.parser).toBe("regex");
		const names = ts.defs.map((d) => `${d.kind}:${d.name}`);
		expect(names).toEqual(
			expect.arrayContaining([
				"interface:CartLine",
				"type:Money",
				"function:cartTotal",
				"const:applyCode",
				"class:Cart",
				"method:add",
			]),
		);
		expect(ts.defs.find((d) => d.name === "add")?.container).toBe("Cart");
		expect(ts.refs.cartTotal).toBe(1);
		const py = regexTags("python", PY_SOURCE);
		expect(py.defs.map((d) => d.name)).toEqual(["MAX_RETRIES", "Resolver", "resolve", "plan"]);
		const kt = regexTags("kotlin", "class Box {\n  fun open(): Int = 1\n}\n");
		expect(kt.defs.map((d) => d.name)).toEqual(["Box", "open"]);
	});
});

function fileTags(defs: string[], refs: Record<string, number> = {}): FileTags {
	return {
		defs: defs.map((name, i) => ({ name, kind: "function", line: i + 1, signature: `function ${name}()` })),
		refs,
		parser: "tree-sitter",
	};
}

describe("repo map ranking and rendering", () => {
	const repo = new Map<string, FileTags>([
		["src/core.ts", fileTags(["parseConfig", "loadSettings"])],
		["src/util.ts", fileTags(["formatBytes"])],
		["src/a.ts", fileTags(["runA"], { parseConfig: 3, loadSettings: 1 })],
		["src/b.ts", fileTags(["runB"], { parseConfig: 2 })],
		["src/c.ts", fileTags(["runC"], { formatBytes: 1 })],
	]);

	it("ranks the definitions the rest of the repo uses first (PageRank over references)", () => {
		const ranked = rankRepo(repo);
		expect(ranked.defs[0]).toMatchObject({ file: "src/core.ts" });
		expect(ranked.defs[0]!.def.name).toBe("parseConfig");
		expect(ranked.files[0]!.file).toBe("src/core.ts");
		const sum = ranked.files.reduce((total, f) => total + f.rank, 0);
		expect(sum).toBeCloseTo(1, 6);
	});

	it("boosts files and identifiers the conversation mentions", () => {
		const focused = rankRepo(repo, { focusFiles: new Set(["src/c.ts"]) });
		expect(focused.defs[0]!.def.name).toBe("formatBytes");
		const byIdent = rankRepo(repo, { focusIdents: new Set(["runB"]) });
		expect(byIdent.defs[0]!.def.name).toBe("runB");
	});

	it("links no file to itself or across languages, and puts files asked for by path first", () => {
		const mixed = new Map<string, FileTags>([
			["src/app.ts", fileTags(["main2"], { resolvePlan: 4, helperFn: 2 })],
			["src/helper.ts", fileTags(["helperFn", "innerLoop"], { innerLoop: 50 })],
			["tools/plan.py", fileTags(["resolvePlan"])],
		]);
		const ranked = rankRepo(mixed);
		expect(ranked.defs.find((d) => d.def.name === "resolvePlan")!.rank).toBeLessThan(1e-3);
		expect(ranked.defs[0]!.def.name).toBe("helperFn");
		// A file that only calls its own helper does not trap the rank.
		expect(ranked.files[0]!.rank).toBeLessThan(0.6);
		const pinned = rankRepo(repo, { focusFiles: new Set(["src/util.ts"]), pinFiles: new Set(["src/util.ts"]) });
		expect(pinned.defs[0]!.file).toBe("src/util.ts");
	});

	it("fits the token budget and grows with it", () => {
		const ranked = rankRepo(repo);
		const small = renderRepoMap(ranked, 20);
		const big = renderRepoMap(ranked, 2000);
		expect(small.tokens).toBeLessThanOrEqual(20);
		expect(estimateTokens(small.text)).toBe(small.tokens);
		expect(big.symbols).toBe(6);
		expect(big.files).toBe(5);
		expect(big.text.split("\n")[0]).toBe("src/core.ts:");
		expect(big.text).toContain("│ function parseConfig()");
		expect(small.symbols).toBeLessThan(big.symbols);
	});

	it("finds mentioned files and identifiers in conversation text", () => {
		const files = ["src/core.ts", "src/deep/util.ts", "test/util.ts", "README.md"];
		const found = mentionsIn(
			"look at ./src/core.ts and deep/util.ts, then fix parseConfig",
			files,
			new Set(["parseConfig"]),
		);
		expect([...found.files].sort()).toEqual(["src/core.ts", "src/deep/util.ts"]);
		expect([...found.idents]).toEqual(["parseConfig"]);
		const text = conversationText([
			{ type: "message", message: { role: "user", content: "fix src/a.ts" } },
			{
				type: "message",
				message: { role: "assistant", content: [{ type: "toolCall", arguments: { path: "src/b.ts" } }] },
			},
		]);
		expect(text).toBe("fix src/a.ts\nsrc/b.ts");
	});

	it("reads /map arguments: a budget, paths, and query words", () => {
		const exists = (p: string) => p === "src" || p === "src/core.ts";
		expect(parseMapArgs("", exists)).toEqual({});
		expect(parseMapArgs("2k src parseConfig retry", exists)).toEqual({
			tokens: 2000,
			focusPaths: ["src"],
			query: "parseConfig retry",
		});
		expect(parseMapArgs("512 src/core.ts", exists)).toEqual({ tokens: 512, focusPaths: ["src/core.ts"] });
	});
});

describe("repo map on disk", () => {
	let root: string;
	let project: string;
	let cacheDir: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "runkiln-repo-map-"));
		project = join(root, "project");
		cacheDir = join(root, "cache");
		write(project, {
			"src/cart.ts": TS_SOURCE,
			"src/store.ts": "export class Store {\n\tsave(): void {}\n}\n",
			"pkg/resolver.py": PY_SOURCE,
			"node_modules/dep/index.js": "export function hidden() {}\n",
			"dist/out.js": "export function built() {}\n",
			"README.md": "# x\n",
			".gitignore": "ignored.ts\n",
			"ignored.ts": "export function ignoredFn() {}\n",
		});
		const git = (...args: string[]) => execFileSync("git", args, { cwd: project, stdio: "ignore" });
		git("init", "-q");
		git("-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
		git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
		resetRepoMaps();
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("lists source files from git, skipping ignored, vendored and built ones", () => {
		expect(listSourceFiles(project)).toEqual(["pkg/resolver.py", "src/cart.ts", "src/store.ts"]);
		rmSync(join(project, ".git"), { recursive: true, force: true });
		expect(listSourceFiles(project)).toEqual(["ignored.ts", "pkg/resolver.py", "src/cart.ts", "src/store.ts"]);
	});

	it("caches tags on disk by HEAD and mtimes, and re-parses only changed files", async () => {
		const first = await new RepoMap({ cwd: project, cacheDir }).render({ tokens: 2000 });
		expect(first.reparsed).toBe(3);
		expect(first.fromDiskCache).toBe(false);
		expect(first.totalFiles).toBe(3);
		expect(first.head).toMatch(/^[0-9a-f]{40}$/);
		expect(first.text).toContain("src/store.ts:");
		expect(first.text).toContain("export class Store");
		expect(first.text).not.toContain("hidden");

		// A new session (new process index) in the unchanged repo parses nothing.
		const second = await new RepoMap({ cwd: project, cacheDir }).render({ tokens: 2000 });
		expect(second.reparsed).toBe(0);
		expect(second.fromDiskCache).toBe(true);
		expect(second.text).toBe(first.text);

		// One edited file: only it is parsed again, by the in-memory index and by a fresh one.
		const map = getRepoMap(project, cacheDir);
		await map.render();
		writeFileSync(
			join(project, "src/store.ts"),
			"export class Store {\n\tsave(): void {}\n\tload(id: string): Store { return this; }\n}\n",
		);
		const future = new Date(Date.now() + 5000);
		utimesSync(join(project, "src/store.ts"), future, future);
		const third = await map.render({ tokens: 2000 });
		expect(third.reparsed).toBe(1);
		expect(third.text).toContain("load(id: string): Store");
		const fresh = await new RepoMap({ cwd: project, cacheDir }).render({ tokens: 2000 });
		expect(fresh.reparsed).toBe(0);
		expect(fresh.text).toContain("load(id: string): Store");
	});

	it("centers the map on focus paths and query words", async () => {
		const map = new RepoMap({ cwd: project, cacheDir });
		const byPath = await map.render({ focusPaths: ["pkg"], tokens: 60 });
		expect(byPath.text.split("\n")[0]).toBe("pkg/resolver.py:");
		expect(byPath.focusFiles).toEqual(["pkg/resolver.py"]);
		const byQuery = await map.render({ query: "save", tokens: 2000 });
		expect(byQuery.focusIdents).toContain("save");
		expect(byQuery.text.split("\n")[0]).toBe("src/store.ts:");
	});

	it("serves the repo_map tool, which runs without asking", async () => {
		const tool = createRepoMapToolDefinition(project, { cacheDir });
		expect(tool.name).toBe("repo_map");
		expect(tool.executionMode).toBe("parallel");
		const result = await tool.execute(
			"call-1",
			{ query: "resolve", tokens: 400 },
			undefined,
			undefined,
			undefined as never,
		);
		const text = (result.content[0] as { text: string }).text;
		expect(text.split("\n")[0]).toMatch(/^Repo map: \d of 3 files, \d+ symbols, ~\d+ tokens, centered on /);
		expect(text).toContain("def resolve(self, graph, targets=())");
		expect(result.details).toMatchObject({ totalFiles: 3 });
		expect(approvalRequestForToolCall("repo_map", {}, project, { builtin: true })).toBeUndefined();
		expect(approvalRequestForToolCall("repo_map", {}, project)).toBeDefined();
	});
});
