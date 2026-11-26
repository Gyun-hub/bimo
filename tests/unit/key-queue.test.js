const test = require('node:test');
const assert = require('node:assert');
const { createKeyQueue } = require('../../lib/key-queue');

// 타이머를 손으로 돌리는 가짜 setTimeout
const setup = () => {
  const out = [];
  const timers = [];
  const kq = createKeyQueue((id, d) => out.push(`${id}:${d}`), (fn) => timers.push(fn));
  const tick = () => timers.shift()?.();
  const flush = () => { while (timers.length) tick(); };
  return { out, kq, tick, flush };
};

test('큐가 없으면 바로 쓴다', () => {
  const { out, kq } = setup();
  kq.write('a', 'hi');
  assert.deepStrictEqual(out, ['a:hi']);
});

test('지우기 키 중에 들어온 write 는 키가 다 나간 뒤 순서대로', () => {
  const { out, kq, tick, flush } = setup();
  kq.keys('a', ['\x7f', '\x7f', '\x7f'], 6);
  tick();
  kq.write('a', 'ab');
  kq.write('a', 'c');
  kq.write('b', 'x'); // 다른 세션은 막지 않는다
  flush();
  assert.deepStrictEqual(out, ['a:\x7f', 'a:\x7f', 'b:x', 'a:\x7f', 'a:abc']);
  assert.strictEqual(kq.busy('a'), false);
  kq.write('a', 'd');
  assert.strictEqual(out.at(-1), 'a:d');
});

test('중첩 pty:keys 는 이어 붙는다', () => {
  const { out, kq, tick, flush } = setup();
  kq.keys('a', ['1', '2'], 6);
  kq.write('a', 'T');
  kq.keys('a', ['3'], 6);
  tick();
  flush();
  assert.deepStrictEqual(out, ['a:1', 'a:2', 'a:3', 'a:T']);
});

test('drop 하면 남은 키와 모은 글을 버리고 다음 write 는 바로 간다', () => {
  const { out, kq, tick, flush } = setup();
  kq.keys('a', ['1', '2', '3'], 6);
  kq.write('a', 'T');
  kq.drop('a');
  flush();
  assert.deepStrictEqual(out, ['a:1']);
  kq.keys('a', ['9'], 6); // 다시 띄운 pty 에 새 큐
  tick();
  assert.deepStrictEqual(out, ['a:1', 'a:9']);
  assert.strictEqual(kq.busy('a'), false);
});
