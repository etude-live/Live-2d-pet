import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { BridgeClient } from "../src/bridge/client";
import type { KeyHandle } from "../src/buttons/base";
import { MockApp, type MockOptions } from "./mock-app";

/** 스트림덱 키 대신 쓰는 가짜 키: 무엇을 그리라고 했는지 기록 */
export class FakeKey implements KeyHandle {
	images: (string | undefined)[] = [];
	titles: (string | undefined)[] = [];
	alerts = 0;
	oks = 0;
	constructor(readonly id = "key-" + Math.random().toString(36).slice(2)) {}
	setImage(img?: string): void {
		this.images.push(img);
	}
	setTitle(t?: string): void {
		this.titles.push(t);
	}
	showAlert(): void {
		this.alerts++;
	}
	showOk(): void {
		this.oks++;
	}
	get title(): string | undefined {
		return this.titles[this.titles.length - 1];
	}
	/** 지금 그림(SVG 원문) */
	get svg(): string {
		const img = this.images[this.images.length - 1] ?? "";
		return decodeURIComponent(img.replace(/^data:image\/svg\+xml;charset=utf8,/, ""));
	}
	/** 지금 그림의 배경색 */
	get bg(): string | undefined {
		return /<rect width="144" height="144" fill="([^"]+)"/.exec(this.svg)?.[1];
	}
}

export async function waitFor(cond: () => unknown, ms = 3000, what = "조건"): Promise<void> {
	const end = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > end) throw new Error(`${what}을(를) 기다리다 시간 초과`);
		await new Promise((r) => setTimeout(r, 10));
	}
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function tmpBridgeFile(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mascot-sd-"));
	return path.join(dir, "bridge.json");
}

/** 가짜 앱 + 거기 붙은 클라이언트 */
export async function setup(opts: Partial<MockOptions> = {}, connect = true) {
	const file = tmpBridgeFile();
	const app = new MockApp({ file, ...opts });
	const client = new BridgeClient({ file, pollMs: 40, pingMs: 1000, timeoutMs: 1500 });
	if (connect) await app.start();
	client.start();
	if (connect) await waitFor(() => client.state.connected && client.state.expressions !== null, 3000, "접속");
	return {
		file,
		app,
		client,
		async close() {
			client.stop();
			await app.stop();
		}
	};
}
