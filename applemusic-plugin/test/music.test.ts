import { describe, expect, it } from "vitest";

import { Music, SCRIPTS, artworkScript, imageDataUrl, isDenied, parseStatus } from "../src/music";
import { fakeMusic } from "./fake-music";

describe("AppleScript", () => {
	it("모든 스크립트가 먼저 Music 이 켜져 있는지 본다 (꺼져 있을 때 저절로 켜지지 않게)", () => {
		for (const s of Object.values(SCRIPTS)) expect(s.startsWith('if application "Music" is running then')).toBe(true);
		expect(SCRIPTS.playpause).toContain("playpause");
		expect(SCRIPTS.next).toContain("next track");
		expect(SCRIPTS.previous).toContain("back track");
	});

	it("상태 읽기", () => {
		expect(parseStatus("off\n")).toEqual({ state: "off" });
		expect(parseStatus("playing\tSong A\tArtist A\n")).toEqual({ state: "playing", track: "Song A", artist: "Artist A" });
		expect(parseStatus("playing\tSong A\tArtist A\tAlbum A\n")).toEqual({ state: "playing", track: "Song A", artist: "Artist A", album: "Album A" });
		expect(parseStatus("paused\t\t\n")).toEqual({ state: "paused" });
		expect(parseStatus("stopped\t\t")).toEqual({ state: "stopped" });
		expect(parseStatus("fast forwarding\tA\tB").state).toBe("playing");
	});

	it("앨범 표지 스크립트: Music 이 켜져 있을 때만, 파일 쓰기는 tell 블록 밖에서", () => {
		const s = artworkScript('/tmp/a "b"/art-1');
		expect(s.startsWith('if application "Music" is running then')).toBe(true);
		expect(s).toContain("raw data of artwork 1 of current track");
		expect(s).toContain('POSIX file "/tmp/a \\"b\\"/art-1"');
		expect(s.indexOf("open for access")).toBeGreaterThan(s.indexOf("end tell"));
	});

	it("그림 → data URL (PNG/JPEG 만)", () => {
		expect(imageDataUrl(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toMatch(/^data:image\/png;base64,/);
		expect(imageDataUrl(Buffer.from([0xff, 0xd8, 0xff]))).toMatch(/^data:image\/jpeg;base64,/);
		expect(imageDataUrl(Buffer.from("GIF89a"))).toBeNull();
	});

	it("권한 거절 알아보기", () => {
		expect(isDenied("Not authorized to send Apple events to Music. (-1743)")).toBe(true);
		expect(isDenied("syntax error")).toBe(false);
	});
});

describe("Music", () => {
	it("refresh 로 상태를 읽고, 바뀔 때만 change", async () => {
		const f = fakeMusic({ state: "playing" });
		const m = new Music({ runner: f.runner, opener: f.opener, artLoader: f.artLoader });
		let changes = 0;
		m.on("change", () => changes++);
		await m.refresh();
		await m.refresh();
		expect(m.status).toEqual({ state: "playing", track: "Song A", artist: "Artist A", album: "Album A" });
		expect(changes).toBe(2); // 상태 + 표지 도착
	});

	it("playpause 는 바로 상태를 뒤집어 보여 줌", async () => {
		const f = fakeMusic({ state: "paused" });
		const m = new Music({ runner: f.runner, opener: f.opener, artLoader: f.artLoader });
		await m.refresh();
		expect(await m.command("playpause")).toBe("ok");
		expect(m.status.state).toBe("playing");
	});

	it("꺼져 있으면 off, 권한이 없으면 denied", async () => {
		const off = fakeMusic({ running: false });
		const m1 = new Music({ runner: off.runner, opener: off.opener, artLoader: off.artLoader });
		expect(await m1.command("next")).toBe("off");
		expect((await m1.refresh()).state).toBe("off");

		const no = fakeMusic({ denied: true });
		const m2 = new Music({ runner: no.runner, opener: no.opener, artLoader: no.artLoader });
		expect((await m2.refresh()).state).toBe("denied");
		expect(await m2.command("next")).toBe("denied");
	});

	it("앨범 표지는 곡이 바뀔 때만 가져옴, 꺼지면 지움", async () => {
		const f = fakeMusic({ state: "playing" });
		const m = new Music({ runner: f.runner, opener: f.opener, artLoader: f.artLoader });
		await m.refresh();
		await m.refresh();
		await m.refresh();
		await new Promise((r) => setTimeout(r, 10));
		expect(f.artLoads()).toBe(1);
		expect(m.artwork).toContain(Buffer.from("Song A").toString("base64"));
		f.app.track = "Song B";
		await m.refresh();
		await new Promise((r) => setTimeout(r, 10));
		expect(f.artLoads()).toBe(2);
		expect(m.artwork).toContain(Buffer.from("Song B").toString("base64"));
		f.app.running = false;
		await m.refresh();
		expect(m.artwork).toBeNull();
	});

	it("start/stop 으로 주기적 확인", async () => {
		const f = fakeMusic();
		const m = new Music({ runner: f.runner, opener: f.opener, artLoader: f.artLoader, pollMs: 20 });
		m.start();
		await new Promise((r) => setTimeout(r, 110));
		m.stop();
		const n = f.calls.length;
		expect(n).toBeGreaterThanOrEqual(3);
		await new Promise((r) => setTimeout(r, 60));
		expect(f.calls.length).toBe(n);
	});
});
