import { afterEach, describe, expect, it } from "vitest";

import { TITLE_APP_OFF, TITLE_MODE_OFF, TITLE_UPDATE, type Button } from "../src/buttons/base";
import {
	ExpressionButton,
	HOLD_MS,
	PomodoroButton,
	TalkButton,
	UsageButton,
	createButtons,
	mmss,
	modeButton,
	newChatButton,
	phraseButton,
	polishButton,
	screenButton,
	skipButton,
	stopButton,
	studyButton,
	translateButton
} from "../src/buttons/buttons";
import { COLORS } from "../src/icons";
import { FakeKey, setup, sleep, waitFor } from "./helpers";

let cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const c of cleanup.reverse()) await c();
	cleanup = [];
});

async function env(opts = {}, connect = true) {
	const t = await setup(opts, connect);
	cleanup.push(t.close);
	return t;
}

function place<B extends Button<any>>(button: B, settings: Record<string, unknown> = {}) {
	cleanup.push(() => button.dispose());
	const key = new FakeKey();
	button.appear(key, settings);
	return { button, key, press: () => button.keyDown(key.id).then(() => button.keyUp(key.id)) };
}

describe("공통", () => {
	it("13개 버튼, id 가 겹치지 않음", async () => {
		const t = await env({}, false);
		const all = createButtons(t.client);
		cleanup.push(() => all.forEach((b) => b.dispose()));
		const ids = all.map((b) => b.id);
		expect(ids).toEqual(["pomodoro", "pomodoro-skip", "talk", "stop", "new-chat", "screen-ask", "translate", "polish", "phrase", "usage", "expression", "study", "mode"]);
	});

	it("앱이 꺼져 있으면 흐린 아이콘 + '앱 꺼짐', 누르면 ⚠️ 이고 명령을 보내지 않음", async () => {
		const t = await env({}, false);
		const all = createButtons(t.client).map((b) => place(b));
		for (const { key, press } of all) {
			expect(key.title).toBe(TITLE_APP_OFF);
			expect(key.bg).toBe(COLORS.off);
			await press();
			expect(key.alerts).toBe(1);
		}
		expect(t.app.received).toEqual([]);
	});

	it("앱이 켜지면 저절로 정상 표시, 꺼지면 다시 '앱 꺼짐'", async () => {
		const t = await env({}, false);
		const { key } = place(stopButton(t.client));
		await t.app.start();
		await waitFor(() => key.title !== TITLE_APP_OFF, 2000, "켜짐 표시");
		expect(key.bg).toBe(COLORS.blue);
		await t.app.stop();
		await waitFor(() => key.title === TITLE_APP_OFF, 2000, "꺼짐 표시");
	});

	it("protocol 이 다르면 모든 버튼에 '업데이트 필요', 누르면 ⚠️", async () => {
		const t = await env({ protocol: 2, version: "3.0.0" }, false);
		const all = createButtons(t.client).map((b) => place(b));
		await t.app.start();
		await waitFor(() => all.every(({ key }) => key.title === TITLE_UPDATE), 2000, "업데이트 필요");
		for (const { key, press } of all) {
			expect(key.bg).toBe(COLORS.amber);
			await press();
			expect(key.alerts).toBe(1);
		}
		expect(t.app.received).toEqual([]);
	});

	it("앱 2.0.0 이전 버전이어도 '업데이트 필요'", async () => {
		const t = await env({ version: "1.5.0" }, false);
		const { key } = place(new TalkButton(t.client));
		await t.app.start();
		await waitFor(() => key.title === TITLE_UPDATE, 2000, "업데이트 필요");
	});

	it("같은 그림·제목은 다시 보내지 않음 (매초 tick 에도 다른 버튼은 조용)", async () => {
		const t = await env();
		const { key } = place(stopButton(t.client));
		const n = key.images.length + key.titles.length;
		for (let i = 0; i < 5; i++) t.app.broadcast("pomodoro", { event: "tick", running: true, paused: false, phase: "work", remainingSec: 100 - i });
		await sleep(100);
		expect(key.images.length + key.titles.length).toBe(n);
	});
});

