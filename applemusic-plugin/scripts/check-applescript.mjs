// (macOS 전용) 플러그인의 AppleScript 가 문법·Music 용어에 맞는지 osacompile 로 확인하고,
// 상태 스크립트를 실제로 한 번 돌려 본다 (Music 이 꺼져 있으면 "off" — 켜지지 않아야 함).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SCRIPTS } from "../src/music.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osa-"));
for (const [name, script] of Object.entries(SCRIPTS)) {
	execFileSync("osacompile", ["-o", path.join(dir, `${name}.scpt`), "-e", script]);
	console.log(`✓ compile ${name}`);
}
const running = () => execFileSync("pgrep", ["-x", "Music"], { encoding: "utf8" }).trim() !== "";
const safeRunning = () => {
	try {
		return running();
	} catch {
		return false;
	}
};
const before = safeRunning();
const out = execFileSync("osascript", ["-e", SCRIPTS.status], { encoding: "utf8", timeout: 20000 }).trim();
console.log(`status → ${JSON.stringify(out)}`);
if (!before && out !== "off") throw new Error("Music 이 꺼져 있는데 off 가 아님");
if (!before && safeRunning()) throw new Error("상태 확인이 Music 을 켜 버림");
console.log("✓ AppleScript OK");
