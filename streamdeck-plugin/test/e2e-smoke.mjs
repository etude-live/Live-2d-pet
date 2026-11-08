// 빌드된 플러그인(bin/plugin.js)을 진짜로 띄워 보는 확인:
// 가짜 Stream Deck 앱(WebSocket) + 가짜 마스코트 앱 사이에서 버튼을 눌러 본다.
//   npm run build && node test/e2e-smoke.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

import { MockApp } from "./mock-app.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const sdPlugin = path.resolve(here, "..", "com.etude.mascot.sdPlugin");
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sd-e2e-")), "bridge.json");
const U = "com.etude.mascot";

const app = new MockApp({ file });
await app.start();

const got = []; // 플러그인 → Stream Deck
const sd = new WebSocketServer({ port: 0, host: "127.0.0.1" });
await new Promise((r) => sd.once("listening", r));
let sock;
sd.on("connection", (ws) => {
	sock = ws;
	ws.on("message", (d) => got.push(JSON.parse(String(d))));
});

const device = "DEV1";
const info = {
	application: { font: "", language: "ko", platform: "mac", platformVersion: "15.0", version: "6.9.0.21000" },
	plugin: { uuid: U, version: "1.0.0.0" },
	devicePixelRatio: 2,
	colors: {},
	devices: [{ id: device, name: "Stream Deck", size: { columns: 5, rows: 3 }, type: 0 }]
};
const child = spawn(process.execPath, ["bin/plugin.js", "-port", String(sd.address().port), "-pluginUUID", U, "-registerEvent", "registerPlugin", "-info", JSON.stringify(info)], {
	cwd: sdPlugin,
	env: { ...process.env, MASCOT_BRIDGE_FILE: file },
	stdio: ["ignore", "pipe", "pipe"]
});
let stderr = "";
child.stderr.on("data", (d) => (stderr += d));

const wait = async (cond, what, ms = 5000) => {
	const end = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > end) throw new Error(`시간 초과: ${what}\n받은 것: ${JSON.stringify(got.slice(-5))}\n${stderr}`);
		await new Promise((r) => setTimeout(r, 20));
	}
};
const send = (event, action, context, payload = {}) => sock.send(JSON.stringify({ event, action, context, device, payload }));
const keyPayload = (row, col, settings = {}) => ({ controller: "Keypad", coordinates: { column: col, row }, isInMultiAction: false, settings, state: 0 });

try {
	await wait(() => got.some((m) => m.event === "registerPlugin"), "등록");
	send("deviceDidConnect", undefined, undefined);
	sock.send(JSON.stringify({ event: "deviceDidConnect", device, deviceInfo: info.devices[0] }));

	send("willAppear", `${U}.pomodoro`, "ctx-pomo", keyPayload(0, 0));
	send("willAppear", `${U}.mode`, "ctx-mode", keyPayload(2, 4));
	await wait(() => app.names().includes("expression.list"), "앱과 동기화");
	await wait(() => got.some((m) => m.event === "setTitle" && m.context === "ctx-mode" && m.payload.title === "켜짐"), "Claude 모드 '켜짐'");

	send("keyDown", `${U}.pomodoro`, "ctx-pomo", keyPayload(0, 0));
	send("keyUp", `${U}.pomodoro`, "ctx-pomo", keyPayload(0, 0));
	await wait(() => app.names().includes("pomodoro.toggle"), "pomodoro.toggle 전송");
	await wait(() => got.some((m) => m.event === "setTitle" && m.context === "ctx-pomo" && m.payload.title === "25:00"), "포모도로 제목 25:00");
	const img = got.filter((m) => m.event === "setImage" && m.context === "ctx-pomo").at(-1);
	if (!decodeURIComponent(img.payload.image).includes("#f0616d")) throw new Error("집중 중인데 빨간 그림이 아님");

	await app.stop();
	await wait(() => got.some((m) => m.event === "setTitle" && m.context === "ctx-mode" && m.payload.title === "앱 꺼짐"), "앱 꺼짐 표시");
	console.log("✅ e2e: 등록 → 동기화 → 버튼 누름 → 상태 표시 → 앱 꺼짐 표시 모두 OK");
} catch (e) {
	console.error("❌", e.message);
	process.exitCode = 1;
} finally {
	child.kill();
	sd.close();
	await app.stop().catch(() => {});
}
