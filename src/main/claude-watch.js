// "같이 공부" 모드: Claude 데스크톱 앱 창의 글자를 읽어(tools/ax-read.swift), 내 질문과 Claude 의 답이
// 다 나오면 캐릭터가 한두 마디 거든다. 글 읽기는 Mac 안에서만 (토큰 0), 거들 때만 Haiku 한 번.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const POLL_MS = 5000;        // 창 읽는 간격
const MIN_GAP = 20000;       // 거드는 최소 간격
const Q_MAX = 900, A_HEAD = 1600, A_TAIL = 600;

function helperPath(app) {
  const p = app.isPackaged ? path.join(process.resourcesPath, 'bin', 'ax-read') : path.join(__dirname, '../../build/bin/ax-read');
  return fs.existsSync(p) ? p : null;
}

function readWindow(app, { prompt = false } = {}) {
  return new Promise((resolve) => {
    const exe = helperPath(app);
    if (!exe) return resolve({ ok: false, error: 'no-helper' });
    execFile(exe, prompt ? ['--prompt'] : [], { timeout: 15000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) return resolve({ ok: false, error: err.killed ? 'timeout' : err.message });
      try { resolve(JSON.parse(stdout)); } catch { resolve({ ok: false, error: 'bad-output' }); }
    });
  });
}

// 답 끝에 이런 말이 있으면 Claude 가 아직 일하는 중 (도구 실행·생각)
const BUSY = /(실행 중|생각 중|작업 중|검색 중|읽는 중|Running|Thinking|Searching|Working|Reading)[.…\s]*$/i;
const IS_USER = /user-message|font-user|human-turn|user-turn/i;
const IS_AI = /claude-response|font-claude|claude-message|assistant-message|ai-turn/i;

// 노드 목록 → 마지막 질문/답. DOM class 로 나누고, 안 되면 끝부분 글 전체 (Haiku 가 알아서 나눔)
function extract(nodes = []) {
  const blocks = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const tag = `${n.c || ''} ${n.i || ''}`;
    const kind = IS_USER.test(tag) ? 'q' : IS_AI.test(tag) ? 'a' : null;
    if (!kind) continue;
    const texts = [];
    let j = i + 1;
    for (; j < nodes.length && nodes[j].d > n.d; j++) if (nodes[j].t) texts.push(nodes[j].t);
    if (n.t) texts.unshift(n.t);
    blocks.push({ kind, text: texts.join('\n').trim(), end: j, cls: (n.c || n.i || '').slice(0, 60) });
    i = j - 1;
  }
  const lastQ = blocks.map((b) => b.kind).lastIndexOf('q');
  if (lastQ >= 0) {
    const q = blocks[lastQ].text;
    // 답: 마지막 질문 뒤의 글 전부 (입력칸 글은 뺌). 답 칸 표시는 화면마다 달라서 (도구 실행 줄·본문이 따로 나뉨) 믿지 않는다
    const a = nodes.slice(blocks[lastQ].end).filter((n) => n.t && n.r !== 'AXTextArea' && n.r !== 'AXTextField').map((n) => n.t).join('\n').trim();
    const method = 'class';
    return { method, q, a, blocks: blocks.length, aiCls: [...new Set(blocks.filter((b) => b.kind === 'a').map((b) => b.cls))].join('|') };
  }
  const all = nodes.filter((n) => n.t).map((n) => n.t).join('\n');
  return { method: 'tail', q: '', a: '', tail: all.slice(-4000), blocks: 0 };
}

const clip = (s, head, tail = 0) => (s.length <= head + tail ? s : s.slice(0, head) + '\n…(중략)…\n' + (tail ? s.slice(-tail) : ''));

