const { app, BrowserWindow, ipcMain, Notification, clipboard, dialog, shell } = require('electron');
const http = require('http');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('@lydell/node-pty');

// --smoke: 기본 보드로 띄워 스크린샷(%TEMP%\bimo-smoke.png)만 찍고 종료. 저장된 보드는 건드리지 않는다.
// SMOKE_CMD = 스모크 노드에 입력할 명령, SMOKE_MS = 스크린샷까지 대기(ms), SMOKE_JS = 캡처 직전 렌더러에서 실행할 스크립트.
const smoke = process.argv.includes('--smoke');
// 테스트용: BIMO_USER_DATA = 따로 쓸 데이터 폴더, SMOKE_SAVE = 스모크에서도 보드 저장(재실행 유지 확인)
if (process.env.BIMO_USER_DATA) app.setPath('userData', process.env.BIMO_USER_DATA);
const keepBoard = !smoke || !!process.env.SMOKE_SAVE;

const boardFile = path.join(app.getPath('userData'), 'board.json');
const hookDir = path.join(app.getPath('userData'), 'hooks');
const ptys = new Map();
let win;
let hookPort;

// 창이 닫힌 뒤에도 pty 출력·훅이 늦게 도착한다 — 파괴된 창에 보내면 메인 프로세스 예외가 난다.
const send = (...args) => win && !win.isDestroyed() && win.webContents.send(...args);

// 사용자가 중지한 서브 에이전트. 밖에서 서브 에이전트만 죽일 방법이 없어 다음 도구 호출부터 거부해 스스로 끝내게 한다.
const stopped = new Set();
const agentKey = (id) => String(id).replace(/^agent-/, '');
const STOP_REPLY = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: '사용자가 Bimo 에서 이 서브 에이전트를 중지했습니다. 도구를 더 쓰지 말고, 지금까지 한 일을 한두 문장으로 보고한 뒤 바로 끝내세요.',
  },
});

// --- 세션끼리 호출 (MCP 서버 mcp-sessions.js 가 /mcp/<호출한 노드>/... 로 부른다) ---
// 보드의 세션 목록과 사용자가 케이블로 이은 연결은 렌더러가 알려준다. 연결된 세션끼리만 호출할 수 있다.
let roster = []; // { id, name, agent, command, folder, state }
let links = []; // { a, b } 노드 id, 방향 없음
const waits = new Map(); // 받는 노드 id -> { callId, resolve, timer }
let callSeq = 0;
ipcMain.on('roster:set', (e, r, l) => { roster = r; links = l; });

const linked = (a, b) => links.some((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a));
const STATE_KO = { working: '일하는 중', waiting: '사용자를 기다리는 중', idle: '대기 중', exited: '종료됨' };

function mcpRoute(caller, route, body) {
  const me = roster.find((s) => s.id === caller);
  if (!me) return Promise.resolve({ error: '이 세션을 보드에서 찾지 못했습니다.' });
  if (route === 'sessions') {
    return Promise.resolve({
      sessions: roster.filter((s) => s.id !== caller && linked(caller, s.id))
        .map((s) => ({ name: s.name, agent: s.agent, folder: s.folder, state: STATE_KO[s.state] ?? '알 수 없음' })),
    });
  }
  if (route !== 'send') return Promise.resolve({ error: `알 수 없는 요청: ${route}` });
  const target = roster.find((s) => s.name === body.session && s.id !== caller);
  if (!target) return Promise.resolve({ error: `"${body.session}" 세션이 없습니다. list_sessions 로 이름을 확인하세요.` });
  if (!linked(caller, target.id)) return Promise.resolve({ error: `"${target.name}" 세션과 연결돼 있지 않습니다. 사용자가 보드에서 케이블로 이어야 합니다.` });
  if (!ptys.has(target.id) || target.state === 'exited') return Promise.resolve({ error: `"${target.name}" 세션이 종료돼 있습니다.` });
  if (target.state === 'working' || waits.has(target.id)) return Promise.resolve({ error: `"${target.name}" 세션이 일하는 중이라 지금은 보낼 수 없습니다. 잠시 뒤 다시 시도하세요.` });

  const callId = ++callSeq;
  const wait = body.wait !== false && target.command === 'claude'; // 답은 claude 의 Stop 훅으로만 알 수 있다
  // 붙여넣기(bracketed paste)로 보내야 여러 줄이 중간에 실행되지 않는다. Enter 는 따로 보낸다.
  const p = ptys.get(target.id);
  p.write(`\x1b[200~[세션 "${me.name}" 에서 온 요청] ${String(body.message)}\x1b[201~`);
  setTimeout(() => p.write('\r'), 120);
  send('call:start', { callId, from: caller, to: target.id, wait });
  if (!wait) {
    setTimeout(() => send('call:end', callId), 1500);
    return Promise.resolve({ result: `"${target.name}" 세션에 보냈습니다. 답은 기다리지 않습니다.` });
  }
  const timeoutMs = Math.min(Math.max(Number(body.timeout) || 600, 10), 3600) * 1000;
  return new Promise((resolve) => {
    const done = (r) => {
      clearTimeout(timer);
      waits.delete(target.id);
      send('call:end', callId);
      resolve(r);
    };
    const timer = setTimeout(() => done({ result: `${timeoutMs / 1000}초 동안 "${target.name}" 세션의 답이 끝나지 않았습니다. 그 세션은 계속 작업 중일 수 있습니다.` }), timeoutMs);
    waits.set(target.id, { callId, done, name: target.name });
  });
}

// 받는 세션의 응답이 끝나면(Stop) 기다리던 호출에 답을 돌려준다. transcript 기록이 늦을 수 있어 잠시 뒤에 읽는다.
function resolveWait(id, event) {
  const w = waits.get(id);
  if (!w) return;
  setTimeout(() => {
    const text = event.last_assistant_message || lastReply(event.transcript_path) || '(빈 응답)';
    w.done({ reply: `"${w.name}" 세션의 답:\n${text}` });
  }, event.last_assistant_message ? 0 : 1000);
}

