// Bimo 세션 호출 MCP 서버 (stdio). claude 가 띄우고, 앱의 로컬 HTTP 로 다른 세션에 말을 건다.
// 환경 변수: BIMO_PORT = 앱 HTTP 포트, BIMO_TOKEN = 앱이 실행마다 만든 접속 토큰, BIMO_NODE = 이 claude 가 붙은 노드 id
const http = require('http');

const PORT = process.env.BIMO_PORT;
const TOKEN = process.env.BIMO_TOKEN || '';
const NODE = encodeURIComponent(process.env.BIMO_NODE || '');

function call(method, route, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({ host: '127.0.0.1', port: PORT, path: `/mcp/${TOKEN}/${NODE}/${route}`, method, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => { try { resolve(JSON.parse(out)); } catch { resolve({ error: '앱 응답을 읽지 못했습니다' }); } });
    });
    req.on('error', () => resolve({ error: 'Bimo 앱에 연결하지 못했습니다. 앱이 꺼졌을 수 있습니다.' }));
    req.end(data);
  });
}

const TOOLS = [
  {
    name: 'list_sessions',
    description: '사용자가 Bimo 보드에서 이 세션과 케이블로 연결해 둔 다른 세션 목록과 상태를 돌려준다. 연결된 세션에만 말을 걸 수 있다.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'send_to_session',
    description: '연결된 다른 세션에 메시지를 보낸다. 메시지는 그 세션의 입력창에 들어가 실행된다. wait_for_reply 가 true(기본)면 그 세션의 응답이 끝날 때까지 기다렸다가 답을 돌려주고, false 면 보내기만 하고 바로 돌아온다. 일하는 중인 세션에는 보낼 수 없다.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'list_sessions 가 알려준 세션 이름' },
        message: { type: 'string', description: '보낼 내용. 상대가 맥락 없이도 이해하게 구체적으로 쓴다.' },
        wait_for_reply: { type: 'boolean', description: '답을 기다릴지 여부, 기본 true' },
        timeout_sec: { type: 'number', description: '답을 기다릴 최대 시간(초), 기본 600' },
      },
      required: ['session', 'message'],
    },
  },
];

const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
const text = (t, isError) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // 알림은 응답하지 않는다
  if (method === 'initialize') {
    return reply(id, { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'bimo', version: '0.1.0' } });
  }
  if (method === 'tools/list') return reply(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const args = params?.arguments || {};
    if (params?.name === 'list_sessions') {
      const r = await call('GET', 'sessions');
      if (r.error) return reply(id, text(r.error, true));
      if (!r.sessions.length) return reply(id, text('연결된 세션이 없습니다. 사용자가 보드에서 이 세션과 다른 세션을 케이블로 이어야 합니다.'));
      return reply(id, text(r.sessions.map((s) => `- ${s.name}: ${s.agent}, 폴더 ${s.folder}, 상태 ${s.state}`).join('\n')));
    }
    if (params?.name === 'send_to_session') {
      const r = await call('POST', 'send', { session: args.session, message: args.message, wait: args.wait_for_reply !== false, timeout: args.timeout_sec });
      if (r.error) return reply(id, text(r.error, true));
      return reply(id, text(r.reply ?? r.result));
    }
    return process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: `알 수 없는 도구: ${params?.name}` } })}\n`);
  }
  if (method === 'ping') return reply(id, {});
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: `지원하지 않는 메서드: ${method}` } })}\n`);
}

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); } catch {}
  }
});
