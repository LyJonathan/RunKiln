/**
 * Definitions and references of one source file. Tree-sitter (WASM grammars from @vscode/tree-sitter-wasm) when the
 * package and the grammar load; otherwise a regex fallback that finds the usual definition forms and counts every
 * identifier as a possible reference (the ranker only keeps names some file defines).
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { type LanguageId, languageSpec } from "./languages.ts";

export type SymbolKind = "function" | "class" | "method" | "interface" | "type" | "enum" | "const" | "module" | "macro";

export interface DefTag {
	name: string;
	kind: SymbolKind;
	/** 1-based line. */
	line: number;
	/** The declaration up to its body, on one line. */
	signature: string;
	/** Enclosing class/impl/module name, for methods. */
	container?: string;
}

export interface FileTags {
	defs: DefTag[];
	/**
	 * Referenced identifier → count. Method calls on objects count a quarter; in languages where they can only reach a
	 * method they are keyed `.name`.
	 */
	refs: Record<string, number>;
	/** How the tags were found. */
	parser: "tree-sitter" | "regex";
}

const MAX_SIGNATURE = 140;
const MAX_REFS_PER_FILE = 2000;
/** A method call on an object (`x.get()`) is weaker evidence than a bare call or a type name. */
const MEMBER_REF_WEIGHT = 0.25;
/** Languages where `x.name()` calls a method, never a free function (Python and Go call module functions that way). */
const METHOD_CALL_LANGUAGES = new Set<LanguageId>([
	"typescript",
	"tsx",
	"javascript",
	"java",
	"c_sharp",
	"php",
	"cpp",
	"rust",
	"ruby",
]);

// ---------------------------------------------------------------------------------------------
// Tree-sitter
// ---------------------------------------------------------------------------------------------

// Minimal structural types for the parts of web-tree-sitter used here.
interface TsPoint {
	row: number;
	column: number;
}
interface TsNode {
	type: string;
	text: string;
	startIndex: number;
	endIndex: number;
	startPosition: TsPoint;
	parent: TsNode | null;
	childForFieldName(name: string): TsNode | null;
}
interface TsQuery {
	captures(node: TsNode): Array<{ name: string; node: TsNode }>;
}
interface TsLanguage {}
interface TsParser {
	setLanguage(language: TsLanguage): void;
	parse(source: string): { rootNode: TsNode; delete?: () => void } | null;
}
interface TsModule {
	Parser: { init(): Promise<void>; new (): TsParser };
	Language: { load(path: string): Promise<TsLanguage> };
	Query: new (language: TsLanguage, source: string) => TsQuery;
}

interface LoadedLanguage {
	parser: TsParser;
	query: TsQuery;
}

let modulePromise: Promise<{ mod: TsModule; dir: string } | undefined> | undefined;
const languages = new Map<LanguageId, Promise<LoadedLanguage | undefined>>();

/** Loads @vscode/tree-sitter-wasm once; undefined when it is not installed or fails to start. */
function loadTreeSitter(): Promise<{ mod: TsModule; dir: string } | undefined> {
	if (process.env.RUNKILN_REPO_MAP_PARSER === "regex") return Promise.resolve(undefined);
	modulePromise ??= (async () => {
		try {
			const require = createRequire(import.meta.url);
			const entry = require.resolve("@vscode/tree-sitter-wasm");
			const mod = require(entry) as TsModule;
			await mod.Parser.init();
			return { mod, dir: dirname(entry) };
		} catch {
			return undefined;
		}
	})();
	return modulePromise;
}

function loadLanguage(id: LanguageId): Promise<LoadedLanguage | undefined> {
	let loaded = languages.get(id);
	if (!loaded) {
		loaded = (async () => {
			const spec = languageSpec(id);
			if (!spec.wasm || spec.patterns.length === 0) return undefined;
			const ts = await loadTreeSitter();
			if (!ts) return undefined;
			try {
				const language = await ts.mod.Language.load(join(ts.dir, spec.wasm));
				const parser = new ts.mod.Parser();
				parser.setLanguage(language);
				// Check each pattern alone, then run the valid ones as one query (one tree walk per file).
				const valid = spec.patterns.filter((pattern) => {
					try {
						new ts.mod.Query(language, pattern);
						return true;
					} catch {
						return false; // a node type this grammar version does not have
					}
				});
				if (valid.length === 0) return undefined;
				return { parser, query: new ts.mod.Query(language, valid.join("\n")) };
			} catch {
				return undefined;
			}
		})();
		languages.set(id, loaded);
	}
	return loaded;
}

