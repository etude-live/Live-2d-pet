const { ipcRenderer, webUtils } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');
const { FORMATS, formatOf, isModelFile, isSingleFileModel, modelFileLabel } = require('../shared/formats');
const { isMotionFile, motionRoles } = require('../shared/motions');
const AGENT = require('../shared/agent-lines');

// ===== パス =====
const ASSETS_DIR = fileURLToPath(new URL('../../assets/', location.href));
const VOICES_DIR = path.join(ASSETS_DIR, 'voices');

// assets/<name>/ にモデルファイルがあれば同梱モデルとして列挙
function listBundledModels() {
  const result = [];
  try {
    for (const dir of fs.readdirSync(ASSETS_DIR, { withFileTypes: true })) {
      if (!dir.isDirectory() || dir.name === 'voices') continue;
      const file = fs.readdirSync(path.join(ASSETS_DIR, dir.name)).find((f) => isModelFile(f));
      if (file) result.push({ id: dir.name, path: path.join(ASSETS_DIR, dir.name, file) });
    }
  } catch (e) { console.warn('assets走査失敗:', e); }
  return result;
}

// assets/voices/<name>/voices.json をボイスパックとして列挙
function listVoicePacks() {
  try {
    return fs.readdirSync(VOICES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(VOICES_DIR, d.name, 'voices.json')))
      .map((d) => d.name);
  } catch { return []; }
}

// ===== 設定 =====
const DEFAULTS = {
  model: 'haru_greeter', // 同梱モデルのフォルダ名、ライブラリ "lib:<名前>"、またはモデルファイルの絶対パス
  voicePack: 'haru',     // assets/voices/<name>、空文字でなし
  height: 480,
  opacity: 1,
  gaze: true,
  // 声の出し方（設定画面・右クリックの「声」は voiceModeOf / setVoiceMode でこの3つにまとめて見せる）
  voice: false,          // 読み上げ：on で VOICEVOX（ボイスパックのセリフも）か OS 音声（自作セリフだけ）
  ttsEngine: 'voicevox', // 'voicevox' | 'os'（VOICEVOXが無ければOSに切り替え）
  mute: false,           // 音を出さない（字幕としぐさだけ）
  voicevoxSpeaker: 8,    // 話者スタイルID
  voicevoxSpeed: 1.0,
  events: true,
  chime: true,
  follow: true           // VS Code の枠内に収める（Windows のみ。判定はメイン）
};

// 声の出し方：'pack'（ボイスパックだけ）/ 'voicevox' / 'os'（ボイスパック＋OS 音声）/ 'mute'
function voiceModeOf(s) {
  if (s.mute) return 'mute';
  if (!s.voice) return 'pack';
  return s.ttsEngine === 'os' ? 'os' : 'voicevox';
}

function setVoiceMode(mode) {
  if (!['pack', 'voicevox', 'os', 'mute'].includes(mode)) return;
  settings.mute = mode === 'mute';
  if (mode === 'pack') settings.voice = false;
  if (mode === 'voicevox' || mode === 'os') { settings.voice = true; settings.ttsEngine = mode; }
  if (settings.mute) stopVoice();
  saveSettings();
}

// キャラごとの設定はメインが characters.json に持つ（窓は index.html?id=c1 のように1キャラ1枚）。
// 最初の起動の1体目だけ、以前の版の localStorage の設定を引き継ぐ
const init = ipcRenderer.sendSync('character-init') || { settings: null, migrate: false, primary: true };
let isPrimary = init.primary; // 代表：VS Code のイベントと時報に反応する

const settings = (() => {
  let saved = init.settings;
  if (!saved && init.migrate) {
    try { saved = JSON.parse(localStorage.getItem('mascot-settings-v3') || 'null'); } catch {}
  }
  return { ...DEFAULTS, ...(saved || {}) };
})();

// 保存は状態の送信を兼ねる（メインが characters.json に書く）
function saveSettings() {
  pushSettingsState();
}

// 設定ウィンドウへ今の状態を送る（メインが中継。閉じていてもメインが最新を覚えておく）
function pushSettingsState() {
  ipcRenderer.send('settings-state', {
    settings: { ...settings },
    bundled: listBundledModels().map((m) => m.id),
    library: libraryModels.map((m) => m.id),
    modelPaths: modelPaths(), // model の値 → ファイル（設定ウィンドウのサムネ用）
    voicePacks: listVoicePacks()
  });
}

// ===== レイアウト定数 =====
const PAD = 16;
const BUBBLE_SPACE = 110;
const MIN_W = 320;
const MIN_H = 460;

// ===== 状態 =====
const $ = (id) => document.getElementById(id);
const bubble = $('bubble');

// ===== アダプタ =====
// 描画はアダプタ（adapters/*.js）に任せる。app.js はここに並べたメソッドだけを使う。
// モデルが無い間は NO_MODEL が代わりに応える（起動直後から届くカーソル位置などを空振りさせる）
const NO_MODEL = {
  formatId: null,
  async load() {},
  setHeight() {},
  getSize: () => ({ width: 0, height: 0 }),
  setPosition() {},
  getBounds: () => null,
  focus() {},
  resetFocus() {},
  listMotions: () => [],
  playMotion() {},
  setExpression() {},
  listExpressions: () => [],
  resetExpression() {},
  setMouth() {},
  setModelSound() {},
  setMotions() {},
  hitTest: () => false,
  dispose() {}
};
let mascot = NO_MODEL;

