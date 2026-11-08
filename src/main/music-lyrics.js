// Apple Music 가사 따라 흥얼거리기 — 지금은 1단계(진단)만.
// tools/ax-read.swift --music 으로 Music 창 구조(역할·위치·크기·속성·글자 수·글자 종류)를 읽는다. 가사 글자는 안 읽음.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

function helperPath(app) {
  const p = app.isPackaged ? path.join(process.resourcesPath, 'bin', 'ax-read') : path.join(__dirname, '../../build/bin/ax-read');
  return fs.existsSync(p) ? p : null;
}

const run = (bin, args, timeout) => new Promise((resolve) => {
  execFile(bin, args, { timeout, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) =>
    resolve(err && !stdout ? { ok: false, error: (stderr || err.message).trim() } : { ok: true, out: String(stdout) }));
});

// Music 상태 (Music 이 꺼져 있으면 켜지 않음. 변수 이름에 예약어 st 금지: -2741)
const STATUS = `if application "Music" is running then
  tell application "Music"
    set playerState to player state as string
    set playerPos to 0
    set trackLen to 0
    try
      set playerPos to player position
      set trackLen to duration of current track
    end try
    return playerState & tab & playerPos & tab & trackLen
  end tell
else
  return "off"
end if`;

async function musicStatus() {
  const r = await run('osascript', ['-e', STATUS], 4000);
  if (!r.ok) return { error: r.error };
  const [state, pos, len] = r.out.trim().split('\t');
  return { state, pos: Number(pos) || 0, len: Number(len) || 0 };
}

async function readMusic(app, prompt) {
  const exe = helperPath(app);
  if (!exe) return { ok: false, error: 'no-helper' };
  const r = await run(exe, ['--music', ...(prompt ? ['--prompt'] : [])], 15000);
  if (!r.ok) return { ok: false, error: r.error };
  try { return JSON.parse(r.out); } catch { return { ok: false, error: 'bad-output' }; }
}

// 진단: 1.5초 간격으로 세 번 읽어 파일로 (줄이 움직이는지·밝기 속성이 있는지 보려고)
async function musicTest(app, dir) {
  const file = path.join(dir, 'music-read.txt');
  const lines = [`# Music 가사 읽기 테스트 ${new Date().toISOString()}`,
    '# 가사 글자는 넣지 않았어요. 각 줄: 깊이 역할[/세부역할] #식별자 [x,y 너비×높이] 글자수·글자종류(어느 속성) sel=선택 foc=포커스', ''];
  let first = null;
  for (let pass = 1; pass <= 3; pass++) {
    const st = await musicStatus();
    const r = await readMusic(app, pass === 1);
    if (!r.ok) {
      lines.push(`## ${pass}회차: 실패 ${r.error}`);
      if (pass === 1) { fs.writeFileSync(file, lines.join('\n')); return { ok: false, error: r.error, file }; }
      continue;
    }
    first = first || r;
    const textNodes = r.nodes.filter((n) => n.n);
    lines.push(`## ${pass}회차  재생=${st.state ?? st.error} 위치=${st.pos?.toFixed?.(1) ?? '?'}초/${st.len?.toFixed?.(0) ?? '?'}초  창=${JSON.stringify(r.window)}  노드 ${r.nodes.length}개, 글자 있는 노드 ${textNodes.length}개`);
    if (pass === 1) lines.push(`# 글자 있는 노드가 가진 속성: ${r.attrNames.join(', ')}`, '');
    for (const n of (pass === 1 ? r.nodes : textNodes)) {
      lines.push(`${' '.repeat(Math.min(n.d, 30))}${n.r}${n.sr ? '/' + n.sr : ''}${n.id ? ' #' + n.id : ''} [${n.x},${n.y} ${n.w}×${n.h}]` +
        `${n.n ? ` ${n.n}자·${n.k}(${n.src})` : ''}${n.sel !== undefined ? ' sel=' + n.sel : ''}${n.foc ? ' foc' : ''}${n.off ? ' off' : ''}`);
    }
    lines.push('');
    if (pass < 3) await new Promise((res) => setTimeout(res, 1500));
  }
  fs.writeFileSync(file, lines.join('\n'));
  return { ok: true, file, textNodes: first?.nodes.filter((n) => n.n).length || 0 };
}

module.exports = { musicTest, musicStatus };
