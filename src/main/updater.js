// 앱 안에서 새 버전 받기 (macOS).
// GitHub Actions 가 push 마다 만드는 릴리스(태그 build-<번호>)의 zip 을 받아, 앱이 꺼진 뒤 바꿔 끼우고 다시 켠다.
// 정식 서명이 없는 앱이라 electron-updater(Squirrel) 대신 직접 교체한다.
const { app, net, dialog, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const REPO = 'etude-live/Live-2d-pet';
const CHECK_EVERY = 3 * 60 * 60 * 1000;   // 3시간마다

const pkg = require('../../package.json');
// 사람이 보는 버전은 vX.Y.Z (package.json version, 빌드할 때 Z 를 채움).
// 비교는 빌드 번호(릴리스 태그 build-N)로 한다 — 예전 빌드도 같은 태그로 업데이트를 찾을 수 있게.
const currentBuild = () => Number(pkg.buildNumber) || 0;
const currentVersion = () => `v${pkg.version}`;

// 지금 실행 중인 .app 경로 (…/X.app/Contents/MacOS/X → …/X.app)
function appBundlePath() {
  const p = process.execPath.split(path.sep);
  const i = p.findIndex((s) => s.endsWith('.app'));
  return i >= 0 ? p.slice(0, i + 1).join(path.sep) : null;
}

async function latestRelease() {
  const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'live2d-desktop-mascot' }
  });
  if (res.status === 404) throw new Error('릴리스를 찾을 수 없어요 (저장소가 비공개이거나 아직 릴리스가 없어요)');
  if (!res.ok) throw new Error(`업데이트 확인 실패 (HTTP ${res.status})`);
  const r = await res.json();
  const build = Number(String(r.tag_name || '').replace(/^build-/, '')) || 0;
  const version = (String(r.name || '').match(/v\d+\.\d+\.\d+/) || [`빌드 ${build}`])[0];
  const asset = (r.assets || []).find((a) => a.name.endsWith(`-mac-${process.arch}.zip`));
  return { build, version, asset, notes: String(r.body || r.name || '').trim(), url: r.html_url };
}

const run = (cmd, args) => new Promise((resolve, reject) =>
  execFile(cmd, args, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout))));

// 업데이트 기록 (안 될 때 원인 찾기용): userData/update.log
const logFile = () => path.join(app.getPath('userData'), 'update.log');
function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}\n`;
  console.log('[update]', ...a);
  try { fs.appendFileSync(logFile(), line); } catch { /* 무시 */ }
}

// 진행률을 알리며 받기 (onProgress(0~100))
async function download(url, file, onProgress) {
  const res = await net.fetch(url, { headers: { 'User-Agent': 'live2d-desktop-mascot', Accept: 'application/octet-stream' } });
  if (!res.ok) throw new Error(`내려받기 실패 (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const out = fs.createWriteStream(file);
  const reader = res.body.getReader();
  let got = 0, last = -1;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
      const pct = total ? Math.floor((got / total) * 100) : -1;
      if (pct >= 0 && pct >= last + 10) { last = pct; onProgress?.(pct); }
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  if (total && got < total) throw new Error(`내려받다 끊겼어요 (${got}/${total} 바이트)`);
  log('downloaded', got, 'bytes');
}

// 다운로드 폴더 등에서 바로 켠 앱은 macOS 가 읽기 전용 임시 위치(AppTranslocation)에서 실행한다.
// 그 경우 원래 앱을 바꿀 수 없으므로 응용 프로그램 폴더에 새로 설치한다.
function installTarget() {
  const cur = appBundlePath();
  if (!cur) return null;
  if (cur.includes('/AppTranslocation/')) return path.join('/Applications', path.basename(cur));
  return cur;
}