// Claude Code http 훅 수신 — URL 의 노드 id 로 어느 노드의 이벤트인지 가른다.
// 같은 PC 의 다른 프로그램·웹페이지가 세션에 끼어들지 못하게, 실행마다 새로 만든 토큰이 URL 에 있어야 받는다.
const hookToken = require('crypto').randomBytes(16).toString('hex');
const HOOK_MAX_BODY = 8 * 1024 * 1024;
const hookServer = http.createServer((req, res) => {
  const [, kind, token, rawId, route] = req.url.split('/');
  if (token !== hookToken || req.headers.host !== `127.0.0.1:${hookPort}`) return res.writeHead(403).end();
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > HOOK_MAX_BODY) req.destroy();
  });
  req.on('end', () => {
    const id = decodeURIComponent(rawId || '');
    if (kind === 'mcp') {
      let parsed = {};
      try { parsed = body ? JSON.parse(body) : {}; } catch {}
      mcpRoute(id, route, parsed).then((r) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(r)));
      return;
    }
    let reply = '{}';
    try {
      const event = JSON.parse(body);
      if (event.hook_event_name === 'Stop' && !event.agent_id) resolveWait(id, event);
      if (event.hook_event_name === 'SubagentStop' && !event.last_assistant_message) event.last_assistant_message = lastReply(event.agent_transcript_path);
      // 최종 보고(SubagentHandback)는 막지 않는다 — 막으면 끝내지도 못한다.
      if (event.hook_event_name === 'PreToolUse' && event.agent_id && stopped.has(agentKey(event.agent_id)) && event.tool_name !== 'SubagentHandback') reply = STOP_REPLY;
      // Stop 이 transcript 기록보다 먼저 올 수 있어 잠시 뒤에 토큰을 센다. 이어한 세션은 시작할 때도 센다.
      if (event.hook_event_name === 'Stop' || event.hook_event_name === 'SessionStart') {
        setTimeout(() => send('agent:event', id, { hook_event_name: 'Usage', usage: sessionUsage(event.transcript_path) }), 1500);
      }
      if (event.hook_event_name === 'Stop' || event.hook_event_name === 'Notification') notifyWaiting(id, event);
      send('agent:event', id, event);
    } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(reply);
  });
});

ipcMain.on('agent:stop', (e, agentId) => stopped.add(agentKey(agentId)));

// 세션 누적 토큰. 같은 응답이 스트리밍으로 여러 줄 기록되므로 message.id 별 마지막 값만 더한다.
function sessionUsage(file) {
  if (!file || !fs.existsSync(file)) return undefined;
  const byId = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    try {
      const { type, message } = JSON.parse(line);
      if (type === 'assistant' && message?.usage) byId.set(message.id, message.usage);
    } catch {}
  }
  const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const u of byId.values()) {
    sum.input += u.input_tokens || 0;
    sum.output += u.output_tokens || 0;
    sum.cacheRead += u.cache_read_input_tokens || 0;
    sum.cacheWrite += u.cache_creation_input_tokens || 0;
  }
  return sum;
}

// 앱을 보고 있지 않을 때 답이 오거나 권한을 물으면 Windows 알림. 누르면 그 노드로 간다.
function notifyWaiting(id, event) {
  if (!win || win.isDestroyed() || win.isFocused() || !Notification.isSupported()) return;
  const where = path.basename(event.cwd || '') || '세션';
  const body = event.hook_event_name === 'Stop' ? '응답이 끝났습니다. 확인해 주세요.' : event.message || '확인이 필요합니다.';
  const toast = new Notification({ title: `${where}: Claude Code`, body });
  toast.on('click', () => {
    if (win.isMinimized()) win.restore();
    win.focus();
    send('node:focus', id);
  });
  toast.show();
}

// 서브 에이전트 transcript(JSONL)를 대화 목록으로 줄인다. Claude 프로젝트 폴더 밖 파일은 읽지 않는다.
const claudeProjects = path.join(os.homedir(), '.claude', 'projects');
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
ipcMain.handle('agent:transcript', (e, file) => {
  const full = path.resolve(String(file));
  if (!full.toLowerCase().startsWith(claudeProjects.toLowerCase() + path.sep) || !fs.existsSync(full)) return null;
  const out = [];
  const handbacks = new Set(); // 최종 보고 도구의 결과({"success":true…})는 대화에서 뺀다
  for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const content = entry.message?.content;
    if (entry.type === 'user' && !entry.isMeta) {
      if (typeof content === 'string') out.push({ role: 'user', text: content });
      else for (const c of content || []) {
        if (c.type === 'text' && !c.text.startsWith('<system-reminder>')) out.push({ role: 'user', text: c.text });
        if (c.type === 'tool_result' && !handbacks.has(c.tool_use_id)) {
          const text = typeof c.content === 'string' ? c.content : (c.content || []).map((x) => x.text || '').join('\n');
          out.push({ role: 'result', text: clip(text, 6000), error: !!c.is_error });
        }
      }
    } else if (entry.type === 'assistant') {
      for (const c of content || []) {
        if (c.type === 'text' && c.text.trim()) out.push({ role: 'assistant', text: c.text });
        if (c.type === 'tool_use' && c.name === 'SubagentHandback') {
          handbacks.add(c.id);
          out.push({ role: 'assistant', text: c.input?.message || '' });
        }
        else if (c.type === 'tool_use') out.push({ role: 'tool', name: c.name, text: clip(JSON.stringify(c.input), 3000) });
      }
    }
  }
  return out.slice(-300);
});

// SubagentStop 에 last_assistant_message 가 안 오는 버전이 있어 서브 에이전트 transcript(JSONL)의 마지막 답변을 읽는다.
// 최종 보고는 텍스트 블록이거나 SubagentHandback 도구의 message 로 온다.
function lastReply(file) {
  if (!file || !fs.existsSync(file)) return undefined;
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const { type, message } = JSON.parse(lines[i]);
      const text = type === 'assistant' && (message?.content || [])
        .map((c) => (c.type === 'text' ? c.text : c.type === 'tool_use' && c.name === 'SubagentHandback' ? c.input?.message : ''))
        .filter(Boolean)
        .join('\n');
      if (text) return text;
    } catch {}
  }
  return undefined;
}

// 세션 호출 MCP 서버 설정. 스크립트는 asar 밖(userData)에 복사해 두고, 앱 실행 파일을 node 로 띄운다(별도 node 설치 불필요).
function mcpConfig(id) {
  const script = path.join(app.getPath('userData'), 'mcp-sessions.js');
  fs.copyFileSync(path.join(__dirname, 'mcp-sessions.js'), script);
  const file = path.join(hookDir, `${id}.mcp.json`);
  fs.writeFileSync(file, JSON.stringify({
    mcpServers: {
      bimo: {
        type: 'stdio',
        command: process.execPath,
        args: [script],
        env: { ELECTRON_RUN_AS_NODE: '1', BIMO_PORT: String(hookPort), BIMO_TOKEN: hookToken, BIMO_NODE: id },
      },
    },
  }));
  return file;
}