// 形式に合うアダプタを用意する。形式が変わる時は canvas ごと作り直す
// （PixiJS と Three.js は同じ canvas の WebGL コンテキストを使い回せない）
async function useAdapter(format) {
  if (mascot.formatId === format.id) return mascot;
  if (!window[format.adapter] && format.module) await import(format.module);
  const Adapter = window[format.adapter];
  if (!Adapter) throw new Error('アダプタがありません: ' + format.adapter);
  mascot.dispose();
  mascot = NO_MODEL;
  const canvas = document.createElement('canvas');
  canvas.id = 'stage';
  canvas.style.opacity = settings.opacity;
  $('stage').replaceWith(canvas);
  mascot = new Adapter(canvas);
  mascot.formatId = format.id;
  mascot.setModelSound(false); // 声はボイスパックから鳴らす（字幕と一致させるため）
  return mascot;
}

let voices = [];          // [{ url, text, motion }]
let isDragging = false;
let dragStartX = 0, dragStartY = 0;
let downScreenX = 0, downScreenY = 0;
let ignoring = false;

// ===== モデル =====
// model の値：同梱 "haru_greeter" / ライブラリ "lib:<名前>" / 外部 "C:\...\x.model3.json"
let libraryModels = [];

async function refreshLibrary() {
  libraryModels = await ipcRenderer.invoke('library-list');
  pushSettingsState();
}

// ライブラリ・モーションはキャラ共通。別のキャラが取り込み・削除した時に届く
ipcRenderer.on('library-changed', async () => {
  await refreshLibrary();
  const m = settings.model;
  if (m.startsWith('lib:') && !libraryModels.some((x) => x.id === m.slice(4))) {
    loadModel(DEFAULTS.model, { announce: false }); // 使っていたモデルが消された
  }
});
ipcRenderer.on('motions-changed', () => refreshMotions());

function modelPaths() {
  const out = {};
  for (const m of listBundledModels()) out[m.id] = m.path;
  for (const m of libraryModels) out['lib:' + m.id] = m.path;
  if (path.isAbsolute(settings.model)) out[settings.model] = settings.model;
  return out;
}

function resolveModelPath(model) {
  if (!model) return null;
  if (model.startsWith('lib:')) return libraryModels.find((m) => m.id === model.slice(4))?.path || null;
  if (path.isAbsolute(model)) return model;
  return listBundledModels().find((m) => m.id === model)?.path || null;
}

// ZIP / .vrm / フォルダをライブラリに取り込んで表示
async function importModel(p) {
  const res = await ipcRenderer.invoke('import-model', p);
  if (!res) return;
  if (res.error) { say('가져오지 못했어…\n' + res.error, 5000, { tts: false }); return; }
  if (res.motions !== undefined) { await onMotionsImported(res.motions); return; } // モーションパック
  await refreshLibrary();
  loadModel('lib:' + res.id);
}

// ===== モーション（VRMA。全モデル共通） =====
// 役割（待機・しぐさ）は shared/motions.js が名前で決める。アダプタは役割ごとの一覧だけ受け取る
let motionFiles = [];

async function refreshMotions() {
  motionFiles = await ipcRenderer.invoke('motions-list');
  applyMotions();
}

function applyMotions() {
  const withUrl = motionFiles.map((m) => ({ name: m.name, url: pathToFileURL(m.path).href }));
  mascot.setMotions(motionRoles(withUrl));
}

async function importMotions(paths) {
  const res = await ipcRenderer.invoke('motions-import', paths);
  if (res.error) { say('가져오지 못했어…\n' + res.error, 5000, { tts: false }); return; }
  await onMotionsImported(res.motions);
}

async function onMotionsImported(n) {
  await refreshMotions();
  const usesMotions = FORMATS.find((f) => f.id === mascot.formatId)?.usesMotionFiles;
  const note = usesMotions ? '' : '\n(VRM 모델에서 사용돼)';
  say(`모션을 ${n}개 가져왔어${note}`, 4000, { tts: false });
}

async function removeLibraryModel() {
  const model = settings.model;
  if (!model.startsWith('lib:')) return; // 確認は設定ウィンドウ側で済ませてある
  await loadModel(DEFAULTS.model, { announce: false });
  await ipcRenderer.invoke('library-remove', model.slice(4));
  await refreshLibrary();
}

async function loadModel(model, { announce = true, auto = false } = {}) {
  const p = resolveModelPath(model);
  try {
    if (!p || !fs.existsSync(p)) throw new Error('model not found: ' + model);
    const format = formatOf(p);
    if (!format) throw Object.assign(new Error('unknown format: ' + p), { userMessage: '이 형식의 모델은 지원하지 않아…' });
    await (await useAdapter(format)).load(pathToFileURL(p).href);
  } catch (err) {
    console.error('モデル読み込みエラー:', err);
    if (model !== DEFAULTS.model) {
      // 形式ごとの理由（Cubism 5.3 未対応など）はアダプタが userMessage に入れて返す
      say((err.userMessage || '모델을 불러오지 못했어…') + '\n기본 모델로 되돌릴게', 6000, { tts: false });
      return loadModel(DEFAULTS.model, { announce: false });
    }
    say('기본 모델을 찾을 수 없어\nassets를 확인해 줘', undefined, { tts: false });
    return false;
  }

  settings.model = model;
  saveSettings();
  if (!settings.gaze) mascot.resetFocus();
  applyHeight(settings.height);
  applyMotions();
  manualExp = null;
  ipcRenderer.send('expressions', mascot.listExpressions());   // 메뉴·스트림덱의 표정 버튼용
  if (announce) playMotion('hello');
  if (announce) say(AGENT.TEXT.hello, 5800, { auto, tts: false, lip: true });   // DeepSeek짱 인사
  return true;
}

