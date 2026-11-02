const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, screen, dialog, shell, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const tracker = require('./tracker');
const library = require('./library');
const motions = require('./motions');
const { isMotionFile } = require('../shared/motions');
const { loadConfig } = require('./config');
const { startBridge } = require('./bridge');
const { createStore } = require('./characters');
const { createAgent, login } = require('./agent');
const { checkForUpdate, startAutoUpdate, currentBuild } = require('./updater');
const { thumbnailUrl, customThumb, setCustomThumb } = require('./thumbs');
const { FORMATS, importExtensions, importLabel } = require('../shared/formats');

// ===== キャラ =====
// 1キャラ＝透明ウィンドウ1枚。親はメインプロセス（bridge・トレイ・設定ファイルを持つ）
// mascots: id → { id, win, inset }  inset はウィンドウ内でのキャラ描画範囲 {left, top, right, bottom}
const mascots = new Map();
let store = null;       // characters.json（一覧・キャラごとの設定・位置）
const WIN_W = 400, WIN_H = 600; // 作った直後の大きさ（すぐにモデルに合わせて変わる）

let trackerHandle = null;
let vscodeRect = null; // DIP座標のVS Code領域（取れない/最小化中はnull）
let cursorTimer = null;
let tray = null;
let creditsWindow = null;
let settingsWindow = null;
let settingsTarget = null;      // 設定ウィンドウで選んでいるキャラ
const lastStates = new Map();   // id → レンダラーから届いた最新の設定状態
let bridge = null;

const APP_ROOT = path.join(__dirname, '../..');

const liveMascots = () => [...mascots.values()].filter((m) => !m.win.isDestroyed());
const primaryMascot = () => { const m = mascots.get(store.primary()); return m && !m.win.isDestroyed() ? m : null; };
function mascotOf(sender) {
  for (const m of mascots.values()) if (!m.win.isDestroyed() && m.win.webContents === sender) return m;
  return null;
}

// Linux：Electron 38 から Wayland セッションではネイティブ Wayland で動く。
// Wayland ではウィンドウ位置の取得・移動、画面全体のカーソル位置、setShape が使えないため XWayland に固定する
if (process.platform === 'linux') app.commandLine.appendSwitch('ozone-platform', 'x11');

// GPU が使えない環境（リモートデスクトップ・VM）では WebGL が拒否されて何も描けない。
// Chromium は SwiftShader（ソフトウェア描画）への自動フォールバックをやめたので明示的に許可する。
// GPU がある環境では使われない。読み込むのはローカルのファイルだけなので "unsafe" の懸念（外部ページの JIT）は当たらない
app.commandLine.appendSwitch('enable-unsafe-swiftshader');

// 多重起動防止
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // もう一度起動された／Dockアイコンがクリックされたら表示を戻す
  const bringBack = () => liveMascots().forEach((m) => { if (m.win.isMinimized()) m.win.restore(); m.win.show(); });
  app.on('second-instance', bringBack);
  app.on('activate', bringBack);
  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('com.fixtan.live2d-desktop-mascot');
    store = createStore(app.getPath('userData'));
    store.list().forEach((id, i) => createMascotWindow(id, { index: i }));
    trackerHandle = tracker.start((rect) => {
      vscodeRect = rect ? screen.screenToDipRect(null, rect) : null;
      clampAll();
    });
    startCursorTracking();
    createTray();
    startBridgeFromConfig();
    startTalk();
    startAutoUpdate({ beforeQuit: () => dropMascot() });
  });
}

// 画面のどこかに十分見えているか（画面構成が変わって見えない位置になった時は使わない）
function onScreen(b) {
  return screen.getAllDisplays().some(({ workArea: w }) =>
    b.x < w.x + w.width - 40 && b.x + b.width > w.x + 40 && b.y >= w.y - 10 && b.y < w.y + w.height - 40);
}

// メイン画面の右下から左へ並べる
function defaultBounds(index, w = WIN_W, h = WIN_H) {
  const wa = screen.getPrimaryDisplay().workArea;
  const x = Math.max(wa.x, wa.x + wa.width - w - 20 - index * 260);
  return { x, y: wa.y + wa.height - h, width: w, height: h };
}

const boundsFromAnchor = (a, w = WIN_W, h = WIN_H) =>
  ({ x: Math.round(a.x - w / 2), y: Math.round(a.bottom - h), width: w, height: h });