// 노드별 훅 설정 파일. claude 는 --settings 로 이 파일만 추가로 읽고, 사용자 전역 설정은 건드리지 않는다.
function hookSettings(id) {
  const hook = [{ type: 'http', url: `http://127.0.0.1:${hookPort}/hook/${hookToken}/${encodeURIComponent(id)}`, timeout: 3 }];
  const file = path.join(hookDir, `${id}.json`);
  fs.mkdirSync(hookDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    permissions: { allow: ['mcp__bimo'] }, // 세션 호출 도구는 매번 묻지 않는다
    hooks: {
      PreToolUse: [{ matcher: '*', hooks: hook }],
      PostToolUse: [{ matcher: 'Agent', hooks: hook }],
      PostToolUseFailure: [{ matcher: 'Agent', hooks: hook }],
      SubagentStart: [{ hooks: hook }],
      SubagentStop: [{ hooks: hook }],
      // 세션 상태 테두리(일하는 중 / 나를 기다림 / 대기)와 세션 이어하기용
      SessionStart: [{ hooks: hook }],
      UserPromptSubmit: [{ hooks: hook }],
      Stop: [{ hooks: hook }],
      Notification: [{ matcher: 'permission_prompt|elicitation_dialog|agent_needs_input', hooks: hook }],
    },
  }));
  return file;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#111111',
    icon: path.join(__dirname, 'build', 'icon.png'), // 개발 모드 작업 표시줄용. exe 는 패키징 때 icon.ico 가 들어간다
    // Windows 기본 창 틀 대신 앱 툴바가 제목 표시줄. 최소화·최대화·닫기는 Windows 버튼을 툴바 색으로 겹쳐 띄운다.
    // Mac 은 신호등 버튼을 툴바 안 왼쪽에 둔다.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' }
      : { titleBarStyle: 'hidden', titleBarOverlay: { color: '#1b1d23', symbolColor: '#e6e8ec', height: 52 } }),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true },
  });
  // 창은 index.html 하나만 띄운다. 마크다운 안의 폼·링크 등으로 다른 페이지로 넘어가면 그 페이지가 preload API(터미널 실행)를 얻게 된다.
  // http(s) 새 창 요청은 기본 브라우저로 넘기고, 나머지는 전부 막는다.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('will-redirect', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) require('electron').shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
  win.loadFile('index.html', { query: smoke ? { smoke: process.env.SMOKE_CMD || 'echo smoke-ok' } : {} });
  if (smoke) {
    // 테스트: X 버튼과 같은 경로로 닫기를 걸어 확인 창이 뜨는지 본다
    if (process.env.SMOKE_CLOSE_AT) setTimeout(() => win.close(), Number(process.env.SMOKE_CLOSE_AT));
    setTimeout(async () => {
      const js = process.env.SMOKE_JS_FILE ? fs.readFileSync(process.env.SMOKE_JS_FILE, 'utf8') : process.env.SMOKE_JS;
      if (js) {
        try {
          console.log('SMOKE_JS:', JSON.stringify(await win.webContents.executeJavaScript(js)));
          console.log('SMOKE_CLIP:', JSON.stringify(clipboard.readText()));
        } catch (err) {
          console.error('SMOKE_JS 실패:', err.message);
        }
      }
      // 창이 가려지거나 숨겨지면 capturePage 가 끝나지 않을 때가 있어 5초 제한
      const img = await Promise.race([win.webContents.capturePage(), new Promise((r) => setTimeout(r, 5000))]).catch(() => null);
      if (img) fs.writeFileSync(path.join(os.tmpdir(), 'bimo-smoke.png'), img.toPNG());
      else console.error('스크린샷 실패');
      closeConfirmed = true;
      win.close();
    }, Number(process.env.SMOKE_MS) || 6000);
  }
  // X(또는 Cmd+Q)로 닫을 때 앱 안의 확인 창으로 묻는다. 세션 터미널이 전부 꺼지기 때문.
  // 화면이 죽어 답을 못 하면 그냥 닫는다(못 닫는 창이 되지 않게).
  win.on('close', (e) => {
    if (closeConfirmed || win.webContents.isCrashed?.()) return;
    e.preventDefault();
    send('app:confirm-close', ptys.size);
  });
}
let closeConfirmed = false;
ipcMain.on('app:close', () => {
  closeConfirmed = true;
  win?.close();
});

// 앱을 claude 안에서 띄우면 부모 세션 표식이 따라와 자식 claude 가 transcript 를 안 남긴다(이어하기 불가). 세션 묶음 변수만 뺀다.
const PARENT_SESSION_VARS = ['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SESSION_ATTENDED'];
function childEnv() {
  const env = { ...process.env };
  for (const k of PARENT_SESSION_VARS) delete env[k];
  // 링크(OSC 8)를 받는 터미널이라고 알린다. 없으면 바탕화면에서 켰을 때 Claude 가 파일 링크를 글자로만 찍는다.
  env.FORCE_HYPERLINK = '1';
  return env;
}

// 세션 transcript 가 있으면(한 번이라도 대화했으면) 이어할 수 있다.
function hasTranscript(sessionId) {
  try {
    return fs.readdirSync(claudeProjects).some((dir) => fs.existsSync(path.join(claudeProjects, dir, `${sessionId}.jsonl`)));
  } catch {
    return false;
  }
}

