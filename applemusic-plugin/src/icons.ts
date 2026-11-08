// 버튼 그림 (SVG, 144×144). 왼쪽에 음표 배지, 오른쪽에 조작 기호, 아래는 제목 자리.
// Apple 로고·Music 앱 아이콘은 쓰지 않고 직접 그린 음표를 쓴다.
// 다른 파일을 import 하지 않는다 → scripts/make-icons.mjs 가 Node 로 바로 읽는다.

export const COLORS = {
	bg: "#111114",
	badge: "#5f7cf5",
	badge2: "#ff8fbd",
	white: "#ffffff",
	dimBg: "#2a2a2e",
	dim: "#77777d",
	warn: "#f5b14c"
} as const;

export type Glyph = "previous" | "play" | "pause" | "next";

export interface KeyArt {
	glyph: Glyph;
	/** 흐리게 (Music 이 꺼짐) */
	dim?: boolean;
	/** 배지를 주황으로 (권한 필요 등) */
	warn?: boolean;
}

function badge(a: KeyArt): string {
	const fill = a.dim ? COLORS.dim : a.warn ? COLORS.warn : "url(#g)";
	const note = a.dim ? COLORS.dimBg : COLORS.white;
	return `<circle cx="44" cy="54" r="27" fill="${fill}"/>
<path d="M38 66 V40 L56 36 V60" fill="none" stroke="${note}" stroke-width="5" stroke-linejoin="round"/>
<ellipse cx="34" cy="67" rx="6.5" ry="5" fill="${note}"/><ellipse cx="52" cy="61" rx="6.5" ry="5" fill="${note}"/>`;
}

function glyph(g: Glyph, c: string): string {
	switch (g) {
		case "previous":
			return `<rect x="86" y="38" width="7" height="32" rx="2" fill="${c}"/><path d="M118 38 V70 L95 54 Z" fill="${c}"/>`;
		case "next":
			return `<path d="M88 38 V70 L111 54 Z" fill="${c}"/><rect x="113" y="38" width="7" height="32" rx="2" fill="${c}"/>`;
		case "play":
			return `<path d="M92 36 V72 L120 54 Z" fill="${c}"/>`;
		case "pause":
			return `<rect x="90" y="38" width="10" height="32" rx="2" fill="${c}"/><rect x="108" y="38" width="10" height="32" rx="2" fill="${c}"/>`;
	}
}

export function keySvg(a: KeyArt): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${COLORS.badge2}"/><stop offset="1" stop-color="${COLORS.badge}"/></linearGradient></defs>
<rect width="144" height="144" fill="${a.dim ? COLORS.dimBg : COLORS.bg}"/>
${badge(a)}
${glyph(a.glyph, a.dim ? COLORS.dim : COLORS.white)}
</svg>`;
}

/** 동작 목록의 작은 아이콘: 기호만 */
export function listIconSvg(g: Glyph): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
<g transform="translate(-134 -36) scale(2)">${glyph(g, COLORS.white)}</g>
</svg>`;
}

export function toDataUrl(svg: string): string {
	return `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`;
}
