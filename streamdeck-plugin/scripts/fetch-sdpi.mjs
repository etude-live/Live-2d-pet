// 설정 화면이 쓰는 sdpi-components 를 플러그인 안에 받아 둔다 (인터넷이 없어도 설정 화면이 열리게).
// 못 받으면 설정 화면이 열릴 때 인터넷에서 불러온다 (ui/*.html 의 대체 경로).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const URL = "https://sdpi-components.dev/releases/v4/sdpi-components.js";
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "com.etude.mascot.sdPlugin", "ui", "sdpi-components.js");

const res = await fetch(URL);
if (!res.ok) throw new Error(`sdpi-components 받기 실패: ${res.status}`);
const js = await res.text();
if (!js.includes("sdpi-item")) throw new Error("받은 파일이 sdpi-components 가 아닌 것 같아요");
fs.writeFileSync(out, js);
console.log(`sdpi-components 저장: ${out} (${js.length} bytes)`);
