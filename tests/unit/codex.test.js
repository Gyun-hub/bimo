const test = require('node:test');
const assert = require('node:assert');
const { callPrefix, isCallTurn, tomlStr, tomlArr, curlConfig, codexArgs, threadId, takenSids, rolloutMeta, pickRollout } = require('../../lib/codex');

test('takenSids: 자기 노드·sid 없는 노드는 빼고 남의 id 만', () => {
  const nodes = new Map([['n1', { sid: 'sess-0001' }], ['n2', { sid: 'sess-0002' }], ['n3', { sid: null }], ['n4', {}]]);
  assert.deepStrictEqual([...takenSids(nodes, 'n1')], ['sess-0002']);
  assert.deepStrictEqual([...takenSids(nodes, 'n3')].sort(), ['sess-0001', 'sess-0002']);
  assert.strictEqual(takenSids(new Map(), 'n1').size, 0);
});

// main.js pty:spawn 의 Windows 인용과 같다
const q = (s) => `'${s.replace(/'/g, "''")}'`;
const paths = {
  exe: 'C:\\Users\\John Smith\\Bimo.exe',
  script: 'C:\\Users\\John Smith\\AppData\\Roaming\\Bimo\\mcp-sessions.js',
  conn: 'C:\\Users\\John Smith\\AppData\\Roaming\\Bimo\\hooks\\n1.bimo.json',
  curl: 'C:\\Users\\John Smith\\AppData\\Roaming\\Bimo\\hooks\\n1.curl',
};

test('tomlStr/tomlArr: 리터럴 문자열로 감싼다', () => {
  assert.strictEqual(tomlStr('C:\\a b\\c'), "'C:\\a b\\c'");
  assert.strictEqual(tomlArr(['a', 'b c']), "['a','b c']");
});

test('codexArgs: -c 4개, 각 값에 " 없음, 백슬래시 그대로', () => {
  const s = codexArgs(paths, q);
  const cs = s.split(/ (?=-c )/);
  assert.strictEqual(cs.length, 4);
  assert.ok(cs.every((c) => c.startsWith("-c '")));
  assert.ok(!s.includes('"'));
  assert.ok(s.includes(`mcp_servers.bimo.args=[''${paths.script}'',''${paths.conn}'']`));
  assert.ok(s.includes("mcp_servers.bimo.env={ELECTRON_RUN_AS_NODE=''1''}"));
  assert.ok(s.includes(`notify=[''curl'',''-K'',''${paths.curl}'',''-d'']`));
});

test('codexArgs: 명령줄에 토큰·포트·URL 이 없다', () => {
  const s = codexArgs(paths, q);
  assert.ok(!/BIMO_TOKEN|BIMO_PORT|BIMO_NODE|http:|\/hook\//.test(s));
});

test("codexArgs: 경로에 ' 가 있으면 협업을 뺀다", () => {
  for (const k of Object.keys(paths)) {
    assert.strictEqual(codexArgs({ ...paths, [k]: "C:\\Users\\O'Brien\\x" }, q), '', k);
  }
});

test('curlConfig: url 과 noproxy', () => {
  const c = curlConfig('http://127.0.0.1:5/hook/tok/n1');
  assert.match(c, /^url = "http:\/\/127\.0\.0\.1:5\/hook\/tok\/n1"$/m);
  assert.match(c, /^noproxy = "\*"$/m);
});

test('isCallTurn: 머리말 든 턴만, 필드 없으면 받는다', () => {
  assert.ok(isCallTurn([`${callPrefix('caller')} ping`]));
  assert.ok(isCallTurn(['앞 메시지', `${callPrefix('a b')} x`]));
  assert.ok(!isCallTurn(['ping']));
  assert.ok(!isCallTurn([]));
  assert.ok(isCallTurn(undefined));
  assert.strictEqual(callPrefix('caller'), '[세션 "caller" 에서 온 요청]');
});

test('threadId: 형식 맞는 thread-id 만', () => {
  const id = '0199abcd-1234-7000-8000-abcdef012345';
  assert.strictEqual(threadId({ type: 'agent-turn-complete', 'thread-id': id }), id);
  assert.strictEqual(threadId({ type: 'agent-turn-complete' }), null);
  assert.strictEqual(threadId({ 'thread-id': 'abc' }), null); // 8자 미만
  assert.strictEqual(threadId({ 'thread-id': "x'; rm -rf /" }), null); // 셸에 들어갈 문자
  assert.strictEqual(threadId({ 'thread-id': 12345678 }), null);
  assert.strictEqual(threadId(null), null);
});

test('rolloutMeta: 첫 줄 session_meta, 잘린 줄은 정규식, 깨진 건 null', () => {
  const cwd = 'C:\\Users\\a b\\p';
  const meta = { timestamp: 't', type: 'session_meta', payload: { id: 'sess-0001', timestamp: 't', cwd, instructions: 'x' } };
  const line = JSON.stringify(meta);
  assert.deepStrictEqual(rolloutMeta(`${line}\n{"type":"x"}\n`), { id: 'sess-0001', cwd });
  assert.deepStrictEqual(rolloutMeta(line.slice(0, line.indexOf('"instructions"') + 20)), { id: 'sess-0001', cwd });
  assert.deepStrictEqual(rolloutMeta(JSON.stringify({ id: 'old-format1', cwd: '/home/a' })), { id: 'old-format1', cwd: '/home/a' });
  assert.deepStrictEqual(rolloutMeta(''), { id: null, cwd: '' });
  assert.deepStrictEqual(rolloutMeta('garbage'), { id: null, cwd: '' });
});

test('pickRollout: 같은 cwd·spawn 이후·남이 안 가진 후보가 딱 하나일 때만', () => {
  const c = (id, cwd, at) => ({ id, cwd, at });
  const cands = [
    c('aaaaaaaa-1', 'C:\\Work\\P', 50), // spawn 전
    c('bbbbbbbb-2', 'C:\\Work\\Other', 300), // 다른 폴더
    c('cccccccc-3', 'c:\\work\\p\\', 200), // 대소문자·끝 구분자만 다름
    c('dddddddd-4', 'C:\\Work\\P', 400), // 다른 노드가 받음
    c('bad id!!', 'C:\\Work\\P', 500), // 형식 틀림
    c('eeeeeeee-5', 'C:\\Work\\P', 150),
  ];
  const opt = { cwd: 'C:\\Work\\P', since: 100, taken: new Set(['dddddddd-4']) };
  assert.strictEqual(pickRollout(cands, opt, true), null); // c·e 둘 다 맞음 → 모호하니 안 고른다
  assert.strictEqual(pickRollout(cands, { ...opt, taken: new Set(['dddddddd-4', 'cccccccc-3']) }, true), 'eeeeeeee-5');
  assert.strictEqual(pickRollout(cands, { ...opt, taken: new Set(['dddddddd-4', 'eeeeeeee-5']) }, true), 'cccccccc-3');
  assert.strictEqual(pickRollout(cands, { ...opt, since: 1000 }, true), null);
  assert.strictEqual(pickRollout(cands, { ...opt, cwd: '' }, true), null);
  assert.strictEqual(pickRollout([], opt, true), null);
});