async function selectModelFile() {
  const p = await ipcRenderer.invoke('select-model');
  if (p) loadModel(p);
}

// ===== ボイスパック =====
function loadVoicePack(name) {
  voices = [];
  settings.voicePack = name || '';
  saveSettings();
  if (!name) return;
  try {
    const dir = path.join(VOICES_DIR, name);
    const data = JSON.parse(fs.readFileSync(path.join(dir, 'voices.json'), 'utf8'));
    voices = (data.voices || [])
      .map((v) => ({ ...v, abs: path.resolve(dir, v.file) }))
      .filter((v) => {
        if (fs.existsSync(v.abs)) return true;
        console.warn('音声ファイルが無い:', v.abs);
        return false;
      })
      .map((v) => ({ abs: v.abs, text: v.text || '', motion: v.motion || null, on: v.on || null }));
  } catch (e) {
    console.warn('ボイスパック読み込み失敗:', e);
  }
}

// ===== 話す順番（複数キャラで同時にしゃべらないように） =====
// しゃべる前にメインへ申し出る。自動（auto）は誰かが話し中なら見送り、手動は相手を止めて割り込む。
// 吹き出しが消えて声も終わったら speech-end
let speaking = false;

function claimSpeech(manual) {
  if (!ipcRenderer.sendSync('speech-claim', !!manual)) return false;
  speaking = true;
  return true;
}

function maybeEndSpeech() {
  if (!speaking) return;
  if (bubble.classList.contains('show') || currentSource) return;
  if ('speechSynthesis' in window && speechSynthesis.speaking) return;
  speaking = false;
  ipcRenderer.send('speech-end');
}

// 手動で割り込まれた
ipcRenderer.on('speech-stop', () => {
  speaking = false;
  stopVoice();
  clearTimeout(bubbleTimer);
  bubble.classList.remove('show');
});

// ===== 音声再生（WebAudio。音量から口パクを作る） =====
let audioCtx = null;
let currentSource = null;
let lipRAF = null;
let mouthLevel = 0;
let playToken = 0; // 後から来た再生要求を優先するための番号

function stopVoice() {
  playToken++;
  if (currentSource) { try { currentSource.stop(); } catch {} currentSource = null; }
  cancelAnimationFrame(lipRAF);
  mouthLevel = 0;
  mascot.setMouth(null);
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}

function toArrayBuffer(data) {
  if (data instanceof ArrayBuffer) return data;
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
}

// wavなどのバイト列を再生。token が古くなっていたら何もしない
async function playAudioData(data, token) {
  audioCtx ||= new AudioContext();
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  const buffer = await audioCtx.decodeAudioData(toArrayBuffer(data));
  if (token !== playToken) return;

  // 音源ごとの音量差を吸収：一番大きい区間の音量で口の開きを正規化
  const ch = buffer.getChannelData(0);
  const WIN = 1024;
  let peak = 0;
  for (let i = 0; i < ch.length; i += WIN) {
    const end = Math.min(ch.length, i + WIN);
    let s = 0;
    for (let j = i; j < end; j++) s += ch[j] * ch[j];
    peak = Math.max(peak, Math.sqrt(s / (end - i)));
  }
  const gain = peak > 0 ? 1 / peak : 1;

  const src = audioCtx.createBufferSource();
  src.buffer = buffer;
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  src.connect(analyser);
  analyser.connect(audioCtx.destination);

  const wave = new Float32Array(analyser.fftSize);
  const tick = () => {
    analyser.getFloatTimeDomainData(wave);
    let sum = 0;
    for (let i = 0; i < wave.length; i++) sum += wave[i] * wave[i];
    const level = Math.sqrt(sum / wave.length) * gain; // 0〜1
    const target = level < 0.12 ? 0 : Math.min(1, level * 1.2); // 小さい音は閉じる
    mouthLevel += (target - mouthLevel) * 0.5; // なめらかに
    mascot.setMouth(mouthLevel);
    lipRAF = requestAnimationFrame(tick);
  };

  src.onended = () => {
    if (currentSource !== src) return;
    currentSource = null;
    cancelAnimationFrame(lipRAF);
    mascot.setMouth(null);
    maybeEndSpeech();
  };
  currentSource = src;
  src.start();
  tick();
}

// 場面に合う声を選ぶ（on 未指定の声はどの場面でも使う）
function voicesFor(scene) {
  return voices.filter((v) => !v.on || v.on.includes(scene));
}

// 声＋字幕＋しぐさ。しぐさはファイル名の部分一致で探し、無ければ適当に選ぶ
function playVoice(v = pick(voices), { auto = false } = {}) {
  if (!v) return false;
  if (!claimSpeech(!auto)) return false;
  stopVoice();
  const token = playToken;

  const motions = mascot.listMotions();
  const matched = v.motion && motions.find((m) => m.file.includes(v.motion));
  mascot.playMotion(matched || pick(motions));

  if (settings.mute) {
    console.log(`[voice] ミュート: ${v.text}`);
    if (v.text) say(v.text, undefined, { tts: false, auto });
    return true;
  }

  // 読み上げ on ＋ VOICEVOX なら、セリフをこのキャラの話者で読む。合成できなければ wav
  const spoken = usesVoicevox() ? spokenText(v.text) : '';
  console.log(spoken
    ? `[voice] VOICEVOX(${settings.voicevoxSpeaker}): ${spoken}`
    : `[voice] wav: ${v.text}（voice=${settings.voice} engine=${settings.ttsEngine}）`);
  const audio = spoken
    ? synthVoicevox(spoken).then((wav) => {
        if (!wav) console.log('[voice] 合成できない → wav');
        return wav || fs.promises.readFile(v.abs);
      })
    : fs.promises.readFile(v.abs);
  audio
    .then((data) => { if (token === playToken) return playAudioData(data, token); })
    .catch((e) => { console.warn('ボイス再生失敗:', e); maybeEndSpeech(); });

  if (v.text) say(v.text, undefined, { tts: false, auto });
  return true;
}