function createMascotWindow(id, { index = 0, anchor = null } = {}) {
  const saved = anchor || store.get(id)?.anchor;
  let bounds = saved ? boundsFromAnchor(saved) : null;
  if (!bounds || !onScreen(bounds)) bounds = defaultBounds(index);

  const win = new BrowserWindow({
    ...bounds,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    hasShadow: false,
    resizable: true,
    skipTaskbar: true, // タスクバーには出さず、トレイから操作する
    minimizable: false, // 最小化させない（隠すのはトレイ／メニューから）
    roundedCorners: false, // Electron 43 から Linux でも既定 true。透明窓の角でキャラが欠けないように
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  const m = { id, win, inset: null };
  mascots.set(id, m);

  // レンダラーのログ・エラーをターミナルに出す
  win.webContents.on('console-message', ({ level, message, lineNumber, sourceId }) => {
    console.log(`[${id} ${String(level).toUpperCase()}] ${message} (${path.basename(sourceId || '')}:${lineNumber})`);
  });
  win.webContents.on('did-fail-load', (e, code, desc, url) => {
    console.error(`[${id} load failed]`, code, desc, url);
  });
  win.webContents.on('render-process-gone', (e, details) => {
    console.error(`[${id} renderer gone]`, details);
  });

  // 足元の位置を覚える（次の起動で同じ場所に出す）
  win.on('move', () => {
    if (m.lifting) return;   // 말 걸기 중 잠깐 들어 올린 위치는 저장하지 않음
    const b = win.getBounds();
    store.setAnchor(id, { x: Math.round(b.x + b.width / 2), bottom: b.y + b.height });
  });
  win.on('closed', () => {
    if (mascots.get(id) === m) mascots.delete(id);
    if (speech.id === id) speech = { id: null, until: 0 };
    if (settingsTarget === id) setSettingsTarget(store.primary());
  });

  win.loadFile(path.join(__dirname, '../renderer/index.html'), { query: { id } });
  win.setAlwaysOnTop(true, 'screen-saver');
  if (process.platform === 'darwin') {
    // どのデスクトップ（Space）・フルスクリーンアプリの上にも表示
    // skipTransformProcessType: これが無いと Electron が Dock アイコンを消してしまう
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  }

  // npm start -- --devtools で DevTools を別窓で開く（--debug は Node のフラグとして弾かれる）
  if (process.argv.includes('--devtools')) {
    win.webContents.openDevTools({ mode: 'detach' });
  }
  return m;
}

// 起動時の設定（同期）。settings が null なら既定値。migrate なら localStorage の旧設定を引き継ぐ
ipcMain.on('character-init', (event) => {
  const m = mascotOf(event.sender);
  if (!m) { event.returnValue = null; return; }
  let settings = store.get(m.id)?.settings || null;
  // v1.4 の未リリース版で全体の動作モードを OFF にしていたら、キャラごとの設定に引き継ぐ
  if (settings && !('follow' in settings) && store.getShared('trackingMode') === false) settings = { ...settings, follow: false };
  event.returnValue = {
    id: m.id,
    settings,
    migrate: store.shouldMigrate(m.id),
    primary: m.id === store.primary()
  };
});

// 代表（先頭のキャラ）が変わったら知らせる
function notifyRoles() {
  for (const m of liveMascots()) m.win.webContents.send('role', { primary: m.id === store.primary() });
}

function addCharacter() {
  const base = mascots.get(settingsTarget) || primaryMascot();
  let anchor = null;
  if (base) {
    const b = base.win.getBounds();
    anchor = { x: b.x - 140, bottom: b.y + b.height }; // 今のキャラの左どなり
  }
  const id = store.add();
  createMascotWindow(id, { index: store.list().length - 1, anchor }); // 固定モードの枠内へは model-bounds が届いた時に寄せる
  setSettingsTarget(id);
}

function removeCharacter(id) {
  const m = mascots.get(id);
  const wasPrimary = id === store.primary();
  if (!store.remove(id)) return;
  lastStates.delete(id);
  if (m && !m.win.isDestroyed()) m.win.destroy();
  mascots.delete(id);
  if (speech.id === id) speech = { id: null, until: 0 };
  if (wasPrimary) notifyRoles();
  setSettingsTarget(store.primary());
}

// ===== 話す順番 =====
// 同時にしゃべらないよう、しゃべる前にメインへ申し出る。
//   自動（ランダム・時報・VS Code）：誰かが話し中なら見送り
//   手動（クリック・話しかける・試聴など）：話し中のキャラを止めて割り込む
// 終わったら speech-end。来なくても SPEECH_MAX で解放
const SPEECH_MAX = 60000;
let speech = { id: null, until: 0 };

ipcMain.on('speech-claim', (event, manual) => {
  const m = mascotOf(event.sender);
  if (!m) { event.returnValue = false; return; }
  const now = Date.now();
  const other = speech.id && speech.id !== m.id && now < speech.until ? mascots.get(speech.id) : null;
  if (other && !other.win.isDestroyed()) {
    if (!manual) { event.returnValue = false; return; }
    other.win.webContents.send('speech-stop');
  }
  speech = { id: m.id, until: now + SPEECH_MAX };
  event.returnValue = true;
});

ipcMain.on('speech-end', (event) => {
  const m = mascotOf(event.sender);
  if (m && speech.id === m.id) speech = { id: null, until: 0 };
});

// ===== VS Code拡張との連携（WebSocket） =====
// 反応するのは代表だけ（全員一斉はうるさい）
async function startBridgeFromConfig() {
  const { config } = loadConfig(app.getPath('userData'));
  if (!config.bridge.enabled) { console.log('[bridge] 無効（config.json）'); return; }
  try {
    bridge = await startBridge({
      dir: app.getPath('userData'),
      port: config.bridge.port,
      version: app.getVersion(),
      onEvent: (msg) => primaryMascot()?.win.webContents.send('bridge-event', msg)
    });
  } catch (e) {
    console.error('[bridge] 起動できません:', e.message);
  }
}

// ===== タスクトレイ =====
function createTray() {
  let icon = nativeImage.createFromPath(path.join(APP_ROOT, 'assets/tray.png'));
  if (icon.isEmpty()) console.warn('[tray] アイコン画像を読めません:', path.join(APP_ROOT, 'assets/tray.png'));
  if (process.platform === 'darwin') icon = icon.resize({ width: 18, height: 18 }); // メニューバー用
  tray = new Tray(icon);
  tray.setToolTip('Live2D Desktop Mascot');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '표시 / 숨기기', click: toggleVisible },
    { label: '위치 초기화', click: resetPosition },
    { type: 'separator' },
    { label: '💬 Claude에게 말 걸기', click: () => showTalk(true) },
    { label: '🤣 아재개그', click: () => primaryMascot()?.win.webContents.send('menu-action', { type: 'talk' }) },
    { label: '⚙️ 설정 열기', click: () => openSettingsWindow() },
    { label: '📜 크레딧', click: openCredits },
    { label: '📂 설정 폴더 열기', click: () => shell.openPath(app.getPath('userData')) },
    { label: `⬆️ 업데이트 확인 (빌드 ${currentBuild()})`, click: () => checkForUpdate({ manual: true, beforeQuit: () => dropMascot() }) },
    { type: 'separator' },
    { label: '❌ 종료', click: () => app.quit() }
  ]));
  tray.on('double-click', toggleVisible);
}