function createClaudeWatch({ app, generate, getPersona, getMemory, onSay, onState, logFile }) {
  // 판단 기록 (왜 말했는지/안 했는지). 같은 이유가 이어지면 한 번만 적음
  let lastLog = '';
  function log(msg) {
    if (!logFile || msg === lastLog) return;
    lastLog = msg;
    try {
      if (fs.existsSync(logFile) && fs.statSync(logFile).size > 300000) fs.renameSync(logFile, logFile + '.old');
      fs.appendFileSync(logFile, `${new Date().toLocaleTimeString('ko-KR', { hour12: false })} ${msg}\n`);
    } catch { /* 무시 */ }
  }
  let on = false, timer = null, busy = false;
  let lastKey = '', stableKey = '', stableCount = 0, lastSaidKey = '', lastAt = 0, lastLine = '', firstSeen = true;

  async function poll() {
    if (!on || busy) return;
    busy = true;
    try {
      const r = await readWindow(app);
      if (!r.ok) { log('읽기 실패: ' + r.error); onState?.({ error: r.error }); if (r.error === 'not-trusted' || r.error === 'no-helper') stop(); return; }
      const ex = extract(r.nodes);
      const body = ex.method !== 'tail' ? `${ex.q}\n---\n${ex.a}` : ex.tail.slice(-1500);
      const info = `[${ex.method} 블록${ex.blocks} 질문${ex.q.length}자 답${ex.a.length}자 노드${r.nodes.length}]`;
      if (!body.trim() || (ex.method !== 'tail' && ex.a.length < 10)) { log(`${info} 답이 아직 없음`); return; }
      const key = crypto.createHash('sha1').update(body).digest('hex');
      // 글이 안 바뀐 채로 두 번 = 답이 다 나옴
      if (key !== stableKey) { stableKey = key; stableCount = 0; log(`${info} 글이 바뀌는 중`); return; }
      if (++stableCount < 2) return;   // 10초 넘게 그대로일 때만 (도구 실행 중 멈춰 있는 것과 구분)
      if (ex.method !== 'tail' && BUSY.test(ex.a.slice(-80))) { log(`${info} 아직 실행 중 (끝: ${ex.a.slice(-30).replace(/\n/g, ' ')})`); return; }
      if (firstSeen) { firstSeen = false; lastSaidKey = key; log(`${info} 켤 때 있던 대화라 건너뜀`); return; }
      if (key === lastSaidKey) return;
      if (Date.now() - lastAt < MIN_GAP) { log(`${info} 방금 말해서 쉼`); return; }
      lastSaidKey = key; lastAt = Date.now();
      log(`${info} 거들기 요청 (질문: ${ex.q.slice(0, 40).replace(/\n/g, ' ')})`);
      const line = await comment(ex);
      log(line ? `→ 말함: ${line}` : '→ 할 말 없음 ("-")');
      if (line) { lastLine = line; onSay?.(line); }
    } catch (e) {
      console.warn('[study]', e.message);
    } finally { busy = false; }
  }

  async function comment(ex) {
    const persona = (getPersona() || '').trim() || '밝고 다정한 데스크톱 마스코트. 존댓말, 살짝 장난스러움.';
    const convo = ex.method !== 'tail'
      ? `<질문>\n${clip(ex.q, Q_MAX)}\n</질문>\n<Claude의 답>\n${clip(ex.a, A_HEAD, A_TAIL)}\n</Claude의 답>`
      : `<Claude 창 글 (끝부분, 마지막 질문과 답이 들어 있음)>\n${ex.tail}\n</Claude 창 글>`;
    const prompt = [
      '너는 사용자 화면 옆에 사는 데스크톱 캐릭터다. 사용자가 Claude 에게 묻고 답을 받는 걸 옆에서 같이 보고 있다.',
      `<말투 지침>\n${persona}\n</말투 지침>`,
      (getMemory() || '').trim() ? `<사용자에 대해 아는 것>\n${getMemory().slice(0, 300)}\n</사용자에 대해 아는 것>` : '',
      convo,
      lastLine ? `(네가 직전에 한 말: "${lastLine}" — 반복하지 마)` : '',
      '마지막 질문과 답을 보고, 옆에서 공부를 같이 하는 친구처럼 한마디 거들어라. 핵심 짚기, 헷갈릴 만한 점, 다음에 물어보면 좋을 것, 가벼운 훈수나 칭찬 중 하나.',
      '규칙: 1~2문장, 70자 이내, 말투 지침대로. 마크다운·따옴표 없이 대사만. 어울리면 맨 앞에 [하트] [홍조] [얄미운] [식은땀] [눈물] 중 하나. 되도록 한마디는 해라. 정말 아무 말도 어색할 때만 "-" 하나.'
    ].filter(Boolean).join('\n\n');
    const outText = String(await generate(prompt) || '').trim().split('\n')[0].replace(/^["“]|["”]$/g, '').trim();
    return outText && outText !== '-' ? outText.slice(0, 140) : '';
  }

  function start() {
    if (on) return;
    on = true; firstSeen = true; stableKey = ''; stableCount = 0; log('— 같이 공부 시작 —');
    timer = setInterval(poll, POLL_MS);
    poll();
  }
  function stop() { on = false; clearInterval(timer); timer = null; }

  // 읽기 테스트: 무엇을 읽었는지 파일로 남김
  async function test(dir) {
    const r = await readWindow(app, { prompt: true });
    const ex = r.ok ? extract(r.nodes) : null;
    const file = path.join(dir, 'claude-read.txt');
    const lines = [`# ${new Date().toISOString()}  ok=${r.ok} ${r.error || ''} app=${r.app || ''} bundle=${r.bundle || ''} title=${r.title || ''} windows=${r.windows ?? '?'} retries=${r.retries ?? 0} nodes=${r.nodes?.length || 0}${r.truncated ? ' (잘림)' : ''}`];
    if (ex) {
      lines.push(`# 나눈 방법: ${ex.method}  블록 ${ex.blocks}개`, '', '===== 마지막 질문 =====', ex.q || '(못 찾음)', '', '===== 답 =====', ex.a || '(못 찾음)');
      if (ex.tail) lines.push('', '===== 끝부분 글 =====', ex.tail);
      lines.push('', '===== 노드 (깊이 역할 class id : 글) =====');
      for (const n of r.nodes) lines.push(`${' '.repeat(Math.min(n.d, 40))}${n.r} ${n.c ? '.' + n.c.replace(/\s+/g, '.') : ''}${n.i ? ' #' + n.i : ''}${n.t ? ' : ' + n.t.slice(0, 120).replace(/\n/g, ' ') : ''}`);
    }
    fs.writeFileSync(file, lines.join('\n'));
    return { ...r, nodes: undefined, file, extract: ex && { method: ex.method, q: ex.q.length, a: ex.a.length, blocks: ex.blocks } };
  }

  return { start, stop, test, log, get on() { return on; } };
}

module.exports = { createClaudeWatch, extract };