// ===== サイズ・配置 =====
function applyHeight(h) {
  h = Math.round(Math.min(1000, Math.max(200, h)));
  settings.height = h;
  saveSettings();

  mascot.setHeight(h);
  const size = mascot.getSize();
  const w = Math.max(MIN_W, Math.ceil(size.width) + PAD * 2);
  const wh = Math.max(MIN_H, BUBBLE_SPACE + Math.ceil(size.height) + PAD);
  ipcRenderer.send('resize-window', { width: w, height: wh });
  layout();
}

function layout() {
  const size = mascot.getSize();
  mascot.setPosition(window.innerWidth / 2, window.innerHeight - PAD - size.height / 2);
  const b = mascot.getBounds();
  if (b) ipcRenderer.send('model-bounds', b);
  positionBubble();
}

window.addEventListener('resize', layout);

// ===== モーション =====
const pick = (arr) => (arr.length ? arr[Math.floor(Math.random() * arr.length)] : null);

// 상황에 맞는 동작 (동작 파일 이름으로 찾음: 즌다몬의 mtnBody_think 등). 없으면 아무 동작
const MOTION_HINTS = {
  thinking: /think|wonder|hmm|考/i,
  approval: /point|surpris|tremble|焦/i,
  done: /laugh|yes|happy|joy|smile|nod|笑/i,
  error: /no\d*\.|tremble|sad|cry|泣/i,
  blush: /shy|blush|照/i,
  smug: /laugh|point/i,
  hello: /wave|hello|greet/i
};
function playMotion(hint) {
  const all = mascot.listMotions();
  const re = hint && MOTION_HINTS[hint];
  const fit = re ? all.filter((m) => re.test(m.file || '')) : [];
  // 의미 있는 동작이 있는 모델이면, 아무 때나 할 땐 무난한 것만 (no·떨기·화남 빼고)
  const calm = all.filter((m) => !/no\d*\.|tremble|angry|sad/i.test(m.file || ''));
  mascot.playMotion(pick(fit.length ? fit : calm.length ? calm : all));
}

// ===== 吹き出し・読み上げ =====
let bubbleTimer = null;

function positionBubble() {
  if (!bubble.classList.contains('show')) return;
  const b = mascot.getBounds();
  if (!b) return;
  bubble.style.top = Math.max(4, b.top - bubble.offsetHeight - 10) + 'px';
}

// auto：自動の発言（ランダム・時報・VS Code・起動時のあいさつ）。他のキャラが話し中なら言わない
function say(text, ms, { tts = true, auto = false, mutter = false, lip = false } = {}) {
  if (!claimSpeech(!auto)) return false;
  bubble.textContent = text;
  bubble.classList.toggle('mutter', mutter);   // 혼잣말: 점선 말풍선
  bubble.classList.add('show');
  positionBubble();
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => {
    bubble.classList.remove('show');
    maybeEndSpeech();
  }, ms || Math.max(3000, text.length * 180));
  if (tts && settings.voice && !settings.mute) speak(text);
  else if (lip) lipSyncText(text);   // 음성 파일을 틀 때는 그쪽이 입을 움직이므로 끔
  return true;
}

// 소리 없이 말풍선만 낼 때: 글자의 모음에 맞춰 입을 움직인다 (DeepSeek짱 방식)
//   한글은 중성(ㅏㅐㅑ…)으로, 영어는 a e i o u 로 입 크기를 정한다
const JUNG_OPEN = [1, .6, 1, .6, .8, .55, .8, .55, .7, .8, .7, .55, .7, .5, .7, .55, .5, .45, .3, .35, .35];
let lipTimer = null;
function mouthOf(ch) {
  const c = ch.charCodeAt(0);
  if (c >= 0xAC00 && c <= 0xD7A3) return JUNG_OPEN[Math.floor(((c - 0xAC00) % 588) / 28)];
  const l = ch.toLowerCase();
  if (l === 'a') return 0.9; if (l === 'o') return 0.7; if (l === 'e') return 0.55; if (l === 'u') return 0.45; if (l === 'i') return 0.35;
  if (/[a-z0-9]/.test(l)) return 0.15;
  return 0;
}
function lipSyncText(text) {
  clearInterval(lipTimer);
  const chars = [...String(text).slice(0, 80)];
  let i = 0;
  lipTimer = setInterval(() => {
    if (i >= chars.length) { clearInterval(lipTimer); mascot.setMouth(null); return; }
    mascot.setMouth(mouthOf(chars[i++]));
  }, 85);
}

// 自作セリフの読み上げ。VOICEVOXが使えなければOS音声に切り替える
async function speak(text) {
  stopVoice();
  const token = playToken;
  if (settings.ttsEngine === 'voicevox') {
    try {
      const wav = await synthVoicevox(text);
      if (token !== playToken) return;
      if (wav) { await playAudioData(wav, token); return; }
    } catch (e) {
      console.warn('VOICEVOX再生失敗:', e);
      if (token !== playToken) return;
    }
  }
  speakOS(text);
}

// このキャラの話者で合成。VOICEVOX が無ければ null（メインが同じセリフの結果を覚えている）
function synthVoicevox(text) {
  return ipcRenderer.invoke('voicevox-synth', {
    text,
    speaker: settings.voicevoxSpeaker,
    speed: settings.voicevoxSpeed
  });
}

