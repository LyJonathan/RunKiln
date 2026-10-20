// Entry point of the standalone runkiln executable (a Node single executable application).
//
// The executable carries the npm package (bundle, assets, wasm and native helpers) as one gzipped
// asset. The first run of a version unpacks it into a cache folder; later runs only check a marker
// file, then load the same bundle `npm i -g @runkiln/coding-agent` runs.
//
// Cache folder (override with RUNKILN_BINARY_CACHE):
//   Windows  %LOCALAPPDATA%\runkiln\bin
//   macOS    ~/Library/Caches/runkiln/bin
//   Linux    $XDG_CACHE_HOME/runkiln/bin, else ~/.cache/runkiln/bin
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const sea = require("node:sea");
const { createRequire, enableCompileCache } = require("node:module");

const PRUNE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

function cacheBase() {
	if (process.env.RUNKILN_BINARY_CACHE) return process.env.RUNKILN_BINARY_CACHE;
	const home = os.homedir();
	if (process.platform === "win32") {
		return path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "runkiln", "bin");
	}
	if (process.platform === "darwin") return path.join(home, "Library", "Caches", "runkiln", "bin");
	return path.join(process.env.XDG_CACHE_HOME || path.join(home, ".cache"), "runkiln", "bin");
}

/** Payload layout: u32 header length, JSON header [{p, s, x}], then the file bodies in order. */
function unpack(target) {
	const data = zlib.gunzipSync(Buffer.from(sea.getAsset("payload")));
	const headerLength = data.readUInt32LE(0);
	const files = JSON.parse(data.subarray(4, 4 + headerLength).toString("utf8"));
	let offset = 4 + headerLength;
	for (const file of files) {
		const dest = path.join(target, ...file.p.split("/"));
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.writeFileSync(dest, data.subarray(offset, offset + file.s), { mode: file.x ? 0o755 : 0o644 });
		offset += file.s;
	}
}

function prune(base, keep) {
	let entries;
	try {
		entries = fs.readdirSync(base);
	} catch {
		return;
	}
	const now = Date.now();
	for (const name of entries) {
		if (name === keep) continue;
		const dir = path.join(base, name);
		try {
			// Each run touches .complete, so its age is the time since this version last ran.
			const marker = path.join(dir, ".complete");
			const stamp = fs.existsSync(marker) ? fs.statSync(marker).mtimeMs : fs.statSync(dir).mtimeMs;
			if (now - stamp > PRUNE_AFTER_MS) fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// In use (Windows locks loaded .node files) or already gone.
		}
	}
}

function ensureUnpacked(base, name) {
	const dir = path.join(base, name);
	if (fs.existsSync(path.join(dir, ".complete"))) return dir;
	fs.mkdirSync(base, { recursive: true });
	const tmp = path.join(base, `.tmp-${name}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
	try {
		unpack(tmp);
		fs.writeFileSync(path.join(tmp, ".complete"), "");
		try {
			fs.renameSync(tmp, dir);
		} catch (error) {
			// Another process unpacked the same version first.
			if (!fs.existsSync(path.join(dir, ".complete"))) throw error;
		}
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
	prune(base, name);
	return dir;
}

function main() {
	const meta = JSON.parse(sea.getAsset("meta.json", "utf8"));
	const name = `${meta.version}-${meta.hash}`;
	let dir;
	try {
		dir = ensureUnpacked(cacheBase(), name);
	} catch (error) {
		if (process.env.RUNKILN_BINARY_CACHE) throw error;
		// Home cache not writable (read-only home, sandbox): use the temp folder.
		dir = ensureUnpacked(path.join(os.tmpdir(), `runkiln-bin-${os.userInfo().username}`), name);
	}
	try {
		const now = new Date();
		fs.utimesSync(path.join(dir, ".complete"), now, now);
	} catch {
		// Pruning only.
	}
	try {
		enableCompileCache(path.join(dir, ".compile-cache"));
	} catch {
		// Older runtimes or a read-only cache: start without it.
	}
	const bundle = path.join(dir, "package", "dist", "bundle");
	createRequire(path.join(bundle, "cli.js"))("./cli-runtime.js");
}

main();
