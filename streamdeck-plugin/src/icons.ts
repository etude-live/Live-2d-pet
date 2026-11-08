// 버튼 그림 (SVG). 글자는 그림에 넣지 않는다 (스트림덱의 SVG 렌더러에서 한글 글꼴이 안 될 수 있어서).
// 글자(남은 시간, % 등)는 버튼 "제목"으로 표시한다.
//
// 이 파일은 다른 파일을 import 하지 않는다 → scripts/make-icons.mjs 가 Node 로 바로 읽어서
// manifest 에 쓰는 기본 아이콘(imgs/)도 같은 그림으로 만든다.

export const COLORS = {
	blue: "#5f7cf5",
	pink: "#ff8fbd",
	red: "#f0616d",
	green: "#4fbf86",
	gray: "#8a909c",
	off: "#3a3f4b",
	amber: "#f5b14c",
	white: "#ffffff",
	ink: "#2b2f3a",
	leafDark: "#1f6e45"
} as const;

export type Glyph =
	| "tomato"
	| "skip"
	| "talk"
	| "talkDots"
	| "talkAsk"
	| "stop"
	| "newChat"
	| "screen"
	| "translate"
	| "polish"
	| "phrase"
	| "battery"
	| "face"
	| "study"
	| "robot"
	| "update";

export type Face = "smile" | "blush" | "sad" | "wink" | "angry" | "surprised";

export interface KeyArt {
	glyph: Glyph;
	/** 배경색 */
	bg?: string;
	/** 그림 색 */
	fg?: string;
	/** 흐리게 (앱 꺼짐) */
	dim?: boolean;
	/** 켜짐 표시 (테두리 링) */
	ring?: string;
	/** battery: 0~1 */
	level?: number;
	/** battery: 채움 색 */
	levelColor?: string;
	/** face: 표정 모양 */
	face?: Face;
}

const W = 144;

/** 그림은 위쪽 3/4 에 그린다 (아래는 제목 자리) */
function glyphSvg(a: KeyArt): string {
	const fg = a.fg ?? COLORS.white;
	const stroke = `fill="none" stroke="${fg}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"`;
	switch (a.glyph) {
		case "tomato":
			return `<circle cx="72" cy="66" r="34" fill="${fg}"/>
<path d="M72 34 L60 24 M72 34 L84 24 M72 34 L72 20" stroke="${a.bg === COLORS.green ? COLORS.leafDark : COLORS.green}" stroke-width="7" stroke-linecap="round"/>
<path d="M58 34 Q72 44 86 34" fill="${a.bg === COLORS.green ? COLORS.leafDark : COLORS.green}"/>`;
		case "skip":
			return `<path d="M38 36 L72 62 L38 88 Z M72 36 L102 62 L72 88 Z" fill="${fg}"/>
<rect x="104" y="36" width="9" height="52" rx="3" fill="${fg}"/>`;
		case "talk":
		case "talkDots":
		case "talkAsk": {
			const bubble = `<path d="M30 30 H114 Q122 30 122 38 V80 Q122 88 114 88 H64 L44 104 L48 88 H30 Q22 88 22 80 V38 Q22 30 30 30 Z" fill="${fg}"/>`;
			const ink = a.bg ?? COLORS.pink;
			if (a.glyph === "talkDots")
				return `${bubble}<circle cx="50" cy="59" r="7" fill="${ink}"/><circle cx="72" cy="59" r="7" fill="${ink}"/><circle cx="94" cy="59" r="7" fill="${ink}"/>`;
			if (a.glyph === "talkAsk")
				return `${bubble}<rect x="66" y="40" width="12" height="28" rx="5" fill="${ink}"/><circle cx="72" cy="78" r="6" fill="${ink}"/>`;
			return bubble;
		}
		case "stop":
			return `<rect x="40" y="30" width="64" height="64" rx="10" fill="${fg}"/>`;
		case "newChat":
			return `<path d="M30 30 H114 Q122 30 122 38 V80 Q122 88 114 88 H64 L44 104 L48 88 H30 Q22 88 22 80 V38 Q22 30 30 30 Z" fill="${fg}"/>
<path d="M72 44 V74 M57 59 H87" stroke="${a.bg ?? COLORS.blue}" stroke-width="9" stroke-linecap="round"/>`;
		case "screen":
			return `<rect x="22" y="26" width="100" height="66" rx="8" ${stroke}/>
<path d="M56 106 H88 M72 92 V106" ${stroke}/>
<circle cx="66" cy="56" r="14" ${stroke}/><path d="M76 66 L92 80" ${stroke}/>`;
		case "translate":
			return `<circle cx="72" cy="62" r="38" ${stroke}/>
<ellipse cx="72" cy="62" rx="16" ry="38" ${stroke}/>
<path d="M36 50 H108 M36 74 H108" ${stroke}/>`;
		case "polish":
			return `<path d="M40 96 L46 74 L94 26 L114 46 L66 94 Z" fill="${fg}"/>
<path d="M86 34 L106 54" stroke="${a.bg ?? COLORS.blue}" stroke-width="6"/>
<path d="M28 108 H116" ${stroke}/>`;
		case "phrase":
			return `<circle cx="54" cy="56" r="24" fill="${fg}"/><circle cx="84" cy="50" r="28" fill="${fg}"/><circle cx="96" cy="70" r="20" fill="${fg}"/>
<rect x="44" y="56" width="62" height="34" rx="17" fill="${fg}"/>
<circle cx="40" cy="98" r="8" fill="${fg}"/><circle cx="28" cy="110" r="5" fill="${fg}"/>`;
		case "battery": {
			const lv = Math.max(0, Math.min(1, a.level ?? 0));
			const w = Math.round(84 * lv);
			return `<rect x="18" y="38" width="100" height="50" rx="10" ${stroke}/>
<rect x="120" y="52" width="8" height="22" rx="3" fill="${fg}"/>
${w > 0 ? `<rect x="26" y="46" width="${w}" height="34" rx="5" fill="${a.levelColor ?? fg}"/>` : ""}`;
		}
		case "face":
			return faceSvg(a.face ?? "smile", fg, a.bg ?? COLORS.pink);
		case "study":
			return `<path d="M72 40 Q50 28 22 32 V92 Q50 88 72 100 Q94 88 122 92 V32 Q94 28 72 40 Z" fill="${fg}"/>
<path d="M72 42 V98" stroke="${a.bg ?? COLORS.blue}" stroke-width="5"/>`;
		case "robot":
			return `<rect x="30" y="38" width="84" height="62" rx="16" fill="${fg}"/>
<path d="M72 38 V24" ${stroke}/><circle cx="72" cy="20" r="7" fill="${fg}"/>
<circle cx="54" cy="66" r="9" fill="${a.bg ?? COLORS.pink}"/><circle cx="90" cy="66" r="9" fill="${a.bg ?? COLORS.pink}"/>
<path d="M58 86 H86" stroke="${a.bg ?? COLORS.pink}" stroke-width="6" stroke-linecap="round"/>`;
		case "update":
			return `<circle cx="72" cy="62" r="40" ${stroke}/>
<path d="M72 40 V74 M58 62 L72 76 L86 62" ${stroke}/>`;
	}
}