/** True when tree-sitter loads here (for diagnostics and tests). */
export async function treeSitterAvailable(): Promise<boolean> {
	return (await loadTreeSitter()) !== undefined;
}

const CONTAINER_TYPES = new Set([
	"class_declaration",
	"abstract_class_declaration",
	"class_definition",
	"interface_declaration",
	"class",
	"module",
	"impl_item",
	"trait_item",
	"struct_declaration",
	"class_specifier",
	"struct_specifier",
	"record_declaration",
]);

function containerOf(node: TsNode): string | undefined {
	for (let current = node.parent; current; current = current.parent) {
		if (current.type === "method_declaration" && current.childForFieldName("receiver")) {
			// Go: func (s *Store) Get(...): the receiver type.
			const receiver = current.childForFieldName("receiver")!.text;
			const match = /([A-Za-z_]\w*)\s*\)\s*$/.exec(receiver) ?? /([A-Za-z_]\w*)[^\w]*$/.exec(receiver);
			return match?.[1];
		}
		if (!CONTAINER_TYPES.has(current.type)) continue;
		const name = current.childForFieldName("name") ?? current.childForFieldName("type");
		if (name) return name.text;
	}
	return undefined;
}

function oneLine(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > MAX_SIGNATURE ? `${flat.slice(0, MAX_SIGNATURE - 1)}…` : flat;
}

/** The declaration around a definition name, from its export keyword to its body. */
function signatureOf(nameNode: TsNode, source: string): string {
	let decl = nameNode.parent ?? nameNode;
	if (decl.type === "variable_declarator" && decl.parent) {
		const value = decl.childForFieldName("value");
		const lexical = decl.parent;
		const start = lexical.parent?.type === "export_statement" ? lexical.parent.startIndex : lexical.startIndex;
		if (
			value &&
			(value.type === "arrow_function" || value.type === "function_expression" || value.type === "function")
		) {
			const body = value.childForFieldName("body");
			const end = body ? body.startIndex : value.endIndex;
			return oneLine(source.slice(start, end).replace(/\s*(=>)?\s*$/, (m) => (m.includes("=>") ? " =>" : "")));
		}
		const firstLine = source.slice(start, lexical.endIndex).split("\n")[0]!;
		return oneLine(firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine);
	}
	// Go type_spec / C++ function_declarator: climb to the statement.
	if (decl.type === "type_spec" && decl.parent) decl = decl.parent;
	if (decl.type === "function_declarator" && decl.parent) decl = decl.parent;
	const start =
		decl.parent?.type === "export_statement" || decl.parent?.type === "decorated_definition"
			? decl.parent.type === "export_statement"
				? decl.parent.startIndex
				: decl.startIndex
			: decl.startIndex;
	const body = decl.childForFieldName("body");
	const end = body && body.startIndex > start ? body.startIndex : Math.min(decl.endIndex, start + 400);
	let text = source.slice(start, end);
	if (!body) text = text.split("\n")[0]!;
	return oneLine(text.replace(/[\s{:=]+$/, ""));
}

async function treeSitterTags(language: LanguageId, source: string): Promise<FileTags | undefined> {
	const loaded = await loadLanguage(language);
	if (!loaded) return undefined;
	const tree = loaded.parser.parse(source);
	if (!tree) return undefined;
	try {
		const defs: DefTag[] = [];
		const refs: Record<string, number> = {};
		const defPositions = new Set<number>();
		const refCaptures: Array<{ name: string; start: number; weight: number }> = [];
		for (const capture of loaded.query.captures(tree.rootNode)) {
			if (capture.name === "ref" || capture.name === "ref.member") {
				if (refCaptures.length < MAX_REFS_PER_FILE)
					refCaptures.push({
						name: capture.node.text,
						start: capture.node.startIndex,
						weight: capture.name === "ref" ? 1 : MEMBER_REF_WEIGHT,
					});
				continue;
			}
			if (!capture.name.startsWith("def.") || defPositions.has(capture.node.startIndex)) continue;
			defPositions.add(capture.node.startIndex);
			const kind = capture.name.slice(4) as SymbolKind;
			const container = kind === "method" || kind === "function" ? containerOf(capture.node) : undefined;
			defs.push({
				name: capture.node.text,
				kind: kind === "function" && container ? "method" : kind,
				line: capture.node.startPosition.row + 1,
				signature: signatureOf(capture.node, source),
				...(container ? { container } : {}),
			});
		}
		const methodCalls = METHOD_CALL_LANGUAGES.has(language);
		for (const ref of refCaptures) {
			if (ref.name.length < 2 || defPositions.has(ref.start)) continue;
			// `x.name()` can only reach a method here: keep it apart so it never links to a free function `name`.
			const key = methodCalls && ref.weight !== 1 ? `.${ref.name}` : ref.name;
			refs[key] = (refs[key] ?? 0) + ref.weight;
		}
		defs.sort((a, b) => a.line - b.line);
		return { defs, refs, parser: "tree-sitter" };
	} finally {
		tree.delete?.();
	}
}

// ---------------------------------------------------------------------------------------------
// Regex fallback
// ---------------------------------------------------------------------------------------------

interface RegexRule {
	re: RegExp;
	kind: SymbolKind;
	/** Capture group of the name. */
	group: number;
}

const JS_RULES: RegexRule[] = [
	{
		re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
		kind: "function",
		group: 1,
	},
	{ re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class", group: 1 },
	{ re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: "interface", group: 1 },
	{ re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=]*>)?\s*=/, kind: "type", group: 1 },
	{ re: /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: "enum", group: 1 },
	{ re: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, kind: "const", group: 1 },
	{
		re: /^\s+(?:public\s+|private\s+|protected\s+|static\s+|async\s+|readonly\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]*)?\{\s*$/,
		kind: "method",
		group: 1,
	},
];

