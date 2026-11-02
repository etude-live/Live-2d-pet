// 말 걸기 창: 캐릭터 옆의 답변 말풍선 + 입력칸. 작업은 메인(src/main/agent.js)이 한다.
const { ipcRenderer } = require('electron');
const { thoughtParagraphs, thoughtLine, toolLine, askLine } = require('../shared/agent-lines');

const $ = (id) => document.getElementById(id);
const reply = $('reply'), replyText = reply.querySelector('.text'), input = $('input'), history = $('history');
const PART = new URLSearchParams(location.search).get('part') || 'reply';
document.body.classList.add('part-' + PART);
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
      const inline = (t) => esc(t.replace(/\\([\\`*_{}\[\]()#+\-.!~|>])/g, '$1'))   // 마크다운 이스케이프(\~ 등)는 글자만
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
function showReply() { reply.classList.add('show'); document.body.classList.remove('show-history', 'show-persona'); $('histBtn').textContent = '지난 대화'; }
function scrollEnd() { reply.scrollTop = reply.scrollHeight; replyText.scrollTop = replyText.scrollHeight; }
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

// 로그인 코드 붙여넣기 칸 (코드는 메인을 거쳐 로그인 과정에만 전달되고 저장하지 않음)
function addCodeBox() {
  replyText.querySelector('.codebox')?.remove();
  const box = document.createElement('div');
  box.className = 'codebox row';
  box.style.marginTop = '8px';
  box.innerHTML = '<input type="password" placeholder="인증 코드 붙여넣기" autocomplete="off"><button class="go">확인</button>';
  const field = box.querySelector('input'), ok = box.querySelector('button');
  const submit = () => {
    const code = field.value.trim();
    if (!code) return;
    ipcRenderer.send('agent-login-code', code);
    box.outerHTML = '<div class="note">코드를 넣었어요. 확인하는 중…</div>';
  };
  ok.onclick = submit;
  field.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  replyText.append(box);
  scrollEnd();
  field.focus();
}

// 답 아래 작은 복사 버튼
function addCopyButton(text) {
  const t = String(text || '').trim();
  if (!t || t.length < 2) return;
  const row = document.createElement('div');
  row.className = 'row copyrow';
  const b = document.createElement('button');
  b.className = 'mini';
  b.textContent = '복사';
  b.onclick = () => { require('electron').clipboard.writeText(t); b.textContent = '복사했어요'; };
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
  if (PART === 'input') {   // 입력칸은 바쁨 표시만
    if (e.type === 'start') setBusy(true);
    if (e.type === 'idle') { setBusy(false); input.focus(); }
    return;
  }
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
      box.innerHTML = `<div class="q"></div><div class="why"></div><div class="warn"></div><code class="what"></code><div class="row"><button class="no">안 돼요</button><button class="go yes">좋아요</button></div>`;
      box.querySelector('.q').textContent = askLine(e.tool);
      // 무엇을 하려는지 쉬운 말로 (Claude 가 붙인 설명)
      if (e.why) box.querySelector('.why').textContent = '💡 ' + e.why; else box.querySelector('.why').remove();
      // 위험 신호
      if (e.dangers?.length) { box.classList.add('danger'); box.querySelector('.warn').textContent = '⚠️ ' + e.dangers.join(' · ') + ' — 확실할 때만 허락해 주세요'; }
      else box.querySelector('.warn').remove();
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
    case 'done': setStatus(null); replyText.querySelector('.mutter')?.remove(); addCopyButton(e.result); break;
    case 'clipDone': addNote('📋 결과를 클립보드에 복사해 뒀어요 (⌘V)'); break;
    case 'reminder': showReply(); replyText.innerHTML = ''; addNote(''); replyText.lastChild.className = 'reminder'; replyText.lastChild.textContent = '⏰ ' + e.text; break;
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
      break;
    case 'loginStart':
      showReply();
      addNote('브라우저에서 Claude 로그인 창이 열려요. 로그인한 뒤 화면에 나온 코드를 아래 칸에 붙여 넣어 주세요.');
      addCodeBox();
      break;
    case 'loginNeedCode': replyText.querySelector('.codebox input')?.focus(); break;
    case 'loginUrl': {
      const a = document.createElement('div');
      a.className = 'note';
      a.innerHTML = '브라우저가 안 열렸으면 <a href="#">여기</a>를 눌러 주세요';
      a.querySelector('a').onclick = (ev2) => { ev2.preventDefault(); ipcRenderer.send('open-url', e.url); };
      replyText.insertBefore(a, replyText.querySelector('.codebox'));
      break;
    }
    case 'loginDone':
      replyText.querySelector('.codebox')?.remove();
      if (e.ok) addNote('로그인됐어요! 이제 말 걸어 주세요.');
      else { addNote('로그인하지 못했어요. ' + (/accepted|expired/i.test(e.error || '') ? '코드가 맞지 않거나 만료됐어요. ' : '') + '다시 시도해 주세요.', true); addLoginButton(); }
      break;
  }
});

ipcRenderer.on('talk-reset', (ev, { note } = {}) => {
  turns.length = 0; turn = null;
  replyText.innerHTML = '';
  if (note) addNote(note);
  renderHistory();
});
// 머리 위 / 옆
ipcRenderer.on('talk-side', (ev, side) => document.body.classList.toggle('side-top', side === 'top'));

// ---------- 말투(지침) / 기억 편집 (같은 칸을 같이 씀) ----------
const PANELS = {
  persona: {
    title: '🗣 캐릭터 말투 · 지침',
    help: '이름, 말투, 나를 부르는 호칭, 성격처럼 캐릭터가 지킬 것을 자유롭게 적어 주세요. 다음 대답부터 바로 적용돼요.',
    get: 'persona-get', set: 'persona-set', saved: '말투를 저장했어요. 다음 대답부터 적용돼요.'
  },
  memory: {
    title: '🧠 기억',
    help: '지난 대화들을 짧게 압축해 둔 메모예요. 대화가 끝나면 중요한 것과 최근 일만 남기고 자동으로 정리돼요. 틀린 건 고치거나 지워도 돼요.',
    get: 'memory-get', set: 'memory-set', saved: '기억을 고쳤어요. 새 대화부터 적용돼요.', placeholder: '아직 기억이 없어요. 대화를 나누면 다음에 켤 때 정리돼요.'
  }
};
let panel = null;
const personaPlaceholder = $('personaText').placeholder;
async function openPanel(kind) {
  panel = kind;
  const P = PANELS[kind];
  document.querySelector('#persona .p-title').textContent = P.title;
  document.querySelector('#persona .p-help').textContent = P.help;
  $('personaText').placeholder = P.placeholder || personaPlaceholder;
  $('personaText').value = await ipcRenderer.invoke(P.get);
  document.body.classList.remove('show-history');
  document.body.classList.add('show-persona');
  $('personaText').focus();
}
function closePanel() { document.body.classList.remove('show-persona'); panel = null; }
const togglePanel = (kind) => (panel === kind ? closePanel() : openPanel(kind));
ipcRenderer.on('talk-persona', () => { if (PART === 'reply') openPanel('persona'); });
ipcRenderer.on('talk-memory', () => { if (PART === 'reply') openPanel('memory'); });
$('personaBtn').onclick = () => togglePanel('persona');
$('memoryBtn').onclick = () => togglePanel('memory');
$('personaCancel').onclick = closePanel;
$('personaSave').onclick = async () => {
  const P = PANELS[panel];
  await ipcRenderer.invoke(P.set, $('personaText').value);
  closePanel();
  showReply();
  addNote(P.saved);
};

// ---------- 화면 캡처 첨부 표시 (입력칸) ----------
ipcRenderer.on('talk-attach', (ev, att) => {
  if (PART !== 'input') return;
  const chip = $('attach');
  if (!att) { chip.style.display = 'none'; input.placeholder = '말 걸기…'; return; }
  chip.querySelector('img').src = att.preview;
  chip.style.display = 'flex';
  input.placeholder = '이 화면에서 뭘 도와줄까요? (그냥 Enter: 알아서 봐 줘)';
  input.focus();
});
$('attachX').onclick = () => ipcRenderer.send('talk-unattach');

// ---------- 파일 끌어다 놓기 (입력칸) ----------
if (PART === 'input') {
  const { webUtils } = require('electron');
  document.addEventListener('dragover', (e) => { e.preventDefault(); $('composer').classList.add('drop'); });
  document.addEventListener('dragleave', () => $('composer').classList.remove('drop'));
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    $('composer').classList.remove('drop');
    const paths = [...e.dataTransfer.files].map((f) => webUtils.getPathForFile(f)).filter(Boolean);
    if (!paths.length) return;
    ipcRenderer.send('talk-drop', paths);
    const names = paths.map((p) => `"${p}"`).join(', ');
    input.value = (input.value ? input.value + '\n' : '') + `이 파일 ${names} 보고 `;
    autosize();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });
}

ipcRenderer.on('talk-focus', () => { if (PART === 'input') input.focus(); });
// 입력칸 창에서 보낸 말 → 말풍선 창이 이번 턴으로 기록
ipcRenderer.on('talk-user', (ev, text) => { if (PART === 'reply') turn = { user: text, bot: '' }; });

// ---------- 입력 ----------
async function send() {
  let text = input.value.trim();
  if (!text && $('attach').style.display === 'flex') text = '이 화면 보고, 지금 내가 뭘 하는 중인지 짧게 짚고 도움이 될 만한 걸 하나 말해 줘';
  if (!text || busy) return;
  input.value = '';
  autosize();
  const err = await ipcRenderer.invoke('agent-send', text);
  if (err) input.value = text;
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
  document.body.classList.remove('show-persona');
  const on = !document.body.classList.contains('show-history');
  document.body.classList.toggle('show-history', on);
  $('histBtn').textContent = on ? '지금 대화' : '지난 대화';
  if (on) renderHistory();
};

ipcRenderer.invoke('talk-state').then((st) => {
  setBusy(st.busy);
  if (PART === 'input') input.focus();
});
