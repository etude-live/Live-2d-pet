#!/usr/bin/env node
// e2e 용 가짜 `open -a Music`: Music 을 켠 것으로 표시
import fs from "node:fs";
const file = process.env.FAKE_MUSIC_FILE;
const s = JSON.parse(fs.readFileSync(file, "utf8"));
s.running = true;
s.opened = (s.opened ?? 0) + 1;
fs.writeFileSync(file, JSON.stringify(s));
