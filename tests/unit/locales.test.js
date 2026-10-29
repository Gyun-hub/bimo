const test = require('node:test');
const assert = require('node:assert');
const { strings, t } = require('../../locales');

test('언어마다 키 집합이 ko 와 같다', () => {
  const ko = Object.keys(strings.ko).sort();
  for (const lang of Object.keys(strings)) assert.deepStrictEqual(Object.keys(strings[lang]).sort(), ko, lang);
});

test('en 값에 한글이 없다', () => {
  const bad = Object.entries(strings.en).filter(([, v]) => /[가-힣]/.test(v)).map(([k]) => k);
  assert.deepStrictEqual(bad, []);
});

test('값은 빈 문자열이 아니다', () => {
  for (const lang of Object.keys(strings)) for (const [k, v] of Object.entries(strings[lang])) assert.ok(typeof v === 'string' && v, `${lang} ${k}`);
});

test('폴백: 없는 언어·없는 키', () => {
  assert.strictEqual(t('fr', 'main.files.notFile'), strings.ko['main.files.notFile']);
  assert.strictEqual(t(undefined, 'main.files.notFile'), strings.ko['main.files.notFile']);
  assert.strictEqual(t('en', 'nope.key'), 'nope.key');
  strings.ko['__only.ko'] = '한국어만';
  try { assert.strictEqual(t('en', '__only.ko'), '한국어만'); } finally { delete strings.ko['__only.ko']; }
});

test('치환: 여러 변수, 없는 변수는 그대로, 0 도 넣는다', () => {
  assert.strictEqual(t('en', 'main.usage.http', { status: 0 }), 'Could not get usage (HTTP 0).');
  assert.strictEqual(t('ko', 'main.pty.noCwd', { cwd: 'C:\\a $& b' }), '작업 폴더 없음, 홈에서 시작: C:\\a $& b');
  assert.strictEqual(t('en', 'main.pty.noCwd', {}), 'Folder not found, started in home: {cwd}');
  assert.strictEqual(t('en', 'main.pty.noCwd'), 'Folder not found, started in home: {cwd}');
});

test('ko·en 의 {변수} 이름이 같다', () => {
  const vars = (s) => (s.match(/\{\w+\}/g) || []).sort();
  for (const k of Object.keys(strings.ko)) assert.deepStrictEqual(vars(strings.en[k] || ''), vars(strings.ko[k]), k);
});
