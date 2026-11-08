// 앱의 로컬 WebSocket 브리지에 붙는 클라이언트 (Stream Deck 과 무관한 순수 Node 코드)
//
// - bridge.json 을 pollMs(기본 3초)마다 읽어, 안 붙어 있으면 접속한다. 파일이 없으면 = 앱이 꺼짐.
// - 앱을 다시 켜면 포트·토큰이 바뀌므로, 끊기면 다음 차례에 파일을 새로 읽어 다시 붙는다.
// - welcome 을 받으면 state.get · expression.list 로 한 번 맞추고, 그 뒤는 방송으로 상태를 갱신한다.
// - 명령은 id 로 결과를 짝지어 Promise 로 돌려준다.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import WebSocket from "ws";

import { bridgeFile } from "./paths";
import { type Bridge, type CommandResult, type MascotState, initialState } from "./types";
import { PROTOCOL, isCompatible } from "./version";

export interface BridgeClientOptions {
	/** bridge.json 경로 (기본: OS 별 앱 폴더) */
	file?: string;
	/** 재접속 확인 간격 (ms) */
	pollMs?: number;
	/** 살아 있는지 확인(ping) 간격 (ms) */
	pingMs?: number;
	/** 명령 기본 제한 시간 (ms) */
	timeoutMs?: number;
	log?: (msg: string) => void;
}

interface BridgeInfo {
	host?: string;
	port: number;
	token: string;
}

interface Pending {
	name: string;
	resolve: (r: CommandResult) => void;
	timer: NodeJS.Timeout;
}

export class BridgeClient extends EventEmitter implements Bridge {
	state: MascotState = initialState();

	private readonly file: string;
	private readonly pollMs: number;
	private readonly pingMs: number;
	private readonly timeoutMs: number;
	private readonly log: (msg: string) => void;

	private ws: WebSocket | null = null;
	private pollTimer: NodeJS.Timeout | null = null;
	private pingTimer: NodeJS.Timeout | null = null;
	private lastSeen = 0;
	private seq = 0;
	private pending = new Map<number, Pending>();
	private stopped = true;

	constructor(opts: BridgeClientOptions = {}) {
		super();
		this.setMaxListeners(100); // 버튼마다 change 를 듣는다
		this.file = opts.file ?? bridgeFile();
		this.pollMs = opts.pollMs ?? 3000;
		this.pingMs = opts.pingMs ?? 15000;
		this.timeoutMs = opts.timeoutMs ?? 10000;
		this.log = opts.log ?? (() => {});
	}

	start(): void {
		if (!this.stopped) return;
		this.stopped = false;
		this.poll();
		this.pollTimer = setInterval(() => this.poll(), this.pollMs);
		this.pingTimer = setInterval(() => this.ping(), this.pingMs);
	}

	stop(): void {
		this.stopped = true;
		if (this.pollTimer) clearInterval(this.pollTimer);
		if (this.pingTimer) clearInterval(this.pingTimer);
		this.pollTimer = this.pingTimer = null;
		this.ws?.terminate();
		this.onClosed();
	}

	/** 지금 바로 bridge.json 을 다시 읽어 본다 (테스트·버튼 누름 때) */
	poll(): void {
		if (this.stopped || this.ws) return;
		const info = this.readInfo();
		if (!info) {
			this.setDisconnected();
			return;
		}
		this.connect(info);
	}

