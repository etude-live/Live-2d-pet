// Stream Deck 과 버튼 로직을 잇는 곳 (얇게 유지 — 로직은 src/buttons, 접속은 src/bridge)
import streamDeck, {
	type KeyDownEvent,
	type KeyUpEvent,
	type DidReceiveSettingsEvent,
	type SendToPluginEvent,
	SingletonAction,
	type WillAppearEvent,
	type WillDisappearEvent
} from "@elgato/streamdeck";

import { BridgeClient } from "./bridge/client";
import type { Button, KeyHandle } from "./buttons/base";
import { createButtons } from "./buttons/buttons";

export const PLUGIN_UUID = "com.etude.mascot";

streamDeck.logger.setLevel("info");
const log = streamDeck.logger.createScope("bridge");

const bridge = new BridgeClient({ log: (m) => log.info(m) });
bridge.on("reminder", (p: { text?: string }) => log.info(`알림: ${p?.text ?? ""}`));

/** 버튼 로직 하나를 Stream Deck 동작(action) 하나로 등록 */
class Adapter extends SingletonAction {
	override readonly manifestId: string;

	constructor(private readonly button: Button) {
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
		this.button.appear(key, ev.payload.settings as Record<string, unknown>);
	}

	override onWillDisappear(ev: WillDisappearEvent): void {
		this.button.disappear(ev.action.id);
	}

	override onDidReceiveSettings(ev: DidReceiveSettingsEvent): void {
		this.button.settingsChanged(ev.action.id, ev.payload.settings as Record<string, unknown>);
	}

	override async onKeyDown(ev: KeyDownEvent): Promise<void> {
		await this.button.keyDown(ev.action.id);
	}

	override async onKeyUp(ev: KeyUpEvent): Promise<void> {
		await this.button.keyUp(ev.action.id);
	}

	override async onSendToPlugin(ev: SendToPluginEvent<Parameters<typeof streamDeck.ui.sendToPropertyInspector>[0], WillAppearEvent["payload"]["settings"]>): Promise<void> {
		const reply = await this.button.fromPropertyInspector(ev.action.id, ev.payload);
		if (reply !== undefined) await streamDeck.ui.sendToPropertyInspector(reply as Parameters<typeof streamDeck.ui.sendToPropertyInspector>[0]);
	}
}

for (const button of createButtons(bridge)) streamDeck.actions.registerAction(new Adapter(button));

bridge.start();
streamDeck.connect();
