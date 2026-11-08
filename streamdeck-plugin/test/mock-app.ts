// 가짜 마스코트 앱 (브리지 서버만 흉내). 테스트와 `npm run mock` 에서 쓴다.
// 진짜 앱(src/main/bridge.js · handleCommand)과 같은 규칙:
// - 127.0.0.1, 토큰 확인, Origin 헤더 거절
// - bridge.json { v, app, version, host, port, token, pid, startedAt }
// - 접속하면 welcome, ping → pong, command → result(보낸 쪽에만), 상태는 broadcast
//
// 이 파일은 ws 말고는 import 하지 않는다 (Node 가 .ts 를 바로 읽을 수 있게).
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";

export interface MockOptions {
	/** bridge.json 을 쓸 경로 */
	file: string;
	version?: string;
	protocol?: number;
	expressions?: string[];
	claude?: boolean;
	/** 실제 1초 타이머로 포모도로를 돌릴지 (수동 테스트용) */
	realTimer?: boolean;
	log?: (msg: string) => void;
}

export interface ReceivedCommand {
	name: string;
	args: Record<string, unknown>;
}

type Result = Record<string, unknown> & { ok: boolean };
type Handler = (args: Record<string, unknown>) => Result | Promise<Result>;

export class MockApp {
	readonly received: ReceivedCommand[] = [];
	port = 0;
	token = crypto.randomBytes(12).toString("hex");
	rejectedOrigins = 0;

	state = {
		claude: true,
		study: false,
		agent: "idle" as "idle" | "working" | "asking",
		expression: null as string | null,
		expressions: [] as string[],
		usage: {} as Record<string, unknown>,
		pomodoro: { running: false, paused: false, phase: "idle", remainingSec: 0, cycle: 0, cycles: 4, minutes: { work: 25, break: 5, long: 15 } }
	};

	private server: http.Server | null = null;
	private wss: WebSocketServer | null = null;
	private overrides = new Map<string, Handler>();
	private timer: NodeJS.Timeout | null = null;

	private readonly opt: MockOptions;

	constructor(opt: MockOptions) {
		this.opt = opt;
		this.state.expressions = opt.expressions ?? ["smile", "angry", "sad"];
		this.state.claude = opt.claude ?? true;
	}

	async start(port = 0): Promise<void> {
		this.server = http.createServer((_req, res) => {
			res.writeHead(426);
			res.end();
		});
		this.wss = new WebSocketServer({
			server: this.server,
			verifyClient: (info, cb) => {
				if (info.origin) {
					this.rejectedOrigins++;
					return cb(false, 403, "Forbidden");
				}
				const t = new URL(info.req.url ?? "/", "http://x").searchParams.get("token");
				if (t !== this.token) return cb(false, 401, "Unauthorized");
				cb(true);
			}
		});
		this.wss.on("connection", (ws) => this.onConnection(ws));
		await new Promise<void>((resolve) => this.server!.listen(port, "127.0.0.1", resolve));
		this.port = (this.server.address() as { port: number }).port;
		fs.mkdirSync(path.dirname(this.opt.file), { recursive: true });
		fs.writeFileSync(
			this.opt.file,
			JSON.stringify({ v: 1, app: "live2d-desktop-mascot", version: this.opt.version ?? "2.0.0", host: "127.0.0.1", port: this.port, token: this.token, pid: process.pid, startedAt: new Date().toISOString() })
		);
		this.log(`가짜 앱 대기: ws://127.0.0.1:${this.port} (${this.opt.file})`);
	}

	/** 앱 끄기: 접속을 끊고 bridge.json 을 지움 */
	async stop(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		try {
			fs.unlinkSync(this.opt.file);
		} catch {
			/* 없음 */
		}
		for (const c of this.wss?.clients ?? []) c.terminate();
		await new Promise<void>((r) => (this.wss ? this.wss.close(() => r()) : r()));
		await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
		this.wss = null;
		this.server = null;
	}

	get clientCount(): number {
		return this.wss?.clients.size ?? 0;
	}

	/** 이 명령의 답을 바꿔 치기 (예: { ok:false, error:"claude-off" }) */
	respond(name: string, handler: Handler | Result): void {
		this.overrides.set(name, typeof handler === "function" ? handler : () => handler);
	}

	broadcast(type: string, payload: unknown = {}): void {
		const text = JSON.stringify({ v: 1, type, payload, ts: Date.now() });
		for (const c of this.wss?.clients ?? []) if (c.readyState === 1) c.send(text);
	}

	/** 마지막으로 받은 명령 이름들 */
	names(): string[] {
		return this.received.map((c) => c.name);
	}

	// ---- 내부 ----

	private log(m: string): void {
		this.opt.log?.(m);
	}

