// Codex 협업(-c 덮어쓰기)·세션 요청 머리말. electron 의존 없음(단위 테스트용).
const path = require('path');

// 다른 세션이 보낸 요청 앞에 붙는 머리말. 받는 쪽 턴 끝 알림이 이 요청의 턴인지 가를 때도 쓴다.
const CALL_MARK = '[세션 "';
const callPrefix = (name) => `${CALL_MARK}${name}" 에서 온 요청]`;
// Codex 턴 끝 알림이 세션 요청으로 시작된 턴인지. input-messages 가 없는 버전은 가를 수 없어 지금처럼 받는다.
const isCallTurn = (msgs) => !Array.isArray(msgs) || msgs.some((m) => String(m).includes(CALL_MARK));

// 값은 TOML 리터럴 문자열('...')로 쓴다 — Windows PowerShell 5.1 은 네이티브 명령 인자의 " 를 이스케이프하지 않아 깨진다.
// 리터럴 문자열엔 ' 를 넣을 수 없어, ' 가 든 값은 codexArgs 가 협업을 통째로 뺀다.
const tomlStr = (s) => `'${s}'`;
const tomlArr = (a) => `[${a.map(tomlStr).join(',')}]`;

// curl -K 설정 파일 내용. 토큰이 든 URL 을 명령줄(argv, 다른 계정이 ps 로 봄) 대신 여기로 넘긴다.
// 프록시 설정(http_proxy)을 따르면 127.0.0.1 요청이 밖으로 샌다.
const curlConfig = (url) => `url = "${url}"\nnoproxy = "*"\nsilent\nmax-time = 5\n`;

// Codex 는 설정 파일 대신 -c 로 같은 MCP 와 턴 끝 알림(notify)을 붙인다. 사용자 ~/.codex/config.toml 은 건드리지 않는다.
// exe = 앱 실행 파일, script = mcp-sessions.js, conn = 포트·토큰·노드 파일, curl = curlConfig 파일. q = 셸 인용.
// 경로에 ' 가 있으면 '' 를 돌려준다 — 협업 없이 그냥 codex 로 띄운다.
function codexArgs({ exe, script, conn, curl }, q) {
  if ([exe, script, conn, curl].some((s) => s.includes("'"))) return '';
  return [
    `mcp_servers.bimo.command=${tomlStr(exe)}`,
    `mcp_servers.bimo.args=${tomlArr([script, conn])}`,
    `mcp_servers.bimo.env={ELECTRON_RUN_AS_NODE=${tomlStr('1')}}`,
    // 어느 값에도 " 를 쓰지 않는다(5.1 이 " 와 공백이 섞인 인자를 잘못 감싼다). Codex 가 턴 끝 JSON 을 마지막 인자로 붙여 -d 로 간다.
    // shortcut: 답 전문이 curl argv 로 간다 — Windows 명령줄 32767자 한계, ANSI argv 로 한글이 깨질 수 있다. 긴 답·한글이 문제되면 rollout JSONL 에서 읽는다.
    `notify=${tomlArr(['curl', '-K', curl, '-d'])}`,
  ].map((c) => `-c ${q(c)}`).join(' ');
}

// --- 세션 id 기억 (다음 실행 때 codex resume <id>) ---
// id 는 PowerShell 명령에 들어가므로 pty:spawn 의 resumeId 검사와 같은 형식만 받는다.
const SID = /^[\w-]{8,80}$/;
const goodSid = (v) => typeof v === 'string' && SID.test(v);
// notify 의 agent-turn-complete JSON 에서 세션 id. 없거나 형식이 틀리면 null (rollout 으로 대체).
const threadId = (event) => (goodSid(event?.['thread-id']) ? event['thread-id'] : null);

// 다른 노드가 이미 가진(알렸거나 이어 연) id. nodes = Map(노드 id -> { sid }). 두 카드가 같은 대화를 resume 하면 기록이 섞인다.
const takenSids = (nodes, self) => new Set([...nodes].filter(([k, v]) => k !== self && v?.sid).map(([, v]) => v.sid));

// rollout 파일 앞부분 → 첫 줄 session_meta 의 { id, cwd }. 첫 줄이 잘렸으면(긴 instructions) 앞쪽 키만 정규식으로 꺼낸다.
function rolloutMeta(text) {
  const line = String(text).split('\n')[0];
  try {
    const j = JSON.parse(line);
    const pl = j.payload ?? j;
    return { id: pl.id ?? null, cwd: pl.cwd ?? '' };
  } catch {
    const get = (k) => { try { return JSON.parse(line.match(new RegExp(`"${k}":("(?:[^"\\\\]|\\\\.)*")`))?.[1] ?? 'null'); } catch { return null; } };
    return { id: get('id'), cwd: get('cwd') ?? '' };
  }
}

// 대체 경로: 그 노드 cwd 와 같고 spawn 이후 수정된 rollout, 다른 노드가 이미 받은 id 는 뺀다.
// 후보가 둘 이상이면 null — 같은 폴더의 다른 codex(앱 밖 터미널 등) 대화를 고를 수 있어서. 모호하면 저장하지 않는다.
// cands = [{ id, cwd, at(mtimeMs) }], taken = Set. Windows 는 경로 대소문자·끝 구분자를 무시한다.
function pickRollout(cands, { cwd, since, taken }, win = process.platform === 'win32') {
  // 실행 OS 의 path 가 아니라 win 기준으로 고른다 — Mac CI 에서 win=true 테스트가 Windows 경로를 풀 수 있게.
  const key = (p) => { const r = (win ? path.win32 : path.posix).resolve(p); return win ? r.toLowerCase() : r; };
  if (!cwd) return null;
  const want = key(cwd);
  const ok = cands.filter((c) => goodSid(c.id) && c.at >= since && c.cwd && key(c.cwd) === want && !taken.has(c.id));
  return ok.length === 1 ? ok[0].id : null;
}

module.exports = { CALL_MARK, callPrefix, isCallTurn, tomlStr, tomlArr, curlConfig, codexArgs, threadId, takenSids, rolloutMeta, pickRollout };
