const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, screen, dialog, shell, globalShortcut, clipboard, Notification, desktopCapturer, systemPreferences } = require('electron');
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
const { checkForUpdate, startAutoUpdate, currentBuild, justUpdated } = require('./updater');
const { createMemory } = require('./memory');
const { createMutter } = require('./mutter');
const { createClaudeWatch } = require('./claude-watch');
const { createReminders } = require('./reminders');
const { createPomodoro } = require('./pomodoro');
const { z } = require('zod');
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
    startAutoUpdate(updateOpts());
    const upd = justUpdated();
    if (upd) setTimeout(() => mascotSay(`빌드 ${upd.to}으로 업데이트됐어요!`), 3500);
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
      onEvent: (msg) => {
        if (msg.type === 'command') { handleCommand(msg.payload, msg.client); return; }   // 스트림덱 등 (docs/STREAMDECK.md)
        primaryMascot()?.win.webContents.send('bridge-event', msg);
      }
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
  refreshTrayMenu();
  tray.on('double-click', toggleVisible);
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '표시 / 숨기기', click: toggleVisible },
    { label: '위치 초기화', click: resetPosition },
    { type: 'separator' },
    modeItem(),
    claudeOn() ? { label: '💬 Claude에게 말 걸기', click: () => showTalk(true) } : { label: '💭 혼잣말 한마디', click: () => primaryMascot()?.win.webContents.send('menu-action', { type: 'talk' }) },
    { label: '⚙️ 설정 열기', click: () => openSettingsWindow() },
    { label: '📜 크레딧', click: openCredits },
    { label: '📂 설정 폴더 열기', click: () => shell.openPath(app.getPath('userData')) },
    { label: `⬆️ 업데이트 확인 (빌드 ${currentBuild()})`, click: () => checkForUpdate({ manual: true, ...updateOpts() }) },
    { type: 'separator' },
    { label: '❌ 종료', click: () => app.quit() }
  ]));
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

onMascot('expressions', (m, list) => { m.expressions = Array.isArray(list) ? list.map(String).slice(0, 100) : []; m.expression = null; });
onMascot('expression-now', (m, name) => { m.expression = name || null; bridge?.broadcast({ type: 'expression', payload: { name: m.expression } }); });

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
    modeItem(),
    ...(claudeOn() ? [{ label: '💬 Claude에게 말 걸기', click: () => showTalk(true) }] : [{ label: '💭 혼잣말 한마디', click: () => act('talk') }]),
    claudeMenu(),
    { type: 'separator' },
    { label: '👗 모델', submenu: modelItems },
    {
      label: m.expressions?.length ? `😊 표정 (${m.expressions.length}개)` : '😊 표정 (이 모델엔 없음)',
      enabled: !!m.expressions?.length,
      submenu: (m.expressions || []).map((name) => ({ label: name, type: 'checkbox', checked: m.expression === name, click: () => act('expression', { value: name }) })).concat(
        m.expressions?.length ? [{ type: 'separator' }, { label: '원래 얼굴로', click: () => act('expression', { value: null }) }] : [])
    },
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
    { label: `⬆️ 업데이트 확인 (빌드 ${currentBuild()})`, click: () => checkForUpdate({ manual: true, ...updateOpts() }) },
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
  const conf = { cwd: j.cwd && fs.existsSync(j.cwd) ? j.cwd : defaultWorkDir(), model: j.model || DEFAULT_MODEL, persona: typeof j.persona === 'string' ? j.persona : '', enabled: j.enabled !== false, study: j.study === true };
  try { fs.mkdirSync(conf.cwd, { recursive: true }); } catch (e) { console.error('[agent] 작업 폴더를 만들 수 없음:', e.message); }
  return conf;
}

function saveAgentConf() {
  try { fs.writeFileSync(agentConfFile(), JSON.stringify(agentConf, null, 2)); } catch (e) { console.error('[agent] 설정 저장 실패:', e.message); }
}

const alive = (w) => w && !w.isDestroyed();
const sendTalk = (ch, msg) => { for (const w of [talk.reply, talk.input]) if (alive(w)) w.webContents.send(ch, msg); };

// 기억·알림은 앱이 준비된 뒤 만든다 (userData 경로가 필요)
let memory = null, reminders = null, mutter = null, study = null;

