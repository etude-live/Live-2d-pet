// 에이전트 작업 상태 → 캐릭터 대사.
// 말투·혼잣말 규칙은 deepseek-harness-kr(DeepSeek짱, MIT)의 dsc.js 를 Claude 도구 이름에 맞춰 옮긴 것.

const TEXT = {
  hello: '안녕하세요! 오늘은 뭘 만들어 볼까요?',
  start: '알겠어요! 시작할게요',
  approval: '확인이 필요해요! 한번 봐 주세요',
  done: '다 했어요!',
  error: '앗, 문제가 생겼어요…',
  stopped: '네, 멈출게요',
  working: ['지금 열심히 하는 중이에요!', '조금만 기다려 주세요~', '집중하는 중!'],
  noFolder: '어느 폴더에서 일할지 먼저 골라 주세요!'
};

// Claude Code 도구 이름 → 말풍선
const TOOLS = {
  Bash: '명령 실행 중…', BashOutput: '명령 결과 보는 중…', KillShell: '명령 멈추는 중…',
  Read: '파일 읽는 중…', Write: '파일 쓰는 중…', Edit: '코드 고치는 중…', MultiEdit: '코드 고치는 중…',
  NotebookEdit: '노트북 고치는 중…', Glob: '파일 찾는 중…', Grep: '찾아보는 중…',
  WebSearch: '검색하는 중…', WebFetch: '웹페이지 보는 중…',
  Task: '도우미 부르는 중…', Agent: '도우미 부르는 중…',
  TodoWrite: '할 일 정리하는 중…', TaskCreate: '할 일 정리하는 중…', TaskUpdate: '할 일 정리하는 중…',
  Skill: '스킬 꺼내는 중…', ExitPlanMode: '계획 세우는 중…'
};
const toolLine = (name) => TOOLS[name] || (name?.startsWith('mcp__') ? '연결된 도구 쓰는 중…' : '도구 쓰는 중…');

// 승인 요청 말풍선: 무엇을 하려는지 짧게
const ASK = {
  Bash: '이 명령 실행해도 될까요?',
  Write: '이 파일 써도 될까요?', Edit: '이 파일 고쳐도 될까요?', MultiEdit: '이 파일 고쳐도 될까요?',
  NotebookEdit: '이 노트북 고쳐도 될까요?', WebFetch: '이 페이지 열어 봐도 될까요?', WebSearch: '검색해 봐도 될까요?'
};
const askLine = (name) => ASK[name] || TEXT.approval;

// 버튜버 말투: 추론 속 "the user"를 시청자에게 말하듯 "you"로 (동사도 맞춤)
const VERB = {
  is: 'are', was: 'were', has: 'have', wants: 'want', needs: 'need', asks: 'ask', asked: 'asked',
  said: 'said', says: 'say', likes: 'like', prefers: 'prefer', seems: 'seem', mentioned: 'mentioned', requested: 'requested'
};
const vtuberize = (s) => s
  .replace(/\b(the|this) user's\b/gi, (m) => (m[0] === 'T' ? 'Your' : 'your'))
  .replace(/\b(the|this) user (\w+)/gi, (m, d, v) => {
    const you = d[0] === d[0].toUpperCase() ? 'You' : 'you';
    return you + ' ' + (VERB[v.toLowerCase()] || v);
  })
  .replace(/\b(the|this) user\b/gi, (m) => (m[0] === m[0].toUpperCase() ? 'You' : 'you'))
  // 한국어 추론: "사용자가 …" → 앞에 있는 상대에게 말하듯 주어를 뺌
  .replace(/사용자(?:님)?(?:이|가|는|께서|의|에게|를)\s/g, '');

// 추론 문단 → 혼잣말 한 줄 (못 쓰는 줄이면 null)
function thoughtLine(s, rand = Math.random) {
  const t = String(s || '').replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim()
    .replace(/^(?:[-•]|\d+[.)])\s+/, '')              // 목록 기호 (- • 1. 1))
    .replace(/^\([^)]{1,30}\):?\s*/, '');            // (Self-Correction): 같은 머리말
  if (!t) return null;
  const hangul = (t.match(/[가-힣]/g) || []).length;
  const latin = (t.match(/[A-Za-z]/g) || []).length;
  const first = (t.match(/^.{4,}?[.!?。…](\s|$)/) || [t])[0].trim();   // 첫 문장
  if (hangul >= 4 && latin <= hangul * 0.35) {                       // 한국어가 대부분인 문장
    const k = vtuberize(first);
    return k.length > 42 ? k.slice(0, 40).trim() + '…' : k;
  }
  // 영어 문장: 낱말 3개 이상, 한글은 거의 없고, 코드·경로처럼 기호가 많은 줄은 뺌
  const words = first.split(' ').filter((w) => /[A-Za-z]{2,}/.test(w)).length;
  const symbols = (first.match(/[{}()[\];=<>/\\|$@]/g) || []).length;
  if (latin < 12 || words < 3 || hangul > latin * 0.1 || symbols > first.length * 0.04 || first.includes('://')) return null;
  let line = vtuberize(first);
  const hmm = rand() < 0.3 ? 'Hmm… ' : '';                            // 가끔 생각하는 소리
  const max = 64 - hmm.length;
  if (line.length > max) {
    const cut = line.slice(0, max - 2), sp = cut.lastIndexOf(' ');    // 낱말 중간에서 자르지 않음
    line = (sp > 30 ? cut.slice(0, sp) : cut).replace(/[\s,;:]+$/, '') + '…';
  }
  if ((line.match(/"/g) || []).length % 2) line = line.slice(0, line.lastIndexOf('"')).replace(/[\s,;:]+$/, '') + '…';
  return hmm + line;
}

// 추론 블록 → 문단 첫 줄들 (요약 추론은 한 블록에 여러 문단이 올 수 있음)
const thoughtParagraphs = (text) =>
  String(text || '').split(/\n\s*\n/).map((p) => p.trim().split('\n')[0]).filter(Boolean);

// 최종 답변 → 말풍선용 한 줄 (마크다운·코드 제거, 첫 문장)
function answerLine(text, max = 70) {
  const t = String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/^\s*#+ .*$/gm, ' ').replace(/[*_`#>|]+/g, '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const first = (t.match(/^.{4,}?[.!?。…](\s|$)/) || [t])[0].trim();
  return first.length > max ? first.slice(0, max - 1).trim() + '…' : first;
}

module.exports = { TEXT, TOOLS, toolLine, askLine, thoughtLine, thoughtParagraphs, answerLine, vtuberize };
