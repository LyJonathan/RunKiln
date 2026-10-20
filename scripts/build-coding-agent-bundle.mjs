#!/usr/bin/env node

// Bundles the built coding-agent (dist/) into dist/bundle: one ESM bundle for the CLI, SDK and
// RPC entries, plus the image-resize worker, which image-resize.ts loads by URL next to itself.

import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const codingAgentDir = join(repoRoot, "packages", "coding-agent");
const codingAgentDistDir = join(codingAgentDir, "dist");
const bundleDir = join(codingAgentDistDir, "bundle");
const banner = {
	js: 'import { createRequire as __rkCreateRequire } from "node:module"; const require = __rkCreateRequire(import.meta.url);',
};
const allowedExternalPackages = new Set([
	"@silvia-odwyer/photon-node",
	// Optional native accelerators. Their callers fall back to JavaScript when absent.
	"bufferutil",
	"utf-8-validate",
	// Optional debug output coloring.
	"supports-color",
]);

function commonBuildOptions() {
	return {
		absWorkingDir: repoRoot,
		banner,
		bundle: true,
		define: { RUNKILN_BUNDLED_NODE: "true" },
		external: ["@silvia-odwyer/photon-node"],
		format: "esm",
		legalComments: "none",
		logLevel: "warning",
		metafile: true,
		minifySyntax: true,
		minifyWhitespace: true,
		platform: "node",
		sourcemap: false,
		target: "node22.19",
		// Resolve the same package entries an installed package would, not the source aliases.
		tsconfigRaw: { compilerOptions: {} },
	};
}

function validateExternalImports(metafiles) {
	const unexpected = new Set();
	for (const metafile of metafiles) {
		for (const input of Object.values(metafile.inputs)) {
			for (const imported of input.imports) {
				if (!imported.external || isBuiltin(imported.path) || allowedExternalPackages.has(imported.path)) {
					continue;
				}
				unexpected.add(imported.path);
			}
		}
	}
	if (unexpected.size > 0) {
		throw new Error(`Bundle left unexpected external imports: ${Array.from(unexpected).sort().join(", ")}`);
	}
}

function findContainingOutput(metafile, inputSuffix) {
	const normalizedSuffix = inputSuffix.replaceAll("\\", "/");
	for (const [outputPath, output] of Object.entries(metafile.outputs)) {
		if (Object.keys(output.inputs).some((inputPath) => inputPath.replaceAll("\\", "/").endsWith(normalizedSuffix))) {
			return resolve(repoRoot, outputPath);
		}
	}
	throw new Error(`Could not locate bundled output containing ${inputSuffix}`);
}

function outputBytes(metafiles) {
	return metafiles.reduce(
		(total, metafile) => total + Object.values(metafile.outputs).reduce((subtotal, output) => subtotal + output.bytes, 0),
		0,
	);
}

for (const entry of [
	join(codingAgentDistDir, "cli.js"),
	join(codingAgentDistDir, "index.js"),
	join(codingAgentDistDir, "rpc-entry.js"),
	join(codingAgentDistDir, "utils", "image-resize-worker.js"),
]) {
	if (!existsSync(entry)) {
		throw new Error(`Bundle input is missing: ${relative(repoRoot, entry)}. Build the workspace packages first.`);
	}
}

rmSync(bundleDir, { force: true, recursive: true });
mkdirSync(bundleDir, { recursive: true });

const mainResult = await build({
	...commonBuildOptions(),
	entryNames: "[name]",
	entryPoints: {
		"cli-runtime": join(codingAgentDistDir, "cli.js"),
		index: join(codingAgentDistDir, "index.js"),
		"rpc-entry": join(codingAgentDistDir, "rpc-entry.js"),
	},
	outdir: bundleDir,
	chunkNames: "chunks/[name]-[hash]",
	splitting: true,
});

// image-resize.ts starts its worker from a URL relative to its own chunk.
const imageResizeOutput = findContainingOutput(mainResult.metafile, "packages/coding-agent/dist/utils/image-resize.js");
const workerResult = await build({
	...commonBuildOptions(),
	entryNames: "[name]",
	entryPoints: { "image-resize-worker": join(codingAgentDistDir, "utils", "image-resize-worker.js") },
	outdir: dirname(imageResizeOutput),
	splitting: false,
});

const metafiles = [mainResult.metafile, workerResult.metafile];
validateExternalImports(metafiles);

// models.yaml ships next to the bundle's package; the loader also finds dist/models.yaml.
copyFileSync(join(repoRoot, "models.yaml"), join(codingAgentDistDir, "models.yaml"));
// router.yaml (auto router catalog) ships the same way; users override it in ~/.runkiln/agent/router.yaml.
copyFileSync(join(repoRoot, "router.yaml"), join(codingAgentDistDir, "router.yaml"));

// Plain syntax and a namespace import, so an old Node prints the version message instead of a SyntaxError.
// npm turns this bin into runkiln.cmd / runkiln.ps1 shims on Windows; the shebang line is what they read.
const cliLauncher = `#!/usr/bin/env node
import nodeModule from "node:module";

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 19)) {
	console.error(
		"runkiln needs Node.js 22.19 or newer (this is " + process.version + "). Update Node, or use a standalone binary: https://github.com/LyJonathan/RunKiln/releases",
	);
	process.exit(1);
}
nodeModule.enableCompileCache?.();
nodeModule.createRequire(import.meta.url)("./cli-runtime.js");
`;
writeFileSync(join(bundleDir, "cli.js"), cliLauncher);
chmodSync(join(bundleDir, "cli.js"), 0o755);
chmodSync(join(bundleDir, "rpc-entry.js"), 0o755);

const files = new Set(metafiles.flatMap((metafile) => Object.keys(metafile.outputs))).size + 1;
const mib = (outputBytes(metafiles) + cliLauncher.length) / (1024 * 1024);
console.log(`Built ${relative(repoRoot, bundleDir)} (${files} files, ${mib.toFixed(1)} MiB)`);