// ボイスパックのセリフを VOICEVOX で読むか：読み上げ on で、エンジンが VOICEVOX
function usesVoicevox() {
  return voiceModeOf(settings) === 'voicevox';
}

// 読ませる文。括弧書きは外す。「(笑)」だけのセリフは笑い声にし、それでも読める字が無ければ空（wav を鳴らす）
function spokenText(text) {
  const src = String(text || '');
  let t = src.replace(/[(（][^)）]*[)）]/g, '').trim();
  if (!/[\p{L}\p{N}]/u.test(t) && /[(（]笑[)）]/.test(src)) t = 'ふふっ';
  return /[\p{L}\p{N}]/u.test(t) ? t : '';
}

function speakOS(text) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ja-JP';
  const v = speechSynthesis.getVoices().find((v) => v.lang.startsWith('ja'));
  if (v) u.voice = v;
  u.pitch = 1.3;
  u.rate = 1.1;
  u.onend = u.onerror = maybeEndSpeech;
  speechSynthesis.speak(u);
}
if ('speechSynthesis' in window) speechSynthesis.getVoices();

function greeting() {
  const h = new Date().getHours();
  if (h >= 5 && h < 10) return '좋은 아침! 오늘도 힘내자';
  if (h >= 10 && h < 17) return '안녕!';
  if (h >= 17 && h < 23) return '안녕. 무리하지 마';
  return '이 시간까지…슬슬 자는 게 어때?';
}

function timeText() {
  const d = new Date();
  return `지금은 ${d.getHours()}시 ${String(d.getMinutes()).padStart(2, '0')}분이야`;
}

// 혼잣말 한마디 (말투 지침대로 Haiku 가 미리 만들어 둔 줄을 하나씩. 메뉴·더블클릭·랜덤)
let mutterBusy = false;
async function idleMutter(auto = true) {
  if (mutterBusy) return;
  mutterBusy = true;
  try {
    const raw = await ipcRenderer.invoke('mutter-next');
    if (!raw) return;
    const line = AGENT.parseLine(raw);
    playMotion(line.faces[0]);
    const face = line.faces.find((f) => agentExpression(f));
    if (face) agentFace(face, 4000);
    say(line.text, Math.min(6000, Math.max(3500, 1500 + line.text.length * 90)), { tts: false, auto, lip: true });
  } catch { /* 무시 */ } finally { mutterBusy = false; }
}
function talk() { idleMutter(false); }

// ランダムイベント（60〜180秒ごと）：半分はボイス、残りはしぐさ＋ひとこと
function scheduleRandomEvent() {
  setTimeout(() => {
    if (!isDragging) {
      // Claude 모드: 말없이 몸짓만 (말 걸기 창과 겹치지 않게)
      // 피규어 모드: 절반은 혼잣말
      if (!claudeMode && Math.random() < 0.5) idleMutter();
      else if (!agentUi.running) playMotion();
    }
    scheduleRandomEvent();
  }, 60000 + Math.random() * 120000);
}
scheduleRandomEvent();

// ===== クリック透過 =====
// Linux: クリック透過の切り替えが効かない環境があるので、
// ウィンドウの形（入力を受ける領域）をキャラと吹き出しの矩形に切り抜く
const USE_SHAPE = process.platform === 'linux';
let lastShape = '';

function updateShape() {
  let rects;
  if (isDragging) {
    rects = [{ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }];
  } else {
    rects = [];
    const b = mascot.getBounds();
    if (b) {
      // 横は窓の幅いっぱい（形の外は描画も切れるため。VRM はモーションで体の範囲より外に腕が出る）
      const y = Math.max(0, Math.floor(b.top));
      rects.push({ x: 0, y, width: window.innerWidth, height: Math.min(window.innerHeight, Math.ceil(b.bottom)) - y });
    }
    if (bubble.classList.contains('show')) {
      const r = bubble.getBoundingClientRect();
      rects.push({ x: Math.floor(r.left), y: Math.floor(r.top), width: Math.ceil(r.width), height: Math.ceil(r.height) });
    }
    rects = rects.filter((r) => r.width > 0 && r.height > 0);
  }
  const key = JSON.stringify(rects);
  if (key === lastShape) return;
  lastShape = key;
  ipcRenderer.send('set-shape', rects);
}

function updateHit(x, y) {
  if (USE_SHAPE) { updateShape(); return; }
  const hit = isDragging || mascot.hitTest(x, y);
  if (hit === !ignoring) return;
  ignoring = !hit;
  ipcRenderer.send('set-ignore-mouse', ignoring);
}

ipcRenderer.on('cursor', (event, { x, y }) => {
  if (settings.gaze) mascot.focus(x, y);
  updateHit(x, y);
});

// ===== マウス操作 =====
window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  ipcRenderer.send('show-context-menu'); // 中身はメインが最新の状態（settings-state）から作る
});

window.addEventListener('mousedown', (e) => {
  if (e.button === 0) {
    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    downScreenX = e.screenX;
    downScreenY = e.screenY;
  }
});

window.addEventListener('mousemove', (e) => {
  if (isDragging) {
    ipcRenderer.send('move-window', { mouseX: dragStartX, mouseY: dragStartY });
  } else {
    updateHit(e.clientX, e.clientY);
  }
});

window.addEventListener('mouseup', () => { isDragging = false; });

// クリック：ボイスがあれば半分の確率でしゃべる、なければしぐさ。
// ダブルクリックと区別するため少し待つ
let clickTimer = null;
window.addEventListener('click', (e) => {
  if (Math.abs(e.screenX - downScreenX) > 3 || Math.abs(e.screenY - downScreenY) > 3) return;
  if (e.detail > 1) return;
  clearTimeout(clickTimer);
  clickTimer = setTimeout(() => {
    if (agentOnClick()) return;
    clickReact();
  }, 250);
});

