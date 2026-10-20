import { isReducedMotion, STATIC_INDICATOR } from "../motion.ts";
import type { TUI } from "../tui.ts";
import { Text } from "./text.ts";

export interface LoaderIndicatorOptions {
	/** Animation frames. Use an empty array to hide the indicator. */
	frames?: string[];
	/** Frame interval in milliseconds for animated indicators. */
	intervalMs?: number;
}

const DEFAULT_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DEFAULT_INTERVAL_MS = 80;

/**
 * Loader component that updates with an optional spinning animation. With reduced motion on it shows a static
 * indicator (the first custom frame, or ● for the default spinner) and never animates.
 */
export class Loader extends Text {
	private frames = [...DEFAULT_FRAMES];
	private intervalMs = DEFAULT_INTERVAL_MS;
	private currentFrame = 0;
	private intervalId: NodeJS.Timeout | null = null;
	private ui: TUI | null = null;
	private renderIndicatorVerbatim = false;
	private spinnerColorFn: (str: string) => string;
	private messageColorFn: (str: string) => string;
	private message: string = "Loading...";

	constructor(
		ui: TUI,
		spinnerColorFn: (str: string) => string,
		messageColorFn: (str: string) => string,
		message: string = "Loading...",
		indicator?: LoaderIndicatorOptions,
	) {
		super("", 1, 0);
		this.ui = ui;
		this.spinnerColorFn = spinnerColorFn;
		this.messageColorFn = messageColorFn;
		this.message = message;
		this.setIndicator(indicator);
	}

	render(width: number): string[] {
		return ["", ...super.render(width)];
	}

	start(): void {
		this.updateDisplay();
		this.restartAnimation();
	}

	stop(): void {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}

	setMessage(message: string): void {
		this.message = message;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	setIndicator(indicator?: LoaderIndicatorOptions): void {
		this.renderIndicatorVerbatim = indicator !== undefined;
		this.frames = indicator?.frames !== undefined ? [...indicator.frames] : [...DEFAULT_FRAMES];
		this.intervalMs = indicator?.intervalMs && indicator.intervalMs > 0 ? indicator.intervalMs : DEFAULT_INTERVAL_MS;
		this.currentFrame = 0;
		this.start();
	}

	private restartAnimation(): void {
		this.stop();
		if (this.frames.length <= 1 || isReducedMotion()) {
			return;
		}
		this.intervalId = setInterval(() => {
			if (isReducedMotion()) {
				// Turned on while animating: settle on the static indicator.
				this.stop();
				this.currentFrame = 0;
			} else {
				this.currentFrame = (this.currentFrame + 1) % this.frames.length;
			}
			this.updateDisplay();
		}, this.intervalMs);
	}

	protected getRenderedIndicator(): string {
		const reduced = isReducedMotion();
		const frame =
			reduced && !this.renderIndicatorVerbatim && this.frames.length > 1
				? STATIC_INDICATOR
				: (this.frames[reduced ? 0 : this.currentFrame] ?? "");
		return this.renderIndicatorVerbatim ? frame : this.spinnerColorFn(frame);
	}

	private updateDisplay(): void {
		const renderedFrame = this.getRenderedIndicator();
		const indicator = renderedFrame.length > 0 ? `${renderedFrame} ` : "";
		this.setText(`${indicator}${this.messageColorFn(this.message)}`);
		if (this.ui) {
			this.ui.requestRender();
		}
	}
}
