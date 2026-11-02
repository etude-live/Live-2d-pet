// Claude 에이전트 (Claude Agent SDK). Electron 에 의존하지 않는다.
//
// - 한 번에 하나의 대화(세션)만 돌린다. 이어서 말하면 resume 으로 같은 세션을 이어 간다.
// - 진행 상황은 onEvent({ type, ... }) 로 알린다.
//     start           작업 시작
//     thought  text   추론 요약(혼잣말 재료)
//     text     text   중간/최종 답변 문단
//     tool     name, summary       도구 사용
//     permission id, tool, summary 승인 요청 → answer(id, allow) 로 답한다
//     permissionDone id           승인 요청이 끝남(답했거나 취소됨)
//     done     result, cost       완료
//     error    message            실패
//     idle                         작업 끝(done/error 다음에 항상)
// - 인증: 기본은 이 컴퓨터의 Claude Code 로그인(Pro/Max 구독 포함)을 그대로 쓴다.
//         apiKey 를 넣었을 때만 ANTHROPIC_API_KEY 로 넘긴다.
const fs = require('fs');
const path = require('path');
const { classifyCommand } = require('../shared/command-risk');

let sdkPromise = null;
const loadSdk = () => (sdkPromise ||= import('@anthropic-ai/claude-agent-sdk'));

// 패키징된 앱(app.asar) 안의 실행 파일은 실행할 수 없으므로 asarUnpack 된 쪽을 가리킨다
function claudeExecutable() {
  const names = [`${process.platform}-${process.arch}`];
  if (process.platform === 'linux') names.push(`${process.platform}-${process.arch}-musl`);
  for (const n of names) {
    try {
      const dir = path.dirname(require.resolve(`@anthropic-ai/claude-agent-sdk-${n}/package.json`));
      const exe = path.join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude')
        .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
      if (fs.existsSync(exe)) return exe;
    } catch { /* 이 플랫폼 패키지가 없음 */ }
  }
  return undefined; // SDK 기본값에 맡김
}

// 사용자가 적은 캐릭터 지침(이름·말투·호칭 등)을 기본 지침 뒤에 붙인다
function personaPrompt(custom, memory) {
  const t = String(custom || '').trim();
  let out = PERSONA;
  if (t) out += '\n\n## 캐릭터 지침 (사용자가 정함. 말투·호칭·성격은 이 지침을 기본 지침보다 우선해서 따르세요)\n' + t;
  const m = String(memory || '').trim();
  if (m) out += '\n\n## 기억 (지난 대화들을 압축한 메모. 자연스럽게 활용하되, 메모에 없는 일은 지어내지 마세요)\n' + m;
  return out;
}

const PERSONA = [
  '당신은 사용자의 데스크톱에 사는 Live2D 캐릭터이자, 실제로 일을 해 주는 코딩·작업 도우미입니다.',
  '사용자와는 한국어로, 밝고 다정한 반말이 아닌 존댓말(해요체)로 이야기하세요.',
  '답변은 캐릭터 머리 위 말풍선에 뜹니다. 메신저로 수다 떨듯이 보통 1~3문장으로 짧게 대답하세요.',
  '목록·제목·표·굵은 글씨 같은 문서 서식은 쓰지 말고 말로 하세요. 사용자가 자세히 원하거나 결과물(번역문, 코드 등)을 달라고 할 때만 길게 쓰세요.',
  '한 번에 다 설명하려 하지 말고, 더 궁금하면 물어보게 두세요.',
  '사용자가 기억해 달라고 하거나 이름·취향처럼 오래 기억할 만한 걸 말하면 remember 도구로 적어 두세요.',
  '알림·예약(“30분 뒤 알려 줘”, “매일 9시에”)은 set_reminder 도구로 맞추고, 몇 시에 알릴지 한 문장으로 확인해 주세요.',
  '파일을 고치거나 명령을 실행하기 전에는 무엇을 왜 하는지 한 문장으로 먼저 말하세요.',
  'Bash 도구의 description 은 반드시 한국어로, 컴퓨터를 잘 모르는 사람도 알 수 있게 "무엇을 확인/변경하는지" 짧게 쓰세요. (예: "Cloudflare에 로그인된 계정 확인")'
].join('\n');

