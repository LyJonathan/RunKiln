/**
 * OSC 133 semantic zones in rendered lines. Components start a zone with `133;A` and close it with `133;B` and
 * `133;C`; the fullscreen renderer strips them before writing and uses them to jump between messages. A user prompt
 * starts its zone with `USER_PROMPT_ZONE_START` (an `A` with an `rk=prompt` option, which terminals ignore), so the
 * fullscreen renderer can pin the last prompt above the viewport.
 */
export const USER_PROMPT_ZONE_START = "\x1b]133;A;rk=prompt\x07";

/** Any run of zone marks at the start of a line, options included. */
export const OSC133_ZONE_PREFIX = /^(?:\x1b\]133;[ABC](?:;[^\x07\x1b]*)?(?:\x07|\x1b\\))+/;

/** A line that starts a zone (a message). */
export const OSC133_PROMPT_START = /^\x1b\]133;A(?:;[^\x07\x1b]*)?(?:\x07|\x1b\\)/;

/** A line that starts a user prompt zone. */
export const OSC133_USER_PROMPT_START = /^\x1b\]133;A;(?:[^\x07\x1b]*;)?rk=prompt(?:;[^\x07\x1b]*)?(?:\x07|\x1b\\)/;
