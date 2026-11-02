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
const currentBuild = () => Number(pkg.buildNumber) || 0;

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
  const asset = (r.assets || []).find((a) => a.name.endsWith(`-mac-${process.arch}.zip`));
  return { build, asset, notes: String(r.body || r.name || '').trim(), url: r.html_url };
}

const run = (cmd, args) => new Promise((resolve, reject) =>
  execFile(cmd, args, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout))));

async function download(url, file) {
  const res = await net.fetch(url, { headers: { 'User-Agent': 'live2d-desktop-mascot', Accept: 'application/octet-stream' } });
  if (!res.ok) throw new Error(`내려받기 실패 (HTTP ${res.status})`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

async function install(rel, { beforeQuit } = {}) {
  const target = appBundlePath();
  if (!target) throw new Error('지금 앱 위치를 알 수 없어요');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mascot-update-'));
  const zip = path.join(dir, rel.asset.name);
  await download(rel.asset.browser_download_url, zip);
  const out = path.join(dir, 'new');
  fs.mkdirSync(out);
  await run('/usr/bin/ditto', ['-x', '-k', zip, out]);
  const name = fs.readdirSync(out).find((f) => f.endsWith('.app'));
  if (!name) throw new Error('받은 파일에 앱이 없어요');
  const fresh = path.join(out, name);
  // 앱이 완전히 꺼질 때까지 기다렸다가 바꿔 끼우고 다시 켬
  const script = path.join(dir, 'swap.sh');
  fs.writeFileSync(script, [
    '#!/bin/sh',
    `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done`,
    `rm -rf "${target}.old"`,
    `mv "${target}" "${target}.old" && mv "${fresh}" "${target}" || { mv "${target}.old" "${target}"; open "${target}"; exit 1; }`,
    `xattr -cr "${target}" 2>/dev/null`,
    `rm -rf "${target}.old" "${dir}"`,
    `open "${target}"`
  ].join('\n'), { mode: 0o755 });
  spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' }).unref();
  beforeQuit?.();
  app.isQuitting = true;
  app.quit();
}

let busy = false;
// manual: 메뉴에서 직접 눌렀을 때 (최신이어도, 실패해도 알려 줌)
async function checkForUpdate({ manual = false, beforeQuit } = {}) {
  if (process.platform !== 'darwin' || !app.isPackaged) {
    if (manual) dialog.showMessageBox({ message: '자동 업데이트는 맥에서 설치한 앱에서만 돼요.' });
    return;
  }
  if (busy) return;
  busy = true;
  try {
    const rel = await latestRelease();
    if (!rel.asset || rel.build <= currentBuild()) {
      if (manual) dialog.showMessageBox({ message: `최신 버전이에요 (빌드 ${currentBuild()})` });
      return;
    }
    const notes = rel.notes.split('\n').slice(0, 12).join('\n');
    const { response } = await dialog.showMessageBox({
      type: 'info',
      message: '새 버전이 나왔어요!',
      detail: `빌드 ${currentBuild()} → ${rel.build}\n\n${notes}\n\n업데이트하면 앱이 잠깐 꺼졌다가 다시 켜져요.`,
      buttons: ['지금 업데이트', '나중에'],
      defaultId: 0,
      cancelId: 1
    });
    if (response === 0) await install(rel, { beforeQuit });
  } catch (e) {
    console.warn('[update]', e.message);
    if (manual) {
      const { response } = await dialog.showMessageBox({ type: 'warning', message: '업데이트를 확인하지 못했어요', detail: e.message, buttons: ['확인', '릴리스 페이지 열기'] });
      if (response === 1) shell.openExternal(`https://github.com/${REPO}/releases`);
    }
  } finally {
    busy = false;
  }
}

function startAutoUpdate(opts = {}) {
  setTimeout(() => checkForUpdate(opts), 15000);
  setInterval(() => checkForUpdate(opts), CHECK_EVERY);
}

module.exports = { checkForUpdate, startAutoUpdate, currentBuild };