// 도구 입력을 한 줄로 (승인 창·채팅 기록용)
function summarizeInput(tool, input = {}, cwd = '') {
  const s = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
  const cut = (v, n = 160) => { const t = s(v); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
  // 작업 폴더 안의 파일은 상대 경로로 (말풍선이 짧아지게)
  const rel = (p) => {
    if (!p || !cwd) return p;
    const r = path.relative(cwd, String(p));
    return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : p;
  };
  switch (tool) {
    case 'Bash': return cut(input.command);
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit':
      return cut(rel(input.file_path || input.notebook_path));
    case 'Glob': case 'Grep': return cut(input.pattern) + (input.path ? ` (${cut(rel(input.path), 60)})` : '');
    case 'WebFetch': return cut(input.url);
    case 'WebSearch': return cut(input.query);
    case 'Task': case 'Agent': return cut(input.description || input.prompt);
    default: return cut(JSON.stringify(input));
  }
}

// 로그인/인증 문제는 알아듣기 쉬운 안내로 바꾼다
const LOGIN_HINT = 'Claude 계정 로그인이 필요해요. 아래 로그인 버튼을 눌러 주세요.';
function friendlyError(text) {
  const t = String(text || '');
  if (/invalid api key|authentication|unauthori[sz]ed|\b401\b|not logged in|please run \/login|oauth|credential/i.test(t)) return LOGIN_HINT;
  if (/usage limit|rate limit|\b429\b|limit reached/i.test(t)) return '사용 한도에 걸렸어요. 조금 뒤에 다시 시켜 주세요. (' + t.slice(0, 120) + ')';
  if (/ENOENT|spawn/i.test(t)) return 'Claude 실행 파일을 찾지 못했어요: ' + t.slice(0, 160);
  return t;
}

function createAgent({ onEvent, getOptions, getMemory = () => '', buildTools, onTurn }) {
  const readable = new Set();   // 사용자가 끌어다 놓은 파일: 묻지 않고 읽기 허락
  let sessionId = null;
  let running = null;          // { abort, query }
  let seq = 0;
  let cwd = '';
  let usedPersona = null;   // 이 대화에 마지막으로 알려 준 캐릭터 지침
  const pending = new Map();   // id → { resolve, input }

  const emit = (e) => { try { onEvent(e); } catch (err) { console.error('[agent] onEvent:', err); } };

  async function canUseTool(toolName, input, { signal }) {
    // 읽기만 하는 명령·웹 검색은 묻지 않고 허락 (위험 신호가 하나라도 있으면 물어봄)
    let risk = null;
    if (toolName.startsWith('mcp__mascot__')) return { behavior: 'allow', updatedInput: input };   // 캐릭터 전용 도구(알림·기억)
    if (toolName === 'Read' && readable.has(path.resolve(String(input.file_path || '')))) return { behavior: 'allow', updatedInput: input };
    if (toolName === 'Bash') {
      risk = classifyCommand(input.command);
      if (risk.readOnly) return { behavior: 'allow', updatedInput: input };
    } else if (toolName === 'WebSearch' || toolName === 'WebFetch') {
      return { behavior: 'allow', updatedInput: input };
    } else if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName)) {
      // 작업 폴더 안의 파일 쓰기·고치기는 바로 (폴더 밖은 물어봄)
      const f = input.file_path || input.notebook_path;
      const r = f && cwd ? path.relative(cwd, path.resolve(cwd, String(f))) : '..';
      if (r && !r.startsWith('..') && !path.isAbsolute(r)) return { behavior: 'allow', updatedInput: input };
    }
    const id = ++seq;
    const summary = summarizeInput(toolName, input, cwd);
    const why = typeof input.description === 'string' ? input.description.trim().slice(0, 120) : '';
    const dangers = risk?.dangers || [];
    const answered = new Promise((resolve) => {
      pending.set(id, { resolve });
      signal?.addEventListener('abort', () => resolve(false), { once: true });
    });
    emit({ type: 'permission', id, tool: toolName, summary, why, dangers, input });   // 대기 등록 뒤에 알림(곧바로 답이 와도 놓치지 않게)
    const allow = await answered;
    pending.delete(id);
    emit({ type: 'permissionDone', id, allow });
    return allow
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: '사용자가 허락하지 않았어요. 다른 방법을 찾거나 사용자에게 물어보세요.' };
  }

  // Pro/Max 사용량 (5시간·주간 한도). utilization 은 0~1 로 맞춘다
  function emitUsage(windows) {
    const out = {};
    for (const [k, w] of Object.entries(windows || {})) {
      if (!w || w.utilization == null) continue;
      let u = Number(w.utilization);
      if (u > 1.0001) u /= 100;   // 0~100 으로 오는 경우
      const r = w.resetsAt ?? w.resets_at;
      const resetsAt = typeof r === 'number' ? (r < 1e12 ? r * 1000 : r) : r ? Date.parse(r) : null;
      out[k] = { utilization: u, resetsAt, status: w.status || null };
    }
    if (Object.keys(out).length) emit({ type: 'usage', windows: out });
  }

  async function refreshUsage() {
    try {
      const fn = live?.q?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;   // 실험용 API: 실패해도 무시
      if (!fn) return;
      const r = await fn.call(live.q, { skipBehaviors: true });
      if (r?.rate_limits) emitUsage(r.rate_limits);
    } catch { /* 대화할 때 오는 rate_limit_event 로 대신 */ }
  }

  function handleMessage(msg) {
    if (msg.type === 'rate_limit_event') {
      const i = msg.rate_limit_info || {};
      emitUsage(i.unifiedWindows || (i.rateLimitType ? { [i.rateLimitType]: i } : {}));
      return;
    }
    if (msg.type === 'system' && msg.subtype === 'init') {
      sessionId = msg.session_id;
      return;
    }
    if (msg.type === 'assistant' && msg.error && !msg.parent_tool_use_id) {
      emit({ type: 'note', text: friendlyError(msg.error) });
    }
    if (msg.type === 'assistant' && !msg.parent_tool_use_id) {
      for (const b of msg.message?.content || []) {
        if (b.type === 'thinking' && b.thinking) emit({ type: 'thought', text: b.thinking });
        else if (b.type === 'text' && b.text?.trim()) emit({ type: 'text', text: b.text });
        else if (b.type === 'tool_use') emit({ type: 'tool', name: b.name, summary: summarizeInput(b.name, b.input, cwd) });
      }
      return;
    }
    if (msg.type === 'result') {
      if (msg.session_id) sessionId = msg.session_id;
      if (turn?.stopped) {
        emit({ type: 'error', message: '중지했어요', stopped: true });
      } else if (msg.subtype === 'success' && !msg.is_error) {
        emit({ type: 'done', result: msg.result || '', cost: msg.total_cost_usd });
        if (turn) try { onTurn?.(turn.text, msg.result || '', turn.meta); } catch (e) { console.warn('[agent] onTurn:', e.message); }
      } else {
        const why = (msg.errors && msg.errors.join('\n')) || msg.result || msg.subtype;
        emit({ type: 'error', message: friendlyError(why) });
      }
    }
  }

  // ---------- 한 번 켜 두고 계속 쓰는 세션 ----------
  // 메시지마다 claude 를 새로 켜면 켜고 대화를 다시 읽는 데 1초 넘게 걸리므로,
  // 입력을 계속 받는 스트림으로 한 번만 켜 두고 메시지를 밀어 넣는다.
  let live = null;   // { q, push, close, abort, model, dead }
  let turn = null;   // 지금 턴: { resolve, stopped }

  function makeInput() {
    const queue = [];
    let wake = null, closed = false;
    async function* gen() {
      while (!closed) {
        if (queue.length) { yield queue.shift(); continue; }
        await new Promise((r) => { wake = r; });
        wake = null;
      }
    }
    return {
      iter: gen(),
      push(msg) { queue.push(msg); wake?.(); },
      close() { closed = true; wake?.(); }
    };
  }

  async function startLive() {
    const opts = getOptions();
    cwd = opts.cwd;
    const sdk = await loadSdk();
    const { query } = sdk;
    const abort = new AbortController();
    const env = { ...process.env };
    if (opts.apiKey) env.ANTHROPIC_API_KEY = opts.apiKey;
    const input = makeInput();
    const q = query({
      prompt: input.iter,
      options: {
        cwd: opts.cwd,
        model: opts.model || undefined,
        resume: sessionId || undefined,
        abortController: abort,
        permissionMode: 'default',     // 모든 판단은 canUseTool 에서 (acceptEdits 는 작업 폴더 안의 rm·mv 같은 명령까지 묻지 않아서 쓰지 않음)
        canUseTool,
        thinking: { type: 'adaptive', display: 'summarized' },   // 혼잣말 재료
        systemPrompt: { type: 'preset', preset: 'claude_code', append: personaPrompt(opts.persona, getMemory()) },
        mcpServers: buildTools ? { mascot: sdk.createSdkMcpServer({ name: 'mascot', version: '1.0.0', alwaysLoad: true, tools: buildTools(sdk) }) } : undefined,
        settingSources: [],            // 이 컴퓨터의 Claude Code 설정(플러그인·MCP 등)은 불러오지 않음: 빠르고 예측 가능
        pathToClaudeCodeExecutable: claudeExecutable(),
        env
      }
    });
    const me = live = { q, input, abort, model: opts.model, cwd: opts.cwd, dead: false };
    setTimeout(refreshUsage, 3000);
    usedPersona = String(opts.persona || '').trim();
    (async () => {
      try {
        for await (const msg of q) {
          handleMessage(msg);
          if (msg.type === 'result') endTurn();
        }
      } catch (e) {
        if (turn && !abort.signal.aborted) emit({ type: 'error', message: friendlyError(e?.message || String(e)) });
      } finally {
        me.dead = true;
        if (live === me) live = null;
        if (turn) { if (abort.signal.aborted && turn.stopped) emit({ type: 'error', message: '중지했어요', stopped: true }); endTurn(); }
      }
    })();
    return me;
  }

  function endTurn() {
    if (!turn) return;
    for (const p of pending.values()) p.resolve(false);
    pending.clear();
    const t = turn;
    turn = null;
    running = null;
    emit({ type: 'idle' });
    t.resolve();
  }

  function closeLive() {
    if (!live) return;
    const l = live;
    live = null;
    l.input.close();
    l.abort.abort();
  }

  // 말 걸기 창을 열 때 미리 켜 둔다 (첫 대답이 빨라짐)
  async function warm() {
    try {
      const opts = getOptions();
      if (!live && !running && opts.cwd && fs.existsSync(opts.cwd)) await startLive();
    } catch (e) { console.warn('[agent] 미리 켜기 실패:', e.message); }
  }

  async function send(text, meta = {}) {
    if (running) throw new Error('이미 작업 중이에요');
    const opts = getOptions();
    if (!opts.cwd || !fs.existsSync(opts.cwd)) throw new Error('작업 폴더를 찾을 수 없어요');
    running = {};
    emit({ type: 'start', text });
    try {
      if (live && (live.dead || live.cwd !== opts.cwd)) closeLive();
      if (!live) await startLive();
      if ((opts.model || undefined) !== (live.model || undefined)) {
        await live.q.setModel(opts.model || undefined);
        live.model = opts.model;
      }
    } catch (e) {
      running = null;
      emit({ type: 'error', message: friendlyError(e?.message || String(e)) });
      emit({ type: 'idle' });
      return;
    }
    // 지침이 바뀌었으면 이번 메시지에 새 지침을 같이 알린다 (켜 둔 세션은 처음 지침을 계속 씀)
    const persona = String(opts.persona || '').trim();
    let prompt = text;
    if (usedPersona !== null && persona !== usedPersona) {
      prompt = (persona
        ? `[알림: 사용자가 캐릭터 지침을 바꿨어요. 이전 말투·이름은 잊고, 지금부터는 아래 새 지침만 따르세요.]\n${persona}`
        : '[알림: 사용자가 캐릭터 지침을 지웠어요. 이제 기본 말투로 대답하세요.]') + `\n\n[사용자 메시지]\n${text}`;
    }
    usedPersona = persona;
    const done = new Promise((resolve) => { turn = { resolve, stopped: false, text, meta }; });
    running = { live };
    // 화면 캡처 등 이미지가 붙으면 이미지 블록 + 글
    const content = meta.images?.length
      ? [...meta.images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.data } })), { type: 'text', text: prompt }]
      : prompt;
    live.input.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null });
    return done;
  }

  async function stop() {
    if (!turn || !live) return;
    turn.stopped = true;
    for (const p of pending.values()) p.resolve(false);
    try {
      await live.q.interrupt();   // 세션은 살려 두고 이번 턴만 멈춤 → result 가 와서 턴이 끝남
    } catch {
      closeLive();
    }
  }

  // 도구 없이 한 번만 묻기 (기억 압축용). 가벼운 Haiku 로
  async function summarize(prompt) {
    const opts = getOptions();
    const { query } = await loadSdk();
    const env = { ...process.env };
    if (opts.apiKey) env.ANTHROPIC_API_KEY = opts.apiKey;
    let result = '';
    const q = query({
      prompt,
      options: {
        cwd: opts.cwd,
        model: 'claude-haiku-5-5',
        tools: [],
        maxTurns: 1,
        systemPrompt: '당신은 대화 기록을 짧은 메모로 압축하는 도우미입니다. 요청한 형식의 메모만 출력합니다.',
        settingSources: [],
        persistSession: false,
        pathToClaudeCodeExecutable: claudeExecutable(),
        env
      }
    });
    for await (const m of q) if (m.type === 'result') { if (m.subtype !== 'success') throw new Error(m.subtype); result = m.result || ''; }
    return result;
  }

  return {
    send,
    warm,
    summarize,
    allowRead(p) { readable.add(path.resolve(String(p))); },
    answer(id, allow) { pending.get(id)?.resolve(!!allow); },
    stop,
    refreshUsage,
    reset() { if (!running) { closeLive(); sessionId = null; usedPersona = null; } },
    close: closeLive,
    get busy() { return !!running; },
    get sessionId() { return sessionId; }
  };
}

