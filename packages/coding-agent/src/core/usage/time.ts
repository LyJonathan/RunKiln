/**
 * Wall-clock helpers for `/usage` and `runkiln usage`: turn times and day buckets in the user's time zone.
 *
 * The zone is `TZ` when it names a valid IANA zone, otherwise the zone `Intl` resolves for the process (the OS
 * setting), otherwise UTC. Every helper takes an explicit zone so tests and callers can pin one.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function isValidTimeZone(zone: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: zone });
		return true;
	} catch {
		return false;
	}
}

/** The user's IANA time zone: `TZ` if valid, else the OS zone as `Intl` resolves it, else `UTC`. */
export function resolveTimeZone(env: NodeJS.ProcessEnv = process.env): string {
	const fromEnv = env.TZ?.trim().replace(/^:/, "");
	if (fromEnv && !fromEnv.startsWith("/") && isValidTimeZone(fromEnv)) return fromEnv;
	try {
		const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
		if (zone && isValidTimeZone(zone)) return zone;
	} catch {
		// fall through
	}
	return "UTC";
}

function formatter(zone: string): Intl.DateTimeFormat {
	let cached = formatters.get(zone);
	if (!cached) {
		cached = new Intl.DateTimeFormat("en-US", {
			timeZone: zone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hourCycle: "h23",
		});
		formatters.set(zone, cached);
	}
	return cached;
}

interface ZonedParts {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
}

function zonedParts(ms: number, zone: string): ZonedParts {
	const parts: Record<string, number> = {};
	for (const part of formatter(zone).formatToParts(new Date(ms))) {
		if (part.type !== "literal") parts[part.type] = Number(part.value);
	}
	return {
		year: parts.year!,
		month: parts.month!,
		day: parts.day!,
		hour: parts.hour! % 24,
		minute: parts.minute!,
		second: parts.second!,
	};
}

const pad = (value: number) => String(value).padStart(2, "0");

/** Calendar day of `ms` in `zone`, `YYYY-MM-DD`. */
export function zonedDay(ms: number, zone: string = resolveTimeZone()): string {
	const p = zonedParts(ms, zone);
	return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** `HH:MM` of `ms` in `zone`, 24-hour. */
export function zonedClock(ms: number, zone: string = resolveTimeZone()): string {
	const p = zonedParts(ms, zone);
	return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** Offset of `zone` from UTC at `ms`, in ms (Paris in summer: +2 h). */
export function zoneOffsetMs(ms: number, zone: string): number {
	const p = zonedParts(ms, zone);
	const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
	return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The instant a wall-clock time happens in `zone` (the earlier one when DST repeats it). */
function zonedWallTime(year: number, month: number, day: number, zone: string): number {
	const wall = Date.UTC(year, month - 1, day);
	let guess = wall - zoneOffsetMs(wall, zone);
	// Re-check with the offset at the guess (DST boundaries).
	guess = wall - zoneOffsetMs(guess, zone);
	return guess;
}

/** Midnight that starts the `YYYY-MM-DD` day in `zone`. */
export function startOfZonedDayFromString(day: string, zone: string = resolveTimeZone()): number {
	const [year, month, date] = day.split("-").map(Number);
	return zonedWallTime(year!, month!, date!, zone);
}

/** Midnight that starts the day containing `ms` in `zone`. */
export function startOfZonedDay(ms: number, zone: string = resolveTimeZone()): number {
	return startOfZonedDayFromString(zonedDay(ms, zone), zone);
}

/** `YYYY-MM-DD` shifted by `days` calendar days. */
export function addDays(day: string, days: number): string {
	const [year, month, date] = day.split("-").map(Number);
	const shifted = new Date(Date.UTC(year!, month! - 1, date! + days));
	return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/** UTC offset of `zone` at `ms` as `±HH:MM` (Paris in summer: `+02:00`, UTC: `+00:00`). */
export function utcOffsetString(ms: number, zone: string = resolveTimeZone()): string {
	const minutes = Math.round(zoneOffsetMs(ms, zone) / 60_000);
	const sign = minutes < 0 ? "-" : "+";
	const abs = Math.abs(minutes);
	return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** ISO 8601 timestamp of `ms` in `zone` with its offset, e.g. `2026-10-17T00:30:00.000+02:00`. */
export function zonedIso(ms: number, zone: string = resolveTimeZone()): string {
	const p = zonedParts(ms, zone);
	const millis = String(((ms % 1000) + 1000) % 1000).padStart(3, "0");
	return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}.${millis}${utcOffsetString(ms, zone)}`;
}