window.addEventListener('dblclick', (e) => {
  clearTimeout(clickTimer);
  if (claudeMode) ipcRenderer.send('agent-open');   // 더블클릭 = Claude에게 말 걸기
  else idleMutter(false);                            // 피규어 모드: 혼잣말 한마디
});

window.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  applyHeight(settings.height * (e.deltaY < 0 ? 1.08 : 1 / 1.08));
}, { passive: false });

// モデルのドラッグ&ドロップ（キャラの上にドロップ）
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const paths = [...e.dataTransfer.files].map((f) => webUtils.getPathForFile(f));
  if (!paths.length) return;
  if (paths.every(isMotionFile)) { importMotions(paths); return; }   // .vrma（複数まとめて可）
  const p = paths[0];
  if (isSingleFileModel(p)) { importModel(p); return; }                // 取り込み（.vrm はファイル1個で完結）
  if (isModelFile(p)) { loadModel(p); return; }                        // 外部参照（.model3.json は周りのファイルごと）
  if (/\.zip$/i.test(p) || fs.statSync(p).isDirectory()) { importModel(p); return; } // 取り込み
  say(`ZIP·폴더·${modelFileLabel}를 드롭해 줘`, undefined, { tts: false });
});

// ===== VS Code拡張からのイベント（WebSocket → メイン → IPC） =====
// ボイスパックで on に save / error / fixed / debug / taskOk / taskFail を書くと、その声を優先して使う
const BRIDGE_LINES = {
  connect: ['VS Code와 연결됐어'],
  save: ['저장했네', '자주 저장하다니 대단해', '저장 완료!'],
  error: (n) => [`에러가 ${n}건 있어`, `어, 에러 ${n}건…`, `에러 ${n}건. 침착하게 가자`],
  fixed: ['에러 전부 사라졌어!', '깔끔해졌네', '에러 없음!'],
  debug: ['디버깅 시작이네', '버그, 잡아보자'],
  taskOk: (name) => [`${name} 성공!`, `${name} 통과했어`],
  taskFail: (name, code) => [`${name} 실패했어…(exit ${code})`]
};

const BRIDGE_COOLDOWN = 5000;       // 反応どうしの最短間隔
const SAVE_COOLDOWN = 45000;        // 保存への反応の最短間隔
const SAVE_CHANCE = 0.35;           // 保存に反応する確率
let lastBridgeReact = 0;
let lastSaveReact = 0;
let bridgeGreeted = false;
const diagByClient = new Map();     // client → 前回のエラー数

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// scene に明示的に割り当てた声があればそれ、無ければセリフ＋しぐさ
function react(scene, lines, { force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastBridgeReact < BRIDGE_COOLDOWN) return;
  if (isDragging) return;
  if (!claimSpeech(false)) return; // 他のキャラが話し中
  lastBridgeReact = now;
  const tagged = voices.filter((v) => v.on?.includes(scene));
  if (tagged.length) { playVoice(pick(tagged), { auto: true }); return; }
  playMotion();
  say(pick(lines), undefined, { auto: true });
}

function onBridgeEvent({ type, payload = {}, client }) {
  switch (type) {
    case 'connect':
      if (!bridgeGreeted) { bridgeGreeted = true; react('connect', BRIDGE_LINES.connect); }
      break;
    case 'disconnect':
      diagByClient.delete(client);
      break;
    case 'save': {
      const now = Date.now();
      if (now - lastSaveReact < SAVE_COOLDOWN || Math.random() > SAVE_CHANCE) break;
      lastSaveReact = now;
      react('save', BRIDGE_LINES.save);
      break;
    }
    case 'diagnostics': {
      const errors = Math.max(0, Number(payload.errors) || 0);
      const prev = diagByClient.get(client);
      diagByClient.set(client, errors);
      if (prev === undefined) break; // 接続直後のスナップショットは基準にするだけ
      if (errors > prev) react('error', BRIDGE_LINES.error(errors));
      else if (prev > 0 && errors === 0) react('fixed', BRIDGE_LINES.fixed, { force: true });
      break;
    }
    case 'debugStart':
      react('debug', BRIDGE_LINES.debug);
      break;
    case 'taskEnd': {
      const name = clip(payload.name, 40) || '작업';
      const code = Number.isInteger(payload.exitCode) ? payload.exitCode : null;
      if (code === 0) react('taskOk', BRIDGE_LINES.taskOk(name));
      else if (code !== null) react('taskFail', BRIDGE_LINES.taskFail(name, code), { force: true });
      break;
    }
    case 'say': { // 任意のセリフ（テスト用・他ツール用）
      const text = clip(payload.text, 200);
      if (!text) break;
      lastBridgeReact = Date.now();
      playMotion();
      say(text);
      break;
    }
    default:
      console.log('[bridge] 未対応のイベント:', type);
  }
}

ipcRenderer.on('bridge-event', (event, msg) => onBridgeEvent(msg));

