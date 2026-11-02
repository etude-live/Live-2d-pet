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

const PERSONA = [
  '당신은 사용자의 데스크톱에 사는 Live2D 캐릭터이자, 실제로 일을 해 주는 코딩·작업 도우미입니다.',
  '사용자와는 한국어로, 밝고 다정한 반말이 아닌 존댓말(해요체)로 이야기하세요.',
  '답변은 말풍선과 작은 채팅창에 표시되므로 짧고 또렷하게 쓰고, 긴 코드나 표는 꼭 필요할 때만 쓰세요.',
  '파일을 고치거나 명령을 실행하기 전에는 무엇을 왜 하는지 한 문장으로 먼저 말하세요.'
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

function createAgent({ onEvent, getOptions }) {
  let sessionId = null;
  let running = null;          // { abort, query }
  let seq = 0;
  let cwd = '';
  const pending = new Map();   // id → { resolve, input }

  const emit = (e) => { try { onEvent(e); } catch (err) { console.error('[agent] onEvent:', err); } };

  async function canUseTool(toolName, input, { signal }) {
    const id = ++seq;
    const summary = summarizeInput(toolName, input, cwd);
    const answered = new Promise((resolve) => {
      pending.set(id, { resolve });
      signal?.addEventListener('abort', () => resolve(false), { once: true });
    });
    emit({ type: 'permission', id, tool: toolName, summary, input });   // 대기 등록 뒤에 알림(곧바로 답이 와도 놓치지 않게)
    const allow = await answered;
    pending.delete(id);
    emit({ type: 'permissionDone', id, allow });
    return allow
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: '사용자가 허락하지 않았어요. 다른 방법을 찾거나 사용자에게 물어보세요.' };
  }

  function handleMessage(msg) {
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
      if (msg.subtype === 'success' && !msg.is_error) {
        emit({ type: 'done', result: msg.result || '', cost: msg.total_cost_usd });
      } else {
        const why = (msg.errors && msg.errors.join('\n')) || msg.result || msg.subtype;
        emit({ type: 'error', message: friendlyError(why) });
      }
    }
  }

  async function send(text) {
    if (running) throw new Error('이미 작업 중이에요');
    const opts = getOptions();
    if (!opts.cwd || !fs.existsSync(opts.cwd)) throw new Error('작업 폴더를 먼저 골라 주세요');
    cwd = opts.cwd;
    const { query } = await loadSdk();
    const abort = new AbortController();
    const env = { ...process.env };
    if (opts.apiKey) env.ANTHROPIC_API_KEY = opts.apiKey;
    const q = query({
      prompt: text,
      options: {
        cwd: opts.cwd,
        model: opts.model || undefined,
        resume: sessionId || undefined,
        abortController: abort,
        permissionMode: 'acceptEdits', // 작업 폴더 안의 파일 쓰기·고치기는 바로, 명령 실행 등은 canUseTool 로 물어본다
        canUseTool,
        thinking: { type: 'adaptive', display: 'summarized' },   // 혼잣말 재료
        systemPrompt: { type: 'preset', preset: 'claude_code', append: PERSONA },
        settingSources: ['user', 'project'],
        pathToClaudeCodeExecutable: claudeExecutable(),
        env
      }
    });
    running = { abort, query: q };
    emit({ type: 'start', text });
    try {
      for await (const msg of q) handleMessage(msg);
    } catch (e) {
      if (abort.signal.aborted) emit({ type: 'error', message: '중지했어요', stopped: true });
      else emit({ type: 'error', message: friendlyError(e?.message || String(e)) });
    } finally {
      for (const p of pending.values()) p.resolve(false);
      pending.clear();
      running = null;
      emit({ type: 'idle' });
    }
  }

  return {
    send,
    answer(id, allow) { pending.get(id)?.resolve(!!allow); },
    stop() { running?.abort.abort(); },
    reset() { if (!running) sessionId = null; },
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

// 브라우저 로그인. onUrl(url): 실행 파일이 브라우저를 못 열 때 대신 열 주소
function login({ onUrl } = {}) {
  return new Promise((resolve) => {
    const exe = claudeExecutable();
    if (!exe) { resolve(false); return; }
    const p = spawn(exe, ['auth', 'login', '--claudeai'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let opened = false;
    const scan = (d) => {
      const m = String(d).match(/https:\/\/\S+/);
      if (m && !opened) { opened = true; onUrl?.(m[0]); }
    };
    p.stdout.on('data', scan);
    p.stderr.on('data', scan);
    const timer = setTimeout(() => p.kill(), 5 * 60 * 1000);   // 5분 안에 로그인 안 하면 그만
    p.on('close', async () => { clearTimeout(timer); resolve((await authStatus()).loggedIn !== false); });
    p.on('error', () => { clearTimeout(timer); resolve(false); });
  });
}

module.exports = { createAgent, summarizeInput, authStatus, login, LOGIN_HINT };
