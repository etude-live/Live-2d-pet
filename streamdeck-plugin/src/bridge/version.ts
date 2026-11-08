// 앱과 플러그인이 서로 맞는지 (docs/STREAMDECK.md "버전과 호환")

/** 이 플러그인이 아는 브리지 규격 번호 */
export const PROTOCOL = 1;
/** 스트림덱과 맞는 첫 앱 버전 */
export const MIN_APP_VERSION = "2.0.0";

/** "v2.0.3" / "2.0" / "2.0.3-beta" → [2, 0, 3]. 못 읽으면 null */
export function parseVersion(v: unknown): [number, number, number] | null {
	if (typeof v !== "string") return null;
	const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v.trim());
	if (!m) return null;
	return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

export function compareVersions(a: [number, number, number], b: [number, number, number]): number {
	for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
	return 0;
}

/**
 * welcome 메시지를 보고 맞는지 판단.
 * - protocol 이 다르면 → 안 맞음 (앱이든 플러그인이든 업데이트 필요)
 * - 앱 버전이 2.0.0 보다 낮으면 → 안 맞음 (예전 build-N 앱은 명령이 모자람)
 * - 버전을 못 읽으면 protocol 만 보고 판단
 */
export function isCompatible(welcome: { protocol?: unknown; version?: unknown }): boolean {
	if (welcome.protocol !== PROTOCOL) return false;
	const v = parseVersion(welcome.version);
	const min = parseVersion(MIN_APP_VERSION)!;
	return v === null || compareVersions(v, min) >= 0;
}
