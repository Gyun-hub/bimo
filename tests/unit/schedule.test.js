const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PERM_ARGS, permArgs, schedFileName, saveUnique, stamp, trustedIn } = require('../../lib/schedule');

test('권한은 ask·read·edit 만, 전부 허용은 없다', () => {
  assert.deepStrictEqual(Object.keys(PERM_ARGS).sort(), ['ask', 'edit', 'read']);
  assert.ok(!Object.values(PERM_ARGS).flat().some((a) => /dangerously|bypass/i.test(a)));
  assert.deepStrictEqual(permArgs('edit'), ['--permission-mode', 'acceptEdits']);
});

test('모르는 권한 값은 빈 인자', () => {
  for (const p of ['all', undefined, null, '', 'toString', '__proto__', 'constructor', ['edit'], { a: 1 }]) assert.deepStrictEqual(permArgs(p), [], String(p));
});

test('결과 파일 이름: 금지 문자 제거·40자·대체 이름', () => {
  const d = new Date(2026, 10, 12, 9, 5);
  assert.strictEqual(stamp(d), '2026-11-12-09-05');
  assert.strictEqual(schedFileName('a/b\\c:d*?"<>|e\r\nf', d, '예약'), 'a b c d      e  f 2026-11-12-09-05.md');
  assert.strictEqual(schedFileName('x'.repeat(60), d, '예약'), `${'x'.repeat(40)} 2026-11-12-09-05.md`);
  for (const t of ['', '   ', null, '..', '/\\']) assert.strictEqual(schedFileName(t, d, '예약'), '예약 2026-11-12-09-05.md', String(t));
});

test('결과 파일 이름에 폴더 이름을 넣는다', () => {
  const d = new Date(2026, 10, 12, 9, 5);
  assert.strictEqual(schedFileName('점검', d, '예약', '/home/u/my:repo/'), '점검 - my repo 2026-11-12-09-05.md');
  assert.strictEqual(schedFileName('', d, '예약', 'C:/Work/api'), '예약 - api 2026-11-12-09-05.md');
  assert.strictEqual(schedFileName('t', d, '예약', '/'), 't 2026-11-12-09-05.md');
});

test('saveUnique: 같은 이름이면 덮어쓰지 않고 -2, -3, 임시 파일은 남기지 않는다', async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bimo-sched-')), 'schedules');
  const files = await Promise.all(['a', 'b', 'c'].map((t) => saveUnique(dir, 'x 2026.md', t)));
  assert.deepStrictEqual(files.map((f) => path.basename(f)).sort(), ['x 2026 -2.md', 'x 2026 -3.md', 'x 2026.md']);
  assert.deepStrictEqual(files.map((f) => fs.readFileSync(f, 'utf8')).sort(), ['a', 'b', 'c']);
  assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
});

test('신뢰 폴더: 상위 폴더까지, Windows 는 대소문자·구분자 무시', () => {
  const projects = { 'C:/Work/Repo': { hasTrustDialogAccepted: true }, 'C:/Other': { hasTrustDialogAccepted: false } };
  assert.strictEqual(trustedIn(projects, 'c:\\work\\repo\\src\\', true), true);
  assert.strictEqual(trustedIn(projects, 'C:\\Work', true), false);
  assert.strictEqual(trustedIn(projects, 'C:\\Other\\x', true), false);
  assert.strictEqual(trustedIn(projects, 'c:/work/repo', false), false); // Mac 은 대소문자 구분
  assert.strictEqual(trustedIn({ '/Users/a': { hasTrustDialogAccepted: true } }, '/Users/a/p', false), true);
  assert.strictEqual(trustedIn(undefined, '/x', false), false);
});