// 1体でも見えていれば全員隠す。全員隠れていれば全員出す
function toggleVisible() {
  const all = liveMascots();
  const anyVisible = all.some((m) => m.win.isVisible() && !m.win.isMinimized());
  for (const m of all) {
    if (anyVisible) m.win.hide();
    else { if (m.win.isMinimized()) m.win.restore(); m.win.show(); }
  }
}

// メイン画面の右下から並べ直す
function resetPosition() {
  store.list().forEach((id, i) => {
    const m = mascots.get(id);
    if (!m || m.win.isDestroyed()) return;
    const [w, h] = m.win.getSize();
    const b = defaultBounds(i, w, h);
    m.win.setPosition(b.x, b.y);
    m.win.show();
    clampToVSCode(m);
  });
}

// ===== クレジット =====
function openCredits() {
  if (creditsWindow) { creditsWindow.focus(); return; }
  creditsWindow = new BrowserWindow({
    width: 560,
    height: 640,
    title: '크레딧',
    autoHideMenuBar: true,
    alwaysOnTop: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  creditsWindow.loadFile(path.join(__dirname, '../renderer/credits.html'), {
    query: { version: app.getVersion() }
  });
  // リンクは既定のブラウザで開く
  creditsWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  creditsWindow.on('closed', () => { creditsWindow = null; });
}

// ===== 設定ウィンドウ =====
// 設定の値と反映はマスコット側（app.js）が持つ。設定ウィンドウは操作を送り、状態を受け取って表示するだけ
//   設定ウィンドウ → 'settings-action' → メイン → 選んでいるキャラ
//   各キャラ → 'settings-state' → メイン（characters.json に保存）→ 設定ウィンドウ
const SETTINGS_W = 340, SETTINGS_H = 800;

function settingsWindowFile() { return path.join(app.getPath('userData'), 'settings-window.json'); }

function loadSettingsBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(settingsWindowFile(), 'utf8'));
    if (![b.x, b.y, b.width, b.height].every(Number.isFinite)) return null;
    return onScreen(b) ? b : null;
  } catch { return null; }
}

// 初回：マスコットの横（左に空きがあれば左、無ければ右）
function defaultSettingsBounds() {
  const target = mascots.get(settingsTarget) || primaryMascot();
  const m = target ? target.win.getBounds() : defaultBounds(0);
  const wa = screen.getDisplayMatching(m).workArea;
  const w = SETTINGS_W, h = Math.min(SETTINGS_H, wa.height);
  let x = m.x - w - 8;
  if (x < wa.x) x = Math.min(m.x + m.width + 8, wa.x + wa.width - w);
  const y = Math.max(wa.y, Math.min(m.y + m.height - h, wa.y + wa.height - h));
  return { x: Math.round(x), y: Math.round(y), width: w, height: h };
}

