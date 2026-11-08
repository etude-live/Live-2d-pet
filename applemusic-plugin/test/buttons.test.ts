import { describe, expect, it } from "vitest";

import { type KeyHandle, MusicButton, TITLE_DENIED, TITLE_OFF, TITLE_PAUSED, createButtons, shorten } from "../src/buttons";
import { Music } from "../src/music";
import { fakeMusic } from "./fake-music";

class FakeKey implements KeyHandle {
	images: (string | undefined)[] = [];
	titles: (string | undefined)[] = [];
	alerts = 0;
	constructor(readonly id = Math.random().toString(36)) {}
	setImage(i?: string) {
		this.images.push(i);
	}
	setTitle(t?: string) {
		this.titles.push(t);
	}
	showAlert() {
		this.alerts++;
	}
	showOk() {}
	get title() {
		return this.titles.at(-1);
	}
	get svg() {
		return decodeURIComponent((this.images.at(-1) ?? "").replace(/^data:image\/svg\+xml;charset=utf8,/, ""));
	}
}

async function setup(init: Parameters<typeof fakeMusic>[0] = {}) {
	const f = fakeMusic(init);
	const music = new Music({ runner: f.runner, opener: f.opener });
	await music.refresh();
	const [prev, play, next] = createButtons(music);
	const keys = { prev: new FakeKey(), play: new FakeKey(), next: new FakeKey() };
	prev.appear(keys.prev);
	play.appear(keys.play);
	next.appear(keys.next);
	return { f, music, prev, play, next, keys };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

describe("버튼", () => {
	it("id = manifest UUID 끝부분", () => {
		const m = new Music({ runner: async () => ({ ok: true, out: "off" }) });
		expect(createButtons(m).map((b) => b.id)).toEqual(["previous", "playpause", "next"]);
	});

	it("제목 자르기", () => {
		expect(shorten("밤양갱")).toBe("밤양갱");
		expect(shorten("Bohemian Rhapsody")).toBe("Bohemi…");
	});

	it("Music 이 꺼져 있으면 음표 배지(흐리지 않게) + 'Music 열기 / 실행 중 아님', 누르면 Music 을 연다", async () => {
		const t = await setup({ running: false });
		for (const k of Object.values(t.keys)) {
			expect(k.title).toBe(TITLE_OFF);
			expect(k.svg).toContain('<circle cx="44"'); // 배지
			expect(k.svg).toContain("url(#g)"); // 색 그대로
			expect(k.svg).not.toContain("scale(2)");
		}
		await t.next.press(t.keys.next.id);
		expect(t.f.opened()).toBe(1);
		expect(t.f.calls).not.toContain("next");
	});

	it("Music 이 켜져 있으면 배지 없이 기호만 크게", async () => {
		const t = await setup({ state: "paused" });
		for (const k of Object.values(t.keys)) {
			expect(k.svg).not.toContain('<circle cx="44"');
			expect(k.svg).toContain("scale(2)");
		}
	});

	it("재생 중: ❚❚ + 곡 제목 / 일시정지: ▶ + '일시정지'", async () => {
		const t = await setup({ state: "playing", track: "Hype Boy" });
		expect(t.keys.play.title).toBe("Hype Boy".slice(0, 6) + "…");
		expect(t.keys.play.svg).toContain('width="10"'); // pause 막대
		expect(t.keys.prev.title).toBeUndefined();

		await t.play.press(t.keys.play.id);
		expect(t.f.calls).toContain("playpause");
		expect(t.keys.play.title).toBe(TITLE_PAUSED);
		expect(t.keys.play.svg).toContain("M92 36 V72 L120 54 Z"); // play 삼각형
	});

	it("⏮ / ⏭ 는 back track / next track", async () => {
		const t = await setup({ state: "playing" });
		await t.prev.press(t.keys.prev.id);
		await t.next.press(t.keys.next.id);
		expect(t.f.calls.filter((c) => c !== "status")).toEqual(["previous", "next"]);
		await t.music.refresh();
		expect(t.music.status.track).toBe("다음 곡");
	});

	it("권한이 없으면 주황 + '권한 필요', 누르면 ⚠️", async () => {
		const t = await setup({ denied: true });
		expect(t.keys.play.title).toBe(TITLE_DENIED);
		expect(t.keys.play.svg).toContain("#f5b14c");
		await t.play.press(t.keys.play.id);
		expect(t.keys.play.alerts).toBe(1);
	});

	it("상태가 바뀌면 보이는 버튼이 저절로 다시 그려짐, 같으면 다시 안 보냄", async () => {
		const t = await setup({ state: "paused" });
		const n = t.keys.play.images.length;
		await t.music.refresh();
		expect(t.keys.play.images.length).toBe(n);
		t.f.app.state = "playing";
		await t.music.refresh();
		await tick();
		expect(t.keys.play.images.length).toBe(n + 1);
	});

	it("사라진 키는 그리지 않음", async () => {
		const t = await setup();
		const b: MusicButton = t.play;
		b.disappear(t.keys.play.id);
		expect(b.count).toBe(0);
	});
});
