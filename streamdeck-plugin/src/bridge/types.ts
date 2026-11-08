// 앱이 보내는 상태의 모양 (docs/STREAMDECK.md 2절)

export type AgentState = "working" | "asking" | "idle";
export type PomodoroPhase = "idle" | "work" | "break" | "long";

export interface PomodoroState {
	running: boolean;
	paused: boolean;
	phase: PomodoroPhase;
	remainingSec: number;
	cycle?: number;
	cycles?: number;
	minutes?: { work: number; break: number; long: number };
}

export interface UsageWindow {
	/** 0 ~ 1 */
	utilization: number;
	/** ms */
	resetsAt?: number;
	status?: string;
}

export type Usage = Record<string, UsageWindow | undefined>;

/** 플러그인이 기억하는 앱의 지금 상태 */
export interface MascotState {
	/** 앱에 붙어 있는지 */
	connected: boolean;
	/** 앱 버전 (welcome.version, 예 "2.0.3") */
	version: string | null;
	/** 브리지 규격 번호 (welcome.protocol) */
	protocol: number | null;
	/** 앱이 이 플러그인과 맞지 않음 → 모든 버튼에 "업데이트 필요" */
	incompatible: boolean;
	/** Claude 모드 (null = 아직 모름) */
	claude: boolean | null;
	agent: AgentState;
	pomodoro: PomodoroState | null;
	usage: Usage;
	/** 같이 공부 모드 (null = 아직 모름. state.get 에 없어서 방송이 올 때까지 모름) */
	study: boolean | null;
	/** 지금 켜진 표정 (null = 원래 얼굴) */
	expression: string | null;
	/** 지금 모델의 표정 목록 (null = 아직 모름) */
	expressions: string[] | null;
}

export interface CommandResult {
	ok: boolean;
	error?: string;
	[key: string]: unknown;
}

/** 버튼 로직이 쓰는 브리지의 모양 (테스트에서 바꿔 끼울 수 있게) */
export interface Bridge {
	readonly state: MascotState;
	command(name: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<CommandResult>;
	on(event: "change", listener: (state: MascotState) => void): unknown;
	off(event: "change", listener: (state: MascotState) => void): unknown;
}

export function initialState(): MascotState {
	return {
		connected: false,
		version: null,
		protocol: null,
		incompatible: false,
		claude: null,
		agent: "idle",
		pomodoro: null,
		usage: {},
		study: null,
		expression: null,
		expressions: null
	};
}