// 캐릭터 전용 도구: Claude 가 직접 부른다 (mcp__mascot__*)
const textResult = (t) => ({ content: [{ type: 'text', text: t }] });
function buildMascotTools(sdk) {
  const { tool } = sdk;
  return [
    tool('set_reminder', '정해진 시간에 사용자에게 알림을 띄운다. 몇 분 뒤면 minutes, 시각이면 at("HH:MM" 또는 ISO 날짜시간), 매일이면 daily=true 와 at("HH:MM").',
      { message: z.string().describe('알릴 내용 (캐릭터 말투로 짧게)'), minutes: z.number().optional(), at: z.string().optional(), daily: z.boolean().optional() },
      async (a) => { try { const r = reminders.add(a); return textResult('맞췄어요: ' + reminders.describe(r)); } catch (e) { return textResult('실패: ' + e.message); } }),
    tool('list_reminders', '맞춰 둔 알림 목록을 본다.', {},
      async () => textResult(reminders.list().map(reminders.describe).join('\n') || '맞춰 둔 알림이 없어요')),
    tool('cancel_reminder', '알림을 취소한다 (list_reminders 의 #번호).', { id: z.number() },
      async ({ id }) => textResult(reminders.cancel(id) ? `#${id} 알림을 취소했어요` : `#${id} 알림이 없어요`)),
    tool('remember', '사용자에 대해 오래 기억할 사실을 장기 기억에 적는다 (이름·호칭·취향·하는 일 등). 짧은 한 문장.',
      { fact: z.string() },
      async ({ fact }) => { memory.remember(fact); return textResult('기억해 뒀어요'); })
  ];
}

function fireReminder(r) {
  const text = r.text;
  primaryMascot()?.win.webContents.send('agent-event', { type: 'reminder', text });
  sendTalk('agent-event', { type: 'reminder', text });
  if (Notification.isSupported()) new Notification({ title: '⏰ 알림', body: text, silent: false }).show();
  bridge?.broadcast?.({ type: 'reminder', payload: { text } });
}

const agent = createAgent({
  getOptions: () => agentConf,
  getMemory: () => memory?.read() || '',
  buildTools: buildMascotTools,
  onTurn: (user, result, meta = {}) => {
    if (meta.clip) {   // 클립보드 번역·다듬기: 결과를 클립보드에 넣어 둠
      clipboard.writeText(result.trim());
      sendTalk('agent-event', { type: 'clipDone' });
    }
    if (!meta.noMemory) memory?.recordTurn(meta.label || user, result);
  },
  onEvent: (e) => {
    if (e.type === 'usage') { onUsage(e.windows); return; }
    const st = { start: 'working', permission: 'asking', permissionDone: 'working', idle: 'idle' }[e.type];
    if (st) bridge?.broadcast({ type: 'agent', payload: { state: st } });
    const talkOpen = (alive(talk.input) && talk.input.isVisible()) || (alive(talk.reply) && talk.reply.isVisible());
    sendTalk('agent-event', e);
    if (e.type === 'permission') showReply(false);   // 승인은 말풍선 안의 버튼으로 받는다
    primaryMascot()?.win.webContents.send('agent-event', { ...e, talkOpen: talkOpen || e.type === 'permission' });
  }
});

// 입력칸은 캐릭터 발밑 가운데, 답변 말풍선은 캐릭터 옆(왼쪽, 자리가 없으면 오른쪽).
// 발밑에 자리가 없으면 말 거는 동안만 캐릭터를 들어 올린다.
const IN_W = 340, RE_W = 360, RE_H = 440;
let IN_H = 72;   // 입력칸 창 높이: 글 줄 수에 따라 talk-input-height 로 바뀜
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
  if (!claudeOn()) {
    if (focus) primaryMascot()?.win.webContents.send('bridge-event', { type: 'say', payload: { text: 'Claude 모드가 꺼져 있어요. 우클릭 메뉴에서 켜 주세요' } });
    return;
  }
  agent.warm();   // Claude 를 미리 켜 둠 (첫 대답이 빨라짐)
  if (!alive(talk.input)) talk.input = makeTalkWindow('input', IN_W, IN_H);
  if (!alive(talk.reply)) talk.reply = makeTalkWindow('reply', RE_W, RE_H);
  liftMascot();
  placeTalk();
  whenLoaded(talk.input, () => {
    if (focus) { talk.input.show(); talk.input.focus(); sendTalk('talk-focus'); } else talk.input.showInactive();
  });
  if (talk.hasReply) whenLoaded(talk.reply, () => talk.reply.showInactive());
  primaryMascot()?.win.webContents.send('talk-visible', true);
}