// 에이전트도 PowerShell 안에서 실행한다 — npm .cmd 심(codex, gemini)이 그대로 돌고, 종료 후 셸이 남는다.
// claude 는 세션 id 를 앱이 정해서 띄우고, 다음 실행 때 그 id 로 이어한다.
ipcMain.handle('pty:spawn', (e, { id, command, cwd, cols, rows, sessionId }) => {
  if (!/^[\w-]{1,80}$/.test(id)) return '실행 실패: 잘못된 세션 id';
  const dir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  const settings = hookSettings(id);
  if (command === 'claude') {
    const sid = /^[0-9a-f-]{36}$/i.test(sessionId || '') ? sessionId : null; // PowerShell 명령에 들어가므로 형식 검사
    const session = sid ? (hasTranscript(sid) ? `--resume ${sid}` : `--session-id ${sid}`) : '';
    // 경로에 ' 가 있어도(사용자 폴더 이름 등) 명령이 깨지지 않게 셸에 맞춰 감싼다
    const q = (s) => (isWin ? `'${s.replace(/'/g, "''")}'` : `'${s.replace(/'/g, "'\\''")}'`);
    command = `claude ${session} --settings ${q(settings)} --mcp-config ${q(mcpConfig(id))}`;
  } else if (/^[\w-]{8,80}$/.test(sessionId || '')) {
    // 가져온 Codex·Cursor 대화 이어 열기 (PowerShell 명령에 들어가므로 형식 검사)
    if (command === 'codex') command = `codex resume ${sessionId}`;
    else if (command === 'cursor-agent') command = `cursor-agent --resume ${sessionId}`;
  }
  // Mac·리눅스: 로그인 셸에서 실행하고, 끝나면 같은 셸이 남게 exec 로 이어 준다
  const [shell, args] = isWin
    ? ['powershell.exe', ['-NoLogo', ...(command ? ['-NoExit', '-Command', command] : [])]]
    : [userShell, command ? ['-ilc', `${command}; exec ${userShell} -il`] : ['-il']];
  try {
    // Windows 10 기본 ConPTY 는 화면을 다시 그리는 앱(claude 입력창 등)에서 잔상이 남는다.
    // node-pty 에 같이 들어 있는 최신 conpty.dll/OpenConsole.exe 를 쓴다(VS Code·오르카와 같은 방식).
    // BIMO_INBOX_CONPTY=1 은 비교 테스트용으로 기본 ConPTY 를 강제한다.
    const useConptyDll = !process.env.BIMO_INBOX_CONPTY;
    const p = pty.spawn(shell, args, { name: 'xterm-256color', cwd: dir, cols, rows, env: childEnv(), ...(isWin && { useConptyDll }) });
    p.onData((data) => send('pty:data', id, data));
    p.onExit(({ exitCode }) => {
      ptys.delete(id);
      waits.get(id)?.done({ error: '받는 세션이 종료돼 답을 받지 못했습니다.' });
      send('pty:exit', id, exitCode);
    });
    ptys.set(id, p);
    return cwd && dir !== cwd ? `작업 폴더 없음, 홈에서 시작: ${cwd}` : null;
  } catch (err) {
    return `실행 실패: ${err.message}`;
  }
});
// xterm windowsPty.buildNumber: 번들 ConPTY 는 최신이라 OS 빌드(Win10=19045)가 아니라 최신 빌드로 알려야
// xterm 이 옛 ConPTY 용 줄바꿈 추정을 끄고 ConPTY 와 같은 방식으로 줄을 다시 감는다(아니면 좁힐 때 글자가 빠진다).
ipcMain.handle('sys:info', () => ({ build: process.env.BIMO_INBOX_CONPTY ? Number(os.release().split('.')[2]) || 0 : 22621 }));

// 설치된 AI CLI 찾기. 앱이 켜진 뒤 설치하면 PATH 가 예전 값이라, 레지스트리에서 최신 PATH 를 다시 읽어 합친다
// (새로 여는 터미널도 이 PATH 를 물려받아 새 CLI 를 바로 쓸 수 있다).
const AGENT_CLIS = ['claude', 'codex', 'gemini', 'qwen', 'opencode', 'aider', 'cursor-agent', 'copilot', 'amp'];
const regPath = (key) => new Promise((resolve) => {
  execFile('reg', ['query', key, '/v', 'Path'], { windowsHide: true }, (err, out) => resolve(err ? '' : (out.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i)?.[1] ?? '').trim()));
});
const isWin = process.platform === 'win32';
// Mac: Finder 로 띄운 앱은 PATH 가 /usr/bin 정도뿐이라(brew·npm 전역 없음) 로그인 셸의 PATH 를 받아 온다.
const userShell = process.env.SHELL || '/bin/zsh';
async function refreshPath() {
  if (!isWin) {
    const shellPath = await new Promise((resolve) => execFile(userShell, ['-ilc', 'printf %s "$PATH"'], { timeout: 5000 }, (err, out) => resolve(err ? '' : out.trim().split('\n').pop())));
    process.env.PATH = [...new Set([...shellPath.split(':'), ...(process.env.PATH || '').split(':'), '/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin')].filter(Boolean))].join(':');
    return;
  }
  const [sys, user] = await Promise.all([regPath('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'), regPath('HKCU\\Environment')]);
  const expand = (s) => s.replace(/%([^%]+)%/g, (m, v) => process.env[v] ?? m);
  const parts = [...(process.env.Path || '').split(';'), ...expand(sys).split(';'), ...expand(user).split(';')].filter(Boolean);
  process.env.Path = [...new Set(parts)].join(';');
}
// --- AI 별 남은 사용량 (헤더 AI 버튼 호버 박스) ---
// Claude: Claude Code 로그인 토큰으로 api.anthropic.com/api/oauth/usage (비공개 API라 바뀔 수 있다).
//   토큰이 만료돼도 앱이 갱신하지 않는다 — 자격 증명 파일을 덮어쓰다 claude 로그인을 망가뜨릴 수 있어서.
// Codex: 사용할 때마다 ~/.codex/sessions 기록에 남기는 rate_limits 의 마지막 값.
const usageCache = new Map(); // agent -> { at, result }
const BUCKETS = [['five_hour', '5시간'], ['seven_day', '주간'], ['seven_day_opus', '주간 Opus'], ['seven_day_sonnet', '주간 Sonnet']];

// Mac 의 Claude Code 는 로그인 정보를 파일이 아니라 키체인("Claude Code-credentials")에 둔다
const readClaudeCred = () => isWin || fs.existsSync(path.join(os.homedir(), '.claude', '.credentials.json'))
  ? Promise.resolve(fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8'))
  : new Promise((resolve, reject) => execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout: 5000 }, (err, out) => (err ? reject(err) : resolve(out))));

