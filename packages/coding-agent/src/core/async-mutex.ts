/** Runs callers one at a time, in order (one approval prompt at a time while tool calls run in parallel). */
export class AsyncMutex {
	private tail: Promise<void> = Promise.resolve();
	private holders = 0;

	/** Runs `fn` once every earlier holder is done. */
	async run<T>(fn: () => Promise<T>): Promise<T> {
		let release!: () => void;
		const next = new Promise<void>((resolveNext) => {
			release = resolveNext;
		});
		const previous = this.tail;
		this.tail = previous.then(() => next);
		await previous;
		this.holders++;
		try {
			return await fn();
		} finally {
			this.holders--;
			release();
		}
	}

	get busy(): boolean {
		return this.holders > 0;
	}
}
