// Fails unless every workspace package's version equals the release tag (v0.1.0 -> 0.1.0).
import { readFileSync } from "node:fs";

const tag = process.argv[2] ?? "";
const version = tag.replace(/^v/, "");
const packages = ["agent", "ai", "coding-agent", "tui"];
const mismatched = packages
	.map((dir) => JSON.parse(readFileSync(`packages/${dir}/package.json`, "utf8")))
	.filter((pkg) => pkg.version !== version);

if (!version || mismatched.length > 0) {
	for (const pkg of mismatched) console.error(`${pkg.name} is ${pkg.version}, tag is ${tag}`);
	process.exit(1);
}
console.log(`All packages at ${version}`);
