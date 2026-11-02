// Claude 에이전트 채팅 창. 실제 작업은 메인 프로세스(src/main/agent.js)가 하고, 여기는 보여 주고 입력만 받는다.
const { ipcRenderer } = require('electron');
const { thoughtParagraphs } = require('../shared/agent-lines');

const $ = (id) => document.getElementById(id);
const log = $('log'), input = $('input'), sendBtn = $('send'), stopBtn = $('stop');
let busy = false;
const asks = new Map(); // 승인 요청 id → 카드

function add(cls, text) {
  const el = document.createElement('div');
  el.className = 'msg ' + cls;
  if (text != null) el.textContent = text;
  const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.append(el);
  if (stick) log.scrollTop = log.scrollHeight;
  return el;
}
const note = (text, bad = false) => { const el = add('note' + (bad ? ' bad' : ''), text); el.classList.remove('msg'); return el; };

function setBusy(on) {
  busy = on;
  sendBtn.style.display = on ? 'none' : '';
  stopBtn.style.display = on ? '' : 'none';
  $('reset').disabled = on;
  $('folder').disabled = on;
}

function showState(st) {
  $('folder').textContent = st.cwd ? '📁 ' + st.cwd.split(/[\\/]/).filter(Boolean).pop() : '📁 작업 폴더 고르기';
  $('folder').title = st.cwd || '작업 폴더 고르기';
  $('model').value = st.model || '';
  $('keyState').textContent = st.hasKey ? 'API 키가 저장되어 있어요 (지우려면 칸을 비우고 Enter).' : 'API 키 없음: 이 컴퓨터의 Claude Code 설정을 따릅니다. (Finder로 켠 앱은 터미널 환경 변수를 못 읽으니 키를 넣어 두는 게 확실해요)';
  setBusy(st.busy);
}

function askCard(e) {
  const card = add('ask');
  card.classList.remove('msg');
  const title = document.createElement('div');
  title.textContent = `🙋 ${e.tool} 를(을) 써도 될까요?`;
  const code = document.createElement('code');
  code.textContent = e.summary || '';
  const row = document.createElement('div');
  row.className = 'row';
  const no = document.createElement('button'); no.textContent = '거부';
  const yes = document.createElement('button'); yes.textContent = '허용'; yes.className = 'primary';
  no.onclick = () => ipcRenderer.send('agent-answer', { id: e.id, allow: false });
  yes.onclick = () => ipcRenderer.send('agent-answer', { id: e.id, allow: true });
  row.append(no, yes);
  const verdict = document.createElement('div'); verdict.className = 'verdict';
  card.append(title, code, row, verdict);
  asks.set(e.id, card);
  yes.focus();
}

ipcRenderer.on('agent-event', (ev, e) => {
  switch (e.type) {
    case 'start': setBusy(true); break;
    case 'thought':
      for (const p of thoughtParagraphs(e.text)) add('thought', '💭 ' + p);
      break;
    case 'text': add('assistant', e.text.trim()); break;
    case 'tool': {
      const el = note('');
      el.className = 'tool';
      el.innerHTML = '🔧 <b></b> ';
      el.querySelector('b').textContent = e.name;
      el.append(e.summary || '');
      el.title = e.summary || '';
      break;
    }
    case 'permission': askCard(e); break;
    case 'permissionDone': {
      const card = asks.get(e.id);
      if (card) {
        card.classList.add('answered');
        card.querySelector('.verdict').textContent = e.allow ? '✅ 허용함' : '⛔ 거부함';
        asks.delete(e.id);
      }
      break;
    }
    case 'done':
      note(typeof e.cost === 'number' ? `완료 · 이번 작업 약 $${e.cost.toFixed(4)}` : '완료');
      break;
    case 'error': note(e.stopped ? '중지했어요' : '⚠️ ' + e.message, !e.stopped); break;
    case 'idle': setBusy(false); input.focus(); break;
  }
});

async function send() {
  const text = input.value.trim();
  if (!text || busy) return;
  add('user', text);
  input.value = '';
  autosize();
  const err = await ipcRenderer.invoke('agent-send', text);
  if (err) note('⚠️ ' + err, true);
}

function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(140, input.scrollHeight + 2) + 'px';
}
input.addEventListener('input', autosize);
input.addEventListener('keydown', (e) => {
  // 한글 조합 중 Enter 는 글자 확정이므로 보내지 않음
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); send(); }
});
sendBtn.onclick = send;
stopBtn.onclick = () => ipcRenderer.send('agent-stop');
$('folder').onclick = async () => showState(await ipcRenderer.invoke('agent-pick-folder'));
$('reset').onclick = async () => {
  showState(await ipcRenderer.invoke('agent-reset'));
  log.textContent = '';
  note('새 대화를 시작해요');
};
$('gear').onclick = () => $('settings').classList.toggle('open');
$('model').onchange = async () => showState(await ipcRenderer.invoke('agent-set', { model: $('model').value }));
$('apikey').addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  showState(await ipcRenderer.invoke('agent-set', { apiKey: $('apikey').value.trim() }));
  $('apikey').value = '';
});

ipcRenderer.invoke('agent-get-state').then((st) => {
  showState(st);
  if (!st.cwd) note('먼저 위의 📁 버튼으로 작업할 폴더를 골라 주세요.');
  input.focus();
});