function hideTalk() {
  for (const w of [talk.input, talk.reply]) if (alive(w)) w.hide();
  primaryMascot()?.win.webContents.send('talk-visible', false);
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
  memory = createMemory(path.join(app.getPath('userData'), 'memory'));
  mutter = createMutter({
    file: path.join(app.getPath('userData'), 'mutter.json'),
    getPersona: () => agentConf.persona,
    getMemory: () => memory?.read() || '',
    generate: (p) => agent.summarize(p, '데스크톱 캐릭터의 혼잣말 대사를 만드는 작가. 요청한 대사 줄만 출력한다.')
  });
  study = createClaudeWatch({
    app,
    logFile: path.join(app.getPath('userData'), 'study.log'),
    generate: (p) => agent.summarize(p, '데스크톱 캐릭터의 짧은 대사를 쓰는 작가. 대사 한 줄만 출력한다.'),
    getPersona: () => agentConf.persona,
    getMemory: () => memory?.read() || '',
    onSay: (text) => primaryMascot()?.win.webContents.send('agent-event', { type: 'study', text }),
    onState: ({ error }) => {
      if (error === 'not-trusted') { studyNeedsPermission(); setStudy(false); }
      else if (error === 'no-helper') { mascotSay('이 빌드엔 Claude 창 읽기 도구가 없어요'); setStudy(false); }
    }
  });
  if (agentConf.study && process.platform === 'darwin') study.start();
  reminders = createReminders(path.join(app.getPath('userData'), 'reminders.json'), fireReminder);
  // 지난번에 쌓인 대화를 압축해서 기억에 합침 (뒤에서 조용히)
  setTimeout(() => memory.compress((p) => agent.summarize(p)).then((ok) => ok && console.log('[memory] 압축 완료')), 4000);
  const keys = [
    [TALK_SHORTCUT, toggleTalk],
    [CLIP_KEYS.translate, () => clipAction('translate')],
    [CLIP_KEYS.polish, () => clipAction('polish')],
    [SCREEN_KEY, () => captureScreen()]
  ];
  for (const [k, fn] of keys) {
    if (!globalShortcut.register(k, fn)) { failedKeys.add(k); console.warn('[talk] 단축키 등록 실패 (다른 앱이 쓰는 중?):', k); }
  }
  sendMode();
}

// ===== 같이 공부 모드 (Claude 앱 창을 읽고 한두 마디 거듦) =====
function studyNeedsPermission() {
  mascotSay('손쉬운 사용 권한이 안 맞아요. 목록에서 이 앱을 골라 [−]로 지우고, [+]로 다시 넣은 뒤 앱을 껐다 켜 주세요 (업데이트하면 Mac이 다른 앱으로 봐요)');
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
}
function setStudy(on) {
  if (process.platform !== 'darwin') { mascotSay('같이 공부 모드는 Mac 에서만 돼요'); return; }
  agentConf.study = !!on; saveAgentConf();
  if (on) { study.start(); mascotSay('같이 볼게요! Claude한테 물어보면 옆에서 거들게요'); }
  else study.stop();
  refreshTrayMenu();
  bridge?.broadcast({ type: 'study', payload: { on: !!on } });
}
async function studyTest() {
  mascotSay('Claude 창 읽어 볼게요…');
  const r = await study.test(app.getPath('userData'));
  if (!r.ok) {
    if (r.error === 'not-trusted') studyNeedsPermission();
    else mascotSay({ 'no-app': 'Claude 앱이 안 켜져 있어요', 'no-window': 'Claude 창을 못 찾았어요', 'no-helper': '이 빌드엔 읽기 도구가 없어요' }[r.error] || '읽기 실패: ' + r.error);
    return r;
  }
  const ex = r.extract;
  const who = `[${r.app}${r.title ? ' · ' + r.title.slice(0, 30) : ''}]`;
  if (ex.method === 'class') mascotSay(`${who} 읽었어요! 질문 ${ex.q}자, 답 ${ex.a}자`);
  else { mascotSay(`${who} 글은 읽었는데 질문/답 구분은 아직 못 해요. 열린 파일 내용을 보여 주세요!`); shell.openPath(r.file); }   // 텍스트 편집기로 바로 열기
  return r;
}
function studyItems() {
  if (process.platform !== 'darwin') return [];
  return [
    { label: '📖 같이 공부 (Claude 앱 보며 거들기)', type: 'checkbox', checked: !!agentConf?.study, click: (item) => setStudy(item.checked) },
    { label: '🔍 Claude 창 읽기 테스트', click: () => studyTest() },
    { label: '📄 같이 공부 기록 보기', click: () => shell.openPath(path.join(app.getPath('userData'), 'study.log')) }
  ];
}