describe("🍅 포모도로", () => {
	it("mm:ss", () => {
		expect(mmss(0)).toBe("00:00");
		expect(mmss(61)).toBe("01:01");
		expect(mmss(1500)).toBe("25:00");
	});

	it("짧게 누르면 pomodoro.toggle (설정의 분·횟수, 기본 25/5/15/4)", async () => {
		const t = await env();
		const { press } = place(new PomodoroButton(t.client));
		await press();
		expect(t.app.received.at(-1)).toEqual({ name: "pomodoro.toggle", args: { work: 25, break: 5, long: 15, cycles: 4 } });

		const b2 = place(new PomodoroButton(t.client), { work: "50", break: 10, long: "30", cycles: 2 });
		await b2.press();
		expect(t.app.received.at(-1)).toEqual({ name: "pomodoro.toggle", args: { work: 50, break: 10, long: 30, cycles: 2 } });
	});

	it("0.5초 이상 누르면 pomodoro.pause (toggle 은 보내지 않음)", async () => {
		const t = await env();
		const { button, key } = place(new PomodoroButton(t.client));
		await button.keyDown(key.id);
		await sleep(HOLD_MS + 150);
		await button.keyUp(key.id);
		await sleep(50);
		expect(t.app.names().filter((n) => n.startsWith("pomodoro."))).toEqual(["pomodoro.pause"]);
	});

	it("집중=빨강 / 휴식=초록 / 일시정지=회색 / 꺼짐=기본, 제목은 남은 시간", async () => {
		const t = await env();
		const { key } = place(new PomodoroButton(t.client));
		expect(key.bg).toBe(COLORS.blue);
		expect(key.title).toBeUndefined();
		const send = (p: object) => t.app.broadcast("pomodoro", { event: "tick", running: true, paused: false, cycle: 1, cycles: 4, ...p });

		send({ phase: "work", remainingSec: 1499 });
		await waitFor(() => key.title === "24:59");
		expect(key.bg).toBe(COLORS.red);

		send({ phase: "break", remainingSec: 300 });
		await waitFor(() => key.title === "05:00");
		expect(key.bg).toBe(COLORS.green);

		send({ phase: "long", remainingSec: 900, paused: true });
		await waitFor(() => key.title === "15:00");
		expect(key.bg).toBe(COLORS.gray);

		t.app.broadcast("pomodoro", { event: "stopped", running: false, paused: false, phase: "idle", remainingSec: 0 });
		await waitFor(() => key.title === undefined);
		expect(key.bg).toBe(COLORS.blue);
	});

	it("⏭ 건너뛰기: pomodoro.skip", async () => {
		const t = await env();
		await place(skipButton(t.client)).press();
		expect(t.app.names().at(-1)).toBe("pomodoro.skip");
	});
});

describe("💬 말 걸기", () => {
	it("누르면 talk.toggle", async () => {
		const t = await env();
		await place(new TalkButton(t.client)).press();
		expect(t.app.names().at(-1)).toBe("talk.toggle");
	});

	it("working 이면 '…', asking 이면 깜빡임, idle 이면 원래대로", async () => {
		const t = await env();
		const { key } = place(new TalkButton(t.client));
		t.app.broadcast("agent", { state: "working" });
		await waitFor(() => key.title === "…");

		t.app.broadcast("agent", { state: "asking" });
		await waitFor(() => key.title === "승인\n대기");
		const bgs = new Set<string | undefined>();
		const end = Date.now() + 1300;
		while (Date.now() < end) {
			bgs.add(key.bg);
			await sleep(50);
		}
		expect(bgs).toEqual(new Set([COLORS.amber, COLORS.pink])); // 번갈아 바뀜

		t.app.broadcast("agent", { state: "idle" });
		await waitFor(() => key.title === undefined);
		const n = key.images.length;
		await sleep(700);
		expect(key.images.length).toBe(n); // 깜빡임 멈춤
		expect(key.bg).toBe(COLORS.pink);
	});
});

describe("⏹ 멈추기 · 🆕 새 대화", () => {
	it("agent.stop / agent.newChat, 성공하면 ✅", async () => {
		const t = await env();
		const a = place(stopButton(t.client));
		const b = place(newChatButton(t.client));
		await a.press();
		await b.press();
		expect(t.app.names().slice(-2)).toEqual(["agent.stop", "agent.newChat"]);
		expect(a.key.oks).toBe(1);
		expect(b.key.oks).toBe(1);
	});
});