function faceSvg(face: Face, fg: string, ink: string): string {
	const head = `<circle cx="72" cy="62" r="42" fill="${fg}"/>`;
	const eye = (x: number) => `<circle cx="${x}" cy="54" r="6" fill="${ink}"/>`;
	const line = (d: string) => `<path d="${d}" fill="none" stroke="${ink}" stroke-width="6" stroke-linecap="round"/>`;
	switch (face) {
		case "smile":
			return head + line("M50 56 Q57 46 64 56 M80 56 Q87 46 94 56") + line("M52 74 Q72 92 92 74");
		case "blush":
			return (
				head +
				eye(56) +
				eye(88) +
				`<ellipse cx="46" cy="72" rx="9" ry="5" fill="${COLORS.red}" opacity=".6"/><ellipse cx="98" cy="72" rx="9" ry="5" fill="${COLORS.red}" opacity=".6"/>` +
				line("M62 80 Q72 74 82 80")
			);
		case "sad":
			return head + line("M46 52 L62 44 M98 52 L82 44") + eye(56).replace('cy="54"', 'cy="62"') + eye(88).replace('cy="54"', 'cy="62"') + line("M56 88 Q72 74 88 88");
		case "wink":
			return head + eye(56) + line("M80 54 H96") + line("M52 74 Q72 92 92 74");
		case "angry":
			return head + line("M46 44 L64 52 M98 44 L80 52") + eye(58) + eye(86) + line("M56 84 H88");
		case "surprised":
			return head + eye(56) + eye(88) + `<ellipse cx="72" cy="82" rx="9" ry="12" fill="${ink}"/>`;
	}
}

/** 버튼 한 칸 그림 (144×144, 72×72 에서도 그대로 축소) */
export function keySvg(a: KeyArt): string {
	const bg = a.dim ? COLORS.off : (a.bg ?? COLORS.blue);
	const ring = a.ring ? `<rect x="5" y="5" width="134" height="134" rx="18" fill="none" stroke="${a.ring}" stroke-width="10"/>` : "";
	const art = a.dim ? { ...a, fg: COLORS.gray, bg: COLORS.off } : a;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}" viewBox="0 0 ${W} ${W}">
<rect width="${W}" height="${W}" fill="${bg}"/>${ring}
<g${a.dim ? ' opacity=".55"' : ""}>${glyphSvg(art)}</g>
</svg>`;
}

/** 동작 목록에 보이는 작은 아이콘 (배경 없이 흰 그림 → 스트림덱 앱의 어두운 목록에 어울림) */
export function listIconSvg(a: KeyArt): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}" viewBox="0 0 ${W} ${W}">
<g>${glyphSvg({ ...a, fg: COLORS.white, bg: COLORS.ink })}</g>
</svg>`;
}

/** setImage 에 넣는 data URL */
export function toDataUrl(svg: string): string {
	return `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`;
}
