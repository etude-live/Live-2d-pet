// 앱의 진짜 서버 코드(../src/main/bridge.js)에 붙어 보기. Electron 없이 돌아가는 파일이라 그대로 띄울 수 있다.
// (앱 저장소의 node_modules 가 없어도 되게, ws 는 플러그인 쪽 것을 빌려 준다)
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BridgeClient } from "../src/bridge/client";
import { waitFor } from "./helpers";

const bridgeJs = path.resolve(__dirname, "..", "..", "src", "main", "bridge.js");
const req = createRequire(path.resolve(__dirname, "..", "package.json"));

type Started = { info: { port: number; token: string }; file: string; send: (c: number, m: unknown) => void; broadcast: (m: unknown) => void; stop: () => void };
type StartBridge = (o: { dir: string; version: string; onEvent: (m: { type: string; payload: any; client: number }) => void }) => Promise<Started>;

function loadStartBridge(): StartBridge {
	const src = fs.readFileSync(bridgeJs, "utf8");
	const mod = { exports: {} as { startBridge: StartBridge } };
	new Function("require", "module", "exports", src)((n: string) => req(n), mod, mod.exports);
	return mod.exports.startBridge;
}

let stops: (() => void)[] = [];
afterEach(() => {
	stops.forEach((s) => s());
	stops = [];
});

describe.skipIf(!fs.existsSync(bridgeJs))("진짜 앱 브리지(src/main/bridge.js)", () => {
	it("bridge.json 으로 접속 → welcome(protocol 1) → 명령/결과 → 방송 → 종료 시 끊김", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "real-bridge-"));
		const commands: string[] = [];
		// eslint-disable-next-line prefer-const
		let server: Started;
		const onEvent = (m: { type: string; payload: any; client: number }) => {
			if (m.type !== "command") return;
			commands.push(m.payload.name);
			const extra = m.payload.name === "expression.list" ? { expressions: ["smile"], current: null } : m.payload.name === "state.get" ? { claude: true, agent: "idle" } : {};
			server.send(m.client, { type: "result", payload: { id: m.payload.id, name: m.payload.name, ok: true, ...extra } });
		};
		server = await loadStartBridge()({ dir, version: "2.0.1", onEvent });
		stops.push(() => server.stop());

		const client = new BridgeClient({ file: path.join(dir, "bridge.json"), pollMs: 40 });
		client.start();
		stops.push(() => client.stop());
		await waitFor(() => client.state.expressions !== null, 3000, "접속·동기화");
		expect(client.state).toMatchObject({ connected: true, version: "2.0.1", protocol: 1, incompatible: false, claude: true, expressions: ["smile"] });
		expect(commands).toEqual(["state.get", "expression.list"]);

		expect(await client.command("pomodoro.toggle")).toEqual({ ok: true });
		server.broadcast({ type: "mode", payload: { claude: false } });
		await waitFor(() => client.state.claude === false, 2000, "방송");

		server.stop();
		await waitFor(() => !client.state.connected, 2000, "끊김");
	});
});
