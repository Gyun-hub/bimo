const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const s = require('../../lib/sessions');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bimo-sessions-'));
const jsonl = (rows) => rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';
const write = (file, text, mtime) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mtime) fs.utimesSync(file, mtime / 1000, mtime / 1000);
};
const ID1 = '11111111-1111-1111-1111-111111111111';
const ID2 = '22222222-2222-2222-2222-222222222222';
const ID3 = '33333333-3333-3333-3333-333333333333';

test('realPrompt: 공백 정리·120자·< 로 시작하면 null', () => {
  assert.strictEqual(s.realPrompt('  a \n b  '), 'a b');
  assert.strictEqual(s.realPrompt('<command-name>/x</command-name>'), null);
  assert.strictEqual(s.realPrompt('   '), null);
  assert.strictEqual(s.realPrompt(null), null);
  assert.strictEqual(s.realPrompt('가'.repeat(200)).length, 120);
});

test('pool: 순서 유지, 동시 수 제한', async () => {
  let live = 0, peak = 0;
  const out = await s.pool([5, 1, 3, 2, 4], 2, async (x) => {
    peak = Math.max(peak, ++live);
    await new Promise((r) => setTimeout(r, x));
    live--;
    return x * 10;
  });
  assert.deepStrictEqual(out, [50, 10, 30, 20, 40]);
  assert.strictEqual(peak, 2);
  assert.deepStrictEqual(await s.pool([], 16, async (x) => x), []);
});

test('scanHead: 64KB 경계를 넘는 줄·한글을 온전히 읽고, 끝의 잘린 줄은 넘긴다', async () => {
  const dir = tmp();
  const big = { pad: '한'.repeat(40000) }; // 약 120KB, 첫 64KB 조각을 넘는다
  const f = path.join(dir, 'a.jsonl');
  write(f, jsonl([{ n: 1 }, big, { n: 2 }]) + '{"n":3');
  const seen = [];
  await s.scanHead(f, (j) => { seen.push(j.n ?? j.pad.length); });
  assert.deepStrictEqual(seen, [1, 40000, 2]);
});

test('scanHead: true 를 돌려주면 멈추고, 상한 뒤는 읽지 않는다', async () => {
  const dir = tmp();
  const f = path.join(dir, 'a.jsonl');
  write(f, jsonl([{ n: 1 }, { n: 2 }, { n: 3 }]));
  const seen = [];
  await s.scanHead(f, (j) => { seen.push(j.n); return j.n === 2; });
  assert.deepStrictEqual(seen, [1, 2]);
  const g = path.join(dir, 'b.jsonl');
  write(g, jsonl([{ pad: 'x'.repeat(s.HEAD_MAX) }, { n: 9 }])); // 첫 줄이 상한보다 길다
  const got = [];
  await s.scanHead(g, (j) => { got.push(j); });
  assert.deepStrictEqual(got, []);
});

test('claudeSessions: 앞의 큰 attachment 뒤 제목, 메타·명령 줄 건너뜀, 제목 없는 세션 제외, 최신순', async () => {
  const root = tmp();
  const attach = { type: 'attachment', cwd: 'C:\\work\\a', pad: 'x'.repeat(100 * 1024) }; // 최근 CLI 처럼 첫 user 앞 100KB
  write(path.join(root, 'p1', `${ID1}.jsonl`), jsonl([
    attach,
    { type: 'user', isMeta: true, message: { content: '메타' } },
    { type: 'user', message: { content: '<command-name>/clear</command-name>' } },
    'not json',
    { type: 'user', message: { content: [{ type: 'image' }, { type: 'text', text: '첫  질문' }] } },
  ]), 2000e3);
  write(path.join(root, 'p1', `${ID2}.jsonl`), jsonl([{ type: 'summary', cwd: '/x' }]), 3000e3); // 대화 없음
  write(path.join(root, 'p2', `${ID3}.jsonl`), jsonl([{ type: 'user', cwd: '/home/b', message: { content: '둘째' } }]), 1000e3);
  write(path.join(root, 'p2', 'not-a-session.jsonl'), jsonl([{ type: 'user', cwd: '/', message: { content: 'x' } }]));
  const out = await s.claudeSessions(root);
  assert.deepStrictEqual(out, [
    { agent: 'claude', id: ID1, cwd: 'C:\\work\\a', title: '첫 질문', at: 2000e3 },
    { agent: 'claude', id: ID3, cwd: '/home/b', title: '둘째', at: 1000e3 },
  ]);
});

