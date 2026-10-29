const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BOARD_VERSION, migrate, tooNew, loadBoard, saveBoard } = require('../../lib/board');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bimo-board-')), 'board.json');
const quiet = () => {};

test('저장 후 로드 왕복, version 붙음', () => {
  const f = tmp();
  saveBoard(f, { view: { x: 1 }, nodes: [{ id: 'a' }] });
  assert.deepStrictEqual(loadBoard(f, quiet), { view: { x: 1 }, nodes: [{ id: 'a' }], version: BOARD_VERSION });
  assert.ok(!fs.existsSync(f + '.tmp'));
});

test('두 번째 저장은 이전 내용을 .bak 으로 남기고 덮어쓴다', () => {
  const f = tmp();
  saveBoard(f, { n: 1 });
  saveBoard(f, { n: 2 });
  assert.strictEqual(loadBoard(f, quiet).n, 2);
  assert.strictEqual(JSON.parse(fs.readFileSync(f + '.bak', 'utf8')).n, 1);
});

test('깨진 board.json + 정상 .bak → .bak 내용', () => {
  const f = tmp();
  fs.writeFileSync(f, '{"view":');
  fs.writeFileSync(f + '.bak', JSON.stringify({ n: 7 }));
  const logs = [];
  assert.deepStrictEqual(loadBoard(f, (m) => logs.push(m)), { n: 7, version: 1 });
  assert.strictEqual(logs.length, 1);
});

test('깨진 board.json + 정상 .bak 에서 저장 → .bak 그대로, 깨진 파일은 corrupt-* 로 남음', () => {
  const f = tmp();
  fs.writeFileSync(f, '{"view":');
  fs.writeFileSync(f + '.bak', JSON.stringify({ n: 7 }));
  saveBoard(f, { n: 8 });
  assert.strictEqual(JSON.parse(fs.readFileSync(f + '.bak', 'utf8')).n, 7);
  assert.strictEqual(loadBoard(f, quiet).n, 8);
  const corrupt = fs.readdirSync(path.dirname(f)).filter((n) => n.startsWith('board.json.corrupt-'));
  assert.strictEqual(corrupt.length, 1);
  assert.strictEqual(fs.readFileSync(path.join(path.dirname(f), corrupt[0]), 'utf8'), '{"view":');
});

test('둘 다 깨진 상태에서 저장 → .bak 그대로, 깨진 board.json 은 corrupt-* 로 남음', () => {
  const f = tmp();
  fs.writeFileSync(f, '{"view":');
  fs.writeFileSync(f + '.bak', '{"bak":');
  saveBoard(f, { n: 1 });
  assert.strictEqual(fs.readFileSync(f + '.bak', 'utf8'), '{"bak":');
  assert.strictEqual(fs.readdirSync(path.dirname(f)).filter((n) => n.startsWith('board.json.corrupt-')).length, 1);
  assert.strictEqual(loadBoard(f, quiet).n, 1);
});

test('둘 다 깨짐 → null', () => {
  const f = tmp();
  fs.writeFileSync(f, '{"view":');
  fs.writeFileSync(f + '.bak', '');
  assert.strictEqual(loadBoard(f, quiet), null);
});

test('깨짐 + .bak 없음 → null, JSON 이 객체가 아니면 깨진 것으로 본다', () => {
  const f = tmp();
  fs.writeFileSync(f, 'null');
  assert.strictEqual(loadBoard(f, quiet), null);
});

test('파일 없음 → null', () => {
  assert.strictEqual(loadBoard(tmp(), quiet), null);
});

test('본 파일 없고 .bak 만 있음 → .bak 내용, 복구 로그', () => {
  const f = tmp();
  fs.writeFileSync(f + '.bak', JSON.stringify({ n: 5 }));
  const logs = [];
  assert.deepStrictEqual(loadBoard(f, (m) => logs.push(m)), { n: 5, version: 1 });
  assert.strictEqual(logs.length, 1);
});

// board.json 자리에 폴더를 두어 읽기 오류(EISDIR)를 흉내 낸다.
test('본 파일 읽기 오류 → 저장은 던지고 .bak·본 자리를 건드리지 않음', () => {
  const f = tmp();
  fs.mkdirSync(f);
  fs.writeFileSync(f + '.bak', JSON.stringify({ n: 3 }));
  assert.throws(() => saveBoard(f, { n: 4 }), { code: 'EISDIR' });
  assert.ok(fs.statSync(f).isDirectory());
  assert.strictEqual(JSON.parse(fs.readFileSync(f + '.bak', 'utf8')).n, 3);
  const left = fs.readdirSync(path.dirname(f)).filter((n) => n.includes('corrupt') || n.endsWith('.tmp'));
  assert.deepStrictEqual(left, []);
});

test('본 파일 읽기 오류 → 로드는 .bak 으로 넘어감', () => {
  const f = tmp();
  fs.mkdirSync(f);
  fs.writeFileSync(f + '.bak', JSON.stringify({ n: 3 }));
  assert.strictEqual(loadBoard(f, quiet).n, 3);
});

