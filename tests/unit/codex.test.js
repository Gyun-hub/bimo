const test = require('node:test');
const assert = require('node:assert');
const { callPrefix, isCallTurn, tomlStr, tomlArr, curlConfig, codexArgs } = require('../../lib/codex');

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