test('claudeSessions: 제목이 256KB 뒤면 예전처럼 뺀다', async () => {
  const root = tmp();
  write(path.join(root, 'p', `${ID1}.jsonl`), jsonl([
    { type: 'attachment', cwd: '/a', pad: 'x'.repeat(300 * 1024) },
    { type: 'user', message: { content: '늦은 제목' } },
  ]));
  assert.deepStrictEqual(await s.claudeSessions(root), []);
});

test('newestFiles: 최근 SESSION_LIMIT 개만, 없는 폴더는 빈 배열', async () => {
  const root = tmp();
  for (let i = 0; i < s.SESSION_LIMIT + 5; i++) write(path.join(root, `f${i}.x`), '', (1000 + i) * 1e3);
  const out = await s.newestFiles(root, (n) => n.endsWith('.x'), 0);
  assert.strictEqual(out.length, s.SESSION_LIMIT);
  assert.strictEqual(out[0].at, (1000 + s.SESSION_LIMIT + 4) * 1e3);
  assert.deepStrictEqual(await s.newestFiles(path.join(root, 'none'), () => true, 1), []);
});

test('codexSessions: session_meta id·cwd, user_message 와 message/input_text 제목, 파일 이름 id 대체', async () => {
  const root = tmp();
  const day = path.join(root, '2026', '11', '16');
  write(path.join(day, `rollout-2026-11-16T10-00-00-${ID1}.jsonl`), jsonl([
    { type: 'session_meta', payload: { id: 'sid-1', cwd: 'C:\\w', timestamp: 't' } },
    { type: 'event_msg', payload: { type: 'user_message', message: '<env>' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '코덱스 질문' }] } },
  ]), 2000e3);
  write(path.join(day, `rollout-2026-11-16T09-00-00-${ID2}.jsonl`), jsonl([{ type: 'other' }]), 1000e3);
  assert.deepStrictEqual(await s.codexSessions(root), [
    { agent: 'codex', id: 'sid-1', cwd: 'C:\\w', title: '코덱스 질문', at: 2000e3 },
    { agent: 'codex', id: ID2, cwd: '', title: '(첫 메시지 없음)', at: 1000e3 },
  ]);
});

test('cursorSessions: meta.json, hasConversation false·깨진 JSON 제외, updatedAtMs 우선', async () => {
  const root = tmp();
  write(path.join(root, 'h1', 'c1', 'meta.json'), JSON.stringify({ title: '커서', cwd: '/c', updatedAtMs: 5 }), 2000e3);
  write(path.join(root, 'h1', 'c2', 'meta.json'), JSON.stringify({ hasConversation: false }), 3000e3);
  write(path.join(root, 'h2', 'c3', 'meta.json'), '{깨짐', 4000e3);
  write(path.join(root, 'h2', 'c4', 'meta.json'), JSON.stringify({}), 1000e3);
  assert.deepStrictEqual(await s.cursorSessions(root), [
    { agent: 'cursor-agent', id: 'c1', cwd: '/c', title: '커서', at: 5 },
    { agent: 'cursor-agent', id: 'c4', cwd: '', title: '(제목 없음)', at: 1000e3 },
  ]);
});

test('listSessions: claude·codex·cursor 순서로 합치고, 없는 폴더는 건너뛴다', async () => {
  const root = tmp();
  write(path.join(root, 'claude', 'p', `${ID1}.jsonl`), jsonl([{ type: 'user', cwd: '/a', message: { content: 'hi' } }]));
  write(path.join(root, 'cursor', 'h', 'c1', 'meta.json'), JSON.stringify({ title: 't' }));
  const out = await s.listSessions({ claude: path.join(root, 'claude'), codex: path.join(root, 'none'), cursor: path.join(root, 'cursor') });
  assert.deepStrictEqual(out.map((x) => x.agent), ['claude', 'cursor-agent']);
});
