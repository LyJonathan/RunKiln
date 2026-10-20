#!/usr/bin/env node

// Builds standalone runkiln executables (Node single executable applications) into dist/binaries:
//
//   runkiln-win-x64.exe  runkiln-linux-x64  runkiln-linux-arm64  runkiln-darwin-arm64  runkiln-darwin-x64
//
// Each one is the official Node binary for its platform with the coding-agent package injected as an
// asset (scripts/sea/launcher.cjs unpacks it on first run). Every target builds from any host: the
// SEA blob holds no code cache, so it is platform independent.
//
//   node scripts/build-binaries.mjs [--no-build] [--targets linux-x64,win-x64] [--node 22.23.3]
//
// macOS: the Node binary is signed, and injecting invalidates that signature. On a macOS host the
// script re-signs ad hoc with codesign; elsewhere it uses rcodesign when it is on PATH, and otherwise
// leaves the darwin binaries unsigned (they then need `codesign --sign - <file>` on a Mac to run).
// Windows: the injected node.exe keeps no valid Authenticode signature (SmartScreen may warn).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const require = createRequire(import.meta.url);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = join(repoRoot, "packages", "coding-agent");
const outDir = join(repoRoot, "dist", "binaries");
const workDir = join(repoRoot, "dist", "binaries-work");

const ALL_TARGETS = ["win-x64", "linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64"];
// Pinned Node release the executables embed. It must also run the blob generation (same version).
const DEFAULT_NODE = "22.23.3";
const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

function arg(name) {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
}
const nodeVersion = (arg("--node") ?? process.env.RUNKILN_SEA_NODE ?? DEFAULT_NODE).replace(/^v/, "");
const targets = (arg("--targets") ?? ALL_TARGETS.join(",")).split(",").filter(Boolean);
for (const target of targets) {
	if (!ALL_TARGETS.includes(target)) throw new Error(`Unknown target ${target} (known: ${ALL_TARGETS.join(", ")})`);
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { stdio: "inherit", ...options });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
	return result;
}

function runQuiet(command, args) {
	const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		process.stderr.write(`${result.stdout}${result.stderr}`);
		throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
	}
}

function hasCommand(command) {
	const result = spawnSync(process.platform === "win32" ? "where" : "which", [command], { stdio: "ignore" });
	return result.status === 0;
}

// ---------------------------------------------------------------------------------------------------
// 1. The package payload: the same files the npm package runs from, bundle only.
// ---------------------------------------------------------------------------------------------------

function walk(dir, base = dir, out = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) walk(full, base, out);
		else if (entry.isFile()) out.push(relative(base, full).split("\\").join("/"));
	}
	return out;
}

function resolvePackageDir(name) {
	return dirname(require.resolve(`${name}/package.json`, { paths: [agentDir] }));
}