function openSettingsWindow(targetId) {
  setSettingsTarget(targetId || settingsTarget || store.primary());
  const target = mascots.get(settingsTarget);
  if (target && !target.win.isDestroyed() && !target.win.isVisible()) target.win.show();
  if (settingsWindow) { settingsWindow.show(); settingsWindow.focus(); return; }
  settingsWindow = new BrowserWindow({
    ...(loadSettingsBounds() || defaultSettingsBounds()),
    minWidth: 300,
    minHeight: 400,
    title: '마스코트 설정',
    autoHideMenuBar: true,
    alwaysOnTop: true,
    backgroundColor: '#252526',
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  settingsWindow.loadFile(path.join(__dirname, '../renderer/settings.html'));
  settingsWindow.on('close', () => {
    try { fs.writeFileSync(settingsWindowFile(), JSON.stringify(settingsWindow.getBounds())); } catch {}
  });
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

function modelLabel(model) {
  if (!model) return '?';
  if (model.startsWith('lib:')) return model.slice(4);
  return path.isAbsolute(model) ? path.basename(model) : model;
}

// 設定ウィンドウに渡す状態：選んでいるキャラの状態＋キャラ一覧
function settingsView() {
  const s = lastStates.get(settingsTarget);
  if (!s) return null;
  const primary = store.primary();
  return {
    ...s,
    target: settingsTarget,
    primary: settingsTarget === primary,
    followSupported: tracker.supported,
    characters: store.list().map((id, i) => ({
      id,
      model: lastStates.get(id)?.settings.model ?? store.get(id)?.settings?.model ?? null,
      modelPath: (() => { const st = lastStates.get(id); return st ? st.modelPaths?.[st.settings.model] ?? null : null; })(),
      label: `${i + 1}: ${modelLabel(lastStates.get(id)?.settings.model ?? store.get(id)?.settings?.model)}${id === primary ? '(대표)' : ''}`
    }))
  };
}

function pushSettingsView() {
  const v = settingsView();
  if (v) settingsWindow?.webContents.send('settings-state', v);
}

function setSettingsTarget(id) {
  if (!store.get(id)) id = store.primary();
  settingsTarget = id;
  pushSettingsView();
}

ipcMain.on('settings-state', (event, state) => {
  const m = mascotOf(event.sender);
  if (!m || !state?.settings) return;
  lastStates.set(m.id, state);
  store.setSettings(m.id, state.settings);
  clampToVSCode(m); // VS Code 追従を入れた時に枠内へ寄せる
  pushSettingsView(); // 他のキャラの変更でも一覧の名前が変わる
});
ipcMain.handle('settings-get-state', () => settingsView());
ipcMain.on('settings-action', (event, action) => {
  const m = mascots.get(settingsTarget);
  if (m && !m.win.isDestroyed()) m.win.webContents.send('settings-action', action);
});
// サムネ：ファイル → data URL（無ければ null）
// ライブラリのモデルは models/<名前>/ の thumb.* を見る
const thumbDirOf = (file) => library.modelFolderOf(file) || path.dirname(file);
ipcMain.handle('model-thumbs', (event, files) =>
  Object.fromEntries((Array.isArray(files) ? files : []).filter((f) => typeof f === 'string').map((f) => [f, thumbnailUrl(f, thumbDirOf(f))])));

// サムネの差し替え（設定ウィンドウでタイルに画像をドロップ）。確認は設定ウィンドウ側で済ませてある
ipcMain.handle('thumb-info', (event, file) => {
  const dir = typeof file === 'string' ? library.modelFolderOf(file) : null;
  return { editable: !!dir, exists: !!(dir && customThumb(dir)) };
});
ipcMain.handle('thumb-set', (event, { file, image }) => {
  const dir = typeof file === 'string' ? library.modelFolderOf(file) : null;
  if (!dir) return { error: '라이브러리 모델만 변경할 수 있습니다' };
  try {
    setCustomThumb(dir, image);
    return { ok: true };
  } catch (e) { return { error: e.message }; }
});
ipcMain.on('settings-select-character', (event, id) => setSettingsTarget(id));
ipcMain.on('character-add', () => addCharacter());
ipcMain.on('character-remove', (event, id) => removeCharacter(id));

// 画面全体のマウス位置をウィンドウ相対座標で各キャラへ送る（視線追従・ヒット判定用）
function startCursorTracking() {
  cursorTimer = setInterval(() => {
    const p = screen.getCursorScreenPoint();
    for (const m of liveMascots()) {
      const b = m.win.getContentBounds();
      const x = p.x - b.x, y = p.y - b.y;
      if (x === m.lastX && y === m.lastY) continue;
      m.lastX = x; m.lastY = y;
      m.win.webContents.send('cursor', { x, y });
    }
  }, 33);
}

// VS Code 追従はキャラごと（Windows のみ）
function follows(m) {
  if (!tracker.supported) return false;
  const st = lastStates.get(m.id)?.settings ?? store.get(m.id)?.settings;
  return st?.follow !== false;
}

// (x, y) をVS Code領域内に収めた座標を返す（判定はキャラの描画範囲）
function clampPosition(m, x, y) {
  if (!follows(m) || !vscodeRect) return { x, y };
  const [w, h] = m.win.getSize();
  const ins = m.inset || { left: 0, top: 0, right: w, bottom: h };
  const r = vscodeRect;
  const clamp1 = (v, min, max) => (max < min ? min : Math.min(Math.max(v, min), max));
  return {
    x: Math.round(clamp1(x, r.x - ins.left, r.x + r.width - ins.right)),
    y: Math.round(clamp1(y, r.y - ins.top, r.y + r.height - ins.bottom))
  };
}

function clampToVSCode(m) {
  if (!m || m.win.isDestroyed()) return;
  const [x, y] = m.win.getPosition();
  const c = clampPosition(m, x, y);
  if (c.x !== x || c.y !== y) m.win.setPosition(c.x, c.y);
}

const clampAll = () => liveMascots().forEach(clampToVSCode);

// 送り主のキャラに対して処理する IPC
const onMascot = (channel, fn) => ipcMain.on(channel, (event, arg) => {
  const m = mascotOf(event.sender);
  if (m) fn(m, arg);
});

onMascot('model-bounds', (m, inset) => {
  m.inset = inset;
  clampToVSCode(m);
});

// クリック透過の切り替え（キャラの上だけクリックを受ける）
// Linux 用：ウィンドウの形を矩形の集合に切り抜く（外側はクリックが下に抜ける）
onMascot('set-shape', (m, rects) => m.win.setShape(rects));

onMascot('set-ignore-mouse', (m, ignore) => m.win.setIgnoreMouseEvents(ignore, { forward: true }));

// サイズ変更（足元の中心を固定したままリサイズ）
onMascot('resize-window', (m, { width, height }) => {
  const b = m.win.getBounds();
  const w = Math.round(width), h = Math.round(height);
  if (w === b.width && h === b.height) return;
  m.win.setBounds({
    x: Math.round(b.x + (b.width - w) / 2),
    y: b.y + b.height - h,
    width: w,
    height: h
  });
});

// ドラッグ移動（固定モード中は枠内にクランプ）
onMascot('move-window', (m, { mouseX, mouseY }) => {
  if (m.lifting) { m.lifting = false; talk.lifted = null; }   // 직접 옮기면 그 자리가 새 위치
  const { x, y } = screen.getCursorScreenPoint();
  const c = clampPosition(m, x - mouseX, y - mouseY);
  m.win.setPosition(c.x, c.y);
});

// モデルファイル選択（取り込まずに直接参照）
ipcMain.handle('select-model', async (event) => {
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    title: '모델 선택',
    filters: [
      { name: '모델', extensions: [...new Set(FORMATS.flatMap((f) => f.dialogExtensions))] },
      ...FORMATS.map((f) => ({ name: f.name, extensions: f.dialogExtensions }))
    ],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// ライブラリへ取り込み（ZIP / .vrm / フォルダ）。p 省略時はダイアログ
ipcMain.handle('import-model', async (event, p) => {
  if (!p) {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: `모델 가져오기(${importLabel})`,
      filters: [{ name: importLabel, extensions: importExtensions }],
      properties: ['openFile']
    });
    if (result.canceled || !result.filePaths.length) return null;
    p = result.filePaths[0];
  }
  try {
    // モデルが入っておらず .vrma だけの ZIP はモーションパックとして取り込む
    if (/\.zip$/i.test(p)) {
      const zip = library.openZip(p);
      if (!library.zipHasModel(zip) && zip.getEntries().some((e) => isMotionFile(e.entryName))) {
        const n = motions.importZip(zip);
        broadcastMotionsChanged(event.sender);
        return { motions: n };
      }
    }
    const id = library.importModel(p);
    broadcastLibraryChanged(event.sender);
    return { id };
  } catch (e) {
    return { error: e.message };
  }
});

// ライブラリ・モーションはキャラ共通。変わったら他のキャラにも知らせる（設定ウィンドウの一覧用）
function broadcastLibraryChanged(except) {
  for (const m of liveMascots()) if (m.win.webContents !== except) m.win.webContents.send('library-changed');
}
function broadcastMotionsChanged(except) {
  for (const m of liveMascots()) if (m.win.webContents !== except) m.win.webContents.send('motions-changed');
}

// モーション（VRMA）。全モデル共通のフォルダ
ipcMain.handle('motions-list', () => motions.listMotions());
ipcMain.handle('motions-import', (event, paths) => {
  try {
    const n = motions.importFiles(paths);
    broadcastMotionsChanged(event.sender);
    return { motions: n };
  } catch (e) { return { error: e.message }; }
});
ipcMain.on('motions-open', () => shell.openPath(motions.motionsDir()));

ipcMain.handle('library-list', () => library.listModels());

ipcMain.handle('library-remove', (event, id) => {
  library.removeModel(id);
  broadcastLibraryChanged(event.sender);
  return true;
});

// VOICEVOX（CORS回避のためメインプロセスから叩く）
const VOICEVOX = 'http://127.0.0.1:50021';

// 失敗時は例外を投げずに null を返す（エンジン未起動のたびに長いエラーログが出ないように）
let voicevoxWarned = false;
function voicevoxDown(e) {
  if (!voicevoxWarned) console.log('[voicevox] 接続できません（' + (e.cause?.code || e.message) + '）→ ボイスパック／OS音声を使用');
  voicevoxWarned = true;
  return null;
}

// 話者一覧。右クリックのたびに取りに行かないよう 30 秒覚える
// quick：右クリック用。エンジンが返事をしなくてもメニューを待たせない
let speakersCache = { at: 0, list: null };
async function voicevoxSpeakers({ quick = false } = {}) {
  if (speakersCache.list && Date.now() - speakersCache.at < 30000) return speakersCache.list;
  try {
    const res = await fetch(`${VOICEVOX}/speakers`, { signal: AbortSignal.timeout(quick ? 800 : 3000) });
    if (!res.ok) throw new Error('speakers ' + res.status);
    voicevoxWarned = false;
    speakersCache = { at: Date.now(), list: await res.json() };
    return speakersCache.list;
  } catch (e) {
    speakersCache = { at: 0, list: null };
    return voicevoxDown(e);
  }
}
ipcMain.handle('voicevox-speakers', () => voicevoxSpeakers());

// 合成結果を覚えておく（ボイスパックのセリフは決まっているので、2回目からクリックの反応が待たない）
const synthCache = new Map();
const SYNTH_CACHE_MAX = 64;

ipcMain.handle('voicevox-synth', async (event, { text, speaker, speed = 1 }) => {
  const key = `${speaker}:${speed}:${text}`;
  const hit = synthCache.get(key);
  if (hit) {
    synthCache.delete(key); // 新しい側へ
    synthCache.set(key, hit);
    return hit;
  }
  try {
    const q = await fetch(
      `${VOICEVOX}/audio_query?text=${encodeURIComponent(text)}&speaker=${speaker}`,
      { method: 'POST', signal: AbortSignal.timeout(10000) }
    );
    if (!q.ok) throw new Error('audio_query ' + q.status);
    const query = await q.json();
    query.speedScale = speed;

    const s = await fetch(`${VOICEVOX}/synthesis?speaker=${speaker}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(query),
      signal: AbortSignal.timeout(30000)
    });
    if (!s.ok) throw new Error('synthesis ' + s.status);
    voicevoxWarned = false;
    const wav = new Uint8Array(await s.arrayBuffer());
    synthCache.set(key, wav);
    if (synthCache.size > SYNTH_CACHE_MAX) synthCache.delete(synthCache.keys().next().value);
    return wav;
  } catch (e) {
    return voicevoxDown(e);
  }
});

ipcMain.on('library-open', () => shell.openPath(library.libraryDir()));

// OSネイティブの右クリックメニュー（そのキャラの設定）
// 中身はそのキャラから最後に届いた状態（settings-state）で作り、操作は設定ウィンドウと同じ settings-action で送る
const VOICE_MODES = [
  ['pack', '보이스팩만'],
  ['voicevox', 'VOICEVOX'],
  ['os', '보이스팩 + OS 음성'],
  ['mute', '음소거(자막만)']
];

function voiceModeOf(st) {
  if (st.mute) return 'mute';
  if (!st.voice) return 'pack';
  return st.ttsEngine === 'os' ? 'os' : 'voicevox';
}

onMascot('show-context-menu', async (m) => {
  const state = lastStates.get(m.id);
  const st = state?.settings || {};
  const act = (type, extra = {}) => m.win.webContents.send('settings-action', { type, ...extra });
  const set = (key, value) => act('set', { key, value });
  const isPrimary = m.id === store.primary();
  const mode = voiceModeOf(st);

  // モデル：同梱・ライブラリ・外部（直接開いたファイル）
  const modelItems = [];
  const radio = (label, value) => ({ label, type: 'radio', checked: st.model === value, click: () => act('model', { value }) });
  if (state?.bundled?.length) {
    modelItems.push({ label: '기본 포함', enabled: false }, ...state.bundled.map((id) => radio(id, id)));
  }
  if (state?.library?.length) {
    if (modelItems.length) modelItems.push({ type: 'separator' });
    modelItems.push({ label: '라이브러리', enabled: false }, ...state.library.map((id) => radio(id, 'lib:' + id)));
  }
  if (st.model && path.isAbsolute(st.model)) {
    modelItems.push({ type: 'separator' }, radio('📁 ' + path.basename(st.model), st.model));
  }
  if (!modelItems.length) modelItems.push({ label: '(모델이 없습니다)', enabled: false });

  // VOICEVOX の話者：話者 ▸ スタイル。エンジンが起動していなければ灰色
  const speakers = mode === 'voicevox' ? await voicevoxSpeakers({ quick: true }) : null;
  let speakerItem;
  if (speakers) {
    speakerItem = {
      label: '🎙 VOICEVOX 화자',
      submenu: speakers.map((sp) => ({
        // サブメニューを持つ項目にはチェックを付けられないので、今の話者は印で示す
        label: (sp.styles.some((t) => t.id === st.voicevoxSpeaker) ? '● ' : '　') + sp.name,
        submenu: sp.styles.map((t) => ({
          label: t.name,
          type: 'radio',
          checked: t.id === st.voicevoxSpeaker,
          click: () => set('voicevoxSpeaker', t.id)
        }))
      }))
    };
  } else {
    speakerItem = {
      label: mode === 'voicevox' ? '🎙 VOICEVOX 화자(엔진 미실행)' : '🎙 VOICEVOX 화자',
      enabled: false
    };
  }

  const template = [
    { label: '💬 Claude에게 말 걸기', click: () => showTalk(true) },
    claudeMenu(),
    { label: '🤣 아재개그', click: () => act('talk') },
    { type: 'separator' },
    { label: '👗 모델', submenu: modelItems },
    {
      label: '🔊 음성',
      submenu: VOICE_MODES.map(([value, label]) => ({
        label, type: 'radio', checked: mode === value, click: () => act('voice-mode', { value })
      }))
    },
    speakerItem,
    { type: 'separator' },
    { label: '👀 시선 추적', type: 'checkbox', checked: st.gaze !== false, click: (item) => set('gaze', item.checked) },
    { label: '🎲 랜덤 이벤트', type: 'checkbox', checked: st.events !== false, click: (item) => set('events', item.checked) },
    {
      label: isPrimary ? '🕐 시보' : '🕐 시보(대표만)',
      type: 'checkbox',
      checked: st.chime !== false,
      enabled: isPrimary,
      click: (item) => set('chime', item.checked)
    },
    {
      label: tracker.supported ? '📌 VS Code 따라가기' : '📌 VS Code 따라가기(Windows 전용)',
      type: 'checkbox',
      checked: follows(m),
      enabled: tracker.supported,
      click: (item) => set('follow', item.checked)
    },
    { type: 'separator' },
    { label: '⚙️ 설정 열기', click: () => openSettingsWindow(m.id) },
    { label: '📜 크레딧', click: openCredits },
    { label: `⬆️ 업데이트 확인 (빌드 ${currentBuild()})`, click: () => checkForUpdate({ manual: true, beforeQuit: () => dropMascot() }) },
    { label: '🙈 숨기기(트레이에서 복원 가능)', click: () => m.win.hide() },
    { label: '❌ 종료', click: () => app.quit() }
  ];
  if (m.win.isDestroyed()) return;
  Menu.buildFromTemplate(template).popup(m.win);
});

// ===== Claude 에이전트 =====
// 대화는 앱을 켤 때마다 새로 시작하고, 끌 때까지 이어진다. 반응은 대표 캐릭터만 한다.
// 말 걸기 창(talk)은 캐릭터 옆에 붙은 투명 창: 답변 말풍선 + 입력칸. 더블클릭 또는 단축키로 연다.
const TALK_SHORTCUT = 'CommandOrControl+Shift+Space';
const DEFAULT_MODEL = 'claude-haiku-5-5';
const MODELS = [
  ['claude-haiku-5-5', 'Haiku 5.5 (빠름·가벼움)'],
  ['claude-sonnet-5-5', 'Sonnet 5.5'],
  ['claude-opus-5-5', 'Opus 5.5 (어려운 일)']
];
const talk = { reply: null, input: null, lifted: null, hasReply: false };   // 답변 말풍선 창 / 발밑 입력칸 창
let agentConf = { cwd: '', model: DEFAULT_MODEL, persona: '' };
const agentConfFile = () => path.join(app.getPath('userData'), 'agent.json');
const defaultWorkDir = () => path.join(app.getPath('home'), 'Claude작업');

function loadAgentConf() {
  let j = {};
  try { j = JSON.parse(fs.readFileSync(agentConfFile(), 'utf8')); } catch { /* 처음 */ }
  const conf = { cwd: j.cwd && fs.existsSync(j.cwd) ? j.cwd : defaultWorkDir(), model: j.model || DEFAULT_MODEL, persona: typeof j.persona === 'string' ? j.persona : '' };
  try { fs.mkdirSync(conf.cwd, { recursive: true }); } catch (e) { console.error('[agent] 작업 폴더를 만들 수 없음:', e.message); }
  return conf;
}

function saveAgentConf() {
  try { fs.writeFileSync(agentConfFile(), JSON.stringify(agentConf, null, 2)); } catch (e) { console.error('[agent] 설정 저장 실패:', e.message); }
}

const alive = (w) => w && !w.isDestroyed();
const sendTalk = (ch, msg) => { for (const w of [talk.reply, talk.input]) if (alive(w)) w.webContents.send(ch, msg); };

const agent = createAgent({
  getOptions: () => agentConf,
  onEvent: (e) => {
    const talkOpen = (alive(talk.input) && talk.input.isVisible()) || (alive(talk.reply) && talk.reply.isVisible());
    sendTalk('agent-event', e);
    if (e.type === 'permission') showReply(false);   // 승인은 말풍선 안의 버튼으로 받는다
    primaryMascot()?.win.webContents.send('agent-event', { ...e, talkOpen: talkOpen || e.type === 'permission' });
  }
});

// 입력칸은 캐릭터 발밑 가운데, 답변 말풍선은 캐릭터 옆(왼쪽, 자리가 없으면 오른쪽).
// 발밑에 자리가 없으면 말 거는 동안만 캐릭터를 들어 올린다.
const IN_W = 340, IN_H = 64, RE_W = 360, RE_H = 440;
function mascotBox(pm) {
  const b = pm.win.getBounds();
  const ins = pm.inset || { left: 0, top: 0, right: b.width, bottom: b.height };
  return { b, ins, feet: b.y + ins.bottom, cx: b.x + (ins.left + ins.right) / 2, wa: screen.getDisplayMatching(b).workArea };
}

function placeTalk() {
  const pm = primaryMascot();
  if (!pm) return;
  const { b, ins, feet, cx, wa } = mascotBox(pm);
  const clampX = (x, w) => Math.round(Math.min(Math.max(wa.x, x), wa.x + wa.width - w));
  if (alive(talk.input)) {
    const y = Math.min(feet + 2, wa.y + wa.height - IN_H);
    talk.input.setBounds({ x: clampX(cx - IN_W / 2, IN_W), y, width: IN_W, height: IN_H });
  }
  if (alive(talk.reply)) {
    // 머리 위 가운데(머리 위 공간만큼만 높이를 씀). 머리 위가 너무 좁으면 옆(왼쪽, 안 되면 오른쪽)
    const head = b.y + ins.top + 10;
    const room = head - wa.y;
    let x = cx - RE_W / 2, h = Math.min(RE_H, room), y = head - h, side = 'top';
    if (room < 170) {
      side = 'side';
      h = RE_H;
      x = b.x + ins.left - RE_W + 30;
      if (x < wa.x) x = b.x + ins.right - 30;
      y = Math.min(Math.max(wa.y, Math.round(feet - RE_H + 10)), wa.y + wa.height - RE_H);
    }
    talk.reply.setBounds({ x: clampX(x, RE_W), y: Math.round(y), width: RE_W, height: Math.round(h) });
    if (talk.side !== side) { talk.side = side; talk.reply.webContents.send('talk-side', side); }
  }
}

// 발밑 자리 만들기 / 되돌리기
function liftMascot() {
  const pm = primaryMascot();
  if (!pm || talk.lifted) return;
  const { feet, wa } = mascotBox(pm);
  const need = feet + 2 + IN_H - (wa.y + wa.height);
  if (need <= 0) return;
  const [x, y] = pm.win.getPosition();
  talk.lifted = { id: pm.id, x, y };
  pm.lifting = true;
  pm.win.setPosition(x, y - need);
}
function dropMascot() {
  const l = talk.lifted;
  talk.lifted = null;
  const m = l && mascots.get(l.id);
  if (!m || m.win.isDestroyed() || !m.lifting) return;
  m.lifting = false;
  m.win.setPosition(l.x, l.y);
}

function makeTalkWindow(part, w, h) {
  const win = new BrowserWindow({
    width: w, height: h, show: false,
    transparent: true, frame: false, hasShadow: false, resizable: false,
    alwaysOnTop: true, skipTaskbar: true, minimizable: false, roundedCorners: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  win.loadFile(path.join(__dirname, '../renderer/talk.html'), { query: { part } });
  return win;
}

const whenLoaded = (win, fn) => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', fn) : fn());

function showReply(focus = false) {
  if (!alive(talk.reply)) talk.reply = makeTalkWindow('reply', RE_W, RE_H);
  talk.hasReply = true;
  placeTalk();
  whenLoaded(talk.reply, () => { if (focus) talk.reply.show(); else talk.reply.showInactive(); });
}

function showTalk(focus = true) {
  agent.warm();   // Claude 를 미리 켜 둠 (첫 대답이 빨라짐)
  if (!alive(talk.input)) talk.input = makeTalkWindow('input', IN_W, IN_H);
  if (!alive(talk.reply)) talk.reply = makeTalkWindow('reply', RE_W, RE_H);
  liftMascot();
  placeTalk();
  whenLoaded(talk.input, () => {
    if (focus) { talk.input.show(); talk.input.focus(); sendTalk('talk-focus'); } else talk.input.showInactive();
  });
  if (talk.hasReply) whenLoaded(talk.reply, () => talk.reply.showInactive());
}

function hideTalk() {
  for (const w of [talk.input, talk.reply]) if (alive(w)) w.hide();
  dropMascot();
}

function toggleTalk() {
  if (alive(talk.input) && talk.input.isVisible() && talk.input.isFocused()) hideTalk();
  else showTalk(true);
}

// 캐릭터가 움직이면 따라간다
setInterval(() => { if ((alive(talk.input) && talk.input.isVisible()) || (alive(talk.reply) && talk.reply.isVisible())) placeTalk(); }, 120);

function startTalk() {
  agentConf = loadAgentConf();
  if (!globalShortcut.register(TALK_SHORTCUT, toggleTalk)) console.warn('[talk] 단축키 등록 실패:', TALK_SHORTCUT);
}

async function changeWorkDir() {
  if (agent.busy) return;
  const r = await dialog.showOpenDialog({
    title: 'Claude가 일할 폴더', defaultPath: agentConf.cwd, properties: ['openDirectory', 'createDirectory']
  });
  if (r.canceled || !r.filePaths[0] || r.filePaths[0] === agentConf.cwd) return;
  agentConf.cwd = r.filePaths[0];
  agent.reset();
  saveAgentConf();
  sendTalk('talk-reset', { note: `작업 폴더: ${agentConf.cwd}` });
}

function setModel(id) {
  agentConf.model = id;
  saveAgentConf();
}

function newConversation() {
  if (agent.busy) return;
  agent.reset();
  sendTalk('talk-reset', { note: '새 대화를 시작해요' });
}

let loginRun = null;
async function doLogin() {
  if (loginRun) loginRun.cancel();
  showReply(false);
  sendTalk('agent-event', { type: 'loginStart' });
  const run = loginRun = login({
    onUrl: (url) => sendTalk('agent-event', { type: 'loginUrl', url }),
    onNeedCode: () => sendTalk('agent-event', { type: 'loginNeedCode' })
  });
  const { ok, error } = await run.done;
  if (loginRun === run) loginRun = null;
  if (loginRun && loginRun !== run) return;   // 다시 시도 중
  sendTalk('agent-event', { type: 'loginDone', ok, error });
  primaryMascot()?.win.webContents.send('agent-event', { type: 'loginDone', ok });
}
ipcMain.handle('persona-get', () => agentConf.persona);
ipcMain.handle('persona-set', (event, text) => { agentConf.persona = String(text || '').slice(0, 4000); saveAgentConf(); return true; });
ipcMain.on('agent-login-code', (event, code) => loginRun?.sendCode(code));
ipcMain.on('open-url', (event, url) => { if (/^https:\/\/[a-z0-9.-]*claude\.(ai|com)\//i.test(url)) shell.openExternal(url); });

// 메뉴(캐릭터 우클릭·트레이)에 넣는 Claude 항목
function claudeMenu() {
  return {
    label: '🤖 Claude',
    submenu: [
      { label: `말 걸기  (${process.platform === 'darwin' ? '⌘⇧Space' : 'Ctrl+Shift+Space'} · 더블클릭)`, click: () => showTalk(true) },
      { label: '🆕 새 대화', enabled: !agent.busy, click: newConversation },
      { type: 'separator' },
      { label: '모델', submenu: MODELS.map(([id, label]) => ({ label, type: 'radio', checked: agentConf.model === id, click: () => setModel(id) })) },
      { label: `📁 작업 폴더: ${path.basename(agentConf.cwd || '')}`, enabled: !agent.busy, click: changeWorkDir },
      { label: '📂 작업 폴더 열기', click: () => shell.openPath(agentConf.cwd) },
      { type: 'separator' },
      { label: '🗣 캐릭터 말투(지침)', click: () => { showTalk(true); showReply(true); whenLoaded(talk.reply, () => talk.reply.webContents.send('talk-persona')); } },
      { label: '🔑 Claude 계정 로그인', click: doLogin }
    ]
  };
}

ipcMain.handle('agent-send', async (event, text) => {
  const t = String(text || '').trim();
  if (!t) return null;
  if (agent.busy) return '이미 작업 중이에요';
  try { fs.mkdirSync(agentConf.cwd, { recursive: true }); } catch { /* 아래에서 알림 */ }
  showReply(false);
  sendTalk('talk-user', t);
  agent.send(t).catch((e) => {
    const ev = { type: 'error', message: e.message };
    sendTalk('agent-event', ev);
    primaryMascot()?.win.webContents.send('agent-event', ev);
  });
  return null;
});
ipcMain.on('agent-answer', (event, { id, allow }) => agent.answer(id, allow));
ipcMain.on('agent-stop', () => agent.stop());
ipcMain.on('agent-login', () => doLogin());
ipcMain.on('talk-hide', () => hideTalk());
ipcMain.on('talk-ignore-mouse', (event, ignore) => BrowserWindow.fromWebContents(event.sender)?.setIgnoreMouseEvents(ignore, { forward: true }));
ipcMain.handle('talk-state', () => ({ model: agentConf.model, cwd: agentConf.cwd, busy: agent.busy, shortcut: TALK_SHORTCUT }));
// 캐릭터 더블클릭 / 승인 대기 중 클릭
onMascot('agent-open', () => showTalk(true));
onMascot('agent-answer', (m, { id, allow }) => agent.answer(id, allow));

app.on('before-quit', () => {
  app.isQuitting = true;
  dropMascot();
  agent.close();
  globalShortcut.unregisterAll();
  store?.flush();
  if (bridge) bridge.stop();
  if (trackerHandle) trackerHandle.stop();
  if (cursorTimer) clearInterval(cursorTimer);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