// ===== Claude 에이전트 (메인의 src/main/agent.js → IPC) =====
// 반응 흐름은 DeepSeek짱(deepseek-harness-kr)과 같다:
//   시작 → 생각 중(추론을 혼잣말로) → 도구 사용 → 승인 대기(식은땀) → 완료(하트 눈) / 실패(눈물)
// 표정은 모델이 가진 표정 이름에서 상태에 맞는 것을 찾아 쓴다. 없으면 몸짓만.
const EXP_HINTS = {
  thinking: [/think|hmm|question|confus|wonder|생각|고민|考|悩/i, /relax|calm|normal/i],
  approval: [/sweat|panic|nervous|worr|땀|당황|焦|汗/i, /surpris|shock|놀람|驚/i],
  done: [/heart|love|happy|joy|smile|glad|하트|기쁨|웃|笑|喜/i],
  error: [/tear|cry|sad|sorrow|눈물|슬픔|泣|悲/i, /dizzy|angry|어지|怒/i],
  blush: [/blush|shy|embarrass|홍조|부끄|照|赤|脸红/i],
  smug: [/smug|grin|tease|얄미|ドヤ|得意/i, /laugh/i]
};
const VRM_EXP = { thinking: 'relaxed', approval: 'surprised', done: 'happy', error: 'sad', blush: 'happy', smug: 'relaxed' };

function agentExpression(state) {
  const names = mascot.listExpressions();
  if (!names.length) return null;
  if (mascot.formatId === 'vrm') return VRM_EXP[state] || null;
  for (const re of EXP_HINTS[state] || []) {
    const hit = names.find((n) => re.test(n));
    if (hit) return hit;
  }
  return null;
}

// 직접 고른 표정 (메뉴·스트림덱). 같은 걸 다시 고르면 원래 얼굴로
let manualExp = null;
function setManualExpression(name, text) {
  if (!name || name === manualExp) { manualExp = null; mascot.resetExpression(); }
  else { manualExp = name; mascot.setExpression(name); }
  playMotion();
  if (text) say(String(text).slice(0, 200), 3500, { tts: false, lip: true });
  ipcRenderer.send('expression-now', manualExp);
}

// Claude 모드(에이전트) / 끄면 혼잣말 피규어. talkVisible: 말 걸기 창이 떠 있음 (그동안 내 말풍선은 쉼)
let claudeMode = true, talkVisible = false;
ipcRenderer.invoke('claude-mode-get').then((on) => { claudeMode = on !== false; }).catch(() => {});
ipcRenderer.on('claude-mode', (event, { on }) => {
  const was = claudeMode;
  claudeMode = !!on;
  if (was === claudeMode) return;
  playMotion();
  say(claudeMode ? 'Claude 모드 켰어요! 더블클릭하면 말 걸 수 있어요' : '이제 그냥 피규어로 있을게요~ 더블클릭하면 혼잣말 한마디!', 4000, { tts: false, lip: true });
});
ipcRenderer.on('talk-visible', (event, v) => { talkVisible = !!v; if (v) { bubble.classList.remove('show'); } });

const agentUi = { running: false, ask: null, lastToolSay: 0, lastMutterAt: 0, lastSayAt: 0, expTimer: null, flashUntil: 0 };

function agentFace(state, ms = 0) {
  clearTimeout(agentUi.expTimer);
  const name = state && agentExpression(state);
  if (name) mascot.setExpression(name);
  else if (manualExp) mascot.setExpression(manualExp);   // 직접 고른 표정은 반응이 끝나면 되돌아감
  else mascot.resetExpression();
  agentUi.flashUntil = ms ? Date.now() + ms : 0;
  if (ms) agentUi.expTimer = setTimeout(() => agentFace(agentUi.ask ? 'approval' : agentUi.running ? 'thinking' : null), ms);
}

function agentSay(text, ms, opts = {}) {
  if (!text || agentUi.quiet) return;
  if (say(text, ms, { tts: false, lip: true, ...opts })) agentUi.lastSayAt = Date.now();
}

// 클릭 반응 (DeepSeek짱 대사 + 표정). 3초 안에 6번 넘게 누르면 투덜, 8초 안에 5번이면 기분 좋음
let clickTimes = [];
function clickReact() {
  const now = Date.now();
  clickTimes = clickTimes.filter((t) => now - t < 8000); clickTimes.push(now);
  const recent = clickTimes.filter((t) => now - t < 3000).length;
  const line = AGENT.parseLine(recent >= 6 ? pick(AGENT.CLICK_SPAM) : clickTimes.length >= 5 ? pick(AGENT.CLICK_MANY) : pick(AGENT.CLICK));
  if (recent >= 6 || clickTimes.length >= 5) clickTimes = [];
  playMotion(line.faces[0]);
  const face = line.faces.find((f) => agentExpression(f));
  if (face) agentFace(face, 3500);
  if (!talkVisible) say(line.text, 3500, { tts: false, lip: true });   // 말 걸기 창이 떠 있으면 표정·몸짓만
}

function agentOnClick() {
  if (agentUi.ask) { ipcRenderer.send('agent-open'); return true; }   // 승인 대기 중: 창을 띄워서 보여 줌
  if (agentUi.running && Math.random() < 0.5) { agentSay(pick(AGENT.TEXT.working)); return true; }
  return false;
}

