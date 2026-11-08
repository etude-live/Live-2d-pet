// 버튼 로직의 바탕. Stream Deck SDK 와 분리돼 있어서 테스트에서 가짜 키(KeyHandle)로 돌려 볼 수 있다.
//
// 공통 규칙
// - 앱이 꺼져 있으면: 흐린 아이콘 + "앱 꺼짐", 누르면 showAlert
// - 앱과 버전이 안 맞으면: 업데이트 아이콘 + "업데이트 필요", 누르면 showAlert
// - 명령 결과가 ok:false 면 showAlert. claude-off 면 제목에 "모드 꺼짐" 잠깐
import type { Bridge, CommandResult, MascotState } from "../bridge/types";
import { COLORS, type KeyArt, keySvg, toDataUrl } from "../icons";

export type Settings = Record<string, unknown>;
export type JsonLike = string | number | boolean | null | JsonLike[] | { [k: string]: JsonLike | undefined };

/** 스트림덱의 키 하나 (SDK 의 KeyAction 을 감싼 것) */
export interface KeyHandle {
	readonly id: string;
	setImage(image?: string): unknown;
	setTitle(title?: string): unknown;
	showAlert(): unknown;
	showOk(): unknown;
}

export interface View {
	art: KeyArt;
	/** undefined = 사용자가 정한 제목(없으면 빈칸) 그대로 */
	title?: string;
}

export interface Inst<S extends Settings = Settings> {
	key: KeyHandle;
	settings: S;
	lastImage?: string;
	lastTitle?: string | null;
	/** 잠깐 보여 줄 제목 */
	flash?: { title: string; timer: NodeJS.Timeout };
	/** 명령을 보내고 답을 기다리는 중 → 제목 "…" */
	busy: boolean;
	/** keyDown 이 받아들여졌는지 (keyUp 짝 맞추기) */
	down: boolean;
	holdTimer?: NodeJS.Timeout;
	held?: boolean;
}

export interface RunOptions {
	timeoutMs?: number;
	/** 성공하면 ✅ */
	okMark?: boolean;
	/** 기다리는 동안 제목 "…" */
	busy?: boolean;
}

export const TITLE_APP_OFF = "앱 꺼짐";
export const TITLE_UPDATE = "업데이트\n필요";
export const TITLE_MODE_OFF = "모드\n꺼짐";

/** 실패 이유 → 잠깐 보여 줄 제목 */
const ERROR_TITLES: Record<string, string> = {
	"claude-off": TITLE_MODE_OFF,
	busy: "바빠요",
	empty: "비어\n있음",
	"screen-permission": "화면\n권한",
	"capture-failed": "캡처\n실패",
	"no-such-expression": "표정\n없음",
	timeout: "응답\n없음",
	"app-off": TITLE_APP_OFF
};

export abstract class Button<S extends Settings = Settings> {
	/** manifest 의 UUID 끝부분 (com.etude.mascot.<id>) */
	abstract readonly id: string;
	protected readonly insts = new Map<string, Inst<S>>();
	private readonly onChange = (): void => this.renderAll();

	constructor(protected readonly bridge: Bridge) {
		bridge.on("change", this.onChange);
	}

	dispose(): void {
		this.bridge.off("change", this.onChange);
		for (const id of [...this.insts.keys()]) this.disappear(id);
	}

	// ---- 각 버튼이 정하는 것 ----

	/** 기본 그림 (앱이 꺼졌을 때는 이걸 흐리게) */
	protected abstract baseArt(inst: Inst<S>): KeyArt;
	/** 앱에 붙어 있을 때의 모습 */
	protected view(inst: Inst<S>): View {
		return { art: this.baseArt(inst) };
	}
	/** 눌렀을 때 (기본: 누르는 순간 press) */
	protected onDown(inst: Inst<S>): void | Promise<void> {
		return this.press(inst);
	}
	protected onUp(_inst: Inst<S>): void | Promise<void> {}
	protected press(_inst: Inst<S>): void | Promise<void> {}
	/** 설정 화면(Property Inspector)에서 온 요청. 돌려준 값을 설정 화면으로 보낸다 */
	async fromPropertyInspector(_id: string, _payload: unknown): Promise<JsonLike | undefined> {
		return undefined;
	}

	// ---- SDK 쪽(plugin.ts)이 부르는 것 ----

	appear(key: KeyHandle, settings: S): void {
		const old = this.insts.get(key.id);
		if (old) this.clearTimers(old);
		const inst: Inst<S> = { key, settings: settings ?? ({} as S), busy: false, down: false };
		this.insts.set(key.id, inst);
		this.render(inst);
		this.instancesChanged();
	}

