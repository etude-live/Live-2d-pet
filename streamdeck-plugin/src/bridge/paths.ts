import os from "node:os";
import path from "node:path";

/** 앱(Electron)의 userData 폴더 이름 = package.json 의 productName */
export const APP_DIR = "Live2D Desktop Mascot";

/**
 * 앱이 켜져 있는 동안 쓰는 접속 정보 파일(bridge.json)의 위치.
 * 테스트·개발용으로 MASCOT_BRIDGE_FILE 환경 변수로 바꿀 수 있다 (scripts/bridge-send.js 와 같은 규칙).
 */
export function bridgeFile(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
	if (env.MASCOT_BRIDGE_FILE) return env.MASCOT_BRIDGE_FILE;
	const home = os.homedir();
	switch (platform) {
		case "win32":
			return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), APP_DIR, "bridge.json");
		case "darwin":
			return path.join(home, "Library", "Application Support", APP_DIR, "bridge.json");
		default:
			return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), APP_DIR, "bridge.json");
	}
}