function onAgentEvent(e) {
  const now = Date.now();
  agentUi.quiet = !!e.talkOpen || talkVisible;   // 머리 위 답변 말풍선이 떠 있으면 내 말풍선은 쉼 (표정·몸짓만)
  switch (e.type) {
    case 'start':
      agentUi.running = true; agentUi.ask = null;
      agentFace('thinking');
      playMotion('thinking');
      agentSay(AGENT.TEXT.start, 2500);
      break;
    case 'thought':   // 추론 혼잣말은 말 걸기 창과 겹쳐서 뺐다. 가끔 몸짓만
    case 'tool':
      if (agentUi.running && !agentUi.ask && now - agentUi.lastToolSay > 4000) { agentUi.lastToolSay = now; playMotion(); }
      break;
    case 'permission': {
      agentUi.ask = e;
      agentFace('approval');
      playMotion('approval');
      // 자세한 내용과 버튼은 말 걸기 창에. 여기선 짧게
      agentSay(e.talkOpen === false ? AGENT.askLine(e.tool) : AGENT.TEXT.approval, 55000);
      break;
    }
    case 'permissionDone':
      if (agentUi.ask?.id !== e.id) break;
      agentUi.ask = null;
      agentFace('thinking');
      agentSay(e.allow ? '고마워요! 계속할게요' : '알겠어요, 다른 방법을 찾아볼게요', 2200);
      break;
    case 'done': {
      agentFace('done', 4000);
      playMotion('done');
      // 말 걸기 창이 열려 있으면 답은 거기 있으니 짧게
      const summary = e.talkOpen ? '' : AGENT.answerLine(e.result, 60);
      agentSay(summary ? `${AGENT.TEXT.done}\n${summary}` : AGENT.TEXT.done, 4000);
      break;
    }
    case 'error':
      if (e.stopped) { agentFace(null); agentSay(AGENT.TEXT.stopped, 2500); break; }
      agentFace('error', 5000);
      playMotion('error');
      agentSay(AGENT.TEXT.error, 5000);
      break;
    case 'clipDone': agentFace('done', 2500); playMotion('done'); break;
    case 'pomodoro':   // 포모도로 단계 바뀜
      agentUi.quiet = false;
      if (e.phase === 'break' || e.phase === 'long' || e.phase === 'done') agentFace('done', 4000);
      playMotion('done');
      agentSay('🍅 ' + e.text, 6000);
      break;
    case 'reminder':   // 알림은 말 걸기 창이 열려 있어도 직접 말함
      agentUi.quiet = false;
      agentFace('done', 5000);
      playMotion('done');
      agentSay('⏰ ' + e.text, 15000);
      break;
    case 'study': {   // 같이 공부: Claude 앱의 답을 보고 한마디
      if (talkVisible) break;
      const line = AGENT.parseLine(e.text);
      const face = line.faces.find((f) => agentExpression(f));
      if (face) agentFace(face, 5000);
      playMotion(line.faces[0]);
      say(line.text, Math.min(9000, Math.max(4500, 1500 + line.text.length * 110)), { tts: false, lip: true });
      break;
    }
    case 'loginDone':
      if (e.ok) { agentFace('done', 3000); agentSay('로그인됐어요! 이제 말 걸어 주세요', 4000); }
      break;
    case 'idle':
      agentUi.running = false; agentUi.ask = null;
      if (Date.now() >= agentUi.flashUntil) agentFace(null);   // 완료·실패 표정은 잠깐 유지
      break;
  }
}
ipcRenderer.on('agent-event', (event, e) => onAgentEvent(e));
ipcRenderer.on('role', (event, { primary }) => { isPrimary = primary; });

// ===== メインプロセスからのイベント =====
// 右クリックの操作は設定ウィンドウと同じ 'settings-action' で届く。ここはトレイの「話しかける」だけ
ipcRenderer.on('menu-action', (event, { type }) => {
  if (type === 'talk') talk();
});

// ===== 設定（設定ウィンドウからの操作） =====
function setSetting(key, value) {
  settings[key] = value;
  saveSettings();
}

function setGaze(on) {
  setSetting('gaze', on);
  if (!on) mascot.resetFocus();
}

function applyOpacity(val) {
  settings.opacity = parseFloat(val);
  saveSettings();
  $('stage').style.opacity = val; // canvas を作り直した時は useAdapter が引き継ぐ
}

// 型が既定値と合う時だけ受け付ける
function applySetting(key, value) {
  if (!(key in DEFAULTS) || typeof value !== typeof DEFAULTS[key]) return;
  if (key === 'height') applyHeight(value);
  else if (key === 'opacity') applyOpacity(value);
  else if (key === 'gaze') setGaze(value);
  else if (key === 'model' || key === 'voicePack' || key === 'voice' || key === 'ttsEngine' || key === 'mute') return; // 専用の操作で
  else setSetting(key, value);
}

ipcRenderer.on('settings-action', (event, a = {}) => {
  switch (a.type) {
    case 'set': applySetting(a.key, a.value); break;
    case 'model': if (typeof a.value === 'string') loadModel(a.value); break;
    case 'import-model': importModel(); break;
    case 'select-model-file': selectModelFile(); break;
    case 'remove-model': removeLibraryModel(); break;
    case 'voice-pack': loadVoicePack(typeof a.value === 'string' ? a.value : ''); break;
    case 'test-voice': if (!playVoice()) say('보이스가 없어', undefined, { tts: false }); break;
    case 'voice-mode': setVoiceMode(a.value); break;
    case 'talk': talk(); break;
    case 'expression': setManualExpression(a.value, a.text); break;
    case 'motion': playMotion(); if (a.text) say(String(a.text).slice(0, 200), 3500, { tts: false, lip: true }); break;
    // 今の声の出し方で試す（ボイスパックだけ・ミュートはボイスパックのセリフで）
    case 'test-tts': {
      const mode = voiceModeOf(settings);
      if (mode === 'pack' || mode === 'mute') {
        if (!playVoice()) say(`${greeting()}\n${timeText()}`, undefined, { tts: false });
        break;
      }
      playMotion();
      say(`${greeting()}\n${timeText()}`, undefined, { tts: false });
      speak(`${greeting()}。${timeText()}`);
      break;
    }
  }
});

// ===== 起動 =====
applyOpacity(settings.opacity);
loadVoicePack(settings.voicePack);
Promise.all([refreshLibrary(), refreshMotions()]).then(() => loadModel(settings.model, { auto: true }));