	disappear(id: string): void {
		const inst = this.insts.get(id);
		if (!inst) return;
		this.clearTimers(inst);
		this.insts.delete(id);
		this.instancesChanged();
	}

	settingsChanged(id: string, settings: S): void {
		const inst = this.insts.get(id);
		if (!inst) return;
		inst.settings = settings ?? ({} as S);
		this.render(inst);
	}

	async keyDown(id: string): Promise<void> {
		const inst = this.insts.get(id);
		if (!inst) return;
		inst.down = false;
		if (!this.usable()) {
			await inst.key.showAlert();
			if (!this.bridge.state.connected) this.pollSoon();
			return;
		}
		inst.down = true;
		await this.onDown(inst);
	}

	async keyUp(id: string): Promise<void> {
		const inst = this.insts.get(id);
		if (!inst || !inst.down) return;
		inst.down = false;
		await this.onUp(inst);
	}

	/** 지금 보이는 키 수 (테스트용) */
	get count(): number {
		return this.insts.size;
	}

	// ---- 그리기 ----

	renderAll(): void {
		for (const inst of this.insts.values()) this.render(inst);
	}

	protected render(inst: Inst<S>): void {
		const st = this.bridge.state;
		let v: View;
		if (!st.connected) v = { art: { ...this.baseArt(inst), dim: true, ring: undefined }, title: TITLE_APP_OFF };
		else if (st.incompatible) v = { art: { glyph: "update", bg: COLORS.amber }, title: TITLE_UPDATE };
		else {
			v = this.view(inst);
			if (inst.busy) v = { ...v, title: "…" };
			if (inst.flash) v = { ...v, title: inst.flash.title };
		}
		const image = toDataUrl(keySvg(v.art));
		if (image !== inst.lastImage) {
			inst.lastImage = image;
			void inst.key.setImage(image);
		}
		const title = v.title ?? null;
		if (title !== inst.lastTitle) {
			inst.lastTitle = title;
			void inst.key.setTitle(v.title);
		}
	}

	/** 제목을 잠깐 바꿔 보여 줌 */
	protected flash(inst: Inst<S>, title: string, ms = 2000): void {
		if (inst.flash) clearTimeout(inst.flash.timer);
		const timer = setTimeout(() => {
			if (inst.flash?.timer === timer) inst.flash = undefined;
			this.render(inst);
		}, ms);
		inst.flash = { title, timer };
		this.render(inst);
	}

	// ---- 명령 ----

	protected usable(): boolean {
		const st = this.bridge.state;
		return st.connected && !st.incompatible;
	}

	protected get state(): MascotState {
		return this.bridge.state;
	}

	/** 명령을 보내고, 실패면 ⚠️(+ 이유를 제목에 잠깐), 성공이면 (원하면) ✅ */
	protected async run(inst: Inst<S>, name: string, args: Record<string, unknown> = {}, opt: RunOptions = {}): Promise<CommandResult> {
		if (opt.busy) {
			inst.busy = true;
			this.render(inst);
		}
		let r: CommandResult;
		try {
			r = await this.bridge.command(name, args, opt.timeoutMs);
		} finally {
			if (opt.busy) {
				inst.busy = false;
				this.render(inst);
			}
		}
		if (!r.ok) this.fail(inst, r);
		else if (opt.okMark) await inst.key.showOk();
		return r;
	}

	protected fail(inst: Inst<S>, r: CommandResult): void {
		void inst.key.showAlert();
		const t = r.error ? ERROR_TITLES[r.error] : undefined;
		if (t) this.flash(inst, t);
	}

	/** 앱이 꺼져 보일 때 누르면, 혹시 방금 켜졌는지 바로 확인 */
	private pollSoon(): void {
		(this.bridge as { poll?: () => void }).poll?.();
	}

	protected instancesChanged(): void {}

	private clearTimers(inst: Inst<S>): void {
		if (inst.flash) clearTimeout(inst.flash.timer);
		if (inst.holdTimer) clearTimeout(inst.holdTimer);
		inst.flash = undefined;
		inst.holdTimer = undefined;
	}
}

/** 설정값을 문자열로 (없으면 기본값). 빈 문자열은 그대로 빈 문자열 */
export function str(v: unknown, fallback: string): string {
	return typeof v === "string" ? v : fallback;
}

/** 설정값을 양수로 (설정 화면은 숫자도 문자열로 저장할 수 있음) */
export function num(v: unknown, fallback: number): number {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}
