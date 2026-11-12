// 예약 다음 실행 시각 계산 (순수 함수). main·테스트는 require 로, renderer 는 <script> 로 불러 window.SCHED_TIME 을 쓴다.
// s = { repeat: once|daily|weekdays|weekly|hours, start(ms), time 'HH:MM', days [0-6], hours }. after 보다 늦은 첫 시각(ms), 없으면 null.
(() => {
  function nextRun(s, after) {
    if (s.repeat === 'once') return s.start > after ? s.start : null;
    if (s.repeat === 'hours') {
      const step = s.hours * 3600 * 1000;
      return s.start > after ? s.start : s.start + (Math.floor((after - s.start) / step) + 1) * step;
    }
    const [h, m] = s.time.split(':').map(Number);
    for (let i = 0; i < 8; i++) {
      const d = new Date(after);
      d.setDate(d.getDate() + i);
      d.setHours(h, m, 0, 0);
      const wd = d.getDay();
      if (d.getTime() <= after || (s.repeat === 'weekdays' && (wd === 0 || wd === 6)) || (s.repeat === 'weekly' && !s.days.includes(wd))) continue;
      return d.getTime();
    }
    return null;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { nextRun };
  else window.SCHED_TIME = { nextRun };
})();