// ===== Claude 모드 =====
// 켜면 캐릭터가 Claude 에이전트(말 걸기·화면 보기), 끄면 혼잣말하는 피규어 (Claude 안 씀, 토큰 0)
// 번역·다듬기·포모도로·알림은 두 모드 모두 그대로
const claudeOn = () => agentConf?.enabled !== false;
const sendMode = () => { for (const m of liveMascots()) m.win.webContents.send('claude-mode', { on: claudeOn() }); };
function modeItem() {
  return { label: '🤖 Claude 모드 (끄면 혼잣말 피규어)', type: 'checkbox', checked: claudeOn(), click: (item) => setClaudeMode(item.checked) };
}
function setClaudeMode(on) {
  agentConf.enabled = !!on;
  saveAgentConf();
  if (!on) { hideTalk(); agent.stop(); }
  sendMode();
  refreshTrayMenu();
  bridge?.broadcast({ type: 'mode', payload: { claude: !!on } });
}

// ===== 클립보드 번역·다듬기 =====
const failedKeys = new Set();   // 다른 앱이 이미 쓰고 있어서 못 잡은 단축키 (메뉴에 표시)
const CLIP_KEYS = { translate: 'CommandOrControl+Shift+1', polish: 'CommandOrControl+Shift+2' };
const CLIP_PROMPTS = {
  translate: (t) => {
    // 원문 언어는 여기서 정함 (한글이 많으면 영어로, 아니면 한국어로)
    const hangul = (t.match(/[가-힣]/g) || []).length, letters = (t.match(/\p{L}/gu) || []).length;
    const to = hangul > letters * 0.3 ? '영어' : '한국어';
    return `다음 글을 자연스러운 ${to}로 번역하세요. 원문과 같은 언어로 다시 쓰면 안 됩니다. 반드시 ${to}로 된 번역문만 출력하세요.\n\n<원문>\n${t}\n</원문>`;
  },
  polish: (t) => `아래 글을 뜻은 그대로 두고 자연스럽고 매끄럽게 다듬어 주세요. 원래 언어 그대로, 다듬은 글만 출력하고 다른 말은 붙이지 마세요.\n\n${t}`
};
// 번역·다듬기는 캐릭터 대화와 따로, 도구 없이 한 번만 묻는다 (말투가 섞이지 않고 빠르고 싸다)
const CLIP_SYSTEM = '당신은 번역가이자 교정 편집자입니다. 요청한 결과물(번역문 또는 다듬은 글)만 출력하고, 인사·설명·따옴표·머리말을 붙이지 않습니다.';
let clipBusy = false;
async function clipAction(kind) {
  const text = String(await clipboard.readText() || '').trim();   // Electron 44: readText 는 Promise
  showTalk(false);
  showReply(false);
  if (!text) { sendTalk('agent-event', { type: 'note', text: '먼저 번역하거나 다듬을 글을 복사해 주세요 (⌘C)' }); return { ok: false, error: 'empty' }; }
  if (clipBusy) return { ok: false, error: 'busy' };
  clipBusy = true;
  const label = kind === 'translate' ? '번역' : '다듬기';
  sendTalk('agent-event', { type: 'clipStart', label, source: text.slice(0, 80) });
  try {
    const out = String(await agent.summarize(CLIP_PROMPTS[kind](text.slice(0, 8000)), CLIP_SYSTEM)).trim();
    if (!out) throw new Error('결과가 비어 있어요');
    await clipboard.writeText(out);
    sendTalk('agent-event', { type: 'clipResult', label, text: out });
    primaryMascot()?.win.webContents.send('agent-event', { type: 'clipDone' });
    return { ok: true };
  } catch (e) {
    sendTalk('agent-event', { type: 'error', message: `${label}하지 못했어요: ${e.message}` });
    return { ok: false, error: e.message };
  } finally {
    clipBusy = false;
  }
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
  memory?.compress((p) => agent.summarize(p));   // 지금까지 대화를 기억으로 정리
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
ipcMain.handle('memory-get', () => memory?.read() || '');
ipcMain.handle('memory-set', (event, text) => { memory?.write(String(text || '').slice(0, 4000)); return true; });
// 입력칸에 끌어다 놓은 파일: 묻지 않고 읽게 허락
ipcMain.on('talk-unattach', () => { talk.image = null; sendTalk('talk-attach', null); });
ipcMain.on('talk-drop', (event, paths) => { for (const p of paths || []) agent.allowRead(p); });
ipcMain.handle('persona-set', (event, text) => { agentConf.persona = String(text || '').slice(0, 4000); saveAgentConf(); return true; });
ipcMain.on('agent-login-code', (event, code) => loginRun?.sendCode(code));
ipcMain.on('open-url', (event, url) => { if (/^https:\/\/[a-z0-9.-]*claude\.(ai|com)\//i.test(url)) shell.openExternal(url); });

// 메뉴(캐릭터 우클릭·트레이)에 넣는 Claude 항목
function claudeMenu() {
  return {
    label: '🤖 Claude',
    submenu: claudeOn() ? [
      { label: `말 걸기  (${process.platform === 'darwin' ? '⌘⇧Space' : 'Ctrl+Shift+Space'} · 더블클릭)`, click: () => showTalk(true) },
      { label: '🆕 새 대화', enabled: !agent.busy, click: newConversation },
      { type: 'separator' },
      { label: '모델', submenu: MODELS.map(([id, label]) => ({ label, type: 'radio', checked: agentConf.model === id, click: () => setModel(id) })) },
      { label: `📁 작업 폴더: ${path.basename(agentConf.cwd || '')}`, enabled: !agent.busy, click: changeWorkDir },
      { label: '📂 작업 폴더 열기', click: () => shell.openPath(agentConf.cwd) },
      { type: 'separator' },
      { label: `📋 클립보드 번역  (${failedKeys.has(CLIP_KEYS.translate) ? '단축키 안 됨: 다른 앱이 사용 중' : process.platform === 'darwin' ? '⌘⇧1' : 'Ctrl+Shift+1'})`, click: () => clipAction('translate') },
      { label: `📋 클립보드 다듬기  (${failedKeys.has(CLIP_KEYS.polish) ? '단축키 안 됨: 다른 앱이 사용 중' : process.platform === 'darwin' ? '⌘⇧2' : 'Ctrl+Shift+2'})`, click: () => clipAction('polish') },
      { label: usageText() ? `${usageText()}  (${usage.five_hour?.resetsAt ? hhmm(usage.five_hour.resetsAt) + ' 리셋' : ''})` : '🔋 사용량: 대화하면 표시돼요', enabled: false },
      { type: 'separator' },
      { label: `📸 화면 보고 도와줘  (${failedKeys.has(SCREEN_KEY) ? '단축키 안 됨: 다른 앱이 사용 중' : process.platform === 'darwin' ? '⌘⇧0' : 'Ctrl+Shift+0'})`, click: () => captureScreen() },
      { label: '🍅 포모도로 시작/끝', click: () => handleCommand({ name: 'pomodoro.toggle' }) },
      { label: '⏰ 알림 목록', click: () => { showTalk(true); showReply(false); sendTalk('agent-event', { type: 'note', text: reminders.list().map(reminders.describe).join('\n') || '맞춰 둔 알림이 없어요' }); } },
      { label: '🧠 기억 보기·고치기', click: () => { showTalk(true); showReply(true); whenLoaded(talk.reply, () => talk.reply.webContents.send('talk-memory')); } },
      { type: 'separator' },
      { label: '🗣 캐릭터 말투(지침)', click: () => { showTalk(true); showReply(true); whenLoaded(talk.reply, () => talk.reply.webContents.send('talk-persona')); } },
      { label: '🔑 Claude 계정 로그인', click: doLogin },
      { type: 'separator' },
      ...studyItems()
    ] : [
      ...studyItems(),
      { type: 'separator' },
      { label: '📋 클립보드 번역', click: () => clipAction('translate') },
      { label: '📋 클립보드 다듬기', click: () => clipAction('polish') },
      { label: '🍅 포모도로 시작/끝', click: () => handleCommand({ name: 'pomodoro.toggle' }) }
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
  const images = talk.image ? [talk.image] : undefined;
  talk.image = null;
  sendTalk('talk-attach', null);
  agent.send(t, { images }).catch((e) => {
    const ev = { type: 'error', message: e.message };
    sendTalk('agent-event', ev);
    primaryMascot()?.win.webContents.send('agent-event', ev);
  });
  return null;
});
ipcMain.handle('claude-mode-get', () => claudeOn());
ipcMain.handle('mutter-next', () => mutter?.next() || '');
ipcMain.on('agent-answer', (event, { id, allow }) => agent.answer(id, allow));
ipcMain.on('agent-stop', () => agent.stop());
ipcMain.on('agent-login', () => doLogin());
ipcMain.on('talk-hide', () => hideTalk());
ipcMain.on('talk-input-height', (event, h) => {
  const nh = Math.max(60, Math.min(200, Math.ceil(Number(h) || 72)));
  if (nh === IN_H) return;
  IN_H = nh;
  placeTalk();
});
ipcMain.on('talk-ignore-mouse', (event, ignore) => BrowserWindow.fromWebContents(event.sender)?.setIgnoreMouseEvents(ignore, { forward: true }));
ipcMain.handle('talk-state', () => ({ usage: usageText(), model: agentConf.model, cwd: agentConf.cwd, busy: agent.busy, shortcut: TALK_SHORTCUT }));
// 캐릭터 더블클릭 / 승인 대기 중 클릭
onMascot('agent-open', () => showTalk(true));
onMascot('agent-answer', (m, { id, allow }) => agent.answer(id, allow));

// ===== Pro/Max 사용량 표시 =====
// 대화할 때마다 오는 5시간·주간 한도 사용률. 메뉴·메뉴바·말풍선·스트림덱에 보여 주고, 80%를 넘으면 한 번 알림
const usageFile = () => path.join(app.getPath('userData'), 'usage.json');
let usage = {};
try { usage = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'usage.json'), 'utf8')); } catch { usage = {}; }
const warned = new Set();
const pct = (w) => (w ? `${Math.round(w.utilization * 100)}%` : '?');
const hhmm = (t) => { const d = new Date(t); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };
const dayName = (t) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()} ${hhmm(t)}`; };
function usageText(long = false) {
  const f = usage.five_hour, w = usage.seven_day;
  if (!f && !w) return '';
  let t = `🔋 5시간 ${pct(f)} · 주간 ${pct(w)}`;
  if (long) {
    if (f?.resetsAt) t += `\n5시간 한도 다시 채워짐: ${hhmm(f.resetsAt)}`;
    if (w?.resetsAt) t += `\n주간 한도 다시 채워짐: ${dayName(w.resetsAt)}`;
  }
  return t;
}
function onUsage(windows) {
  // 지난 창(이미 리셋된 것)은 버림
  const now = Date.now();
  usage = { ...Object.fromEntries(Object.entries(usage).filter(([, w]) => !w.resetsAt || w.resetsAt > now)), ...windows };
  try { fs.writeFileSync(usageFile(), JSON.stringify(usage)); } catch { /* 무시 */ }
  tray?.setToolTip(`Live2D Desktop Mascot\n${usageText(true)}`);
  sendTalk('talk-usage', usageText());
  bridge?.broadcast({ type: 'usage', payload: usage });
  for (const [k, label] of [['five_hour', '5시간'], ['seven_day', '이번 주']]) {
    const w = usage[k];
    if (!w) continue;
    for (const lim of [0.8, 0.95]) {
      const key = `${k}:${lim}:${w.resetsAt}`;
      if (w.utilization >= lim && !warned.has(key)) {
        warned.add(key);
        const when = w.resetsAt ? (k === 'five_hour' ? ` ${hhmm(w.resetsAt)}에 다시 채워져요.` : ` ${dayName(w.resetsAt)}에 다시 채워져요.`) : '';
        mascotSay(lim < 0.9 ? `${label} 사용량이 ${pct(w)}예요. 조금 아껴 써요!${when}` : `${label} 사용량이 거의 다 찼어요 (${pct(w)}).${when}`);
      }
    }
  }
}

// 캐릭터가 한마디 (토큰 안 씀)
const mascotSay = (text) => primaryMascot()?.win.webContents.send('bridge-event', { type: 'say', payload: { text } });
const updateOpts = () => ({ beforeQuit: () => dropMascot(), say: mascotSay });

// ===== 화면 보고 도와주기 =====
// 캐릭터가 있는 화면을 찍어(긴 변 1568px 이하 JPEG, 약 2천 토큰) 다음 메시지에 붙인다.
// question 이 있으면 바로 묻는다 (스트림덱 버튼 등).
const SCREEN_KEY = 'CommandOrControl+Shift+0';
async function captureScreen(question) {
  if (!claudeOn()) return { ok: false, error: 'claude-off' };
  if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
    // 처음엔 권한 요청이 뜨도록 한 번 시도는 해 본다
    try { await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }); } catch { /* 무시 */ }
    if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
      showTalk(false); showReply(false);
      sendTalk('agent-event', { type: 'note', text: '화면을 보려면 권한이 필요해요. 시스템 설정 → 개인정보 보호 및 보안 → 화면 및 시스템 오디오 녹음에서 이 앱을 켜고, 앱을 다시 켜 주세요.' });
      shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
      return { ok: false, error: 'screen-permission' };
    }
  }
  const pm = primaryMascot();
  const display = pm ? screen.getDisplayMatching(pm.win.getBounds()) : screen.getPrimaryDisplay();
  const { width, height } = display.size;
  const k = Math.min(1, 1568 / Math.max(width, height));
  // 말 걸기 창은 잠깐 숨기고 찍음
  const wasOpen = alive(talk.input) && talk.input.isVisible();
  for (const w of [talk.input, talk.reply]) if (alive(w)) w.hide();
  await new Promise((r) => setTimeout(r, 180));
  let img;
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(width * k), height: Math.round(height * k) } });
    const src = sources.find((x) => String(x.display_id) === String(display.id)) || sources[0];
    img = src?.thumbnail;
  } catch (e) {
    console.warn('[screen]', e.message);
  }
  showTalk(true);
  if (!img || img.isEmpty()) {
    sendTalk('agent-event', { type: 'note', text: '화면을 찍지 못했어요.' });
    return { ok: false, error: 'capture-failed' };
  }
  talk.image = { mediaType: 'image/jpeg', data: img.toJPEG(80).toString('base64') };
  sendTalk('talk-attach', { preview: img.resize({ width: 160 }).toDataURL() });
  if (question) {
    return sendFromOutside(question);
  } else if (!wasOpen) {
    sendTalk('talk-focus');
  }
  return { ok: true };
}

// 밖(스트림덱 등)에서 말 걸기: 입력칸에 친 것과 똑같이 처리
function sendFromOutside(text) {
  const t = String(text || '').trim();
  if (!t) return { ok: false, error: 'empty' };
  if (!claudeOn()) return { ok: false, error: 'claude-off' };
  if (agent.busy) return { ok: false, error: 'busy' };
  showTalk(false);
  showReply(false);
  sendTalk('talk-user', t);
  const images = talk.image ? [talk.image] : undefined;
  talk.image = null;
  sendTalk('talk-attach', null);
  agent.send(t, { images }).catch((e) => sendTalk('agent-event', { type: 'error', message: e.message }));
  return { ok: true };
}

// ===== 포모도로 =====
const POMO_LINES = {
  work: (s) => s.cycle === 1 ? `집중 시작! ${s.minutes.work}분 동안 같이 힘내요` : `다시 집중! ${s.cycle}번째예요`,
  break: (s) => `수고했어요! ${s.minutes.break}분 쉬어요`,
  long: (s) => `${s.cycles}번 다 했어요! ${s.minutes.long}분 푹 쉬어요`,
  done: () => '포모도로 끝! 정말 잘했어요',
  stopped: () => '포모도로를 멈췄어요',
  paused: () => '잠깐 멈춤!',
  resumed: () => '다시 시작해요!'
};
const fmt = (sec) => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
const pomodoro = createPomodoro({
  onPhase: (phase, s) => {
    const text = (POMO_LINES[phase] || (() => ''))(s);
    if (text) primaryMascot()?.win.webContents.send('agent-event', { type: 'pomodoro', phase, text });
    if (['work', 'break', 'long', 'done'].includes(phase) && Notification.isSupported()) new Notification({ title: '🍅 포모도로', body: text, silent: false }).show();
    bridge?.broadcast({ type: 'pomodoro', payload: { event: phase, ...s } });
  },
  onTick: (s) => {
    tray?.setTitle(s.running ? `${s.phase === 'work' ? '🍅' : '☕'} ${fmt(s.remainingSec)}${s.paused ? ' ⏸' : ''}` : '');
    bridge?.broadcast({ type: 'pomodoro', payload: { event: 'tick', ...s } });
  }
});

// ===== 외부 명령 (스트림덱 플러그인 등). 형식은 docs/STREAMDECK.md =====
async function handleCommand(payload = {}, client) {
  const { id, name, args = {} } = payload;
  let result;
  try {
    switch (name) {
      case 'study.toggle': setStudy(!agentConf.study); result = { ok: true, study: !!agentConf.study }; break;
      case 'study.test': { const t = await studyTest(); result = { ok: !!t.ok, error: t.error, extract: t.extract }; break; }
      case 'mode.set': setClaudeMode(args.on !== false); result = { ok: true, claude: claudeOn() }; break;
      case 'mode.toggle': setClaudeMode(!claudeOn()); result = { ok: true, claude: claudeOn() }; break;
      case 'expression.list': { const pm = primaryMascot(); result = { ok: true, expressions: pm?.expressions || [], current: pm?.expression || null }; break; }
      case 'expression.set': {
        const pm = primaryMascot();
        const name = args.name == null ? null : String(args.name);
        if (name && !(pm?.expressions || []).includes(name)) { result = { ok: false, error: 'no-such-expression' }; break; }
        pm?.win.webContents.send('settings-action', { type: 'expression', value: name, text: args.text });
        result = { ok: true }; break;
      }
      case 'expression.reset': primaryMascot()?.win.webContents.send('settings-action', { type: 'expression', value: null }); result = { ok: true }; break;
      case 'motion.play': primaryMascot()?.win.webContents.send('settings-action', { type: 'motion', text: args.text }); result = { ok: true }; break;
      case 'talk.open': showTalk(true); result = { ok: true }; break;
      case 'talk.toggle': toggleTalk(); result = { ok: true }; break;
      case 'talk.hide': hideTalk(); result = { ok: true }; break;
      case 'talk.send': result = sendFromOutside(args.text); break;
      case 'agent.stop': agent.stop(); result = { ok: true }; break;
      case 'agent.newChat': newConversation(); result = { ok: true }; break;
      case 'clip.translate': result = await clipAction('translate'); break;
      case 'clip.polish': result = await clipAction('polish'); break;
      case 'screen.ask': result = await captureScreen(args.question); break;
      case 'pomodoro.start': result = { ok: true, state: pomodoro.start(args) }; break;
      case 'pomodoro.toggle': result = { ok: true, state: pomodoro.toggle(args) }; break;
      case 'pomodoro.stop': result = { ok: true, state: pomodoro.stop() }; break;
      case 'pomodoro.pause': result = { ok: true, state: pomodoro.pause() }; break;
      case 'pomodoro.skip': result = { ok: true, state: pomodoro.skip() }; break;
      case 'reminder.list': result = { ok: true, reminders: reminders.list().map((r) => ({ id: r.id, text: r.text, at: r.at, daily: r.daily })) }; break;
      case 'mascot.say': primaryMascot()?.win.webContents.send('bridge-event', { type: 'say', payload: { text: String(args.text || '') } }); result = { ok: true }; break;
      case 'state.get': result = { ok: true, claude: claudeOn(), agent: agent.busy ? 'working' : 'idle', pomodoro: pomodoro.state(), usage, build: currentBuild() }; break;
      case 'usage.get': await agent.refreshUsage(); result = { ok: true, usage }; break;
      default: result = { ok: false, error: 'unknown-command' };
    }
  } catch (e) {
    result = { ok: false, error: e.message };
  }
  if (client) bridge?.send(client, { type: 'result', payload: { id, name, ...result } });
  return result;
}

app.on('before-quit', () => {
  app.isQuitting = true;
  pomodoro.stop();
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