describe("📸 이거 뭐야", () => {
	it("기본 질문 '이 화면 설명해 줘'", async () => {
		const t = await env();
		await place(screenButton(t.client)).press();
		expect(t.app.received.at(-1)).toEqual({ name: "screen.ask", args: { question: "이 화면 설명해 줘" } });
	});

	it("설정한 질문, 비워 두면 질문 없이 첨부만", async () => {
		const t = await env();
		await place(screenButton(t.client), { question: "이 에러 뭐야?" }).press();
		expect(t.app.received.at(-1)?.args).toEqual({ question: "이 에러 뭐야?" });
		await place(screenButton(t.client), { question: "  " }).press();
		expect(t.app.received.at(-1)?.args).toEqual({});
	});

	it("Claude 모드가 꺼져 있으면(claude-off) ⚠️ + '모드 꺼짐' 잠깐", async () => {
		const t = await env({ claude: false });
		const { key, press } = place(screenButton(t.client));
		await press();
		expect(key.alerts).toBe(1);
		expect(key.title).toBe(TITLE_MODE_OFF);
		await waitFor(() => key.title === undefined, 3000, "제목 원래대로");
	});

	it("화면 권한이 없으면 ⚠️ + '화면 권한'", async () => {
		const t = await env();
		t.app.respond("screen.ask", { ok: false, error: "screen-permission" });
		const { key, press } = place(screenButton(t.client));
		await press();
		expect(key.alerts).toBe(1);
		expect(key.title).toBe("화면\n권한");
	});
});

describe("🌐 번역 · ✍️ 다듬기", () => {
	it("clip.translate / clip.polish, 기다리는 동안 '…', 성공하면 ✅", async () => {
		const t = await env();
		t.app.respond("clip.translate", () => sleep(200).then(() => ({ ok: true })));
		const tr = place(translateButton(t.client));
		const p = tr.press();
		await waitFor(() => tr.key.title === "…", 1000, "기다림 표시");
		await p;
		expect(tr.key.oks).toBe(1);
		expect(tr.key.title).toBeUndefined();

		const po = place(polishButton(t.client));
		await po.press();
		expect(t.app.names().slice(-2)).toEqual(["clip.translate", "clip.polish"]);
		expect(po.key.oks).toBe(1);
	});

	it("실패하면 ⚠️ (복사한 글이 없으면 '비어 있음')", async () => {
		const t = await env();
		t.app.respond("clip.polish", { ok: false, error: "empty" });
		const { key, press } = place(polishButton(t.client));
		await press();
		expect(key.alerts).toBe(1);
		expect(key.oks).toBe(0);
		expect(key.title).toBe("비어\n있음");
	});
});

describe("💭 정해진 말", () => {
	it("버튼마다 다른 문구로 talk.send (기본 '오늘 할 일 정리해 줘')", async () => {
		const t = await env();
		await place(phraseButton(t.client)).press();
		await place(phraseButton(t.client), { text: "커밋 메시지 써 줘" }).press();
		expect(t.app.received.slice(-2)).toEqual([
			{ name: "talk.send", args: { text: "오늘 할 일 정리해 줘" } },
			{ name: "talk.send", args: { text: "커밋 메시지 써 줘" } }
		]);
	});

	it("문구를 비워 두면 보내지 않고 ⚠️", async () => {
		const t = await env();
		const { key, press } = place(phraseButton(t.client), { text: "" });
		const before = t.app.received.length;
		await press();
		expect(t.app.received.length).toBe(before);
		expect(key.alerts).toBe(1);
	});

	it("캐릭터가 바쁘면(busy) ⚠️ + '바빠요'", async () => {
		const t = await env();
		t.app.respond("talk.send", { ok: false, error: "busy" });
		const { key, press } = place(phraseButton(t.client));
		await press();
		expect(key.alerts).toBe(1);
		expect(key.title).toBe("바빠요");
	});
});

describe("🔋 사용량", () => {
	it("five_hour % 를 제목으로, 80% 이상이면 빨강", async () => {
		const t = await env();
		const { key } = place(new UsageButton(t.client));
		expect(key.title).toBe("--%");
		t.app.broadcast("usage", { five_hour: { utilization: 0.374 }, seven_day: { utilization: 0.9 } });
		await waitFor(() => key.title === "37%");
		expect(key.bg).toBe(COLORS.blue);
		t.app.broadcast("usage", { five_hour: { utilization: 0.8 } });
		await waitFor(() => key.title === "80%");
		expect(key.bg).toBe(COLORS.red);
	});

	it("누르면 usage.get 으로 새로고침", async () => {
		const t = await env();
		t.app.state.usage = { five_hour: { utilization: 0.55 } };
		const { key, press } = place(new UsageButton(t.client));
		await press();
		expect(t.app.names().at(-1)).toBe("usage.get");
		expect(key.title).toBe("55%");
	});
});

