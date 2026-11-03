// 設定ウィンドウ。値は持たず、操作をマスコットへ送り、返ってきた状態を表示する
//   操作：ipcRenderer.send('settings-action', { type, key?, value? })
//   状態：'settings-state' { settings, bundled, library, voicePacks, target, primary, followSupported, characters }
//   どのキャラの設定を出すかはメインが持つ（settings-select-character で切り替え）
const { ipcRenderer, webUtils } = require('electron');
const path = require('path');

const $ = (id) => document.getElementById(id);
const act = (type, extra = {}) => ipcRenderer.send('settings-action', { type, ...extra });
const set = (key, value) => act('set', { key, value });

let state = null;

// ドラッグ中・入力中の部品は上書きしない（スライダーが指から逃げないように）
const idle = (el) => el !== document.activeElement;

// ===== モデル一覧（エクスプローラ風） =====
// サムネは VRM の埋め込みだけ。無いモデルは頭文字。一度取ったサムネはここで覚える
const thumbCache = new Map(); // file → data URL | null
let gridKey = '';

async function loadThumbs(files) {
  const need = files.filter((f) => f && !thumbCache.has(f));
  if (!need.length) return;
  const got = await ipcRenderer.invoke('model-thumbs', need);
  for (const f of need) thumbCache.set(f, got[f] ?? null);
}

function thumbBox(el, file, label) {
  el.innerHTML = '';
  const url = file ? thumbCache.get(file) : null;
  if (url) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    el.appendChild(img);
  } else {
    const span = document.createElement('span');
    span.className = 'initial';
    span.textContent = [...(label || '?')][0].toUpperCase();
    el.appendChild(span);
  }
}

async function fillModelGrid(s) {
  const grid = $('model-grid');
  const external = path.isAbsolute(s.settings.model) ? [s.settings.model] : [];
  const groups = [
    ['기본 포함', s.bundled.map((id) => [id, id])],
    ['라이브러리', s.library.map((id) => [id, 'lib:' + id])],
    ['외부', external.map((p) => ['📁 ' + path.basename(p), p])]
  ].filter(([, items]) => items.length);

  // 一覧が変わった時だけ作り直す（スライダー操作のたびに状態が届くため）
  const key = JSON.stringify(groups);
  if (key !== gridKey) {
    gridKey = key;
    await loadThumbs(groups.flatMap(([, items]) => items.map(([, v]) => s.modelPaths?.[v])));
    grid.innerHTML = '';
    for (const [label, items] of groups) {
      const h = document.createElement('div');
      h.className = 'group';
      h.textContent = label;
      grid.appendChild(h);
      for (const [text, value] of items) {
        const tile = document.createElement('button');
        tile.className = 'model-tile';
        tile.dataset.value = value;
        tile.title = text;
        const box = document.createElement('div');
        box.className = 'thumb';
        thumbBox(box, s.modelPaths?.[value], text.replace(/^📁 /, ''));
        const name = document.createElement('div');
        name.className = 'name';
        name.textContent = text;
        tile.append(box, name);
        tile.onclick = () => { tile.blur(); act('model', { value }); };
        if (value.startsWith('lib:')) acceptThumbDrop(tile, s.modelPaths?.[value], text);
        grid.appendChild(tile);
      }
    }
  }
  for (const tile of grid.querySelectorAll('.model-tile')) {
    const on = tile.dataset.value === state.settings.model;
    if (on && !tile.classList.contains('selected')) tile.scrollIntoView({ block: 'nearest' });
    tile.classList.toggle('selected', on);
  }
}

// タイルに画像をドロップ → 確認してから、そのモデルのフォルダに thumb.* として入れる（ライブラリのモデルだけ）
const IMAGE_RE = /\.(png|jpe?g|webp)$/i;
function acceptThumbDrop(tile, file, name) {
  if (!file) return;
  tile.addEventListener('dragover', (e) => { e.preventDefault(); tile.classList.add('drop'); });
  tile.addEventListener('dragleave', () => tile.classList.remove('drop'));
  tile.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    tile.classList.remove('drop');
    const f = e.dataTransfer.files[0];
    if (!f) return;
    const image = webUtils.getPathForFile(f);
    if (!IMAGE_RE.test(image)) { alert('썸네일은 PNG·JPEG·WebP 이미지만 사용할 수 있습니다'); return; }
    const info = await ipcRenderer.invoke('thumb-info', file);
    if (!info.editable) return;
    const verb = info.exists ? '교체할까요?' : '추가할까요?';
    if (!confirm(`「${name}」에 썸네일 이미지 「${path.basename(image)}」을(를) ${verb}`)) return;
    const res = await ipcRenderer.invoke('thumb-set', { file, image });
    if (res.error) { alert(res.error); return; }
    thumbCache.delete(file);
    gridKey = ''; // 作り直す
    render(state);
  });
}