// ===== 로그인 (Claude Code 계정. Pro/Max 구독 로그인) =====
// SDK 에 들어 있는 claude 실행 파일의 auth 명령을 쓴다. 터미널 없이 앱에서 로그인 창(브라우저)을 연다.
const { execFile, spawn } = require('child_process');

function authStatus() {
  return new Promise((resolve) => {
    const exe = claudeExecutable();
    if (!exe) { resolve({ loggedIn: null }); return; }   // 확인할 수 없음 → 일단 시도해 보게 둔다
    execFile(exe, ['auth', 'status', '--json'], { timeout: 15000 }, (err, stdout) => {
      try { resolve(JSON.parse(stdout)); } catch { resolve({ loggedIn: err ? false : null }); }
    });
  });
}

// 브라우저 로그인. onUrl(url): 브라우저로 열 주소, onNeedCode(): 브라우저에 뜬 코드를 붙여 넣어야 할 때
// 반환: { done: Promise<boolean>, sendCode(code), cancel() }
function login({ onUrl, onNeedCode } = {}) {
  const exe = claudeExecutable();
  if (!exe) return { done: Promise.resolve({ ok: false, error: 'Claude 실행 파일을 찾지 못했어요' }), sendCode() {}, cancel() {} };
  const p = spawn(exe, ['auth', 'login', '--claudeai'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let opened = false, lastErr = '';
  const scan = (d) => {
    const t = String(d);
    const m = t.match(/https:\/\/\S+/);
    if (m && !opened) { opened = true; onUrl?.(m[0]); onNeedCode?.(); }   // 실행 파일이 브라우저를 직접 연다. 주소는 예비용
    if (/fail|error/i.test(t)) lastErr = t.trim();
  };
  p.stdout.on('data', scan);
  p.stderr.on('data', scan);
  const timer = setTimeout(() => p.kill(), 10 * 60 * 1000);   // 10분 안에 로그인 안 하면 그만
  const done = new Promise((resolve) => {
    p.on('close', async () => { clearTimeout(timer); const ok = (await authStatus()).loggedIn === true; resolve({ ok, error: ok ? '' : lastErr }); });
    p.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
  });
  return {
    done,
    sendCode(code) { try { p.stdin.write(String(code).trim() + '\n'); } catch { /* 이미 끝남 */ } },
    cancel() { p.kill(); }
  };
}

module.exports = { createAgent, summarizeInput, authStatus, login, LOGIN_HINT };
