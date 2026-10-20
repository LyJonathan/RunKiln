/**
 * Reduced motion: no spinners or animations, static indicators instead. Set from the `ui.reducedMotion` setting;
 * components read it when they start animating and on every frame, so a change applies to running indicators too.
 */
let reducedMotion = false;

export function setReducedMotion(enabled: boolean): void {
	reducedMotion = enabled;
}

export function isReducedMotion(): boolean {
	return reducedMotion;
}

/** The static indicator shown instead of a spinner. */
export const STATIC_INDICATOR = "●";
