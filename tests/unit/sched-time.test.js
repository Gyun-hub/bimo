// 시간대 의존을 피하려 모든 시각을 로컬 Date 생성자로 만든다.
const test = require('node:test');
const assert = require('node:assert');
const { nextRun } = require('../../lib/sched-time');

const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
// 2026-11-13 은 금요일, 11-15 일요일, 11-16 월요일
const FRI = at(2026, 11, 13, 10, 0);

test('once: 미래면 start, 같은 시각·과거면 null', () => {
  const s = { repeat: 'once', start: at(2026, 11, 13, 12, 0) };
  assert.strictEqual(nextRun(s, FRI), s.start);
  assert.strictEqual(nextRun(s, s.start), null);
  assert.strictEqual(nextRun(s, s.start + 1), null);
});

test('hours: start 이전이면 start, 같은 시각이면 한 칸 뒤, 중간이면 다음 칸', () => {
  const start = at(2026, 11, 13, 9, 0);
  const s = { repeat: 'hours', start, hours: 3 };
  assert.strictEqual(nextRun(s, start - 1), start);
  assert.strictEqual(nextRun(s, start), at(2026, 11, 13, 12, 0));
  assert.strictEqual(nextRun(s, at(2026, 11, 13, 13, 30)), at(2026, 11, 13, 15, 0));
  assert.strictEqual(nextRun(s, at(2026, 11, 13, 15, 0)), at(2026, 11, 13, 18, 0));
});

test('daily: 오늘 그 시각 전이면 오늘, 같은 시각이면 다음 날', () => {
  const s = { repeat: 'daily', time: '10:00' };
  assert.strictEqual(nextRun(s, at(2026, 11, 13, 9, 59)), FRI);
  assert.strictEqual(nextRun(s, FRI), at(2026, 11, 14, 10, 0));
});

test('weekdays: 금요일 지났으면 월요일', () => {
  const s = { repeat: 'weekdays', time: '09:00' };
  assert.strictEqual(nextRun(s, FRI), at(2026, 11, 16, 9, 0));
  assert.strictEqual(nextRun(s, at(2026, 11, 14, 8, 0)), at(2026, 11, 16, 9, 0)); // 토요일
  assert.strictEqual(nextRun(s, at(2026, 11, 16, 8, 0)), at(2026, 11, 16, 9, 0));
});

test('weekly: 일요일(0) 지정', () => {
  const s = { repeat: 'weekly', time: '07:30', days: [0] };
  assert.strictEqual(nextRun(s, FRI), at(2026, 11, 15, 7, 30));
});

test('weekly: 같은 요일 시각이 지났으면 +7일', () => {
  const s = { repeat: 'weekly', time: '09:00', days: [5] };
  assert.strictEqual(nextRun(s, FRI), at(2026, 11, 20, 9, 0));
  assert.strictEqual(nextRun(s, at(2026, 11, 13, 9, 0)), at(2026, 11, 20, 9, 0)); // 같은 시각
  assert.strictEqual(nextRun(s, at(2026, 11, 13, 8, 0)), at(2026, 11, 13, 9, 0));
});

test('weekly: 요일 없으면 null', () => {
  assert.strictEqual(nextRun({ repeat: 'weekly', time: '09:00', days: [] }, FRI), null);
});

test('월말을 넘어가도 날짜가 맞다', () => {
  const s = { repeat: 'daily', time: '00:30' };
  assert.strictEqual(nextRun(s, at(2026, 11, 30, 23, 0)), at(2026, 12, 1, 0, 30));
});
