import { type RunResult, SCRIPTS } from "../src/music";

/** 가짜 osascript: Music 앱 상태를 흉내 */
export function fakeMusic(init: { running?: boolean; state?: string; track?: string; artist?: string; denied?: boolean } = {}) {
	const app = { running: true, state: "paused", track: "밤양갱", artist: "비비", denied: false, ...init };
	const calls: string[] = [];
	let opened = 0;
	const runner = async (script: string): Promise<RunResult> => {
		const kind = Object.entries(SCRIPTS).find(([, s]) => s === script)?.[0] ?? "?";
		calls.push(kind);
		if (!app.running) return { ok: true, out: "off\n" };
		if (app.denied) return { ok: false, error: "execution error: Not authorized to send Apple events to Music. (-1743)" };
		if (kind === "status") return { ok: true, out: `${app.state}\t${app.track}\t${app.artist}\n` };
		if (kind === "playpause") app.state = app.state === "playing" ? "paused" : "playing";
		if (kind === "next") app.track = "다음 곡";
		if (kind === "previous") app.track = "이전 곡";
		return { ok: true, out: "ok\n" };
	};
	const opener = async () => {
		opened++;
		app.running = true;
	};
	return { app, calls, runner, opener, opened: () => opened };
}
