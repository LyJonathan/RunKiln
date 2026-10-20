import { describe, expect, it } from "vitest";
import {
	PARENT_SESSION_ID_HEADER,
	runInfraSessionHeaders,
	SESSION_ID_HEADER,
} from "../../../ai/src/api/runinfra-headers.ts";
import {
	backgroundSessionId,
	PARENT_SESSION_ID_ENV,
	resolveParentSessionId,
	SESSION_ID_ENV,
} from "../../src/core/runkiln/session-headers.ts";
import { titleCallRouting } from "../../src/core/runkiln/session-title.ts";

describe("session headers", () => {
	it("prefers an explicit parent id over the enclosing session", () => {
		expect(
			resolveParentSessionId({
				[PARENT_SESSION_ID_ENV]: " parent ",
				[SESSION_ID_ENV]: "shell",
			}),
		).toBe("parent");
		expect(resolveParentSessionId({ [SESSION_ID_ENV]: " shell " })).toBe("shell");
		expect(resolveParentSessionId({ [PARENT_SESSION_ID_ENV]: "  ", [SESSION_ID_ENV]: "" })).toBeUndefined();
	});

	it("sends one session id, and a parent id only when there is one", () => {
		expect(runInfraSessionHeaders("session-1")).toEqual({ [SESSION_ID_HEADER]: "session-1" });
		expect(runInfraSessionHeaders("session-1", "parent-1")).toEqual({
			[SESSION_ID_HEADER]: "session-1",
			[PARENT_SESSION_ID_HEADER]: "parent-1",
		});
		expect(runInfraSessionHeaders("  ", "  ")).toEqual({});
	});

	it("gives a title call its own session id and the main session as parent", () => {
		expect(backgroundSessionId("abc", "title")).toBe("abc.title");
		const routing = titleCallRouting("abc");
		expect(runInfraSessionHeaders(routing.sessionId, routing.parentSessionId)).toEqual({
			[SESSION_ID_HEADER]: "abc.title",
			[PARENT_SESSION_ID_HEADER]: "abc",
		});
	});
});
