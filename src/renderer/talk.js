// 말 걸기 창: 캐릭터 옆의 답변 말풍선 + 입력칸. 작업은 메인(src/main/agent.js)이 한다.
const { ipcRenderer } = require('electron');
const { thoughtParagraphs, thoughtLine, toolLine, askLine } = require('../shared/agent-lines');

const $ = (id) => document.getElementById(id);
const reply = $('reply'), replyText = reply.querySelector('.text'), input = $('input'), history = $('history');
let busy = false;
let turn = null;            // 지금 대화 한 턴: { user, bot }
const turns = [];           // 지난 대화

// ---------- 투명한 곳은 클릭이 뒤로 빠지게 ----------
let ignoring = null;
const setIgnore = (v) => { if (v !== ignoring) { ignoring = v; ipcRenderer.send('talk-ignore-mouse', v); } };
document.addEventListener('mousemove', (e) => {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  setIgnore(!el || el === document.body || el === document.documentElement);
});
document.addEventListener('mouseleave', () => setIgnore(true));
setIgnore(true);

// ---------- 아주 가벼운 마크다운 (코드 블록·인라인 코드·굵게·목록) ----------
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function md(src) {
  const parts = String(src).split(/```[^\n]*\n?/);
  return parts.map((part, i) => {
    if (i % 2) return `<pre><code>${esc(part.replace(/\n$/, ''))}</code></pre>`;
    return part.split(/\n{2,}/).map((para) => {
      const lines = para.split('\n').filter((l) => l.trim());
      if (!lines.length) return '';
      const inline = (t) => esc(t)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
        .replace(/^#{1,6}\s+(.*)$/, '<b>$1</b>');
      if (lines.every((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l))) {
        const ordered = /^\s*\d/.test(lines[0]);
        const items = lines.map((l) => `<li>${inline(l.replace(/^\s*([-*•]|\d+[.)])\s+/, ''))}</li>`).join('');
        return ordered ? `<ol>${items}</ol>` : `<ul>${items}</ul>`;
      }
      return `<p>${lines.map(inline).join('<br>')}</p>`;
    }).join('');
  }).join('');
}

// ---------- 말풍선 ----------
function showReply() { reply.classList.add('show'); document.body.classList.remove('show-history'); }
function scrollEnd() { reply.scrollTop = reply.scrollHeight; }
function setStatus(text) {
  let st = replyText.querySelector('.status');
  if (!text) { st?.remove(); return; }
  if (!st) { st = document.createElement('div'); st.className = 'status'; replyText.append(st); }
  st.innerHTML = `<span>${esc(text)}</span><span class="dots"></span>`;
  replyText.append(st);   // 항상 맨 아래
  scrollEnd();
}
function setMutter(text) {
  let m = replyText.querySelector('.mutter');
  if (!m) { m = document.createElement('div'); m.className = 'mutter'; replyText.append(m); }
  m.textContent = text;
  scrollEnd();
}
function addNote(text, bad = false) {
  const n = document.createElement('div');
  n.className = 'note' + (bad ? ' bad' : '');
  n.textContent = text;
  replyText.append(n);
  showReply(); scrollEnd();
  return n;
}
function addLoginButton() {
  const row = document.createElement('div');
  row.className = 'row';
  row.style.marginTop = '8px';
  const b = document.createElement('button');
  b.className = 'go';
  b.textContent = 'Claude 계정으로 로그인';
  b.onclick = () => { b.disabled = true; ipcRenderer.send('agent-login'); };
  row.append(b);
  replyText.append(row);
  scrollEnd();
}

function setBusy(on) {
  busy = on;
  document.body.classList.toggle('busy', on);
}

function renderHistory() {
  const all = turn ? [...turns, turn] : turns;
  if (!all.length) { history.innerHTML = '<div class="h-empty">아직 나눈 이야기가 없어요</div>'; return; }
  history.innerHTML = all.map((t) =>
    `<div class="h-user"><span>${esc(t.user)}</span></div><div class="h-bot">${md(t.bot || '…')}</div>`).join('');
  history.scrollTop = history.scrollHeight;
}

// ---------- 에이전트 이벤트 ----------
let lastMutter = 0;
ipcRenderer.on('agent-event', (ev, e) => {
  switch (e.type) {
    case 'start':
      setBusy(true);
      showReply();
      replyText.innerHTML = '';
      setStatus('생각하는 중');
      break;
    case 'thought': {
      const now = Date.now();
      if (now - lastMutter < 2500) break;
      const line = thoughtParagraphs(e.text).map((p) => thoughtLine(p)).filter(Boolean).pop();
      if (line) { lastMutter = now; setMutter(line); }
      break;
    }
    case 'text': {
      // 중간 문장도 답의 일부. 마지막 문단이 최종 답
      if (turn) turn.bot = (turn.bot ? turn.bot + '\n\n' : '') + e.text.trim();
      replyText.querySelector('.mutter')?.remove();
      const div = document.createElement('div');
      div.innerHTML = md(e.text.trim());
      replyText.insertBefore(div, replyText.querySelector('.status'));
      showReply(); scrollEnd();
      break;
    }
    case 'tool':
      setStatus(toolLine(e.name).replace(/…$/, ''));
      break;
    case 'permission': {
      showReply();
      setStatus(null);
      const box = document.createElement('div');
      box.className = 'ask';
      box.dataset.id = e.id;
      box.innerHTML = `<div class="q"></div><code class="what"></code><div class="row"><button class="no">안 돼요</button><button class="go yes">좋아요</button></div>`;
      box.querySelector('.q').textContent = askLine(e.tool);
      box.querySelector('.what').textContent = e.summary || e.tool;
      box.querySelector('.no').onclick = () => ipcRenderer.send('agent-answer', { id: e.id, allow: false });
      box.querySelector('.yes').onclick = () => ipcRenderer.send('agent-answer', { id: e.id, allow: true });
      replyText.append(box);
      scrollEnd();
      box.querySelector('.yes').focus();
      break;
    }
    case 'permissionDone': {
      const box = replyText.querySelector(`.ask[data-id="${e.id}"]`);
      if (box) box.querySelector('.row').outerHTML = `<div class="note">${e.allow ? '✅ 허락했어요' : '⛔ 거절했어요'}</div>`;
      if (busy) setStatus('계속하는 중');
      break;
    }
    case 'note': addNote(e.text, true); if (/로그인/.test(e.text)) addLoginButton(); break;
    case 'done': setStatus(null); replyText.querySelector('.mutter')?.remove(); break;
    case 'error':
      setStatus(null);
      replyText.querySelector('.mutter')?.remove();
      if (e.stopped) addNote('멈췄어요');
      else { addNote(e.message, true); if (/로그인/.test(e.message)) addLoginButton(); }
      if (turn && !turn.bot) turn.bot = '(' + (e.stopped ? '멈춤' : e.message) + ')';
      break;
    case 'idle':
      setBusy(false);
      if (turn) { turns.push(turn); turn = null; }
      input.focus();
      break;
    case 'loginStart': addNote('브라우저에서 로그인 창이 열려요. 로그인하고 돌아와 주세요.'); break;
    case 'loginDone': addNote(e.ok ? '로그인됐어요! 다시 말 걸어 주세요.' : '로그인하지 못했어요. 다시 시도해 주세요.', !e.ok); break;
  }
});

ipcRenderer.on('talk-reset', (ev, { note } = {}) => {
  turns.length = 0; turn = null;
  replyText.innerHTML = '';
  if (note) addNote(note);
  renderHistory();
});
ipcRenderer.on('talk-focus', () => input.focus());

// ---------- 입력 ----------
async function send() {
  const text = input.value.trim();
  if (!text || busy) return;
  turn = { user: text, bot: '' };
  input.value = '';
  autosize();
  const err = await ipcRenderer.invoke('agent-send', text);
  if (err) { addNote(err, true); turn = null; }
}
function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(120, input.scrollHeight) + 'px';
}
input.addEventListener('input', autosize);
input.addEventListener('keydown', (e) => {
  // 한글 조합 중 Enter 는 글자 확정이므로 보내지 않음
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); send(); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') ipcRenderer.send('talk-hide'); });
$('send').onclick = send;
$('stop').onclick = () => ipcRenderer.send('agent-stop');
$('closeBtn').onclick = () => ipcRenderer.send('talk-hide');
$('histBtn').onclick = () => {
  const on = !document.body.classList.contains('show-history');
  document.body.classList.toggle('show-history', on);
  $('histBtn').textContent = on ? '지금 대화' : '지난 대화';
  if (on) renderHistory();
};

ipcRenderer.invoke('talk-state').then((st) => {
  setBusy(st.busy);
  input.focus();
});
