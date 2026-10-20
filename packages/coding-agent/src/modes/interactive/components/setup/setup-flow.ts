/**
 * Step order and navigation for the setup wizard, kept free of rendering and I/O so it can be tested
 * on its own.
 *
 * The order follows what each choice depends on: the key (it lists the models), then how models are
 * picked (auto with a mode, or one manual model with its thinking level), then the classifier key, but
 * only when auto routing or auto permissions need one, then permissions, theme, the review and a short
 * "done" screen. Steps that need no decision are left out by the `include` rule, which the wizard
 * evaluates live, so the indicator and next/back follow the choices made so far.
 *
 * From the review any step can be reopened; finishing or backing out of a reopened step returns to the
 * review instead of walking on.
 */

export type SetupStepId = "welcome" | "key" | "model" | "router" | "permissions" | "theme" | "summary" | "done";

/** Every step in order. Which ones show is decided by SetupFlowOptions. */
export const SETUP_STEP_ORDER: readonly SetupStepId[] = [
	"welcome",
	"key",
	"model",
	"router",
	"permissions",
	"theme",
	"summary",
	"done",
];

export type IndicatorStep = Exclude<SetupStepId, "welcome" | "done">;
export type EditableStep = Exclude<SetupStepId, "welcome" | "summary" | "done">;

/** Steps named in the step indicator. The welcome and done screens are not steps. */
export const SETUP_STEP_LABELS: Record<IndicatorStep, string> = {
	key: "Key",
	model: "Model",
	router: "Classifier",
	permissions: "Permissions",
	theme: "Theme",
	summary: "Review",
};

export interface SetupFlowOptions {
	/** Start on the welcome screen (first run and `runkiln setup`). Default true. */
	welcome?: boolean;
	/** Offer the theme step (only when there is more than one theme). Default true. */
	theme?: boolean;
	/** End on the "done" screen after the review (fullscreen). Default false. */
	done?: boolean;
	/**
	 * Whether a conditional step is needed right now (the classifier step). Called on every move, so the
	 * answer may change as choices are made. Default: every step is needed.
	 */
	include?: (step: SetupStepId) => boolean;
}

export type BackResult = "moved" | "quit";

export type StepState = "done" | "current" | "upcoming";

export class SetupFlow {
	/** Steps this flow can show at all (before the live `include` rule). */
	private readonly candidates: readonly SetupStepId[];
	private readonly include: (step: SetupStepId) => boolean;
	private currentStep: SetupStepId;
	/** Set while a step was opened from the review. */
	private editing = false;
	/** Furthest step reached (by order), so the indicator marks earlier steps as done. */
	private furthest = 0;

	constructor(options: SetupFlowOptions = {}) {
		this.candidates = SETUP_STEP_ORDER.filter((step) => {
			if (step === "welcome") return options.welcome ?? true;
			if (step === "theme") return options.theme ?? true;
			if (step === "done") return options.done ?? false;
			return true;
		});
		this.include = options.include ?? (() => true);
		this.currentStep = this.candidates[0] ?? "summary";
	}

	/** The steps that show right now, in order. The current step always counts. */
	get steps(): SetupStepId[] {
		return this.candidates.filter((step) => step === this.currentStep || this.include(step));
	}

	get current(): SetupStepId {
		return this.currentStep;
	}

	/** True while a step was reopened from the review. */
	get isEditing(): boolean {
		return this.editing;
	}

	/** Steps shown in the indicator (everything but welcome and done). */
	get indicatorSteps(): IndicatorStep[] {
		return this.steps.filter((step): step is IndicatorStep => step !== "welcome" && step !== "done");
	}

	/** 1-based position among the indicator steps; 0 on the welcome and done screens. */
	get position(): number {
		const current = this.currentStep;
		if (current === "welcome" || current === "done") return 0;
		return this.indicatorSteps.indexOf(current) + 1;
	}

	get total(): number {
		return this.indicatorSteps.length;
	}

	private rank(step: SetupStepId): number {
		return SETUP_STEP_ORDER.indexOf(step);
	}

	stateOf(step: SetupStepId): StepState {
		if (step === this.currentStep) return "current";
		return this.rank(step) <= this.furthest ? "done" : "upcoming";
	}

	private moveTo(step: SetupStepId): SetupStepId {
		this.currentStep = step;
		this.furthest = Math.max(this.furthest, this.rank(step));
		return step;
	}

	/** Advance: the next needed step, or back to the review when the step was reopened from it. */
	next(): SetupStepId {
		if (this.editing) {
			this.editing = false;
			return this.moveTo("summary");
		}
		const here = this.rank(this.currentStep);
		const next = this.steps.find((step) => this.rank(step) > here);
		return next ? this.moveTo(next) : this.currentStep;
	}

	/** Go back one needed step. On the first screen there is nowhere to go: the caller asks to quit. */
	back(): BackResult {
		if (this.editing) {
			this.editing = false;
			this.currentStep = "summary";
			return "moved";
		}
		if (this.currentStep === "done") return "quit";
		const here = this.rank(this.currentStep);
		const previous = this.steps.filter((step) => this.rank(step) < here).at(-1);
		if (!previous) return "quit";
		this.currentStep = previous;
		return "moved";
	}

	/** Reopen a step from the review (also a step the `include` rule left out, like the classifier). */
	edit(step: EditableStep): void {
		if (!this.candidates.includes(step)) return;
		this.editing = true;
		this.currentStep = step;
	}

	/**
	 * Jump to an earlier step without the review's return rule, e.g. from permissions to the classifier
	 * when auto permissions need a key. A reopened step stays reopened, so it still ends on the review.
	 */
	jump(step: SetupStepId): void {
		if (!this.candidates.includes(step)) return;
		this.currentStep = step;
	}
}
