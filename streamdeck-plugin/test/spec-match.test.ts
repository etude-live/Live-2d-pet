// 플러그인이 보내는 명령이 진짜 앱(handleCommand)과 문서(docs/STREAMDECK.md) 양쪽에 다 있는지 대조
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..", "..");
const mainJs = path.join(root, "src", "main", "main.js");
const doc = path.join(root, "docs", "STREAMDECK.md");
const read = (f: string) => fs.readFileSync(f, "utf8");

/** 플러그인 소스에 나오는 "xxx.yyy" 명령 이름 */
function pluginCommands(): string[] {
	const src = read(path.join(__dirname, "..", "src", "buttons", "buttons.ts")) + read(path.join(__dirname, "..", "src", "bridge", "client.ts"));
	const names = [...src.matchAll(/["'](pomodoro|talk|agent|clip|screen|usage|expression|motion|study|mode|state)\.([a-zA-Z]+)["']/g)].map((m) => `${m[1]}.${m[2]}`);
	return [...new Set(names)].sort();
}

describe.skipIf(!fs.existsSync(mainJs))("명령 이름 대조", () => {
	const used = pluginCommands();

	it("버튼이 쓰는 명령 목록", () => {
		expect(used).toEqual(
			[
				"agent.newChat",
				"agent.stop",
				"clip.polish",
				"clip.translate",
				"expression.list",
				"expression.set",
				"mode.toggle",
				"motion.play",
				"pomodoro.pause",
				"pomodoro.skip",
				"pomodoro.toggle",
				"screen.ask",
				"state.get",
				"study.toggle",
				"talk.send",
				"talk.toggle",
				"usage.get"
			].sort()
		);
	});

	it("모두 앱의 handleCommand() 에 있음", () => {
		const cases = new Set([...read(mainJs).matchAll(/case '([a-zA-Z]+\.[a-zA-Z]+)'/g)].map((m) => m[1]));
		expect(used.filter((n) => !cases.has(n))).toEqual([]);
	});

	it("모두 docs/STREAMDECK.md 명령 표에 있음", () => {
		const rows = new Set([...read(doc).matchAll(/^\| `([a-zA-Z]+\.[a-zA-Z]+)` \|/gm)].map((m) => m[1]));
		expect(used.filter((n) => !rows.has(n))).toEqual([]);
	});

	it("받는 방송 이름도 문서에 있음", () => {
		const text = read(doc);
		for (const t of ["welcome", "agent", "pomodoro", "usage", "mode", "study", "expression", "reminder"]) expect(text).toContain(`| \`${t}\` |`);
	});
});
