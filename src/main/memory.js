// 장기 기억. 토큰을 아끼려고 "압축된 메모" 하나만 기억한다.
//
// - memory.md   : 압축된 기억 (사용자에 대한 중요한 것 / 최근 일 / 약속). 매 대화의 지침에 붙는다. 약 1200자 이내.
// - pending.jsonl: 아직 압축하지 않은 대화 기록. 다음에 켤 때(또는 새 대화를 시작할 때) 한 번 압축해서 memory.md 에 합친다.
// - remember(fact): "이거 기억해" 같은 건 바로 memory.md 에 적는다.
const fs = require('fs');
const path = require('path');

const MAX_MEMORY = 1400;        // 압축 기억 최대 글자 수
const MAX_TRANSCRIPT = 14000;   // 압축할 때 넘기는 대화 기록 최대 글자 수 (최근 것부터)

function createMemory(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const memFile = path.join(dir, 'memory.md');
  const pendFile = path.join(dir, 'pending.jsonl');

  const read = () => { try { return fs.readFileSync(memFile, 'utf8').trim(); } catch { return ''; } };
  const write = (t) => fs.writeFileSync(memFile, String(t || '').trim().slice(0, MAX_MEMORY * 1.5) + '\n');

  function recordTurn(user, assistant) {
    if (!user && !assistant) return;
    const line = JSON.stringify({ t: new Date().toISOString(), user: String(user || '').slice(0, 2000), assistant: String(assistant || '').slice(0, 2000) });
    fs.appendFileSync(pendFile, line + '\n');
  }

  function remember(fact) {
    const f = String(fact || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!f) return read();
    let mem = read();
    if (!mem) mem = '## 사용자에 대해\n\n## 최근 일\n\n## 약속·할 일\n';
    if (/## 사용자에 대해\n/.test(mem)) mem = mem.replace(/## 사용자에 대해\n/, `## 사용자에 대해\n- ${f}\n`);
    else mem = `- ${f}\n` + mem;
    write(mem);
    return mem;
  }

  function hasPending() {
    try { return fs.statSync(pendFile).size > 0; } catch { return false; }
  }

  // 쌓인 대화를 압축해서 기억에 합친다. summarize(prompt) → 모델의 답 (문자열)
  let compressing = null;
  function compress(summarize) {
    if (compressing) return compressing;
    if (!hasPending()) return Promise.resolve(false);
    compressing = (async () => {
      // 압축하는 동안 새로 쌓이는 대화와 섞이지 않게 먼저 떼어 둔다
      const work = pendFile + '.work';
      try { fs.renameSync(pendFile, work); } catch { return false; }
      const lines = fs.readFileSync(work, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      let transcript = lines.map((x) => `[${x.t.slice(0, 16).replace('T', ' ')}]\n사용자: ${x.user}\n캐릭터: ${x.assistant}`).join('\n\n');
      if (transcript.length > MAX_TRANSCRIPT) transcript = '…(앞부분 생략)\n' + transcript.slice(-MAX_TRANSCRIPT);
      const prompt = [
        '아래는 데스크톱 캐릭터가 사용자에 대해 지금까지 기억하는 메모와, 그 뒤에 나눈 대화 기록입니다.',
        '둘을 합쳐 다음 대화에서 쓸 "새 기억 메모"를 만들어 주세요.',
        '',
        '규칙:',
        `- 전체 ${MAX_MEMORY}자 이내. 짧은 글머리표만. 인사·잡담·한 번 쓰고 끝난 작업의 세부 내용은 버리기.`,
        '- 남길 것: 사용자의 이름·호칭·취향·하는 일·자주 쓰는 도구·싫어하는 것, 진행 중인 일, 다음에 이어서 할 일, 한 약속.',
        '- "최근 일"은 최근 것 위주로 5개 이하. 오래되거나 끝난 일은 지우기. 날짜(월/일)를 앞에 붙이기.',
        '- 대화에 없는 내용은 지어내지 말기. 기존 메모와 대화가 다르면 최근 대화를 따르기.',
        '- 형식은 정확히 아래 세 제목만 쓰고, 메모만 출력 (설명 금지):',
        '## 사용자에 대해',
        '## 최근 일',
        '## 약속·할 일',
        '',
        '=== 지금 기억 ===',
        read() || '(없음)',
        '',
        '=== 대화 기록 ===',
        transcript
      ].join('\n');
      try {
        const out = String(await summarize(prompt) || '').trim();
        if (!/##/.test(out)) throw new Error('압축 결과 형식이 이상해요');
        write(out);
        fs.rmSync(work, { force: true });
        return true;
      } catch (e) {
        // 실패하면 기록을 되돌려 놓고 다음에 다시 시도
        try {
          const back = fs.readFileSync(work, 'utf8');
          fs.appendFileSync(pendFile, back);
          fs.rmSync(work, { force: true });
        } catch { /* 무시 */ }
        console.warn('[memory] 압축 실패:', e.message);
        return false;
      }
    })().finally(() => { compressing = null; });
    return compressing;
  }

  // 시작할 때 남아 있는 .work (압축 중에 앱이 꺼진 경우) 되살리기
  try {
    const work = pendFile + '.work';
    if (fs.existsSync(work)) { fs.appendFileSync(pendFile, fs.readFileSync(work, 'utf8')); fs.rmSync(work); }
  } catch { /* 무시 */ }

  return { read, write: (t) => write(t), recordTurn, remember, compress, hasPending, file: memFile };
}

module.exports = { createMemory };
