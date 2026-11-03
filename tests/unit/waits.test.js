const test = require('node:test');
const assert = require('node:assert');
const { startWait } = require('../../lib/waits');

test('done 은 여러 번 불려도 한 번만 끝낸다', async () => {
  const waits = new Map();
  let ends = 0;
  const { promise, done } = startWait(waits, 'n1', { callId: 1, name: 'a' }, 10000, { result: 'timeout' }, () => ends++);
  assert.strictEqual(waits.get('n1').callId, 1);
  done({ reply: 'first' });
  done({ reply: 'second' });
  waits.get('n1')?.done({ reply: 'third' });
  assert.deepStrictEqual(await promise, { reply: 'first' });
  assert.strictEqual(ends, 1);
  assert.strictEqual(waits.has('n1'), false);
});

test('옛 호출의 늦은 done 이 같은 노드의 새 대기를 지우지 않는다', async () => {
  const waits = new Map();
  const old = startWait(waits, 'n1', { callId: 1 }, 10000, null);
  old.done({ reply: 'old' });
  const cur = startWait(waits, 'n1', { callId: 2 }, 10000, null);
  old.done({ reply: 'late' }); // 예: 끊긴 연결의 close 가 늦게 옴
  assert.strictEqual(waits.get('n1')?.callId, 2);
  cur.done({ reply: 'new' });
  assert.deepStrictEqual(await cur.promise, { reply: 'new' });
  assert.strictEqual(waits.has('n1'), false);
});

test('시간이 지나면 timeoutResult 로 끝나고 대기를 지운다', async () => {
  const waits = new Map();
  let ends = 0;
  const { promise } = startWait(waits, 'n1', { callId: 7 }, 10, { result: 'timeout' }, () => ends++);
  assert.deepStrictEqual(await promise, { result: 'timeout' });
  assert.strictEqual(waits.has('n1'), false);
  assert.strictEqual(ends, 1);
});