	private onConnection(ws: WebSocket): void {
		ws.send(JSON.stringify({ v: 1, type: "welcome", payload: { app: "live2d-desktop-mascot", version: this.opt.version ?? "2.0.0", protocol: this.opt.protocol ?? 1 }, ts: Date.now() }));
		ws.on("message", async (data) => {
			let msg: { v?: number; type?: string; payload?: { id?: unknown; name?: string; args?: Record<string, unknown> } };
			try {
				msg = JSON.parse(String(data));
			} catch {
				return;
			}
			if (msg.v !== 1) return;
			if (msg.type === "ping") return ws.send(JSON.stringify({ v: 1, type: "pong", ts: Date.now() }));
			if (msg.type !== "command") return;
			const { id, name = "", args = {} } = msg.payload ?? {};
			this.received.push({ name, args });
			this.log(`명령 ← ${name} ${JSON.stringify(args)}`);
			let result: Result;
			try {
				result = await (this.overrides.get(name) ?? ((a: Record<string, unknown>) => this.handle(name, a)))(args);
			} catch (e) {
				result = { ok: false, error: (e as Error).message };
			}
			if (ws.readyState === 1) ws.send(JSON.stringify({ v: 1, type: "result", payload: { id, name, ...result }, ts: Date.now() }));
		});
	}

	private pomoBroadcast(event: string): void {
		this.broadcast("pomodoro", { event, ...this.state.pomodoro });
	}

	/** 진짜 앱의 handleCommand 를 흉내 */
	private handle(name: string, args: Record<string, unknown>): Result {
		const s = this.state;
		const p = s.pomodoro;
		switch (name) {
			case "state.get":
				return { ok: true, claude: s.claude, agent: s.agent === "asking" ? "working" : s.agent, pomodoro: { ...p }, usage: s.usage, build: 1, version: this.opt.version ?? "2.0.0" };
			case "mode.toggle":
				s.claude = !s.claude;
				this.broadcast("mode", { claude: s.claude });
				return { ok: true, claude: s.claude };
			case "study.toggle":
				s.study = !s.study;
				this.broadcast("study", { on: s.study });
				return { ok: true, study: s.study };
			case "expression.list":
				return { ok: true, expressions: [...s.expressions], current: s.expression };
			case "expression.set": {
				const n = args.name == null ? null : String(args.name);
				if (n && !s.expressions.includes(n)) return { ok: false, error: "no-such-expression" };
				s.expression = s.expression === n ? null : n;
				this.broadcast("expression", { name: s.expression });
				return { ok: true };
			}
			case "expression.reset":
				s.expression = null;
				this.broadcast("expression", { name: null });
				return { ok: true };
			case "motion.play":
			case "mascot.say":
			case "talk.open":
			case "talk.toggle":
			case "talk.hide":
			case "agent.stop":
			case "agent.newChat":
				return { ok: true };
			case "talk.send":
				if (!String(args.text ?? "").trim()) return { ok: false, error: "empty" };
				if (!s.claude) return { ok: false, error: "claude-off" };
				return { ok: true };
			case "screen.ask":
				if (!s.claude) return { ok: false, error: "claude-off" };
				return { ok: true };
			case "clip.translate":
			case "clip.polish":
				return { ok: true };
			case "usage.get":
				return { ok: true, usage: s.usage };
			case "pomodoro.start":
			case "pomodoro.toggle": {
				if (name === "pomodoro.toggle" && p.running) return this.pomoStop();
				const m = { work: Number(args.work) || 25, break: Number(args.break) || 5, long: Number(args.long) || 15 };
				Object.assign(p, { running: true, paused: false, phase: "work", remainingSec: m.work * 60, cycle: 1, cycles: Number(args.cycles) || 4, minutes: m });
				this.pomoBroadcast("work");
				if (this.opt.realTimer) this.startTimer();
				return { ok: true, state: { ...p } };
			}
			case "pomodoro.stop":
				return this.pomoStop();
			case "pomodoro.pause":
				if (p.running) {
					p.paused = !p.paused;
					this.pomoBroadcast(p.paused ? "paused" : "resumed");
				}
				return { ok: true, state: { ...p } };
			case "pomodoro.skip":
				if (p.running) {
					p.phase = p.phase === "work" ? "break" : "work";
					p.remainingSec = (p.phase === "work" ? p.minutes.work : p.minutes.break) * 60;
					this.pomoBroadcast(p.phase);
				}
				return { ok: true, state: { ...p } };
			default:
				return { ok: false, error: "unknown-command" };
		}
	}

	private pomoStop(): Result {
		const p = this.state.pomodoro;
		const was = p.running;
		Object.assign(p, { running: false, paused: false, phase: "idle", remainingSec: 0 });
		if (was) this.pomoBroadcast("stopped");
		return { ok: true, state: { ...p } };
	}

	private startTimer(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			const p = this.state.pomodoro;
			if (!p.running) return;
			if (!p.paused) p.remainingSec = Math.max(0, p.remainingSec - 1);
			this.pomoBroadcast("tick");
		}, 1000);
	}
}
