import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { BridgeClient } from "../src/bridge/client";
import { MockApp } from "./mock-app";
import { setup, sleep, tmpBridgeFile, waitFor } from "./helpers";

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const c of cleanup.reverse()) await c();
	cleanup = [];
});

describe("BridgeClient: 접속", () => {
	it("bridge.json 이 없으면 꺼짐, 생기면 붙고 state.get · expression.list 로 맞춘다", async () => {
		const t = await setup({ claude: false }, false);
		cleanup.push(t.close);
		await sleep(150);
		expect(t.client.state.connected).toBe(false);
		await t.app.start();
		await waitFor(() => t.client.state.expressions !== null, 3000, "동기화");
		expect(t.client.state.connected).toBe(true);
		expect(t.client.state.version).toBe("2.0.0");
		expect(t.client.state.claude).toBe(false);
		expect(t.app.names().slice(0, 2)).toEqual(["state.get", "expression.list"]);
		expect(t.client.state.expressions).toEqual(["smile", "angry", "sad"]);
		expect(t.app.rejectedOrigins).toBe(0); // Origin 헤더를 보내지 않음
	});

	it("앱이 꺼지면 끊김, 다시 켜면(포트·토큰이 바뀜) 다시 붙는다", async () => {
		const t = await setup();
		cleanup.push(t.close);
		const oldPort = t.app.port;
		await t.app.stop();
		await waitFor(() => !t.client.state.connected, 2000, "끊김");
		expect(fs.existsSync(t.file)).toBe(false);

		const app2 = new MockApp({ file: t.file });
		cleanup.push(() => app2.stop());
		await app2.start();
		expect(app2.token).not.toBe(t.app.token);
		await waitFor(() => t.client.state.connected, 2000, "재접속");
		expect(app2.port).not.toBe(oldPort);
	});

	it("bridge.json 이 남아 있어도 앱이 죽어 있으면 꺼짐으로 보고 계속 다시 시도", async () => {
		const file = tmpBridgeFile();
		fs.writeFileSync(file, JSON.stringify({ v: 1, host: "127.0.0.1", port: 1, token: "x" }));
		const client = new BridgeClient({ file, pollMs: 30 });
		client.start();
		cleanup.push(async () => client.stop());
		await sleep(200);
		expect(client.state.connected).toBe(false);
	});

	it("앱이 꺼져 있으면 명령은 바로 app-off", async () => {
		const client = new BridgeClient({ file: tmpBridgeFile(), pollMs: 30 });
		expect(await client.command("pomodoro.toggle")).toEqual({ ok: false, error: "app-off" });
	});

	it("protocol 이 다르면 incompatible (명령으로 동기화하지 않음)", async () => {
		const t = await setup({ protocol: 2, version: "3.0.0" }, false);
		cleanup.push(t.close);
		await t.app.start();
		await waitFor(() => t.client.state.connected, 2000, "접속");
		expect(t.client.state.incompatible).toBe(true);
		await sleep(100);
		expect(t.app.received).toEqual([]);
	});

	it("2.0.0 이전 앱도 incompatible", async () => {
		const t = await setup({ version: "1.5.0" }, false);
		cleanup.push(t.close);
		await t.app.start();
		await waitFor(() => t.client.state.connected, 2000, "접속");
		expect(t.client.state.incompatible).toBe(true);
	});
});

describe("BridgeClient: 명령과 방송", () => {
	it("명령 결과를 id 로 짝짓고, 결과의 상태도 반영", async () => {
		const t = await setup();
		cleanup.push(t.close);
		const r = await t.client.command("pomodoro.toggle", { work: 30 });
		expect(r.ok).toBe(true);
		expect(t.client.state.pomodoro?.running).toBe(true);
		expect(t.client.state.pomodoro?.remainingSec).toBe(1800);
		const [a, b] = await Promise.all([t.client.command("mode.toggle"), t.client.command("no.such")]);
		expect(a).toMatchObject({ ok: true, claude: false });
		expect(b).toEqual({ ok: false, error: "unknown-command" });
	});

	it("답이 없으면 timeout", async () => {
		const t = await setup();
		cleanup.push(t.close);
		t.app.respond("clip.translate", () => new Promise(() => {}));
		expect(await t.client.command("clip.translate", {}, 100)).toEqual({ ok: false, error: "timeout" });
	});

	it("방송(agent·pomodoro·usage·mode·study·expression)으로 상태 갱신, 모르는 방송은 무시", async () => {
		const t = await setup();
		cleanup.push(t.close);
		const s = t.client.state;
		t.app.broadcast("agent", { state: "asking" });
		t.app.broadcast("pomodoro", { event: "tick", running: true, paused: false, phase: "break", remainingSec: 61 });
		t.app.broadcast("usage", { five_hour: { utilization: 0.42, resetsAt: Date.now() + 1e6 } });
		t.app.broadcast("mode", { claude: false });
		t.app.broadcast("study", { on: true });
		t.app.broadcast("expression", { name: "angry" });
		t.app.broadcast("something-new", { x: 1 });
		await waitFor(() => s.expression === "angry", 2000, "방송");
		expect(s.agent).toBe("asking");
		expect(s.pomodoro).toMatchObject({ phase: "break", remainingSec: 61 });
		expect(s.pomodoro).not.toHaveProperty("event");
		expect(s.usage.five_hour?.utilization).toBe(0.42);
		expect(s.claude).toBe(false);
		expect(s.study).toBe(true);
	});

	it("reminder 방송은 이벤트로 전달", async () => {
		const t = await setup();
		cleanup.push(t.close);
		const got: unknown[] = [];
		t.client.on("reminder", (p) => got.push(p));
		t.app.broadcast("reminder", { text: "물 마시기" });
		await waitFor(() => got.length === 1);
		expect(got[0]).toEqual({ text: "물 마시기" });
	});
});