test('본 파일 읽기 오류 + .bak 없음 → 던짐(빈 보드로 원본을 덮지 않게), 아무것도 만들지 않음', () => {
  const f = tmp();
  fs.mkdirSync(f);
  assert.throws(() => loadBoard(f, quiet), { code: 'EISDIR' });
  assert.ok(fs.statSync(f).isDirectory());
  assert.deepStrictEqual(fs.readdirSync(path.dirname(f)), ['board.json']);
});

test('본 파일 읽기 오류 + 깨진 .bak → 던짐', () => {
  const f = tmp();
  fs.mkdirSync(f);
  fs.writeFileSync(f + '.bak', '{"x":');
  assert.throws(() => loadBoard(f, quiet), { code: 'EISDIR' });
});

test('본 파일 없음·.bak 없음·.tmp 정상 → .tmp 내용, 복구 로그', () => {
  const f = tmp();
  fs.writeFileSync(f + '.tmp', JSON.stringify({ n: 9 }));
  const logs = [];
  assert.deepStrictEqual(loadBoard(f, (m) => logs.push(m)), { n: 9, version: 1 });
  assert.strictEqual(logs.length, 1);
  assert.match(logs[0], /\.tmp/);
});

test('후보 순서는 본 파일 → .bak → .tmp', () => {
  const f = tmp();
  fs.writeFileSync(f + '.bak', JSON.stringify({ n: 'bak' }));
  fs.writeFileSync(f + '.tmp', JSON.stringify({ n: 'tmp' }));
  assert.strictEqual(loadBoard(f, quiet).n, 'bak');
  fs.writeFileSync(f, JSON.stringify({ n: 'main' }));
  assert.strictEqual(loadBoard(f, quiet).n, 'main');
});

test('본 파일 읽기 오류 + .bak 없음 + .tmp 정상 → .tmp 로 복구(던지지 않음)', () => {
  const f = tmp();
  fs.mkdirSync(f);
  fs.writeFileSync(f + '.tmp', JSON.stringify({ n: 2 }));
  assert.strictEqual(loadBoard(f, quiet).n, 2);
});

// fs.renameSync 를 잠시 바꿔 잠금(EPERM 등)을 흉내 낸다.
function failRename(times, code) {
  const orig = fs.renameSync;
  let calls = 0;
  fs.renameSync = (...a) => (++calls <= times ? (() => { throw Object.assign(new Error(code), { code }); })() : orig(...a));
  return { calls: () => calls, restore: () => { fs.renameSync = orig; } };
}

test('rename 이 EPERM 으로 몇 번 실패해도 다시 시도해 저장된다', () => {
  const f = tmp();
  const r = failRename(3, 'EPERM');
  try { saveBoard(f, { n: 1 }); } finally { r.restore(); }
  assert.strictEqual(r.calls(), 4);
  assert.strictEqual(loadBoard(f, quiet).n, 1);
});

test('rename 이 계속 EBUSY 면 5번 시도 뒤 던지고 본 파일은 그대로', () => {
  const f = tmp();
  saveBoard(f, { n: 1 });
  const r = failRename(99, 'EBUSY');
  try { assert.throws(() => saveBoard(f, { n: 2 }), { code: 'EBUSY' }); } finally { r.restore(); }
  assert.strictEqual(r.calls(), 5);
  assert.strictEqual(loadBoard(f, quiet).n, 1);
});

test('재시도 대상이 아닌 오류는 바로 던진다', () => {
  const f = tmp();
  const r = failRename(99, 'EXDEV');
  try { assert.throws(() => saveBoard(f, { n: 1 }), { code: 'EXDEV' }); } finally { r.restore(); }
  assert.strictEqual(r.calls(), 1);
});

test('tooNew: 더 새 version 만 참, 로드는 그 파일을 그대로 돌려준다', () => {
  assert.strictEqual(tooNew({ version: BOARD_VERSION + 1 }), true);
  assert.strictEqual(tooNew({ version: BOARD_VERSION }), false);
  assert.strictEqual(tooNew({}), false);
  assert.strictEqual(tooNew(null), false);
  const f = tmp();
  fs.writeFileSync(f, JSON.stringify({ version: BOARD_VERSION + 1, x: 1 }));
  const b = loadBoard(f, quiet);
  assert.deepStrictEqual(b, { version: BOARD_VERSION + 1, x: 1 });
  assert.strictEqual(tooNew(b), true);
});

test('version 없는 파일 → version 1', () => {
  const f = tmp();
  fs.writeFileSync(f, JSON.stringify({ view: {} }));
  assert.strictEqual(loadBoard(f, quiet).version, 1);
});

test('MIGRATIONS 순서 적용, 더 새 version 은 그대로', () => {
  const migs = [(b) => ({ ...b, log: [...b.log, '1to2'] }), (b) => ({ ...b, log: [...b.log, '2to3'] })];
  assert.deepStrictEqual(migrate({ log: [] }, migs, 3), { log: ['1to2', '2to3'], version: 3 });
  assert.deepStrictEqual(migrate({ log: [], version: 2 }, migs, 3), { log: ['2to3'], version: 3 });
  const newer = { version: 9, x: 1 };
  assert.strictEqual(migrate(newer, migs, 3), newer);
});
