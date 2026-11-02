// 피규어 모드 혼잣말. 말투 지침에 맞춘 혼잣말을 Haiku 에게 한 번에 40줄씩 받아 두고 하나씩 꺼내 쓴다.
// 한 번 받는 데 입력 수백 토큰 + 출력 1천 토큰 남짓 (말 한 번 거는 것보다 적음).
// 다 쓰면 새로 받는데, 40분에 한 번까지만. 그 사이엔 받아 둔 걸 섞어서 다시 씀. 지침이 바뀌면 새로 받음.
const fs = require('fs');
const crypto = require('crypto');

const FALLBACK = [
  '[하트] 오늘도 같이 힘내요!', '음~ 뭐 재밌는 일 없나…', '[홍조] 심심하면 저 불러도 돼요',
  '물 한 잔 마시고 해요!', '[얄미운] 흐응~ 열심히 하네요?', '잠깐 기지개 켜는 거 어때요?',
  '[하트] 여기서 지켜보고 있을게요', '으음… 졸려…', '[홍조] 헤헤, 그냥 불러 봤어요'
];
const BATCH = 40, MIN_GAP = 40 * 60000, MAX_AGE = 6 * 3600000;

function band(d = new Date()) {
  const h = d.getHours();
  return h < 6 ? '새벽' : h < 11 ? '아침' : h < 14 ? '점심 무렵' : h < 18 ? '오후' : h < 22 ? '저녁' : '밤';
}

function createMutter({ file, getPersona, getMemory, generate }) {
  let st = { key: '', at: 0, lines: [], used: [] };
  try { st = { ...st, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* 처음 */ }
  let busy = false, lastTry = 0;
  const save = () => { try { fs.writeFileSync(file, JSON.stringify(st)); } catch { /* 무시 */ } };
  const keyOf = () => crypto.createHash('sha1').update(getPersona() || '').digest('hex').slice(0, 12);

  async function refill() {
    if (busy || Date.now() - lastTry < MIN_GAP) return;
    busy = true; lastTry = Date.now();
    try {
      const persona = (getPersona() || '').trim() || '밝고 다정한 데스크톱 마스코트. 존댓말을 쓰고 살짝 장난스럽다.';
      const mem = (getMemory() || '').slice(0, 400);
      const prompt = [
        '너는 사용자 화면 구석에 사는 데스크톱 캐릭터다. 아래 말투 지침 그대로, 혼자 중얼거리는 혼잣말을 만들어라.',
        `<말투 지침>\n${persona}\n</말투 지침>`,
        mem ? `<사용자에 대해 아는 것>\n${mem}\n</사용자에 대해 아는 것>` : '',
        `지금은 ${band()}이다.`,
        `규칙: 혼잣말 ${BATCH}줄. 한 줄에 하나, 번호·따옴표 없이. 한 줄은 8~35자. 자연스러운 한국어 구어체.`,
        '아재개그·말장난·이모지 남발 금지. 일상적인 감상, 사용자 응원, 날씨·시간대·기분, 사용자에 대해 아는 것에서 가끔. 서로 겹치지 않게 다양하게.',
        '표정이 어울리면 줄 맨 앞에 [하트] [홍조] [얄미운] [식은땀] [눈물] 중 하나를 붙여도 된다 (절반 이하).'
      ].filter(Boolean).join('\n\n');
      const out = await generate(prompt);
      const lines = String(out).split('\n').map((l) => l.replace(/^\s*(\d+[.)]|[-*•])\s*/, '').replace(/^["“']|["”']$/g, '').trim())
        .filter((l) => l.length >= 2 && l.length <= 60);
      if (lines.length >= 5) { st = { key: keyOf(), at: Date.now(), lines: shuffle(lines), used: [] }; save(); }
    } catch (e) {
      console.warn('[mutter] 혼잣말 받기 실패:', e.message);
    } finally { busy = false; }
  }

  function next() {
    const stale = st.key !== keyOf() || Date.now() - st.at > MAX_AGE;
    if (stale || st.lines.length < 5) refill();
    if (!st.lines.length) st.lines = shuffle(st.used.length ? st.used : FALLBACK.slice()), st.used = [];
    const line = st.lines.shift();
    st.used.push(line);
    save();
    return line;
  }

  return { next, refill };
}

function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

module.exports = { createMutter };
