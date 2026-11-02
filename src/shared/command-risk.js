// 셸 명령이 "읽기만 하는지" / "위험한지" 가늠한다. 완벽한 분석이 아니라 보수적인 걸러내기:
// 확실히 읽기만 하는 명령만 자동 허락하고, 조금이라도 애매하면 사용자에게 묻는다.

// 그 자체로 읽기만 하는 명령
const READ_ONLY = new Set([
  'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'echo', 'printf', 'which', 'whoami', 'id', 'date', 'uname', 'hostname',
  'grep', 'egrep', 'fgrep', 'rg', 'stat', 'file', 'du', 'df', 'tree', 'basename', 'dirname', 'realpath', 'readlink',
  'sort', 'uniq', 'cut', 'tr', 'column', 'less', 'more', 'diff', 'cmp', 'md5', 'md5sum', 'shasum', 'sha256sum',
  'env', 'printenv', 'true', 'false', 'test', '[', 'type', 'command', 'sw_vers', 'uptime', 'cal', 'jq', 'nl'
]);
// 하위 명령에 따라 읽기만 하는 도구
const READ_SUB = {
  git: ['status', 'log', 'diff', 'show', 'branch', 'remote', 'ls-remote', 'ls-files', 'rev-parse', 'describe', 'tag', 'blame', 'shortlog', 'reflog', 'config --get', 'config --list', 'config -l', 'fetch --dry-run'],
  npm: ['ls', 'list', 'view', 'info', 'outdated', 'config get', 'whoami', 'prefix', 'root', 'bin', '-v', '--version'],
  pnpm: ['ls', 'list', '-v', '--version'],
  yarn: ['list', 'info', '-v', '--version'],
  node: ['-v', '--version'],
  python: ['--version', '-V'], python3: ['--version', '-V'],
  wrangler: ['whoami', '--version', '-v'],
  gh: ['auth status', 'repo view', 'pr list', 'pr view', 'issue list', 'issue view', '--version'],
  brew: ['list', 'info', '--version', 'config'],
  docker: ['ps', 'images', '--version', 'version'],
  find: ['']   // find 는 아래에서 -exec/-delete 등을 따로 막는다
};
// 앞에 붙어도 되는 감싸기 (환경 변수 지정·timeout·npx --no-install 등)
const WRAPPERS = /^(?:(?:[A-Z_][A-Z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)|(?:timeout\s+\d+[smh]?\s+)|(?:npx\s+--no-install\s+)|(?:command\s+)|(?:\S*\/(?=\S)))*/;

// 위험 신호: 지우기·덮어쓰기·올리기·권한·원격 스크립트 실행 등
const DANGER = [
  [/\brm\b|\brmdir\b|\bunlink\b|\bshred\b/, '파일을 지워요'],
  [/\bsudo\b|\bsu\b\s/, '관리자 권한을 써요'],
  [/\bgit\s+(push|reset\s+--hard|clean|checkout\s+--|rebase|filter-branch)\b|\bgit\b[^|;&]*\s(--force|-f)\b/, '되돌리기 어려운 git 작업이에요'],
  [/\s~?\/?\.ssh\b|\.aws\/|\.env\b|keychain|security\s+find/, '비밀번호·키 같은 민감한 파일이에요'],
  [/\b(deploy|publish)\b|wrangler\s+(deploy|publish|delete)|npm\s+publish/, '인터넷에 올리거나 배포해요'],
  [/(curl|wget)[^|]*\|\s*(sh|bash|zsh|python|node)\b/, '인터넷에서 받은 스크립트를 바로 실행해요'],
  [/\bchmod\b|\bchown\b/, '파일 권한을 바꿔요'],
  [/\bkill(all)?\b|\bpkill\b|\bshutdown\b|\breboot\b/, '프로그램이나 컴퓨터를 꺼요'],
  [/\bdd\b|\bmkfs\b|\bdiskutil\s+(erase|partition)/, '디스크를 직접 건드려요'],
  [/\bdrop\s+(table|database)\b|\btruncate\b/i, '데이터를 지워요'],
  [/\/etc\/|\/Library\/|\/System\//, '시스템 파일을 건드릴 수 있어요']
];

function splitSegments(cmd) {
  // 괄호·부분 셸을 걷어내고 && || ; | 로 나눔 (따옴표 안은 대충 무시)
  return cmd.replace(/[()]/g, ' ').split(/&&|\|\||;|\||\n/).map((s) => s.trim()).filter(Boolean);
}

function segmentReadOnly(seg) {
  const s = seg.replace(WRAPPERS, '').trim();
  const [cmd, ...rest] = s.split(/\s+/);
  const args = rest.join(' ');
  if (!cmd) return true;
  if (cmd === 'find') return !/-(exec|execdir|delete|ok|fprint|fls)\b/.test(args);
  if (cmd === 'sed') return !/(^|\s)-i/.test(args);   // sed -i 는 파일 수정
  if (READ_ONLY.has(cmd)) return true;
  const subs = READ_SUB[cmd];
  if (!subs) return false;
  return subs.some((sub) => args === sub || args.startsWith(sub + ' ') || (sub && args.startsWith(sub)));
}

// 파일에 쓰는 리다이렉트(> 파일, >> 파일). 2>&1, >/dev/null 은 괜찮음
const writesFile = (cmd) => /(^|[^0-9&])>{1,2}\s*(?!&|\/dev\/null)\S/.test(cmd.replace(/\d?>\s*\/dev\/null/g, '').replace(/2>&1/g, ''));

function classifyCommand(command) {
  const cmd = String(command || '');
  const dangers = DANGER.filter(([re]) => re.test(cmd)).map(([, why]) => why);
  const readOnly = !dangers.length && !writesFile(cmd) && !/`|\$\(/.test(cmd) && splitSegments(cmd).every(segmentReadOnly);
  return { readOnly, dangers: [...new Set(dangers)] };
}

module.exports = { classifyCommand };
