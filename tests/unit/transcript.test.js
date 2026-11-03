const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { transcriptMessages, interrupted, readTail, lastReplyText, lastReply } = require('../../lib/transcript');

const j = (o) => JSON.stringify(o);
const user = (content, extra) => j({ type: 'user', message: { content }, ...extra });
const asst = (content) => j({ type: 'assistant', message: { content } });
const STOP = '[Request interrupted by user for tool use]';

test('transcriptMessages: 역할별로 줄이고 깨진 줄·system-reminder·isMeta·handback 결과는 뺀다', () => {
  const text = [
    user('하자'),
    user('숨김', { isMeta: true }),
    '{"type":"user", 깨짐',
    user([{ type: 'text', text: '<system-reminder>x' }, { type: 'text', text: '둘' }]),
    asst([{ type: 'text', text: '  ' }, { type: 'text', text: '응' }, { type: 'tool_use', id: 't1', name: 'Read', input: { a: 1 } }]),
    user([{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ok' }], is_error: true }]),
    asst([{ type: 'tool_use', id: 'h', name: 'SubagentHandback', input: { message: '끝' } }]),
    user([{ type: 'tool_result', tool_use_id: 'h', content: '{"success":true}' }]),
    '',
  ].join('\n');
  assert.deepStrictEqual(transcriptMessages(text), [
    { role: 'user', text: '하자' },
    { role: 'user', text: '둘' },
    { role: 'assistant', text: '응' },
    { role: 'tool', name: 'Read', text: '{"a":1}' },
    { role: 'result', text: 'ok', error: true },
    { role: 'assistant', text: '끝' },
  ]);
});

test('transcriptMessages: 긴 결과는 6000자로 자른다', () => {
  const [m] = transcriptMessages(user([{ type: 'tool_result', tool_use_id: 'x', content: 'a'.repeat(7000) }]));
  assert.strictEqual(m.text.length, 6001);
});

test('interrupted: 마지막 항목이 중단 알림 user 글일 때만 true', () => {
  assert.strictEqual(interrupted([asst([{ type: 'text', text: '응' }]), user([{ type: 'text', text: STOP }])].join('\n')), true);
  assert.strictEqual(interrupted(user(STOP)), true); // 문자열 content
  // 중단 뒤 다른 항목이 오면(다시 이어감) false
  assert.strictEqual(interrupted([user(STOP), asst([{ type: 'text', text: '다시' }])].join('\n')), false);
  assert.strictEqual(interrupted([user(STOP), user([{ type: 'tool_result', tool_use_id: 'x', content: 'r' }])].join('\n')), false);
  // 중단 뒤 isMeta·system-reminder 만 오면 여전히 중단
  assert.strictEqual(interrupted([user(STOP), user('m', { isMeta: true }), user([{ type: 'text', text: '<system-reminder>r' }])].join('\n')), true);
  assert.strictEqual(interrupted(user('[Request interrupted') /* 다른 글 */), false);
  assert.strictEqual(interrupted(''), false);
});

test('interrupted: 쓰는 중인 마지막 줄은 무시한다', () => {
  assert.strictEqual(interrupted(`${user(STOP)}\n{"type":"assistant","mess`), true);
});

test('interrupted(partial): 잘린 첫 줄은 버린다', () => {
  // 첫 줄이 우연히 온전한 JSON 이어도 partial 이면 버린다
  assert.strictEqual(interrupted(user(STOP), true), false);
  assert.strictEqual(interrupted(`xx"}]}}\n${user(STOP)}\n`, true), true);
  // 64KB 넘는 한 줄만 있으면 판정 불가 → false
  assert.strictEqual(interrupted('a'.repeat(100), true), false);
});

test('lastReplyText: 마지막 assistant 텍스트·handback, 깨진 줄·user 는 건너뛴다', () => {
  const text = [
    asst([{ type: 'text', text: '처음' }]),
    asst([{ type: 'text', text: '답' }, { type: 'tool_use', id: 'h', name: 'SubagentHandback', input: { message: '보고' } }, { type: 'tool_use', name: 'Read', input: {} }]),
    user([{ type: 'tool_result', tool_use_id: 'h', content: 'ok' }]),
    '{"type":"assistant","mess',
    '',
  ].join('\n');
  assert.strictEqual(lastReplyText(text), '답\n보고');
  assert.strictEqual(lastReplyText(''), undefined);
  assert.strictEqual(lastReplyText(user('x')), undefined);
  // partial 이면 첫 줄은 온전해 보여도 버린다
  assert.strictEqual(lastReplyText(asst([{ type: 'text', text: '잘림' }]), true), undefined);
});

const tmpFile = (text) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bimo-tr-')), 't.jsonl');
  fs.writeFileSync(f, text);
  return f;
};

test('readTail: 끝 bytes 만 읽고 잘렸는지 알려준다', async () => {
  const f = tmpFile('abcdef');
  assert.deepStrictEqual(await readTail(f, 3), { text: 'def', partial: true });
  assert.deepStrictEqual(await readTail(f, 100), { text: 'abcdef', partial: false });
});

test('lastReply: 끝 일부에 답이 없으면 범위를 늘려 찾는다', async () => {
  const long = '긴 보고 '.repeat(20000); // 끝 1KB 보다 훨씬 큰 한 줄
  const f = tmpFile([asst([{ type: 'text', text: long }]), ...Array(50).fill(user('u'.repeat(100))), ''].join('\n'));
  assert.strictEqual(await lastReply(f, 1024), long);
  // 답 줄이 끝 범위 안이면 그대로
  const g = tmpFile([user('x'), asst([{ type: 'text', text: '짧음' }])].join('\n'));
  assert.strictEqual(await lastReply(g, 1024), '짧음');
});

test('lastReply: 답 없음·없는 파일·빈 경로는 undefined', async () => {
  assert.strictEqual(await lastReply(tmpFile(`${user('x')}\n`), 4), undefined);
  assert.strictEqual(await lastReply(path.join(os.tmpdir(), 'bimo-없는-파일.jsonl')), undefined);
  assert.strictEqual(await lastReply(undefined), undefined);
});
