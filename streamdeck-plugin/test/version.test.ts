import { describe, expect, it } from "vitest";

import { isCompatible, parseVersion } from "../src/bridge/version";

describe("버전과 호환 (docs/STREAMDECK.md)", () => {
	it("버전 읽기", () => {
		expect(parseVersion("2.0.3")).toEqual([2, 0, 3]);
		expect(parseVersion("v2.1")).toEqual([2, 1, 0]);
		expect(parseVersion("2.0.0-beta")).toEqual([2, 0, 0]);
		expect(parseVersion("빌드 12")).toBeNull();
		expect(parseVersion(undefined)).toBeNull();
	});

	it("protocol 1 + 앱 2.0.0 이상이면 맞음", () => {
		expect(isCompatible({ protocol: 1, version: "2.0.0" })).toBe(true);
		expect(isCompatible({ protocol: 1, version: "2.3.17" })).toBe(true);
		expect(isCompatible({ protocol: 1, version: "3.0.0" })).toBe(true);
	});

	it("protocol 이 다르면 안 맞음", () => {
		expect(isCompatible({ protocol: 2, version: "3.0.0" })).toBe(false);
		expect(isCompatible({ version: "2.0.0" })).toBe(false);
	});

	it("2.0.0 보다 낮은 (스트림덱 이전) 앱은 안 맞음", () => {
		expect(isCompatible({ protocol: 1, version: "1.5.0" })).toBe(false);
	});
});