// 一覧の外に落とした画像で窓が画像に置き換わらないように
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

async function fillCharacterThumb(s) {
  const c = s.characters.find((x) => x.id === s.target);
  await loadThumbs([c?.modelPath]);
  const label = c?.model ? (c.model.startsWith('lib:') ? c.model.slice(4) : path.basename(c.model)) : '?';
  thumbBox($('character-thumb'), c?.modelPath, label);
}

function fillCharacterSelect(s) {
  const sel = $('character-select');
  if (idle(sel)) {
    sel.innerHTML = '';
    for (const c of s.characters) sel.add(new Option(c.label, c.id));
    sel.value = s.target;
  }
  $('btn-remove-character').disabled = s.characters.length <= 1;
}

function render(s) {
  if (!s) return;
  state = s;
  const st = s.settings;
  fillCharacterSelect(s);
  fillCharacterThumb(s);
  fillModelGrid(s);
  $('btn-remove-model').disabled = !st.model.startsWith('lib:');
  const setVal = (id, v) => { if (idle($(id))) $(id).value = v; };
  setVal('height-range', st.height);
  setVal('opacity-range', st.opacity);
  $('height-val').textContent = st.height + ' px';
  $('opacity-val').textContent = Math.round(st.opacity * 100) + '%';
  $('gaze-check').checked = st.gaze;
}

// ===== Claude 설정 (메인이 가진 값) =====
async function renderClaude() {
  const c = await ipcRenderer.invoke('claude-settings-get');
  $('claude-check').checked = c.claude;
  $('study-check').checked = c.study;
  $('study-check').disabled = !c.mac;
  $('study-row').style.opacity = c.mac ? 1 : 0.5;
  const sel = $('model-select');
  if (idle(sel)) {
    sel.innerHTML = '';
    for (const [id, label] of c.models) sel.add(new Option(label, id));
    sel.value = c.model;
  }
  $('usage').textContent = c.usage || '';
  $('ver').textContent = `빌드 ${c.build}`;
  $('keys').innerHTML = '';
  for (const [k, what] of c.keys) {
    const kb = document.createElement('kbd'); kb.textContent = k;
    const sp = document.createElement('span'); sp.textContent = what;
    $('keys').append(kb, sp);
  }
}
const claudeAct = (action, value) => ipcRenderer.invoke('claude-settings', { action, value }).then(renderClaude);
$('claude-check').onchange = (e) => claudeAct('mode', e.target.checked);
$('study-check').onchange = (e) => claudeAct('study', e.target.checked);
$('model-select').onchange = (e) => { e.target.blur(); claudeAct('model', e.target.value); };
$('btn-persona').onclick = () => claudeAct('persona');
$('btn-memory').onclick = () => claudeAct('memory');
$('btn-login').onclick = () => claudeAct('login');
$('btn-update').onclick = () => claudeAct('update');
$('btn-credits').onclick = () => claudeAct('credits');
$('btn-open-data').onclick = () => claudeAct('data');
ipcRenderer.on('claude-settings-changed', renderClaude);
window.addEventListener('focus', renderClaude);
renderClaude();

// ===== 操作 =====
$('character-select').onchange = (e) => {
  e.target.blur();
  ipcRenderer.send('settings-select-character', e.target.value);
};
$('btn-add-character').onclick = () => ipcRenderer.send('character-add');
$('btn-remove-character').onclick = () => {
  if (!state || state.characters.length <= 1) return;
  const c = state.characters.find((x) => x.id === state.target);
  if (confirm(`「${c?.label || state.target}」을(를) 삭제할까요?`)) ipcRenderer.send('character-remove', state.target);
};
$('btn-import-model').onclick = () => act('import-model');
$('btn-select-file').onclick = () => act('select-model-file');
$('btn-open-library').onclick = () => ipcRenderer.send('library-open');
$('btn-remove-model').onclick = () => {
  const m = state?.settings.model || '';
  if (!m.startsWith('lib:')) return;
  if (confirm(`「${m.slice(4)}」을(를) 라이브러리에서 삭제할까요?`)) act('remove-model');
};
$('height-range').oninput = (e) => set('height', parseFloat(e.target.value));
$('opacity-range').oninput = (e) => set('opacity', parseFloat(e.target.value));
$('gaze-check').onchange = (e) => set('gaze', e.target.checked);

// スライダーは離したらフォーカスを外す（以降の状態更新を反映させる）
for (const id of ['height-range', 'opacity-range']) {
  $(id).addEventListener('change', (e) => e.target.blur());
}

window.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.close(); });

// ===== 状態の受信 =====
ipcRenderer.on('settings-state', (event, s) => render(s));

(async () => {
  render(await ipcRenderer.invoke('settings-get-state'));
})();
