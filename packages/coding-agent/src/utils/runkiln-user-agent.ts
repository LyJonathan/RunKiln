export function getRunKilnUserAgent(version: string): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `runkiln/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}
