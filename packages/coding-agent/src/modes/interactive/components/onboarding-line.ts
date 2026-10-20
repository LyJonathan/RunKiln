/**
 * The startup header's onboarding line. It replaces the upstream "Pi can explain its own features and
 * look up its docs" hint: RunKiln ships no self-docs to the model, so the line points at what RunKiln
 * does have (auto routing, the mode-cycle key, /router) instead of promising self-documentation.
 */
export function runkilnOnboardingLine(modeCycleKey: string): string {
	const cycle = modeCycleKey
		? `${modeCycleKey} cycles auto:low/medium/high`
		: "/router low|medium|high switches modes";
	return `RunKiln picks the model and thinking for each turn: ${cycle}, /router shows why.`;
}
