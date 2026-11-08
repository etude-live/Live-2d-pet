#!/usr/bin/env node
// e2e 용 가짜 osascript: `osascript -e <스크립트>` 를 흉내.
// 상태는 FAKE_MUSIC_FILE(JSON)에 두고, 받은 명령은 같은 파일의 calls 에 기록.
import fs from "node:fs";
const file = process.env.FAKE_MUSIC_FILE;
const s = JSON.parse(fs.readFileSync(file, "utf8"));
const script = process.argv[3] ?? "";
let out = "ok";
if (!s.running) out = "off";
else if (script.includes("player state")) out = `${s.state}\t${s.track}\t${s.artist}`;
else if (script.includes("playpause")) (s.state = s.state === "playing" ? "paused" : "playing"), s.calls.push("playpause");
else if (script.includes("next track")) s.calls.push("next");
else if (script.includes("back track")) s.calls.push("previous");
fs.writeFileSync(file, JSON.stringify(s));
process.stdout.write(out + "\n");
