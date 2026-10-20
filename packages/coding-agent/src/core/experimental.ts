export function areExperimentalFeaturesEnabled(): boolean {
	return process.env.RUNKILN_EXPERIMENTAL === "1";
}
