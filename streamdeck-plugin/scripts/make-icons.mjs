// manifest 에 쓰는 기본 아이콘(SVG)을 src/icons.ts 의 그림으로 만든다.
//   npm run icons   (Node 22.18 이상: .ts 를 바로 읽음)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Resvg } from "@resvg/resvg-js";

import { COLORS, keySvg, listIconSvg } from "../src/icons.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "com.etude.mascot.sdPlugin", "imgs");

/** 동작 id → 기본 그림 */
const ACTIONS = {
	pomodoro: { glyph: "tomato", bg: COLORS.blue },
	"pomodoro-skip": { glyph: "skip", bg: COLORS.blue },
	talk: { glyph: "talk", bg: COLORS.pink },
	stop: { glyph: "stop", bg: COLORS.blue },
	"new-chat": { glyph: "newChat", bg: COLORS.blue },
	"screen-ask": { glyph: "screen", bg: COLORS.blue },
	translate: { glyph: "translate", bg: COLORS.blue },
	polish: { glyph: "polish", bg: COLORS.blue },
	phrase: { glyph: "phrase", bg: COLORS.pink },
	usage: { glyph: "battery", bg: COLORS.blue, level: 0.6, levelColor: COLORS.green },
	expression: { glyph: "face", face: "smile", bg: COLORS.blue },
	study: { glyph: "study", bg: COLORS.blue },
	mode: { glyph: "robot", bg: COLORS.blue }
};

function write(rel, svg) {
	const f = path.join(root, rel);
	fs.mkdirSync(path.dirname(f), { recursive: true });
	fs.writeFileSync(f, svg + "\n");
}

for (const [id, art] of Object.entries(ACTIONS)) {
	write(`actions/${id}/key.svg`, keySvg(art));
	write(`actions/${id}/icon.svg`, listIconSvg(art));
}
// 플러그인 아이콘은 PNG 여야 함 (256×256, @2x 512×512)
const pluginSvg = keySvg({ glyph: "face", face: "smile", bg: COLORS.pink });
write("plugin/icon.svg", pluginSvg);
for (const [suffix, size] of [["", 256], ["@2x", 512]]) {
	const png = new Resvg(pluginSvg, { fitTo: { mode: "width", value: size } }).render().asPng();
	fs.writeFileSync(path.join(root, `plugin/icon${suffix}.png`), png);
}
// 동작 목록의 분류 아이콘
write("plugin/category.svg", listIconSvg({ glyph: "face", face: "smile" }));
console.log("아이콘을 만들었어요:", root);
