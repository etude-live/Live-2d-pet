// 버튼 3개 (⏮ 이전 · ⏯ 재생/일시정지 · ⏭ 다음). Stream Deck SDK 와 무관 → 가짜 키로 테스트.
//
// - Music 이 꺼져 있으면: 흐린 그림 + "Music 열기 / 실행 중 아님", 누르면 Music 을 연다
// - 제어 권한이 없으면: 주황 배지 + "권한 필요", 누르면 ⚠️
// - ⏯ 은 재생 중이면 ❚❚ + 곡 제목, 멈춰 있으면 ▶ + "일시정지"
import { type KeyArt, keySvg, toDataUrl } from "./icons";
import type { Command, Music } from "./music";

export interface KeyHandle {
	readonly id: string;
	setImage(image?: string): unknown;
	setTitle(title?: string): unknown;
	showAlert(): unknown;
	showOk(): unknown;
}

export interface View {
	art: KeyArt;
	title?: string;
}

export const TITLE_OFF = "Music 열기\n실행 중 아님";
export const TITLE_DENIED = "권한 필요";
export const TITLE_PAUSED = "일시정지";

/** 버튼 제목 한 줄에 들어갈 만큼 자르기 (한글 기준 약 7자) */
export function shorten(text: string, max = 7): string {
	const chars = [...text.trim()];
	return chars.length <= max ? chars.join("") : chars.slice(0, max - 1).join("") + "…";
}

interface Inst {
	key: KeyHandle;
	lastImage?: string;
	lastTitle?: string | null;
}

export class MusicButton {
	private readonly insts = new Map<string, Inst>();
	private readonly onChange = (): void => this.renderAll();

	constructor(
		readonly command: Command,
		private readonly music: Music
	) {
		music.on("change", this.onChange);
	}

	/** manifest UUID 끝부분 */
	get id(): string {
		return this.command;
	}

	get count(): number {
		return this.insts.size;
	}

	dispose(): void {
		this.music.off("change", this.onChange);
		this.insts.clear();
	}

	appear(key: KeyHandle): void {
		this.insts.set(key.id, { key });
		this.render(this.insts.get(key.id)!);
	}

	disappear(id: string): void {
		this.insts.delete(id);
	}

	async press(id: string): Promise<void> {
		const inst = this.insts.get(id);
		if (!inst) return;
		const s = this.music.status.state;
		if (s === "off") {
			await this.music.open();
			return;
		}
		const r = await this.music.command(this.command);
		if (r === "off") await this.music.open();
		else if (r !== "ok") await inst.key.showAlert();
	}

	view(): View {
		const st = this.music.status;
		const isPlay = this.command === "playpause";
		const glyph = isPlay ? (st.state === "playing" ? "pause" : "play") : this.command;
		if (st.state === "off") return { art: { glyph, dim: true }, title: TITLE_OFF };
		if (st.state === "denied") return { art: { glyph, warn: true }, title: TITLE_DENIED };
		if (!isPlay) return { art: { glyph } };
		if (st.state === "playing") return { art: { glyph }, title: st.track ? shorten(st.track) : undefined };
		if (st.state === "paused") return { art: { glyph }, title: TITLE_PAUSED };
		return { art: { glyph } };
	}

	renderAll(): void {
		for (const inst of this.insts.values()) this.render(inst);
	}

	private render(inst: Inst): void {
		const v = this.view();
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
}

export function createButtons(music: Music): MusicButton[] {
	return [new MusicButton("previous", music), new MusicButton("playpause", music), new MusicButton("next", music)];
}