	/**
	 * 명령 보내기. 앱이 꺼져 있으면 바로 { ok:false, error:"app-off" },
	 * 시간 안에 답이 없으면 { ok:false, error:"timeout" }.
	 */
	command(name: string, args: Record<string, unknown> = {}, timeoutMs = this.timeoutMs): Promise<CommandResult> {
		const ws = this.ws;
		if (!ws || ws.readyState !== WebSocket.OPEN || !this.state.connected) return Promise.resolve({ ok: false, error: "app-off" });
		const id = ++this.seq;
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				resolve({ ok: false, error: "timeout" });
			}, timeoutMs);
			this.pending.set(id, { name, resolve, timer });
			try {
				ws.send(JSON.stringify({ v: PROTOCOL, type: "command", payload: { id, name, args }, ts: Date.now() }));
			} catch (e) {
				clearTimeout(timer);
				this.pending.delete(id);
				resolve({ ok: false, error: (e as Error).message || "send-failed" });
			}
		});
	}

	// ---- 내부 ----

	private readInfo(): BridgeInfo | null {
		try {
			const info = JSON.parse(fs.readFileSync(this.file, "utf8"));
			if (!info || !Number(info.port) || typeof info.token !== "string") return null;
			return info;
		} catch {
			return null;
		}
	}

	private connect(info: BridgeInfo): void {
		const host = info.host || "127.0.0.1";
		const url = `ws://${host}:${info.port}/?token=${encodeURIComponent(info.token)}`;
		// Node 의 ws 는 Origin 헤더를 보내지 않는다 (보내면 앱이 거절)
		const ws = new WebSocket(url, { handshakeTimeout: 2000 });
		this.ws = ws;
		ws.on("message", (data, isBinary) => {
			if (isBinary) return;
			this.lastSeen = Date.now();
			let msg: { type?: string; payload?: Record<string, unknown> };
			try {
				msg = JSON.parse(data.toString());
			} catch {
				return;
			}
			if (msg && typeof msg.type === "string") this.onMessage(msg.type, msg.payload ?? {});
		});
		ws.on("close", () => {
			if (this.ws !== ws) return;
			this.ws = null;
			this.onClosed();
		});
		ws.on("unexpected-response", (_req, res) => {
			this.log(`[bridge] 거절됨 ${res.statusCode} (토큰이 바뀌었을 수 있음)`);
			ws.terminate();
		});
		ws.on("error", () => {
			/* close 가 뒤따른다 */
		});
	}

	private onClosed(): void {
		for (const [id, p] of this.pending) {
			clearTimeout(p.timer);
			p.resolve({ ok: false, error: "app-off" });
			this.pending.delete(id);
		}
		this.setDisconnected();
	}

	private setDisconnected(): void {
		if (!this.state.connected && this.state.version === null) return;
		const wasConnected = this.state.connected;
		this.state = initialState();
		if (wasConnected) this.log("[bridge] 끊김");
		this.emit("disconnected");
		this.changed();
	}

	private ping(): void {
		const ws = this.ws;
		if (!ws || ws.readyState !== WebSocket.OPEN) return;
		// 앞선 ping 에도 아무 답이 없었으면 죽은 연결로 보고 끊는다 (다음 poll 에서 재접속)
		if (this.lastSeen && Date.now() - this.lastSeen > this.pingMs * 2 + 1000) {
			ws.terminate();
			return;
		}
		try {
			ws.send(JSON.stringify({ v: PROTOCOL, type: "ping", ts: Date.now() }));
		} catch {
			/* close 가 뒤따른다 */
		}
	}

	private changed(): void {
		this.emit("change", this.state);
	}

	private onMessage(type: string, p: Record<string, unknown>): void {
		const s = this.state;
		switch (type) {
			case "welcome": {
				s.connected = true;
				s.version = typeof p.version === "string" ? p.version : null;
				s.protocol = typeof p.protocol === "number" ? p.protocol : null;
				s.incompatible = !isCompatible(p);
				this.log(`[bridge] 접속: 앱 ${s.version} · protocol ${s.protocol}${s.incompatible ? " (맞지 않음)" : ""}`);
				this.emit("connected", s);
				this.changed();
				if (!s.incompatible) void this.sync();
				return;
			}
			case "result": {
				const id = Number(p.id);
				const pend = this.pending.get(id);
				if (!pend) return;
				clearTimeout(pend.timer);
				this.pending.delete(id);
				const { id: _id, name: _name, ...rest } = p;
				const result = { ...rest, ok: p.ok === true } as CommandResult;
				this.applyResult(pend.name, result);
				pend.resolve(result);
				return;
			}
			case "agent":
				if (p.state === "working" || p.state === "asking" || p.state === "idle") s.agent = p.state;
				break;
			case "pomodoro": {
				const { event: _e, ...rest } = p;
				s.pomodoro = rest as unknown as MascotState["pomodoro"];
				break;
			}
			case "usage":
				s.usage = p as MascotState["usage"];
				break;
			case "mode":
				s.claude = !!p.claude;
				break;
			case "study":
				s.study = !!p.on;
				break;
			case "expression":
				s.expression = typeof p.name === "string" ? p.name : null;
				break;
			case "reminder":
				this.emit("reminder", p);
				return;
			default:
				return; // pong · 모르는 방송은 무시
		}
		this.changed();
	}

	/** 명령 결과에 상태가 같이 오면 반영 (방송보다 먼저 올 수도 있어서) */
	private applyResult(name: string, r: CommandResult): void {
		if (!r.ok) return;
		const s = this.state;
		let changed = true;
		if (r.state && typeof r.state === "object" && name.startsWith("pomodoro.")) s.pomodoro = r.state as MascotState["pomodoro"];
		else if (typeof r.claude === "boolean" && name.startsWith("mode.")) s.claude = r.claude;
		else if (typeof r.study === "boolean" && name === "study.toggle") s.study = r.study;
		else if (r.usage && typeof r.usage === "object" && name === "usage.get") s.usage = r.usage as MascotState["usage"];
		else if (name === "expression.list" && Array.isArray(r.expressions)) {
			s.expressions = r.expressions.map(String);
			s.expression = typeof r.current === "string" ? r.current : null;
		} else changed = false;
		if (changed) this.changed();
	}

	/** 처음 붙었을 때 지금 상태를 한 번 맞춤 */
	private async sync(): Promise<void> {
		const st = await this.command("state.get");
		if (st.ok) {
			const s = this.state;
			if (typeof st.claude === "boolean") s.claude = st.claude;
			if (st.agent === "working" || st.agent === "asking" || st.agent === "idle") s.agent = st.agent;
			if (st.pomodoro && typeof st.pomodoro === "object") s.pomodoro = st.pomodoro as MascotState["pomodoro"];
			if (st.usage && typeof st.usage === "object") s.usage = st.usage as MascotState["usage"];
			// 앱이 나중에 state.get 에 넣어 주면 바로 쓰도록 (지금은 없음)
			if (typeof st.study === "boolean") s.study = st.study;
			if (typeof st.expression === "string" || st.expression === null) s.expression = (st.expression as string | null) ?? null;
			this.changed();
		}
		await this.command("expression.list");
	}
}
