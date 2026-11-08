// 버튼 13가지. 무엇을 보내고(press) 어떻게 보이는지(view)만 정한다.
import type { Bridge } from "../bridge/types";
import { COLORS, type Face, type KeyArt } from "../icons";
import { Button, type Inst, type JsonLike, type Settings, type View, num, str } from "./base";

export const HOLD_MS = 500;

export function mmss(sec: number): string {
	const s = Math.max(0, Math.round(sec || 0));
	return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// ---------- 🍅 포모도로 ----------

export interface PomodoroSettings extends Settings {
	work?: number | string;
	break?: number | string;
	long?: number | string;
	cycles?: number | string;
}

export const POMODORO_DEFAULTS = { work: 25, break: 5, long: 15, cycles: 4 };

/** 누르면 시작/끝(toggle), 0.5초 이상 누르고 있으면 일시정지/다시(pause) */
export class PomodoroButton extends Button<PomodoroSettings> {
	readonly id = "pomodoro";

	protected baseArt(): KeyArt {
		return { glyph: "tomato", bg: COLORS.blue };
	}

	protected view(): View {
		const p = this.state.pomodoro;
		if (!p || !p.running || p.phase === "idle") return { art: this.baseArt() };
		const bg = p.paused ? COLORS.gray : p.phase === "work" ? COLORS.red : COLORS.green;
		return { art: { glyph: "tomato", bg }, title: mmss(p.remainingSec) };
	}

	args(inst: Inst<PomodoroSettings>): Record<string, number> {
		const s = inst.settings;
		const d = POMODORO_DEFAULTS;
		return { work: num(s.work, d.work), break: num(s.break, d.break), long: num(s.long, d.long), cycles: num(s.cycles, d.cycles) };
	}

	protected onDown(inst: Inst<PomodoroSettings>): void {
		inst.held = false;
		if (inst.holdTimer) clearTimeout(inst.holdTimer);
		inst.holdTimer = setTimeout(() => {
			inst.holdTimer = undefined;
			inst.held = true;
			void this.run(inst, "pomodoro.pause");
		}, HOLD_MS);
	}

	protected async onUp(inst: Inst<PomodoroSettings>): Promise<void> {
		if (inst.holdTimer) {
			clearTimeout(inst.holdTimer);
			inst.holdTimer = undefined;
		}
		if (inst.held) return; // 길게 누른 건 이미 처리
		await this.run(inst, "pomodoro.toggle", this.args(inst));
	}
}

// ---------- 누르면 명령 하나 보내는 버튼들 ----------

interface SimpleSpec<S extends Settings> {
	id: string;
	art: KeyArt;
	command: string;
	args?: (inst: Inst<S>) => Record<string, unknown> | null;
	okMark?: boolean;
	busy?: boolean;
	timeoutMs?: number;
}

export class SimpleButton<S extends Settings = Settings> extends Button<S> {
	readonly id: string;
	constructor(
		bridge: Bridge,
		private readonly spec: SimpleSpec<S>
	) {
		super(bridge);
		this.id = spec.id;
	}

	protected baseArt(): KeyArt {
		return this.spec.art;
	}

	protected async press(inst: Inst<S>): Promise<void> {
		if (inst.busy) return; // 앞의 요청이 아직 끝나지 않음
		const args = this.spec.args ? this.spec.args(inst) : {};
		if (args === null) return; // 설정이 모자람 (args 쪽에서 알림)
		const { okMark, busy, timeoutMs } = this.spec;
		await this.run(inst, this.spec.command, args, { okMark, busy, timeoutMs });
	}

	/** args 에서 설정이 모자랄 때 */
	needSetting(inst: Inst<S>, title: string): null {
		void inst.key.showAlert();
		this.flash(inst, title);
		return null;
	}
}

export const SCREEN_DEFAULT_QUESTION = "이 화면 설명해 줘";
export const PHRASE_DEFAULT_TEXT = "오늘 할 일 정리해 줘";

export function skipButton(bridge: Bridge): SimpleButton {
	return new SimpleButton(bridge, { id: "pomodoro-skip", art: { glyph: "skip", bg: COLORS.blue }, command: "pomodoro.skip" });
}
export function stopButton(bridge: Bridge): SimpleButton {
	return new SimpleButton(bridge, { id: "stop", art: { glyph: "stop", bg: COLORS.blue }, command: "agent.stop", okMark: true });
}
export function newChatButton(bridge: Bridge): SimpleButton {
	return new SimpleButton(bridge, { id: "new-chat", art: { glyph: "newChat", bg: COLORS.blue }, command: "agent.newChat", okMark: true });
}
export function translateButton(bridge: Bridge): SimpleButton {
	return new SimpleButton(bridge, {
		id: "translate",
		art: { glyph: "translate", bg: COLORS.blue },
		command: "clip.translate",
		okMark: true,
		busy: true,
		timeoutMs: 120_000
	});
}
export function polishButton(bridge: Bridge): SimpleButton {
	return new SimpleButton(bridge, {
		id: "polish",
		art: { glyph: "polish", bg: COLORS.blue },
		command: "clip.polish",
		okMark: true,
		busy: true,
		timeoutMs: 120_000
	});
}

/** 📸 이거 뭐야: 설정의 질문(기본 "이 화면 설명해 줘"). 비워 두면 질문 없이 첨부만 */
export function screenButton(bridge: Bridge): SimpleButton<{ question?: string }> {
	return new SimpleButton<{ question?: string }>(bridge, {
		id: "screen-ask",
		art: { glyph: "screen", bg: COLORS.blue },
		command: "screen.ask",
		okMark: true,
		busy: true,
		timeoutMs: 30_000,
		args: (inst) => {
			const q = str(inst.settings.question, SCREEN_DEFAULT_QUESTION).trim();
			return q ? { question: q } : {};
		}
	});
}

/** 💭 정해진 말: 버튼마다 문구 */
export function phraseButton(bridge: Bridge): SimpleButton<{ text?: string }> {
	const b: SimpleButton<{ text?: string }> = new SimpleButton<{ text?: string }>(bridge, {
		id: "phrase",
		art: { glyph: "phrase", bg: COLORS.pink },
		command: "talk.send",
		okMark: true,
		args: (inst) => {
			const text = str(inst.settings.text, PHRASE_DEFAULT_TEXT).trim();
			return text ? { text } : b.needSetting(inst, "문구\n없음");
		}
	});
	return b;
}

// ---------- 💬 말 걸기 ----------

export const BLINK_MS = 500;

/** talk.toggle. 승인 기다리면(asking) 깜빡이고, 일하는 중(working)이면 "…" */
export class TalkButton extends Button {
	readonly id = "talk";
	private blinkTimer: NodeJS.Timeout | null = null;
	private blinkOn = false;

	protected baseArt(): KeyArt {
		return { glyph: "talk", bg: COLORS.pink };
	}

	protected view(): View {
		const a = this.state.agent;
		if (a === "asking") return { art: { glyph: "talkAsk", bg: this.blinkOn ? COLORS.amber : COLORS.pink }, title: "승인\n대기" };
		if (a === "working") return { art: { glyph: "talkDots", bg: COLORS.pink }, title: "…" };
		return { art: this.baseArt() };
	}

	protected async press(inst: Inst): Promise<void> {
		await this.run(inst, "talk.toggle");
	}

	renderAll(): void {
		this.updateBlink();
		super.renderAll();
	}

	protected instancesChanged(): void {
		this.updateBlink();
	}

	dispose(): void {
		super.dispose();
		this.updateBlink();
	}

	private updateBlink(): void {
		const want = this.state.connected && this.state.agent === "asking" && this.count > 0;
		if (want && !this.blinkTimer) {
			this.blinkOn = true;
			this.blinkTimer = setInterval(() => {
				this.blinkOn = !this.blinkOn;
				super.renderAll();
			}, BLINK_MS);
		} else if (!want && this.blinkTimer) {
			clearInterval(this.blinkTimer);
			this.blinkTimer = null;
			this.blinkOn = false;
		}
	}
}

// ---------- 🔋 사용량 ----------

export const USAGE_WARN = 0.8;

/** five_hour.utilization 을 % 와 게이지로. 80% 이상 빨강. 누르면 새로고침 */
export class UsageButton extends Button {
	readonly id = "usage";

	protected baseArt(): KeyArt {
		return { glyph: "battery", bg: COLORS.blue, level: 0.6, levelColor: COLORS.green };
	}

	protected view(): View {
		const w = this.state.usage?.five_hour;
		if (!w || typeof w.utilization !== "number") return { art: { glyph: "battery", bg: COLORS.blue, level: 0 }, title: "--%" };
		const u = Math.max(0, w.utilization);
		const warn = u >= USAGE_WARN;
		return {
			art: { glyph: "battery", bg: warn ? COLORS.red : COLORS.blue, level: Math.min(1, u), levelColor: warn ? COLORS.white : COLORS.green },
			title: `${Math.round(u * 100)}%`
		};
	}

	protected async press(inst: Inst): Promise<void> {
		if (inst.busy) return;
		await this.run(inst, "usage.get", {}, { busy: true, timeoutMs: 30_000 });
	}
}

// ---------- 😊 표정 ----------

export interface ExpressionSettings extends Settings {
	/** 표정 이름 (expression.list 에서 고름) */
	name?: string;
	/** 같이 띄울 대사 */
	text?: string;
	/** 버튼 그림 모양 */
	face?: Face;
}

export const FACES: Face[] = ["smile", "blush", "sad", "wink", "angry", "surprised"];

/** expression.set { name, text }. 모델에 표정이 없으면 motion.play { text } */
export class ExpressionButton extends Button<ExpressionSettings> {
	readonly id = "expression";

	protected baseArt(inst: Inst<ExpressionSettings>): KeyArt {
		const face = FACES.includes(inst.settings.face as Face) ? (inst.settings.face as Face) : "smile";
		return { glyph: "face", face, bg: COLORS.blue };
	}

	protected view(inst: Inst<ExpressionSettings>): View {
		const art = this.baseArt(inst);
		const name = str(inst.settings.name, "");
		const list = this.state.expressions;
		const noExpressions = list !== null && list.length === 0;
		if (noExpressions) return { art }; // 몸짓 버튼으로 동작
		if (!name) return { art, title: "표정\n고르기" };
		const on = this.state.expression === name;
		return on ? { art: { ...art, bg: COLORS.pink, ring: COLORS.white }, title: name } : { art, title: name };
	}

	protected async press(inst: Inst<ExpressionSettings>): Promise<void> {
		const text = str(inst.settings.text, "").trim();
		const name = str(inst.settings.name, "");
		const list = await this.run(inst, "expression.list");
		if (!list.ok) return;
		const exps = Array.isArray(list.expressions) ? list.expressions.map(String) : [];
		if (exps.length === 0) {
			await this.run(inst, "motion.play", text ? { text } : {});
			return;
		}
		if (!name) {
			void inst.key.showAlert();
			this.flash(inst, "표정\n고르기");
			return;
		}
		await this.run(inst, "expression.set", text ? { name, text } : { name });
	}

	/** 설정 화면의 표정 목록 (sdpi-components 의 datasource="getExpressions") */
	async fromPropertyInspector(_id: string, payload: unknown): Promise<JsonLike | undefined> {
		const event = (payload as { event?: string } | null)?.event;
		if (event !== "getExpressions") return undefined;
		const items = await this.expressionItems();
		return { event, items };
	}

	async expressionItems(): Promise<JsonLike[]> {
		if (!this.usable()) return [{ label: "(앱이 꺼져 있어요 — 켜고 다시 열어 주세요)", value: "", disabled: true }];
		const r = await this.bridge.command("expression.list");
		if (!r.ok) return [{ label: "(목록을 못 받았어요)", value: "", disabled: true }];
		const exps = Array.isArray(r.expressions) ? r.expressions.map(String) : [];
		if (exps.length === 0) return [{ label: "(이 모델엔 표정이 없어요 → 누르면 몸짓)", value: "" }];
		return [{ label: "(고르세요)", value: "" }, ...exps.map((e) => ({ label: e, value: e }))];
	}
}

// ---------- 켜짐/꺼짐 버튼 (같이 공부, Claude 모드) ----------

class ToggleButton extends Button {
	constructor(
		bridge: Bridge,
		readonly id: string,
		private readonly glyph: KeyArt["glyph"],
		private readonly command: string,
		private readonly read: (b: ToggleButton) => boolean | null
	) {
		super(bridge);
	}

	protected baseArt(): KeyArt {
		return { glyph: this.glyph, bg: COLORS.blue };
	}

	protected view(): View {
		const on = this.read(this);
		if (on === null) return { art: this.baseArt() }; // 아직 모름
		return on ? { art: { glyph: this.glyph, bg: COLORS.blue, ring: COLORS.pink }, title: "켜짐" } : { art: { glyph: this.glyph, bg: COLORS.gray }, title: "꺼짐" };
	}

	protected async press(inst: Inst): Promise<void> {
		await this.run(inst, this.command);
	}

	get mascot() {
		return this.state;
	}
}

export function studyButton(bridge: Bridge): Button {
	return new ToggleButton(bridge, "study", "study", "study.toggle", (b) => b.mascot.study);
}
export function modeButton(bridge: Bridge): Button {
	return new ToggleButton(bridge, "mode", "robot", "mode.toggle", (b) => b.mascot.claude);
}

// ---------- 전부 ----------

export function createButtons(bridge: Bridge): Button[] {
	return [
		new PomodoroButton(bridge),
		skipButton(bridge),
		new TalkButton(bridge),
		stopButton(bridge),
		newChatButton(bridge),
		screenButton(bridge) as unknown as Button,
		translateButton(bridge),
		polishButton(bridge),
		phraseButton(bridge) as unknown as Button,
		new UsageButton(bridge),
		new ExpressionButton(bridge) as unknown as Button,
		studyButton(bridge),
		modeButton(bridge)
	];
}