async function install(rel, { beforeQuit, onProgress } = {}) {
  const target = installTarget();
  if (!target) throw new Error('지금 앱 위치를 알 수 없어요');
  log('install build', rel.build, 'from', appBundlePath(), 'to', target);
  // 바꿀 위치에 쓸 수 있는지 먼저 확인
  try { fs.accessSync(path.dirname(target), fs.constants.W_OK); } catch {
    throw new Error(`${path.dirname(target)} 폴더에 쓸 수 없어요. 앱을 응용 프로그램 폴더로 옮긴 뒤 다시 해 주세요.`);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mascot-update-'));
  const zip = path.join(dir, rel.asset.name);
  await download(rel.asset.browser_download_url, zip, onProgress);
  const out = path.join(dir, 'new');
  fs.mkdirSync(out);
  await run('/usr/bin/ditto', ['-x', '-k', zip, out]);
  const name = fs.readdirSync(out).find((f) => f.endsWith('.app'));
  if (!name) throw new Error('받은 파일에 앱이 없어요');
  const fresh = path.join(out, name);
  log('unpacked', fresh);
  // 앱이 완전히 꺼질 때까지 기다렸다가 바꿔 끼우고 다시 켬. 실패하면 원래 앱을 되살려 다시 켬. 과정은 update.log 에
  const L = logFile().replace(/"/g, '\\"');
  const script = path.join(dir, 'swap.sh');
  fs.writeFileSync(script, [
    '#!/bin/sh',
    `exec >> "${L}" 2>&1`,
    `echo "[swap] waiting for ${process.pid}"`,
    `i=0; while kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; i=$((i+1)); [ $i -gt 100 ] && kill -9 ${process.pid}; done`,
    `rm -rf "${target}.old"`,
    `if [ -e "${target}" ]; then mv "${target}" "${target}.old" || { echo "[swap] cannot move old app"; open "${target}"; exit 1; }; fi`,
    `if mv "${fresh}" "${target}"; then echo "[swap] installed ${target}"; else echo "[swap] install failed, restoring"; mv "${target}.old" "${target}"; open "${target}"; exit 1; fi`,
    `xattr -cr "${target}"`,
    `rm -rf "${target}.old" "${dir}"`,
    `echo "[swap] relaunch"`,
    `open "${target}"`
  ].join('\n'), { mode: 0o755 });
  spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' }).unref();
  log('swap script started, quitting');
  beforeQuit?.();
  app.isQuitting = true;
  app.quit();
  setTimeout(() => app.exit(0), 4000);   // 혹시 안 꺼지면 강제로
}

let busy = false;
// manual: 메뉴에서 직접 눌렀을 때 (최신이어도, 실패해도 알려 줌)
// say(text): 캐릭터가 진행 상황을 말함
async function checkForUpdate({ manual = false, beforeQuit, say } = {}) {
  if (process.platform !== 'darwin' || !app.isPackaged) {
    if (manual) dialog.showMessageBox({ message: '자동 업데이트는 맥에서 설치한 앱에서만 돼요.' });
    return;
  }
  if (busy) { if (manual) say?.('지금 업데이트 중이에요!'); return; }
  busy = true;
  let rel;
  try {
    rel = await latestRelease();
  } catch (e) {
    log('check failed:', e.message);
    if (manual) {
      const { response } = await dialog.showMessageBox({ type: 'warning', message: '업데이트를 확인하지 못했어요', detail: e.message, buttons: ['확인', '릴리스 페이지 열기'] });
      if (response === 1) shell.openExternal(`https://github.com/${REPO}/releases`);
    }
    busy = false;
    return;
  }
  try {
    if (!rel.asset || rel.build <= currentBuild()) {
      if (manual) dialog.showMessageBox({ message: `최신 버전이에요 (${currentVersion()})` });
      return;
    }
    const notes = rel.notes.split('\n').slice(0, 12).join('\n');
    const { response } = await dialog.showMessageBox({
      type: 'info',
      message: '새 버전이 나왔어요!',
      detail: `${currentVersion()} → ${rel.version}\n\n${notes}\n\n업데이트하면 내려받은 뒤 앱이 잠깐 꺼졌다가 다시 켜져요.`,
      buttons: ['지금 업데이트', '나중에'],
      defaultId: 0,
      cancelId: 1
    });
    if (response !== 0) return;
    say?.('새 버전 받는 중이에요… 잠깐만요!');
    await install(rel, { beforeQuit, onProgress: (p) => p > 0 && p < 100 && p % 30 < 10 && say?.(`업데이트 받는 중… ${p}%`) });
  } catch (e) {
    // 사용자가 업데이트를 누른 뒤의 실패는 항상 알림
    log('install failed:', e.message);
    const { response } = await dialog.showMessageBox({
      type: 'warning', message: '업데이트하지 못했어요', detail: `${e.message}\n\n기록: ${logFile()}`,
      buttons: ['확인', '릴리스 페이지 열기']
    });
    if (response === 1) shell.openExternal(`https://github.com/${REPO}/releases/latest`);
  } finally {
    busy = false;
  }
}

// 업데이트 뒤 처음 켜졌는지 (지난번 빌드 번호와 비교). 처음 켠 거면 null
function justUpdated() {
  const f = path.join(app.getPath('userData'), 'last-build');
  let prev = null;
  try { prev = Number(fs.readFileSync(f, 'utf8')) || null; } catch { /* 처음 */ }
  try { fs.writeFileSync(f, String(currentBuild())); } catch { /* 무시 */ }
  return prev && currentBuild() > prev ? { from: prev, to: currentVersion() } : null;
}

function startAutoUpdate(opts = {}) {
  setTimeout(() => checkForUpdate(opts), 15000);
  setInterval(() => checkForUpdate(opts), CHECK_EVERY);
}

module.exports = { checkForUpdate, startAutoUpdate, currentBuild, currentVersion, justUpdated };