function collectPayload() {
	const agentPkg = JSON.parse(readFileSync(join(agentDir, "package.json"), "utf8"));
	const files = []; // { p: path inside the payload, src?: file, data?: Buffer }
	const addFile = (p, src) => files.push({ p, src });
	const addDir = (prefix, dir, filter = () => true) => {
		for (const rel of walk(dir)) if (filter(rel)) addFile(`${prefix}/${rel}`, join(dir, rel));
	};

	const bundle = join(agentDir, "dist", "bundle");
	if (!existsSync(join(bundle, "cli-runtime.js"))) {
		throw new Error("packages/coding-agent/dist/bundle is missing. Run `npm run build` first.");
	}
	const pkg = {
		name: agentPkg.name,
		version: agentPkg.version,
		type: "module",
		runkilnConfig: agentPkg.runkilnConfig,
		license: agentPkg.license,
	};
	files.push({ p: "package/package.json", data: Buffer.from(`${JSON.stringify(pkg, null, "\t")}\n`) });
	for (const name of ["README.md", "CHANGELOG.md", "LICENSE"]) addFile(`package/${name}`, join(agentDir, name));
	addFile("package/NOTICE.md", join(repoRoot, "NOTICE.md"));
	addDir("package/dist/bundle", bundle);
	addFile("package/dist/models.yaml", join(agentDir, "dist", "models.yaml"));
	addFile("package/dist/router.yaml", join(agentDir, "dist", "router.yaml"));
	addDir("package/dist/modes/interactive/theme", join(agentDir, "dist", "modes", "interactive", "theme"));
	addDir("package/dist/modes/interactive/assets", join(agentDir, "dist", "modes", "interactive", "assets"));
	addDir("package/dist/core/export-html", join(agentDir, "dist", "core", "export-html"));

	// Runtime packages the bundle resolves from disk: photon (external, wasm) and the tree-sitter grammars.
	for (const name of ["@silvia-odwyer/photon-node", "@vscode/tree-sitter-wasm"]) {
		addDir(`package/node_modules/${name}`, resolvePackageDir(name), (rel) => !rel.endsWith(".d.ts"));
	}
	// Clipboard and key-state helpers. The TUI looks for native/<platform>/prebuilds next to the bundle.
	const tuiNative = join(repoRoot, "packages", "tui", "native");
	for (const platform of ["win32", "linux", "darwin"]) {
		addDir(`package/dist/bundle/native/${platform}/prebuilds`, join(tuiNative, platform, "prebuilds"), (rel) =>
			rel.endsWith(".node"),
		);
	}
	return { files, version: agentPkg.version };
}

function packPayload(files) {
	const bodies = files.map((file) => file.data ?? readFileSync(file.src));
	const header = Buffer.from(
		JSON.stringify(
			files.map((file, i) => ({
				p: file.p,
				s: bodies[i].length,
				x: file.src ? (statSync(file.src).mode & 0o111) !== 0 : false,
			})),
		),
	);
	const length = Buffer.alloc(4);
	length.writeUInt32LE(header.length, 0);
	const raw = Buffer.concat([length, header, ...bodies]);
	return { gz: gzipSync(raw, { level: 9 }), rawBytes: raw.length };
}

// ---------------------------------------------------------------------------------------------------
// 2. Official Node binaries, cached and checked against SHASUMS256.txt.
// ---------------------------------------------------------------------------------------------------

const nodeCache = join(process.env.RUNKILN_SEA_CACHE ?? join(homedir(), ".cache", "runkiln-build"), `node-v${nodeVersion}`);

async function download(url) {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
	return Buffer.from(await response.arrayBuffer());
}

let shasums;
async function expectedSha(file) {
	shasums ??= (await download(`https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt`)).toString("utf8");
	const line = shasums.split("\n").find((l) => l.trim().endsWith(`  ${file}`));
	if (!line) throw new Error(`No checksum for ${file} in Node v${nodeVersion} SHASUMS256.txt`);
	return line.split(/\s+/)[0];
}

async function nodeBinary(target) {
	const exe = target.startsWith("win") ? "node.exe" : "node";
	const dest = join(nodeCache, target, exe);
	if (existsSync(dest)) return dest;
	mkdirSync(dirname(dest), { recursive: true });
	const remote = target.startsWith("win")
		? `${target}/node.exe`
		: `node-v${nodeVersion}-${target}.tar.gz`;
	console.log(`Downloading Node v${nodeVersion} ${target}`);
	const data = await download(`https://nodejs.org/dist/v${nodeVersion}/${remote}`);
	const sha = createHash("sha256").update(data).digest("hex");
	if (sha !== (await expectedSha(remote))) throw new Error(`Checksum mismatch for ${remote}`);
	if (target.startsWith("win")) {
		writeFileSync(dest, data);
	} else {
		const archive = join(nodeCache, `${target}.tar.gz`);
		writeFileSync(archive, data);
		const member = `node-v${nodeVersion}-${target}/bin/node`;
		run("tar", ["xzf", archive, "-C", join(nodeCache, target), "--strip-components=2", member]);
		rmSync(archive, { force: true });
		chmodSync(dest, 0o755);
	}
	return dest;
}

