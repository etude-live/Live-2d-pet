// Mac 의 Music 앱(Apple Music)을 AppleScript(osascript)로 조작·확인한다. Stream Deck SDK 와 무관.
//
// - 모든 스크립트는 `application "Music" is running` 을 먼저 본다 → Music 이 꺼져 있을 때 저절로 켜지지 않게.
// - 처음 조작할 때 macOS 가 "Stream Deck 이(가) Music 을 제어하려고 합니다" 하고 묻는다. 거절하면 -1743 오류 → "denied".
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";

export type PlayerState = "off" | "playing" | "paused" | "stopped" | "denied" | "error";

export interface MusicStatus {
	state: PlayerState;
	track?: string;
	artist?: string;
}

export type Command = "playpause" | "next" | "previous";

/** 실행 결과: 성공이면 출력, 실패면 오류 글 */
export type RunResult = { ok: true; out: string } | { ok: false; error: string };
export type Runner = (script: string) => Promise<RunResult>;
export type Opener = () => Promise<void>;

const ifRunning = (body: string) => `if application "Music" is running then
	tell application "Music"
		${body}
	end tell
	return "ok"
else
	return "off"
end if`;

export const SCRIPTS: Record<"status" | Command, string> = {
	status: `if application "Music" is running then
	tell application "Music"
		set playerState to player state as string
		set trackName to ""
		set trackArtist to ""
		try
			set trackName to name of current track
			set trackArtist to artist of current track
		end try
		return playerState & tab & trackName & tab & trackArtist
	end tell
else
	return "off"
end if`,
	playpause: ifRunning("playpause"),
	next: ifRunning("next track"),
	// back track: 곡 앞부분이면 이전 곡, 아니면 처음으로 (Music 앱의 ⏮ 와 같음)
	previous: ifRunning("back track")
};

/** 권한 거절 (errAEEventNotPermitted) */
export function isDenied(error: string): boolean {
	return /-1743|not authori[sz]ed|허용되지|권한/i.test(error);
}

/** 앱이 꺼짐 (procNotFound / 연결 끊김) */
export function isNotRunning(error: string): boolean {
	return /-600\b|-609\b|isn.t running|실행 중이 아닙니다/i.test(error);
}

export function parseStatus(out: string): MusicStatus {
	const text = out.replace(/\r?\n$/, "");
	if (text.trim() === "off") return { state: "off" };
	const [st, track = "", artist = ""] = text.split("\t");
	const state: PlayerState = st === "playing" ? "playing" : st === "paused" ? "paused" : st === "stopped" ? "stopped" : st?.trim() ? "playing" : "error";
	// fast forwarding / rewinding 도 재생 중으로 본다
	return { state, track: track || undefined, artist: artist || undefined };
}

function run(bin: string, args: string[], timeout: number): Promise<RunResult> {
	return new Promise((resolve) => {
		execFile(bin, args, { timeout, encoding: "utf8" }, (err, stdout, stderr) => {
			if (err) resolve({ ok: false, error: `${stderr || ""} ${err.message}`.trim() });
			else resolve({ ok: true, out: String(stdout) });
		});
	});
}

/** 진짜 osascript. 테스트에서는 MUSIC_OSASCRIPT 로 가짜 프로그램을 끼운다 */
export function osascriptRunner(bin = process.env.MUSIC_OSASCRIPT || "osascript"): Runner {
	return (script) => run(bin, ["-e", script], 4000);
}

/** Music 앱 열기 (`open -a Music`, 권한 필요 없음) */
export function musicOpener(bin = process.env.MUSIC_OPEN || "open"): Opener {
	return async () => {
		await run(bin, ["-a", "Music"], 5000);
	};
}

export interface MusicOptions {
	runner?: Runner;
	opener?: Opener;
	pollMs?: number;
}

/**
 * Music 앱의 상태를 pollMs(기본 1.5초)마다 확인하고, 바뀌면 "change" 를 낸다.
 * 버튼이 하나도 안 보일 때는 확인하지 않는다 (start/stop).
 */
export class Music extends EventEmitter {
	status: MusicStatus = { state: "off" };
	private readonly runner: Runner;
	private readonly opener: Opener;
	private readonly pollMs: number;
	private timer: NodeJS.Timeout | null = null;
	private polling = false;

	constructor(opt: MusicOptions = {}) {
		super();
		this.setMaxListeners(50);
		this.runner = opt.runner ?? osascriptRunner();
		this.opener = opt.opener ?? musicOpener();
		this.pollMs = opt.pollMs ?? 1500;
	}

	get running(): boolean {
		return this.timer !== null;
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => void this.refresh(), this.pollMs);
		void this.refresh();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	/** 지금 상태를 다시 확인 */
	async refresh(): Promise<MusicStatus> {
		if (this.polling) return this.status;
		this.polling = true;
		try {
			const r = await this.runner(SCRIPTS.status);
			this.set(r.ok ? parseStatus(r.out) : isDenied(r.error) ? { state: "denied" } : isNotRunning(r.error) ? { state: "off" } : { state: "error" });
		} finally {
			this.polling = false;
		}
		return this.status;
	}

	/** 재생/일시정지·다음·이전. 결과: ok / off(앱 꺼짐) / denied(권한 없음) / error */
	async command(cmd: Command): Promise<"ok" | "off" | "denied" | "error"> {
		const r = await this.runner(SCRIPTS[cmd]);
		let result: "ok" | "off" | "denied" | "error";
		if (r.ok) result = r.out.trim() === "off" ? "off" : "ok";
		else result = isDenied(r.error) ? "denied" : isNotRunning(r.error) ? "off" : "error";
		if (result === "ok" && cmd === "playpause") {
			// 바로 반영 (확인은 아래 refresh 가)
			const s = this.status.state;
			if (s === "playing") this.set({ ...this.status, state: "paused" });
			else if (s === "paused" || s === "stopped") this.set({ ...this.status, state: "playing" });
		}
		if (result === "denied") this.set({ state: "denied" });
		if (result === "off") this.set({ state: "off" });
		// 진행 중이던 확인이 옛 상태로 덮어쓰지 않게 조금 뒤에 다시 확인
		setTimeout(() => void this.refresh(), 300);
		return result;
	}

	async open(): Promise<void> {
		await this.opener();
		// 켜지는 데 시간이 걸리니 조금 뒤에 확인
		setTimeout(() => void this.refresh(), 1500);
	}

	private set(s: MusicStatus): void {
		const prev = this.status;
		this.status = s;
		if (prev.state !== s.state || prev.track !== s.track || prev.artist !== s.artist) this.emit("change", s);
	}
}
