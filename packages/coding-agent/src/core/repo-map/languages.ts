/**
 * Languages the repo map understands: file extensions, the tree-sitter grammar (from @vscode/tree-sitter-wasm) and
 * tag queries in the style of Aider's `tags.scm`: `@def.<kind>` captures a definition's name, `@ref` a reference.
 * Each pattern is compiled on its own, so one a grammar version does not know is dropped instead of failing the
 * language. Languages without a grammar use the regex fallback in tags.ts.
 */

export type LanguageId =
	| "typescript"
	| "tsx"
	| "javascript"
	| "python"
	| "go"
	| "rust"
	| "java"
	| "ruby"
	| "c_sharp"
	| "cpp"
	| "php"
	| "c"
	| "kotlin"
	| "swift"
	| "lua"
	| "shell";

export interface LanguageSpec {
	id: LanguageId;
	/** Grammar file in @vscode/tree-sitter-wasm/wasm, when there is one. */
	wasm?: string;
	/** Tree-sitter tag patterns, one per entry. `@ref.member` (a method call on an object) counts a quarter. */
	patterns: readonly string[];
}

const EXTENSIONS: Record<string, LanguageId> = {
	".ts": "typescript",
	".mts": "typescript",
	".cts": "typescript",
	".tsx": "tsx",
	".js": "javascript",
	".jsx": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".py": "python",
	".pyi": "python",
	".go": "go",
	".rs": "rust",
	".java": "java",
	".rb": "ruby",
	".cs": "c_sharp",
	".cc": "cpp",
	".cpp": "cpp",
	".cxx": "cpp",
	".hpp": "cpp",
	".hh": "cpp",
	".h": "c",
	".c": "c",
	".php": "php",
	".kt": "kotlin",
	".kts": "kotlin",
	".swift": "swift",
	".lua": "lua",
	".sh": "shell",
	".bash": "shell",
};

export function languageForPath(path: string): LanguageId | undefined {
	const dot = path.lastIndexOf(".");
	if (dot < 0 || dot < path.lastIndexOf("/")) return undefined;
	return EXTENSIONS[path.slice(dot).toLowerCase()];
}

const TS_PATTERNS = [
	"(function_declaration name: (identifier) @def.function)",
	"(generator_function_declaration name: (identifier) @def.function)",
	"(class_declaration name: (type_identifier) @def.class)",
	"(abstract_class_declaration name: (type_identifier) @def.class)",
	"(method_definition name: (property_identifier) @def.method)",
	"(abstract_method_signature name: (property_identifier) @def.method)",
	"(interface_declaration name: (type_identifier) @def.interface)",
	"(type_alias_declaration name: (type_identifier) @def.type)",
	"(enum_declaration name: (identifier) @def.enum)",
	"(program (lexical_declaration (variable_declarator name: (identifier) @def.const)))",
	"(program (export_statement (lexical_declaration (variable_declarator name: (identifier) @def.const))))",
	"(call_expression function: (identifier) @ref)",
	"(call_expression function: (member_expression property: (property_identifier) @ref.member))",
	"(new_expression constructor: (identifier) @ref)",
	"(import_specifier name: (identifier) @ref)",
	"(type_identifier) @ref",
	"(extends_clause value: (identifier) @ref)",
];

const JS_PATTERNS = [
	"(function_declaration name: (identifier) @def.function)",
	"(generator_function_declaration name: (identifier) @def.function)",
	"(class_declaration name: (identifier) @def.class)",
	"(method_definition name: (property_identifier) @def.method)",
	"(program (lexical_declaration (variable_declarator name: (identifier) @def.const)))",
	"(program (export_statement (lexical_declaration (variable_declarator name: (identifier) @def.const))))",
	"(call_expression function: (identifier) @ref)",
	"(call_expression function: (member_expression property: (property_identifier) @ref.member))",
	"(new_expression constructor: (identifier) @ref)",
	"(import_specifier name: (identifier) @ref)",
	"(class_heritage (identifier) @ref)",
];