async function claudeUsage() {
  let cred;
  try {
    cred = JSON.parse(await readClaudeCred()).claudeAiOauth;
  } catch {
    return Promise.resolve({ error: 'Claude Code 로그인 정보를 찾지 못했습니다. claude 를 실행해 로그인하세요.' });
  }
  if (!cred?.accessToken) return Promise.resolve({ error: 'Claude Code 로그인 정보가 없습니다.' });
  if (cred.expiresAt && cred.expiresAt < Date.now()) return Promise.resolve({ error: '로그인 토큰이 만료됐습니다. claude 를 한 번 실행하면 갱신됩니다.' });
  return new Promise((resolve) => {
    const req = require('https').request({
      hostname: 'api.anthropic.com',
      path: '/api/oauth/usage',
      method: 'GET',
      headers: { Authorization: `Bearer ${cred.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' },
      timeout: 8000,
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode === 429) return resolve({ error: '사용량 조회가 잠시 막혔습니다. 조금 뒤 다시 보세요.' });
        if (res.statusCode !== 200) return resolve({ error: `사용량을 가져오지 못했습니다 (HTTP ${res.statusCode}).` });
        try {
          const j = JSON.parse(body);
          const limits = BUCKETS.filter(([k]) => j[k]?.utilization != null)
            .map(([k, label]) => ({ label, used: j[k].utilization, resetsAt: j[k].resets_at }));
          resolve({ plan: cred.subscriptionType, limits });
        } catch {
          resolve({ error: '사용량 응답을 읽지 못했습니다.' });
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ error: '사용량 서버에 연결하지 못했습니다.' }));
    req.end();
  });
}

// 기록 파일을 최근 것부터 열어, 사용량(rate_limits)이 적힌 마지막 줄을 찾는다.
// 막 연 세션은 아직 사용량 줄이 없거나 null 이라 그 전 파일까지 내려가 본다(최근 30개까지).
// 초기화 시각이 지난 칸은 0% 로 보인다 — 기록은 그때 값에 멈춰 있지만 실제 한도는 이미 비었다.
function codexUsage() {
  const root = path.join(os.homedir(), '.codex', 'sessions');
  const files = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.jsonl')) files.push({ p, m: fs.statSync(p).mtimeMs });
    }
  };
  try { walk(root); } catch {}
  if (!files.length) return { error: 'Codex 사용 기록이 없습니다. codex 를 한 번 쓰면 보입니다.' };
  files.sort((x, y) => y.m - x.m);
  for (const f of files.slice(0, 30)) {
    let lines;
    try { lines = fs.readFileSync(f.p, 'utf8').trim().split('\n'); } catch { continue; }
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('rate_limits')) continue;
      let j;
      try { j = JSON.parse(lines[i]); } catch { continue; }
      const rl = j.payload?.rate_limits ?? j.rate_limits ?? j.msg?.rate_limits;
      if (!rl || (!rl.primary && !rl.secondary)) continue;
      const at = Date.parse(j.timestamp) || f.m; // 이 사용량이 기록된 때
      const one = (bk, label) => {
        if (!bk) return null;
        const reset = bk.resets_at ? bk.resets_at * 1000 : bk.resets_in_seconds != null ? at + bk.resets_in_seconds * 1000 : null;
        const passed = reset != null && reset <= Date.now();
        return {
          label: bk.window_minutes ? (bk.window_minutes >= 1440 ? '주간' : `${Math.round(bk.window_minutes / 60)}시간`) : label,
          used: passed ? 0 : bk.used_percent,
          resetsAt: passed || reset == null ? null : new Date(reset).toISOString(),
        };
      };
      const min = Math.round((Date.now() - at) / 60000);
      const ago = min < 1 ? '방금' : min < 60 ? `${min}분 전` : min < 1440 ? `${Math.round(min / 60)}시간 전` : `${Math.round(min / 1440)}일 전`;
      return { note: `이 PC 에서 마지막으로 codex 를 쓴 때(${ago}) 기준. 다른 곳에서 쓴 양은 빠집니다.`, limits: [one(rl.primary, '5시간'), one(rl.secondary, '주간')].filter(Boolean) };
    }
  }
  return { error: 'Codex 기록에 사용량 정보가 없습니다. codex 에서 한 번 대화하면 보입니다.' };
}

ipcMain.handle('usage:get', async (e, agent) => {
  const hit = usageCache.get(agent);
  // Claude 는 서버에 묻는 거라 1분 안에는 다시 묻지 않는다. Codex 는 이 PC 파일만 읽어 매번 새로 본다.
  if (agent === 'claude' && hit && Date.now() - hit.at < 60000) return hit.result;
  const result = agent === 'claude' ? await claudeUsage()
    : agent === 'codex' ? codexUsage()
    : { error: '이 AI 는 남은 사용량을 알아낼 방법이 없습니다.' };
  usageCache.set(agent, { at: Date.now(), result });
  return result;
});

ipcMain.handle('agents:detect', async () => {
  await refreshPath();
  const found = await Promise.all(AGENT_CLIS.map((name) => new Promise((resolve) => {
    execFile(isWin ? 'where.exe' : 'which', [name], { windowsHide: true, env: process.env }, (err) => resolve(err ? null : name));
  })));
  return found.filter(Boolean);
});

// sandbox preload 에선 clipboard 모듈을 못 쓰므로 메인에서 쓴다
ipcMain.on('clipboard:write', (e, text) => clipboard.writeText(String(text)));
ipcMain.handle('clipboard:read', () => clipboard.readText());
// 붙여넣은 캡처 이미지(PNG 바이트)를 임시 파일로 저장해 경로를 돌려준다.
// (Electron 45 메인 clipboard 엔 이미지 읽기가 없어 화면 쪽 navigator.clipboard 로 읽어 넘겨받는다)
ipcMain.handle('image:save', (e, bytes) => {
  const file = path.join(os.tmpdir(), `bimo-paste-${Date.now()}.png`);
  fs.writeFileSync(file, Buffer.from(bytes));
  return file;
});

// 터미널 글자 속 경로 후보 → 실제로 있는 파일만 전체 경로로. 상대 경로는 세션 폴더 기준.
ipcMain.handle('files:resolve', (e, cwd, cands) => cands.map((p) => {
  try {
    const abs = path.resolve(cwd || os.homedir(), p);
    return fs.statSync(abs).isFile() ? abs : null;
  } catch {
    return null;
  }
}));
// 실행할 작업 폴더를 탐색기(Finder)에서 고르기
ipcMain.handle('dialog:folder', async (e, start) => {
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
    title: '작업 폴더 고르기',
    defaultPath: start && fs.existsSync(start) ? start : os.homedir(),
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.on('pty:write', (e, id, data) => ptys.get(id)?.write(data));
// 키를 하나씩 띄워 보낸다. 몰아 보내면 TUI 가 붙여넣기로 읽는다. 창이 가려져도 느려지지 않게 메인에서 센다.
ipcMain.on('pty:keys', (e, id, keys, gap) => {
  let i = 0;
  const next = () => { if (i < keys.length) { ptys.get(id)?.write(keys[i++]); setTimeout(next, gap); } };
  next();
});
ipcMain.on('pty:resize', (e, id, cols, rows) => ptys.get(id)?.resize(cols, rows));
ipcMain.on('pty:kill', (e, id) => ptys.get(id)?.kill());

// 작업 폴더 후보 = Claude Code 가 쓴 경로(~/.claude.json projects, 최근 실행순) + 그 저장소들의 git 워크트리.
// extra = 사용자가 사이드바에서 직접 추가한 폴더(맨 앞에 둔다)
ipcMain.handle('paths:list', async (e, extra = []) => {
  let projects = {};
  try {
    projects = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')).projects || {};
  } catch {}
  const norm = (p) => path.resolve(p).toLowerCase();
  const added = extra.filter((p) => fs.existsSync(p)).map((p) => ({ path: path.resolve(p), trusted: true, custom: true }));
  const entries = [...added, ...Object.entries(projects)
    .filter(([p]) => fs.existsSync(p) && !added.some((a) => norm(a.path) === norm(p)))
    .sort(([, a], [, b]) => (b.lastStartTime || 0) - (a.lastStartTime || 0))
    .map(([p, v]) => ({ path: path.resolve(p), trusted: !!v.hasTrustDialogAccepted }))];
  const seen = new Map(entries.map((e) => [norm(e.path), e]));
  const lists = await Promise.all(entries.map((e) => new Promise((resolve) => {
    execFile('git', ['-C', e.path, 'worktree', 'list', '--porcelain'], { windowsHide: true }, (err, out) => resolve(err ? '' : out));
  })));
  lists.forEach((out, i) => {
    for (const block of out.split(/\r?\n\r?\n/)) {
      const wt = block.match(/^worktree (.+)$/m)?.[1];
      if (!wt) continue;
      const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? '(detached)';
      const known = seen.get(norm(wt));
      if (known) known.branch ??= branch;
      else seen.set(norm(wt), { path: path.resolve(wt), branch, worktreeOf: entries[i].path });
    }
  });
  const all = [...seen.values()];
  // 사이드바 git 상태: 변경 파일 수, upstream 대비 앞선/뒤처진 커밋 수
  await Promise.all(all.map((f) => git(f.path, ['status', '--porcelain=v2', '--branch']).then((out) => {
    if (out == null) return;
    const ab = out.match(/^# branch\.ab \+(\d+) -(\d+)$/m);
    f.changes = out.split('\n').filter((l) => l && !l.startsWith('#')).length;
    if (ab) [f.ahead, f.behind] = [Number(ab[1]), Number(ab[2])];
  })));
  return all;
});

// --- 세션 가져오기: 다른 곳에서 만든 AI 대화를 보드에서 이어 열기 ---
// Claude: ~/.claude/projects/*/<id>.jsonl / Codex: ~/.codex/sessions/**/rollout-*.jsonl (session_meta 에 id·cwd)
// Cursor: ~/.cursor/chats/<폴더 해시>/<id>/meta.json. 셋 다 공식 형식 문서가 없어 못 읽는 항목은 건너뛴다.
const SESSION_LIMIT = 150; // AI 별 최근 것만
function headLines(file, bytes = 256 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(bytes, fs.fstatSync(fd).size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.toString('utf8').split('\n').slice(0, -1); // 마지막 줄은 잘렸을 수 있다
  } finally {
    fs.closeSync(fd);
  }
}
const parse = (line) => { try { return JSON.parse(line); } catch { return null; } };
// 명령·시스템이 끼워 넣은 메시지(<command-name> 등)는 제목으로 쓰지 않는다
const realPrompt = (t) => typeof t === 'string' && t.trim() && !t.trimStart().startsWith('<') ? t.trim().replace(/\s+/g, ' ').slice(0, 120) : null;
function newestFiles(root, match, depth) {
  const out = [];
  const walk = (dir, d) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory() && d > 0) walk(p, d - 1);
      else if (ent.isFile() && match(ent.name)) {
        try { out.push({ p, at: fs.statSync(p).mtimeMs }); } catch {}
      }
    }
  };
  walk(root, depth);
  return out.sort((a, b) => b.at - a.at).slice(0, SESSION_LIMIT);
}

function claudeSessions() {
  return newestFiles(claudeProjects, (n) => /^[0-9a-f-]{36}\.jsonl$/i.test(n), 1).map(({ p, at }) => {
    let cwd = '', title = null;
    for (const j of headLines(p).map(parse)) {
      if (!j) continue;
      cwd ||= j.cwd || '';
      if (!title && j.type === 'user' && !j.isMeta) {
        const c = j.message?.content;
        title = realPrompt(typeof c === 'string' ? c : Array.isArray(c) ? c.find((x) => x.type === 'text')?.text : null);
      }
      if (cwd && title) break;
    }
    return { agent: 'claude', id: path.basename(p, '.jsonl'), cwd, title, at };
  }).filter((s) => s.title); // 대화가 없는(바로 닫은) 세션은 뺀다
}

function codexSessions() {
  return newestFiles(path.join(os.homedir(), '.codex', 'sessions'), (n) => /^rollout-.*\.jsonl$/.test(n), 3).map(({ p, at }) => {
    let id = null, cwd = '', title = null;
    for (const j of headLines(p).map(parse)) {
      if (!j) continue;
      const pl = j.payload ?? j;
      if (j.type === 'session_meta' || (!id && pl.id && pl.timestamp)) { id ??= pl.id; cwd ||= pl.cwd || ''; }
      if (!title && pl.type === 'user_message') title = realPrompt(pl.message);
      if (!title && pl.type === 'message' && pl.role === 'user') title = realPrompt(pl.content?.find?.((x) => x.type === 'input_text')?.text);
      if (id && title) break;
    }
    id ??= path.basename(p).match(/[0-9a-f]{8}-[0-9a-f-]{27}/i)?.[0];
    return id && { agent: 'codex', id, cwd, title: title || '(첫 메시지 없음)', at };
  }).filter(Boolean);
}

// Cursor CLI 대화: chats/<폴더 해시>/<대화 id>/meta.json 에 title·cwd·updatedAtMs (2026-10 맥 실측).
// projects/*/agent-transcripts 는 Cursor 에디터 대화라 cursor-agent 로 이어 열 수 없어 넣지 않는다.
function cursorSessions() {
  return newestFiles(path.join(os.homedir(), '.cursor', 'chats'), (n) => n === 'meta.json', 2).map(({ p, at }) => {
    const m = parse(fs.readFileSync(p, 'utf8'));
    if (!m || m.hasConversation === false) return null;
    return { agent: 'cursor-agent', id: path.basename(path.dirname(p)), cwd: m.cwd || '', title: realPrompt(m.title) || '(제목 없음)', at: m.updatedAtMs || at };
  }).filter(Boolean);
}

ipcMain.handle('sessions:list', () => {
  const safe = (f) => { try { return f(); } catch { return []; } };
  return [...safe(claudeSessions), ...safe(codexSessions), ...safe(cursorSessions)];
});

// --- 파일 서랍: 폴더 트리(펼칠 때만 읽기), git 상태, 이름 찾기, 읽기 전용 미리보기 ---
const HEAVY_DIRS = new Set(['node_modules', 'build', 'dist', 'out', 'target', 'bin', 'obj', '.gradle', '.idea', '.next', '.venv', 'venv', '__pycache__', 'coverage']);
const gitLines = (cwd, args) => git(cwd, args).then((out) => (out == null ? null : out.split('\0').filter(Boolean)));

ipcMain.handle('files:list', async (e, dir) => {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { return { error: err.message }; }
  ents = ents.filter((d) => d.name !== '.git');
  // .gitignore 에 걸린 것도 보여 주되(흐리게), 의존성·빌드 결과처럼 무거운 폴더만 숨긴다. git 저장소가 아니면 그대로.
  const ignored = new Set(await new Promise((resolve) => {
    const p = execFile('git', ['-C', dir, 'check-ignore', '--stdin', '-z'], { windowsHide: true }, (err, out) => resolve(out ? out.split('\0').filter(Boolean) : []));
    p.stdin.end(ents.map((d) => d.name).join('\0') + '\0');
  }));
  return ents
    .filter((d) => !(ignored.has(d.name) && HEAVY_DIRS.has(d.name)))
    .map((d) => ({ name: d.name, dir: d.isDirectory(), ignored: ignored.has(d.name) }))
    .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
});

// 바뀐 파일: 저장소 기준 상대 경로 -> 상태 글자(M 수정, A 추가, D 삭제, R 이름 바꿈, ? 새 파일)
ipcMain.handle('files:status', async (e, dir) => {
  const top = (await git(dir, ['rev-parse', '--show-toplevel']))?.trim();
  if (!top) return { top: null, changes: {} };
  const lines = await gitLines(top, ['status', '--porcelain=v1', '-z', '--untracked-files=all']) ?? [];
  const changes = {};
  for (let i = 0; i < lines.length; i++) {
    const code = lines[i].slice(0, 2), file = lines[i].slice(3);
    if (code[0] === 'R' || code[0] === 'C') i++; // 이름 바꿈은 다음 칸이 원래 이름
    changes[file] = code === '??' ? '?' : (code.trim()[0] || 'M');
  }
  return { top: path.resolve(top), changes };
});

// 글자를 칠 때마다 git 을 다시 돌리지 않게 폴더별 목록을 잠깐(15초) 기억한다
const searchCache = new Map();
ipcMain.handle('files:search', async (e, dir, q) => {
  q = String(q).toLowerCase();
  const hit = searchCache.get(dir);
  const files = hit && Date.now() - hit.at < 15000 ? hit.files : await searchList(dir);
  searchCache.set(dir, { at: hit?.files === files ? hit.at : Date.now(), files });
  return files.filter((f) => path.basename(f).toLowerCase().includes(q)).slice(0, 200);
});
async function searchList(dir) {
  let files = await gitLines(dir, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  if (files) { // .gitignore 에 걸린 파일(*.md 등)도 찾는다. 무거운 폴더(node_modules·build 등) 안은 뺀다.
    const ign = await gitLines(dir, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard']) ?? [];
    files.push(...ign.filter((f) => !f.split('/').some((p) => HEAVY_DIRS.has(p))));
  }
  if (!files) { // git 이 아니면 얕게 훑는다
    files = [];
    const walk = (d, rel, depth) => {
      if (depth > 6 || files.length > 20000) return;
      let ents = [];
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const x of ents) {
        if (x.name === '.git' || x.name === 'node_modules') continue;
        const r = rel ? `${rel}/${x.name}` : x.name;
        if (x.isDirectory()) walk(path.join(d, x.name), r, depth + 1);
        else files.push(r);
      }
    };
    walk(dir, '', 0);
  }
  return files;
}

ipcMain.handle('files:read', (e, file) => {
  try {
    const st = fs.statSync(file);
    if (st.size > 1024 * 1024) return { error: `파일이 커서(${Math.round(st.size / 1024)}KB) 미리보기를 하지 않습니다.` };
    const buf = fs.readFileSync(file);
    if (buf.subarray(0, 8000).includes(0)) return { error: '글자가 아닌 파일이라 미리보기를 하지 않습니다.' };
    return { text: buf.toString('utf8'), mtime: st.mtimeMs };
  } catch (err) {
    return { error: err.message };
  }
});
// 파일 트리 오른쪽 클릭 메뉴: 만들기·이름 바꾸기·휴지통·탐색기에서 보기. 프로젝트 폴더(root) 안에서만 한다.
const insideRoot = (root, p) => {
  const r = path.relative(path.resolve(root), path.resolve(p));
  return !!r && !r.startsWith('..') && !path.isAbsolute(r);
};
const badName = (name) => !name || /[\\/:*?"<>|]/.test(name) || name === '.' || name === '..' || name !== name.trim();
ipcMain.handle('files:op', async (e, op, root, target, name) => {
  try {
    if (op === 'create') { // target = 만들 폴더(root 자신이거나 그 안)
      if (path.resolve(target) !== path.resolve(root) && !insideRoot(root, target)) return { error: '프로젝트 폴더 밖입니다.' };
      if (badName(name.name)) return { error: '쓸 수 없는 이름입니다.' };
      const dest = path.join(target, name.name);
      if (fs.existsSync(dest)) return { error: '같은 이름이 이미 있습니다.' };
      if (name.isDir) fs.mkdirSync(dest);
      else fs.writeFileSync(dest, '', { flag: 'wx' });
      return { path: dest };
    }
    if (op === 'reveal' && path.resolve(target) === path.resolve(root)) { shell.openPath(root); return { ok: true }; }
    if (!insideRoot(root, target)) return { error: '프로젝트 폴더 밖입니다.' };
    if (op === 'rename') {
      if (badName(name)) return { error: '쓸 수 없는 이름입니다.' };
      const dest = path.join(path.dirname(target), name);
      // Windows 는 대소문자만 바꾸는 이름도 "이미 있음" 으로 보이니 같은 파일이면 허용
      if (fs.existsSync(dest) && dest.toLowerCase() !== target.toLowerCase()) return { error: '같은 이름이 이미 있습니다.' };
      fs.renameSync(target, dest);
      return { path: dest };
    }
    if (op === 'trash') { await shell.trashItem(target); return { ok: true }; }
    if (op === 'reveal') { shell.showItemInFolder(target); return { ok: true }; }
    return { error: `알 수 없는 작업: ${op}` };
  } catch (err) {
    return { error: err.message };
  }
});
// 파일 화면 편집기 저장. 연 뒤 다른 곳(AI 등)에서 파일이 바뀌었으면 force 없이는 쓰지 않고 알린다.
ipcMain.handle('files:write', (e, file, text, mtime, force) => {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return { error: '파일이 아닙니다.' };
    if (!force && mtime && Math.abs(st.mtimeMs - mtime) > 1) return { conflict: true };
    fs.writeFileSync(file, text, 'utf8');
    return { mtime: fs.statSync(file).mtimeMs };
  } catch (err) {
    return { error: err.message };
  }
});

const git = (cwd, args) => new Promise((resolve) => {
  execFile('git', ['-C', cwd, ...args], { windowsHide: true }, (err, out, stderr) => resolve(err ? null : out));
});

// 사이드바 워크트리 만들기: <저장소 상위>\<저장소>.worktrees\<브랜치> 에 만든다. 브랜치가 없으면 새로 판다.
ipcMain.handle('git:worktree-add', async (e, repo, branch) => {
  branch = String(branch).trim();
  if (branch.startsWith('-') || (await git(repo, ['check-ref-format', '--branch', branch])) == null) return { error: `브랜치 이름으로 쓸 수 없습니다: ${branch}` };
  const dir = path.join(path.dirname(repo), `${path.basename(repo)}.worktrees`, branch.replace(/[\\/]/g, '-'));
  if (fs.existsSync(dir)) return { error: `이미 있는 폴더입니다: ${dir}` };
  const exists = (await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])) != null;
  return new Promise((resolve) => {
    const args = exists ? ['worktree', 'add', dir, branch] : ['worktree', 'add', '-b', branch, dir];
    execFile('git', ['-C', repo, ...args], { windowsHide: true }, (err, out, stderr) => resolve(err ? { error: stderr.trim() || err.message } : { path: dir }));
  });
});

ipcMain.handle('board:load', () => (keepBoard && fs.existsSync(boardFile) ? JSON.parse(fs.readFileSync(boardFile, 'utf8')) : null));
ipcMain.on('board:save', (e, board) => {
  if (keepBoard) fs.writeFileSync(boardFile, JSON.stringify(board, null, 2));
});

// Windows 알림 표시 + 작업 표시줄 고정. 설치 바로가기의 ID(appId)와 같아야 업데이트 뒤에도 고정이 유지된다.
// 빌드 설정의 extraMetadata.appId 로 패키지된 package.json 에 들어온다.
app.setAppUserModelId(require('./package.json').appId || 'io.github.gyun-hub.bimo');
app.whenReady().then(() => {
  hookServer.listen(0, '127.0.0.1', () => {
    hookPort = hookServer.address().port;
    createWindow();
    if (app.isPackaged && !smoke) {
      setTimeout(() => checkUpdate(false), 10000); // 켜자마자 말고 조금 뒤에
      setInterval(() => checkUpdate(false), 4 * 60 * 60 * 1000);
    }
  });
});

// --- 자동 업데이트: 배포처의 latest.yml(맥은 latest-mac.yml)을 읽어 버전 비교 ---
// 배포처는 빌드 설정 publish → 빌드 때 resources/app-update.yml 로 들어간다.
// Windows: 뒤에서 받아 두고 "다시 시작하면 적용". 맥: Apple 정식 서명이 없으면 자동 설치가 안 돼 dmg 받기 안내만.
function updateFeed() {
  let yml;
  try {
    yml = fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8');
  } catch {
    return null;
  }
  const get = (k) => yml.match(new RegExp(`^${k}:\\s*(.+)$`, 'm'))?.[1].trim().replace(/^['"]|['"]$/g, '');
  if (get('provider') === 'github' && get('owner') && get('repo')) {
    const repo = `https://github.com/${get('owner')}/${get('repo')}/releases`;
    return { yml: `${repo}/latest/download/latest-mac.yml`, file: (v, name) => `${repo}/download/v${v}/${name}` };
  }
  const base = get('url')?.replace(/\/?$/, '/');
  if (!base?.startsWith('https://')) return null; // 업데이트는 https 로만 받는다
  return { yml: `${base}latest-mac.yml`, file: (v, name) => `${base}${name}` };
}
const newer = (a, b) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};
let updater = null;
let readyVersion = null; // Windows: 받아 둔 새 버전
async function checkUpdate(manual) {
  const feed = updateFeed();
  if (!feed) return { status: 'off', message: '업데이트 배포처가 설정되지 않은 빌드입니다.' };
  if (readyVersion) {
    send('update:ready', readyVersion);
    return { status: 'ready', version: readyVersion };
  }
  try {
    if (isWin) {
      if (!updater) {
        updater = require('electron-updater').autoUpdater;
        updater.autoDownload = true;
        updater.autoInstallOnAppQuit = false; // 사용자가 [다시 시작]을 누를 때만
        updater.on('update-downloaded', (info) => { readyVersion = info.version; send('update:ready', info.version); });
        updater.on('error', () => {}); // 배포처에 못 닿으면 조용히 지금 버전으로 계속
      }
      const r = await updater.checkForUpdates();
      const v = r?.updateInfo?.version;
      return v && newer(v, app.getVersion()) ? { status: 'downloading', version: v } : { status: 'latest', version: app.getVersion() };
    }
    // GitHub 는 /latest/download 가 실제 파일로 넘겨 주므로(redirect) 따라가는 net.fetch 로 받는다
    const res = await require('electron').net.fetch(feed.yml, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const yml = await res.text();
    const v = yml.match(/^version:\s*(.+)$/m)?.[1].trim().replace(/^['"]|['"]$/g, '');
    if (!v || !newer(v, app.getVersion())) return { status: 'latest', version: app.getVersion() };
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const dmg = yml.match(new RegExp(`url:\\s*(\\S+-${arch}\\.dmg)`))?.[1];
    if (!dmg) throw new Error('dmg 파일을 찾지 못했습니다');
    const url = feed.file(v, dmg);
    send('update:manual', { version: v, url });
    return { status: 'manual', version: v, url };
  } catch (err) {
    return { status: 'error', message: manual ? `업데이트 배포처에 연결하지 못했습니다: ${err.message}` : '' };
  }
}
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('update:check', () => checkUpdate(true));
ipcMain.on('update:install', () => {
  closeConfirmed = true; // 다시 시작은 사용자가 고른 것이라 종료 확인을 건너뛴다
  updater?.quitAndInstall(false, true);
});
ipcMain.on('update:open', (e, url) => { if (/^https?:\/\//.test(url)) require('electron').shell.openExternal(url); });
app.on('window-all-closed', () => {
  for (const p of ptys.values()) p.kill();
  // ConPTY 정리 핸들이 이벤트 루프를 붙잡아 app.quit() 이 끝나지 않는다.
  // 번들 ConPTY 는 정리 중에 곧바로 프로세스를 끝내면 가끔 강제 종료(0xc0000409)된다 → 잠깐 정리할 시간을 준다.
  setTimeout(() => app.exit(0), 300);
});
