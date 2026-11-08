import { type RunResult, SCRIPTS } from "../src/music";

/** 가짜 osascript: Music 앱 상태를 흉내 */
export function fakeMusic(init: { running?: boolean; state?: string; track?: string; artist?: string; album?: string; denied?: boolean; noArt?: boolean } = {}) {
	const app = { running: true, state: "paused", track: "Song A", artist: "Artist A", album: "Album A", denied: false, noArt: false, ...init };
	let artLoads = 0;
	const calls: string[] = [];
	let opened = 0;
	const runner = async (script: string): Promise<RunResult> => {
		const kind = Object.entries(SCRIPTS).find(([, s]) => s === script)?.[0] ?? "?";
		calls.push(kind);
		if (!app.running) return { ok: true, out: "off\n" };
		if (app.denied) return { ok: false, error: "execution error: Not authorized to send Apple events to Music. (-1743)" };
		if (kind === "status") return { ok: true, out: `${app.state}\t${app.track}\t${app.artist}\t${app.album}\n` };
		if (kind === "playpause") app.state = app.state === "playing" ? "paused" : "playing";
		if (kind === "next") app.track = "Song B";
		if (kind === "previous") app.track = "Song Z";
		return { ok: true, out: "ok\n" };
	};
	const opener = async () => {
		opened++;
		app.running = true;
	};
	/** 가짜 앨범 표지: 곡 이름이 들어간 data URL */
	const artLoader = async () => {
		artLoads++;
		return app.noArt ? null : `data:image/png;base64,${Buffer.from(app.track).toString("base64")}`;
	};
	return { app, calls, runner, opener, artLoader, opened: () => opened, artLoads: () => artLoads };
}