const SPECS: Record<LanguageId, LanguageSpec> = {
	typescript: { id: "typescript", wasm: "tree-sitter-typescript.wasm", patterns: TS_PATTERNS },
	tsx: { id: "tsx", wasm: "tree-sitter-tsx.wasm", patterns: TS_PATTERNS },
	javascript: { id: "javascript", wasm: "tree-sitter-javascript.wasm", patterns: JS_PATTERNS },
	python: {
		id: "python",
		wasm: "tree-sitter-python.wasm",
		patterns: [
			"(class_definition name: (identifier) @def.class)",
			"(function_definition name: (identifier) @def.function)",
			"(module (expression_statement (assignment left: (identifier) @def.const)))",
			"(call function: (identifier) @ref)",
			"(call function: (attribute attribute: (identifier) @ref.member))",
			"(import_from_statement name: (dotted_name (identifier) @ref))",
			"(argument_list (identifier) @ref)",
		],
	},
	go: {
		id: "go",
		wasm: "tree-sitter-go.wasm",
		patterns: [
			"(function_declaration name: (identifier) @def.function)",
			"(method_declaration name: (field_identifier) @def.method)",
			"(type_spec name: (type_identifier) @def.type)",
			"(source_file (const_declaration (const_spec name: (identifier) @def.const)))",
			"(call_expression function: (identifier) @ref)",
			"(call_expression function: (selector_expression field: (field_identifier) @ref.member))",
			"(type_identifier) @ref",
		],
	},
	rust: {
		id: "rust",
		wasm: "tree-sitter-rust.wasm",
		patterns: [
			"(function_item name: (identifier) @def.function)",
			"(function_signature_item name: (identifier) @def.function)",
			"(struct_item name: (type_identifier) @def.class)",
			"(enum_item name: (type_identifier) @def.enum)",
			"(trait_item name: (type_identifier) @def.interface)",
			"(type_item name: (type_identifier) @def.type)",
			"(mod_item name: (identifier) @def.module)",
			"(macro_definition name: (identifier) @def.macro)",
			"(const_item name: (identifier) @def.const)",
			"(call_expression function: (identifier) @ref)",
			"(call_expression function: (field_expression field: (field_identifier) @ref.member))",
			"(call_expression function: (scoped_identifier name: (identifier) @ref))",
			"(macro_invocation macro: (identifier) @ref)",
			"(type_identifier) @ref",
		],
	},
	java: {
		id: "java",
		wasm: "tree-sitter-java.wasm",
		patterns: [
			"(class_declaration name: (identifier) @def.class)",
			"(interface_declaration name: (identifier) @def.interface)",
			"(enum_declaration name: (identifier) @def.enum)",
			"(record_declaration name: (identifier) @def.class)",
			"(method_declaration name: (identifier) @def.method)",
			"(constructor_declaration name: (identifier) @def.method)",
			"(method_invocation name: (identifier) @ref)",
			"(object_creation_expression type: (type_identifier) @ref)",
			"(type_identifier) @ref",
		],
	},
	ruby: {
		id: "ruby",
		wasm: "tree-sitter-ruby.wasm",
		patterns: [
			"(class name: (constant) @def.class)",
			"(module name: (constant) @def.module)",
			"(method name: (identifier) @def.method)",
			"(singleton_method name: (identifier) @def.method)",
			"(call method: (identifier) @ref)",
			"(constant) @ref",
		],
	},
	c_sharp: {
		id: "c_sharp",
		wasm: "tree-sitter-c-sharp.wasm",
		patterns: [
			"(class_declaration name: (identifier) @def.class)",
			"(interface_declaration name: (identifier) @def.interface)",
			"(struct_declaration name: (identifier) @def.class)",
			"(enum_declaration name: (identifier) @def.enum)",
			"(record_declaration name: (identifier) @def.class)",
			"(method_declaration name: (identifier) @def.method)",
			"(invocation_expression function: (identifier) @ref)",
			"(invocation_expression function: (member_access_expression name: (identifier) @ref.member))",
			"(object_creation_expression type: (identifier) @ref)",
		],
	},
	cpp: {
		id: "cpp",
		wasm: "tree-sitter-cpp.wasm",
		patterns: [
			"(function_definition declarator: (function_declarator declarator: (identifier) @def.function))",
			"(function_definition declarator: (function_declarator declarator: (field_identifier) @def.method))",
			"(class_specifier name: (type_identifier) @def.class)",
			"(struct_specifier name: (type_identifier) @def.class)",
			"(call_expression function: (identifier) @ref)",
			"(call_expression function: (field_expression field: (field_identifier) @ref.member))",
			"(type_identifier) @ref",
		],
	},
	php: {
		id: "php",
		wasm: "tree-sitter-php.wasm",
		patterns: [
			"(class_declaration name: (name) @def.class)",
			"(interface_declaration name: (name) @def.interface)",
			"(function_definition name: (name) @def.function)",
			"(method_declaration name: (name) @def.method)",
			"(function_call_expression function: (name) @ref)",
			"(member_call_expression name: (name) @ref.member)",
			"(object_creation_expression (name) @ref)",
		],
	},
	// Regex fallback only.
	c: { id: "c", patterns: [] },
	kotlin: { id: "kotlin", patterns: [] },
	swift: { id: "swift", patterns: [] },
	lua: { id: "lua", patterns: [] },
	shell: { id: "shell", wasm: undefined, patterns: [] },
};

export function languageSpec(id: LanguageId): LanguageSpec {
	return SPECS[id];
}
