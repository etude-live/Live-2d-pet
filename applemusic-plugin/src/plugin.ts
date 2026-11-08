// Stream Deck 과 버튼 로직을 잇는 곳
import streamDeck, { type KeyDownEvent, SingletonAction, type WillAppearEvent, type WillDisappearEvent } from "@elgato/streamdeck";

import { type KeyHandle, MusicButton, createButtons } from "./buttons";
import { Music } from "./music";

export const PLUGIN_UUID = "com.etude.musiccontrol";

streamDeck.logger.setLevel("info");

const music = new Music();
const buttons = createButtons(music);

/** 보이는 버튼이 있을 때만 Music 상태를 확인 (1.5초마다) */
function updatePolling(): void {
	if (buttons.some((b) => b.count > 0)) music.start();
	else music.stop();
}

class Adapter extends SingletonAction {
	override readonly manifestId: string;

	constructor(private readonly button: MusicButton) {
		super();
		this.manifestId = `${PLUGIN_UUID}.${button.id}`;
	}

	override onWillAppear(ev: WillAppearEvent): void {
		if (!ev.action.isKey()) return;
		const a = ev.action;
		const key: KeyHandle = {
			id: a.id,
			setImage: (img) => a.setImage(img).catch(() => {}),
			setTitle: (t) => a.setTitle(t).catch(() => {}),
			showAlert: () => a.showAlert().catch(() => {}),
			showOk: () => a.showOk().catch(() => {})
		};
		this.button.appear(key);
		updatePolling();
	}

	override onWillDisappear(ev: WillDisappearEvent): void {
		this.button.disappear(ev.action.id);
		updatePolling();
	}

	override async onKeyDown(ev: KeyDownEvent): Promise<void> {
		await this.button.press(ev.action.id);
	}
}

for (const b of buttons) streamDeck.actions.registerAction(new Adapter(b));
streamDeck.connect();