function hostTarget() {
	const os = process.platform === "win32" ? "win" : process.platform;
	return `${os}-${process.arch}`;
}

// ---------------------------------------------------------------------------------------------------
// 3. Build
// ---------------------------------------------------------------------------------------------------

async function main() {
	if (!process.argv.includes("--no-build")) run("npm", ["run", "build"], { cwd: repoRoot, shell: process.platform === "win32" });

	rmSync(workDir, { recursive: true, force: true });
	mkdirSync(workDir, { recursive: true });
	mkdirSync(outDir, { recursive: true });

	const { files, version } = collectPayload();
	const { gz, rawBytes } = packPayload(files);
	const hash = createHash("sha256").update(gz).digest("hex").slice(0, 12);
	writeFileSync(join(workDir, "payload.gz"), gz);
	writeFileSync(join(workDir, "meta.json"), JSON.stringify({ version, hash }));
	console.log(
		`Payload: ${files.length} files, ${(rawBytes / 1048576).toFixed(1)} MiB, ${(gz.length / 1048576).toFixed(1)} MiB gzipped`,
	);

	// The blob must come from the same Node version as the executables.
	const blobNode =
		process.version === `v${nodeVersion}` ? process.execPath : await nodeBinary(hostTarget());
	const seaConfig = {
		main: join(repoRoot, "scripts", "sea", "launcher.cjs"),
		output: join(workDir, "sea-prep.blob"),
		disableExperimentalSEAWarning: true,
		useSnapshot: false,
		useCodeCache: false,
		assets: { payload: join(workDir, "payload.gz"), "meta.json": join(workDir, "meta.json") },
	};
	writeFileSync(join(workDir, "sea-config.json"), JSON.stringify(seaConfig, null, 2));
	run(blobNode, ["--experimental-sea-config", join(workDir, "sea-config.json")]);
	const postjectCli = join(dirname(require.resolve("postject")), "cli.js");
	const signer =
		process.platform === "darwin" ? "codesign" : hasCommand("rcodesign") ? "rcodesign" : undefined;
	const unsigned = [];
	const built = [];
	for (const target of targets) {
		const node = await nodeBinary(target);
		const out = join(outDir, `runkiln-${target}${target.startsWith("win") ? ".exe" : ""}`);
		rmSync(out, { force: true });
		copyFileSync(node, out);
		chmodSync(out, 0o755);
		const darwin = target.startsWith("darwin");
		if (darwin && signer === "codesign") run("codesign", ["--remove-signature", out]);
		// One process per target: postject holds the whole executable in wasm memory and does not give it back.
		// Quiet: LIEF prints harmless "string offset" warnings for the ELF note sections.
		runQuiet(process.execPath, [
			postjectCli,
			out,
			"NODE_SEA_BLOB",
			seaConfig.output,
			"--sentinel-fuse",
			SEA_FUSE,
			...(darwin ? ["--macho-segment-name", "NODE_SEA"] : []),
			"--overwrite",
		]);
		if (darwin) {
			if (signer === "codesign") run("codesign", ["--sign", "-", out]);
			else if (signer === "rcodesign") run("rcodesign", ["sign", out]);
			else unsigned.push(out);
		}
		built.push(out);
		console.log(`Built ${relative(repoRoot, out)} (${(statSync(out).size / 1048576).toFixed(1)} MiB)`);
	}

	const sums = built
		.map((file) => `${createHash("sha256").update(readFileSync(file)).digest("hex")}  ${relative(outDir, file)}`)
		.join("\n");
	writeFileSync(join(outDir, "SHA256SUMS"), `${sums}\n`);
	rmSync(workDir, { recursive: true, force: true });
	if (unsigned.length > 0) {
		console.warn(
			`Not signed (no codesign or rcodesign on this host): ${unsigned.map((f) => relative(repoRoot, f)).join(", ")}. ` +
				"Run `codesign --sign - <file>` on a Mac before running them.",
		);
	}
}

await main();
