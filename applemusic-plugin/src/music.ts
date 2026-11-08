// Mac 의 Music 앱(Apple Music)을 AppleScript(osascript)로 조작·확인한다. Stream Deck SDK 와 무관.
//
// - 모든 스크립트는 `application "Music" is running` 을 먼저 본다 → Music 이 꺼져 있을 때 저절로 켜지지 않게.
// - 처음 조작할 때 macOS 가 "Stream Deck 이(가) Music 을 제어하려고 합니다" 하고 묻는다. 거절하면 -1743 오류 → "denied".
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type PlayerState = "off" | "playing" | "paused" | "stopped" | "denied" | "error";

export interface MusicStatus {
	state: PlayerState;
	track?: string;
	artist?: string;
	album?: string;
}

export type Command = "playpause" | "next" | "previous";

/** 실행 결과: 성공이면 출력, 실패면 오류 글 */
export type RunResult = { ok: true; out: string } | { ok: false; error: string };
export type Runner = (script: string) => Promise<RunResult>;
export type Opener = () => Promise<void>;
/** 지금 곡의 앨범 표지를 data URL 로 (없으면 null) */
export type ArtLoader = () => Promise<string | null>;

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
		set trackAlbum to ""
		try
			set trackName to name of current track
			set trackArtist to artist of current track
			set trackAlbum to album of current track
		end try
		return playerState & tab & trackName & tab & trackArtist & tab & trackAlbum
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
	const [st, track = "", artist = "", album = ""] = text.split("\t");
	const state: PlayerState = st === "playing" ? "playing" : st === "paused" ? "paused" : st === "stopped" ? "stopped" : st?.trim() ? "playing" : "error";
	// fast forwarding / rewinding 도 재생 중으로 본다
	const status: MusicStatus = { state, track: track || undefined, artist: artist || undefined };
	if (album) status.album = album;
	return status;
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

/**
 * 지금 곡의 앨범 표지를 file 에 저장하는 스크립트. 결과: "ok" / "none"(표지 없음) / "off"
 * (파일 쓰기는 Music 이 아니라 osascript 가 하도록 tell 블록 밖에서)
 */
export function artworkScript(file: string): string {
	const posix = file.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	return `if application "Music" is running then
	tell application "Music"
		try
			set artData to raw data of artwork 1 of current track
		on error
			return "none"
		end try
	end tell
	set outFile to open for access (POSIX file "${posix}") with write permission
	try
		set eof outFile to 0
		write artData to outFile
		close access outFile
	on error
		close access outFile
		return "none"
	end try
	return "ok"
else
	return "off"
end if`;
}

/** 그림 파일 → data URL (PNG/JPEG 만) */
export function imageDataUrl(buf: Buffer): string | null {
	const mime = buf[0] === 0x89 && buf[1] === 0x50 ? "image/png" : buf[0] === 0xff && buf[1] === 0xd8 ? "image/jpeg" : null;
	return mime ? `data:${mime};base64,${buf.toString("base64")}` : null;
}

/**
 * 진짜 앨범 표지 가져오기: osascript 로 파일에 저장 → sips(macOS 기본)로 144px 로 줄임 → data URL.
 * sips 가 없거나 실패하면 원본 그대로.
 */
export function artworkLoader(runner: Runner, sipsBin = process.env.MUSIC_SIPS || "sips"): ArtLoader {
	let dir: string | null = null;
	let n = 0;
	return async () => {
		dir ??= fs.mkdtempSync(path.join(os.tmpdir(), "sd-music-art-"));
		const raw = path.join(dir, `art-${++n}`);
		const small = `${raw}.png`;
		try {
			const r = await runner(artworkScript(raw));
			if (!r.ok || r.out.trim() !== "ok" || !fs.existsSync(raw)) return null;
			const s = await run(sipsBin, ["-s", "format", "png", "-Z", "144", raw, "--out", small], 5000);
			const file = s.ok && fs.existsSync(small) ? small : raw;
			return imageDataUrl(fs.readFileSync(file));
		} catch {
			return null;
		} finally {
			fs.rmSync(raw, { force: true });
			fs.rmSync(small, { force: true });
		}
	};
}

export interface MusicOptions {
	runner?: Runner;
	opener?: Opener;
	artLoader?: ArtLoader;
	pollMs?: number;
}

/**
 * Music 앱의 상태를 pollMs(기본 1.5초)마다 확인하고, 바뀌면 "change" 를 낸다.
 * 버튼이 하나도 안 보일 때는 확인하지 않는다 (start/stop).
 */
export class Music extends EventEmitter {
	status: MusicStatus = { state: "off" };
	/** 지금 곡의 앨범 표지 (data URL). 없거나 아직 못 받았으면 null */
	artwork: string | null = null;
	private artKey: string | null = null;
	private readonly artLoader: ArtLoader;
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
		this.artLoader = opt.artLoader ?? artworkLoader(this.runner);
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
		this.updateArtwork();
	}

	/** 곡이 바뀌었을 때만 표지를 새로 가져온다 */
	private updateArtwork(): void {
		const s = this.status;
		const on = s.state === "playing" || s.state === "paused" || s.state === "stopped";
		const key = on && (s.track || s.album) ? [s.track, s.artist, s.album].join("\t") : null;
		if (key === this.artKey) return;
		this.artKey = key;
		if (this.artwork !== null) {
			this.artwork = null;
			this.emit("change", s);
		}
		if (key === null) return;
		void this.artLoader().then((url) => {
			if (this.artKey !== key || !url) return; // 그새 곡이 바뀜
			this.artwork = url;
			this.emit("change", this.status);
		});
	}
}