describe("😊 표정", () => {
	it("expression.set { name, text }", async () => {
		const t = await env();
		await place(new ExpressionButton(t.client), { name: "angry", text: "흥!" }).press();
		expect(t.app.received.slice(-2)).toEqual([
			{ name: "expression.list", args: {} },
			{ name: "expression.set", args: { name: "angry", text: "흥!" } }
		]);
	});

	it("지금 켜진 표정의 버튼만 켜짐(분홍), 다시 누르면 원래 얼굴로", async () => {
		const t = await env();
		const a = place(new ExpressionButton(t.client), { name: "smile" });
		const b = place(new ExpressionButton(t.client), { name: "sad" });
		expect(a.key.title).toBe("smile");
		await a.press();
		await waitFor(() => a.key.bg === COLORS.pink, 2000, "켜짐");
		expect(b.key.bg).toBe(COLORS.blue);
		await b.press();
		await waitFor(() => b.key.bg === COLORS.pink && a.key.bg === COLORS.blue, 2000, "바뀜");
		await b.press();
		await waitFor(() => b.key.bg === COLORS.blue, 2000, "원래 얼굴");
	});

	it("표정을 안 골랐으면 '표정 고르기' + ⚠️", async () => {
		const t = await env();
		const { key, press } = place(new ExpressionButton(t.client), { text: "안녕" });
		expect(key.title).toBe("표정\n고르기");
		await press();
		expect(key.alerts).toBe(1);
		expect(t.app.names()).not.toContain("expression.set");
	});

	it("표정이 없는 모델이면 motion.play { text }", async () => {
		const t = await env({ expressions: [] });
		const { key, press } = place(new ExpressionButton(t.client), { name: "smile", text: "짠!" });
		expect(key.title).toBeUndefined();
		await press();
		expect(t.app.received.at(-1)).toEqual({ name: "motion.play", args: { text: "짠!" } });
		expect(key.alerts).toBe(0);
	});

	it("없는 표정이면 ⚠️ + '표정 없음'", async () => {
		const t = await env();
		const { key, press } = place(new ExpressionButton(t.client), { name: "gone" });
		await press();
		expect(key.alerts).toBe(1);
		expect(key.title).toBe("표정\n없음");
	});

	it("설정 화면: getExpressions → expression.list 로 목록", async () => {
		const t = await env();
		const b = new ExpressionButton(t.client);
		cleanup.push(() => b.dispose());
		const reply = await b.fromPropertyInspector("x", { event: "getExpressions" });
		expect(reply).toEqual({
			event: "getExpressions",
			items: [
				{ label: "(고르세요)", value: "" },
				{ label: "smile", value: "smile" },
				{ label: "angry", value: "angry" },
				{ label: "sad", value: "sad" }
			]
		});
		expect(await b.fromPropertyInspector("x", { event: "other" })).toBeUndefined();
	});

	it("설정 화면: 앱이 꺼져 있으면 안내 한 줄", async () => {
		const t = await env({}, false);
		const b = new ExpressionButton(t.client);
		cleanup.push(() => b.dispose());
		const reply = (await b.fromPropertyInspector("x", { event: "getExpressions" })) as { items: { label: string }[] };
		expect(reply.items).toHaveLength(1);
		expect(reply.items[0].label).toContain("앱이 꺼져");
	});
});

describe("📖 같이 공부 · 🤖 Claude 모드", () => {
	it("study.toggle, 켜짐/꺼짐 표시 (study 방송)", async () => {
		const t = await env();
		const { key, press } = place(studyButton(t.client));
		expect(key.title).toBeUndefined(); // 아직 모름 (state.get 에 study 가 없음)
		await press();
		expect(t.app.names().at(-1)).toBe("study.toggle");
		await waitFor(() => key.title === "켜짐");
		t.app.broadcast("study", { on: false });
		await waitFor(() => key.title === "꺼짐");
		expect(key.bg).toBe(COLORS.gray);
	});

	it("mode.toggle, 처음부터 state.get 으로 켜짐 표시, mode 방송으로 바뀜", async () => {
		const t = await env();
		const { key, press } = place(modeButton(t.client));
		expect(key.title).toBe("켜짐");
		await press();
		expect(t.app.names().at(-1)).toBe("mode.toggle");
		await waitFor(() => key.title === "꺼짐");
		t.app.broadcast("mode", { claude: true });
		await waitFor(() => key.title === "켜짐");
	});
});