const RULES: Partial<Record<LanguageId, RegexRule[]>> = {
	typescript: JS_RULES,
	tsx: JS_RULES,
	javascript: JS_RULES,
	python: [
		{ re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: "function", group: 1 },
		{ re: /^\s*class\s+([A-Za-z_]\w*)/, kind: "class", group: 1 },
		{ re: /^([A-Z_][A-Z0-9_]*)\s*=/, kind: "const", group: 1 },
	],
	go: [
		{ re: /^func\s+\([^)]*\)\s*([A-Za-z_]\w*)/, kind: "method", group: 1 },
		{ re: /^func\s+([A-Za-z_]\w*)/, kind: "function", group: 1 },
		{ re: /^type\s+([A-Za-z_]\w*)/, kind: "type", group: 1 },
	],
	rust: [
		{
			re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?fn\s+([A-Za-z_]\w*)/,
			kind: "function",
			group: 1,
		},
		{ re: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/, kind: "class", group: 1 },
		{ re: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/, kind: "enum", group: 1 },
		{ re: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/, kind: "interface", group: 1 },
		{ re: /^\s*(?:pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_]\w*)/, kind: "type", group: 1 },
		{ re: /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)/, kind: "module", group: 1 },
	],
	java: [
		{
			re: /^\s*(?:public\s+|private\s+|protected\s+|abstract\s+|final\s+|static\s+)*(?:class|record)\s+([A-Za-z_]\w*)/,
			kind: "class",
			group: 1,
		},
		{ re: /^\s*(?:public\s+|private\s+|protected\s+)*interface\s+([A-Za-z_]\w*)/, kind: "interface", group: 1 },
		{ re: /^\s*(?:public\s+|private\s+|protected\s+)*enum\s+([A-Za-z_]\w*)/, kind: "enum", group: 1 },
		{
			re: /^\s+(?:public\s+|private\s+|protected\s+|static\s+|final\s+|synchronized\s+|abstract\s+)+[\w<>[\], ?]+\s+([a-zA-Z_]\w*)\s*\(/,
			kind: "method",
			group: 1,
		},
	],
	ruby: [
		{ re: /^\s*class\s+([A-Z]\w*)/, kind: "class", group: 1 },
		{ re: /^\s*module\s+([A-Z]\w*)/, kind: "module", group: 1 },
		{ re: /^\s*def\s+(?:self\.)?([a-zA-Z_]\w*[?!=]?)/, kind: "method", group: 1 },
	],
	c_sharp: [
		{
			re: /^\s*(?:public\s+|internal\s+|private\s+|static\s+|sealed\s+|abstract\s+|partial\s+)*(?:class|struct|record)\s+([A-Za-z_]\w*)/,
			kind: "class",
			group: 1,
		},
		{ re: /^\s*(?:public\s+|internal\s+)*interface\s+([A-Za-z_]\w*)/, kind: "interface", group: 1 },
	],
	c: [
		{
			re: /^(?:static\s+|inline\s+|extern\s+)*[A-Za-z_][\w\s*]*?\b([A-Za-z_]\w*)\s*\([^;]*$/,
			kind: "function",
			group: 1,
		},
	],
	cpp: [
		{ re: /^\s*(?:class|struct)\s+([A-Za-z_]\w*)/, kind: "class", group: 1 },
		{
			re: /^(?:static\s+|inline\s+|virtual\s+)*[A-Za-z_][\w:<>\s*&]*?\b([A-Za-z_]\w*)\s*\([^;]*$/,
			kind: "function",
			group: 1,
		},
	],
	php: [
		{ re: /^\s*(?:abstract\s+|final\s+)?class\s+([A-Za-z_]\w*)/, kind: "class", group: 1 },
		{
			re: /^\s*(?:public\s+|private\s+|protected\s+|static\s+)*function\s+([A-Za-z_]\w*)/,
			kind: "function",
			group: 1,
		},
	],
	kotlin: [
		{ re: /^\s*(?:data\s+|sealed\s+|open\s+|abstract\s+)?class\s+([A-Za-z_]\w*)/, kind: "class", group: 1 },
		{
			re: /^\s*(?:private\s+|public\s+|internal\s+|override\s+|suspend\s+)*fun\s+(?:<[^>]*>\s*)?([A-Za-z_]\w*)/,
			kind: "function",
			group: 1,
		},
		{ re: /^\s*interface\s+([A-Za-z_]\w*)/, kind: "interface", group: 1 },
	],
	swift: [
		{
			re: /^\s*(?:public\s+|private\s+|final\s+)*(?:class|struct|enum|protocol)\s+([A-Za-z_]\w*)/,
			kind: "class",
			group: 1,
		},
		{ re: /^\s*(?:public\s+|private\s+|static\s+|override\s+)*func\s+([A-Za-z_]\w*)/, kind: "function", group: 1 },
	],
	lua: [{ re: /^\s*(?:local\s+)?function\s+([A-Za-z_][\w.:]*)/, kind: "function", group: 1 }],
	shell: [{ re: /^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{?/, kind: "function", group: 1 }],
};

const KEYWORDS = new Set([
	"if",
	"for",
	"while",
	"switch",
	"catch",
	"return",
	"function",
	"constructor",
	"else",
	"new",
	"typeof",
	"await",
]);

const IDENT = /[A-Za-z_$][\w$]{2,}/g;

export function regexTags(language: LanguageId, source: string): FileTags {
	const rules = RULES[language] ?? [];
	const defs: DefTag[] = [];
	const lines = source.split("\n");
	let currentClass: { name: string; indent: number } | undefined;
	for (const [index, line] of lines.entries()) {
		if (line.length > 400) continue;
		const indent = line.length - line.trimStart().length;
		if (currentClass && line.trim() !== "" && indent <= currentClass.indent && !/^\s*[}\])]/.test(line))
			currentClass = undefined;
		for (const rule of rules) {
			const match = rule.re.exec(line);
			if (!match) continue;
			const name = match[rule.group]!;
			if (KEYWORDS.has(name)) break;
			const kind: SymbolKind =
				rule.kind === "function" && currentClass && indent > currentClass.indent ? "method" : rule.kind;
			if (kind === "method" && !currentClass && rule.kind === "method" && language !== "go" && language !== "ruby")
				break;
			defs.push({
				name,
				kind,
				line: index + 1,
				signature: oneLine(line.replace(/[\s{:]+$/, "")),
				...(kind === "method" && currentClass ? { container: currentClass.name } : {}),
			});
			if (kind === "class" || kind === "interface" || kind === "module") currentClass = { name, indent };
			break;
		}
	}
	const refs: Record<string, number> = {};
	let count = 0;
	const defLines = new Set(defs.map((def) => def.line));
	for (const [index, line] of lines.entries()) {
		if (defLines.has(index + 1) || line.length > 400) continue;
		for (const match of line.matchAll(IDENT)) {
			if (count >= MAX_REFS_PER_FILE) break;
			refs[match[0]] = (refs[match[0]] ?? 0) + 1;
			count++;
		}
	}
	return { defs, refs, parser: "regex" };
}

/** Tags of one file: tree-sitter when available for the language, else the regex fallback. */
export async function extractTags(language: LanguageId, source: string): Promise<FileTags> {
	try {
		const tags = await treeSitterTags(language, source);
		if (tags) return tags;
	} catch {
		// fall back
	}
	return regexTags(language, source);
}
