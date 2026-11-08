// 빌드된 플러그인(bin/plugin.js)을 가짜 Stream Deck 과 가짜 osascript 사이에서 실행해 본다.
//   npm run build && npm run e2e
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));
const sdPlugin = path.resolve(here, "..", "com.etude.musiccontrol.sdPlugin");
const U = "com.etude.musiccontrol";
const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "music-e2e-")), "music.json");
const writeState = (s) => fs.writeFileSync(stateFile, JSON.stringify(s));
const readState = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
writeState({ running: false, state: "paused", track: "밤양갱", artist: "비비", calls: [] });

const got = [];
const sd = new WebSocketServer({ port: 0, host: "127.0.0.1" });
await new Promise((r) => sd.once("listening", r));
let sock;
sd.on("connection", (ws) => {
	sock = ws;
	ws.on("message", (d) => got.push(JSON.parse(String(d))));
});
const device = "DEV1";
const info = { application: { language: "ko", platform: "mac", version: "6.9.0" }, plugin: { uuid: U, version: "1.0.0.0" }, devicePixelRatio: 2, colors: {}, devices: [{ id: device, name: "SD", size: { columns: 5, rows: 3 }, type: 0 }] };
const child = spawn(process.execPath, ["bin/plugin.js", "-port", String(sd.address().port), "-pluginUUID", U, "-registerEvent", "registerPlugin", "-info", JSON.stringify(info)], {
	cwd: sdPlugin,
	env: { ...process.env, FAKE_MUSIC_FILE: stateFile, MUSIC_OSASCRIPT: path.join(here, "fake-osascript.mjs"), MUSIC_OPEN: path.join(here, "fake-open.mjs") },
	stdio: ["ignore", "pipe", "pipe"]
});
let stderr = "";
child.stderr.on("data", (d) => (stderr += d));
const wait = async (cond, what, ms = 8000) => {
	const end = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > end) throw new Error(`시간 초과: ${what}\n${JSON.stringify(got.slice(-4))}\n${stderr}`);
		await new Promise((r) => setTimeout(r, 25));
	}
};
const send = (event, id, ctx) => sock.send(JSON.stringify({ event, action: `${U}.${id}`, context: ctx, device, payload: { controller: "Keypad", coordinates: { column: 0, row: 0 }, isInMultiAction: false, settings: {}, state: 0 } }));
const title = (ctx) => got.filter((m) => m.event === "setTitle" && m.context === ctx).at(-1)?.payload.title;

try {
	await wait(() => got.some((m) => m.event === "registerPlugin"), "등록");
	send("willAppear", "playpause", "p");
	send("willAppear", "next", "n");
	await wait(() => title("p") === "Music 열기\n실행 중 아님", "꺼짐 표시");

	send("keyDown", "playpause", "p");
	await wait(() => readState().opened === 1, "Music 열기");
	await wait(() => title("p") === "일시정지", "켜진 뒤 일시정지 표시");

	send("keyDown", "playpause", "p");
	await wait(() => title("p") === "밤양갱", "재생 중 곡 제목");
	send("keyDown", "next", "n");
	await wait(() => readState().calls.includes("next"), "다음 곡");
	console.log("✅ e2e: 꺼짐 표시 → 열기 → 재생 → 곡 제목 → 다음 곡 모두 OK");
} catch (e) {
	console.error("❌", e.message);
	process.exitCode = 1;
} finally {
	child.kill();
	sd.close();
}
