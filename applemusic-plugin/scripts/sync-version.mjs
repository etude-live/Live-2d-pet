// package.json 의 version(MAJOR.MINOR.PATCH)을 manifest.json 의 Version(MAJOR.MINOR.PATCH.0)에 맞춘다.
//   node scripts/sync-version.mjs [PATCH]   ← CI 는 PATCH 에 실행 번호를 넣는다
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const [major, minor, patch] = pkg.version.split(".").map(Number);
const p = process.argv[2] !== undefined ? Number(process.argv[2]) : patch;
const version = `${major}.${minor}.${p}`;
const mf = path.join(root, "com.etude.musiccontrol.sdPlugin", "manifest.json");
const manifest = JSON.parse(fs.readFileSync(mf, "utf8"));
manifest.Version = `${version}.0`;
fs.writeFileSync(mf, JSON.stringify(manifest, null, "\t") + "\n");
console.log(version);
