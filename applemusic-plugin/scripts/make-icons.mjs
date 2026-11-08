// manifest 에 쓰는 기본 아이콘을 src/icons.ts 의 그림으로 만든다.  npm run icons  (Node 22.18 이상)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Resvg } from "@resvg/resvg-js";

import { keySvg, listIconSvg } from "../src/icons.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "com.etude.musiccontrol.sdPlugin", "imgs");
const write = (rel, data) => {
	const f = path.join(root, rel);
	fs.mkdirSync(path.dirname(f), { recursive: true });
	fs.writeFileSync(f, data);
};

const glyphs = { previous: "previous", playpause: "play", next: "next" };
for (const [id, g] of Object.entries(glyphs)) {
	write(`actions/${id}/key.svg`, keySvg({ glyph: g, badge: true }) + "\n");
	write(`actions/${id}/icon.svg`, listIconSvg(g) + "\n");
}
// 플러그인 아이콘은 PNG (256, @2x 512), 분류 아이콘은 SVG
const pluginSvg = keySvg({ glyph: "play", badge: true });
for (const [suffix, size] of [["", 256], ["@2x", 512]]) write(`plugin/icon${suffix}.png`, new Resvg(pluginSvg, { fitTo: { mode: "width", value: size } }).render().asPng());
write("plugin/category.svg", listIconSvg("play") + "\n");
console.log("아이콘을 만들었어요:", root);
