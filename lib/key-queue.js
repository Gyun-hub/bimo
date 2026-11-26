// 키를 한 개씩 보내는 중(프롬프트 지우기)에 친 글은 모아 뒀다가 다 보낸 뒤에 보낸다.
// Windows 타이머는 약 15ms 라 60키에 1초 가까이 걸리고, 그 사이 친 글이 뒤따르는 지우기 키에 지워졌다.
// write(id, data) 는 실제 pty 쓰기. drop(id) 은 pty 종료·다시 띄우기 때 남은 키와 모은 글을 버린다.
function createKeyQueue(write, wait = setTimeout) {
  const queues = new Map(); // id -> { keys, after }
  const typed = (id, data) => {
    const q = queues.get(id);
    if (q) q.after += data;
    else write(id, data);
  };
  const keys = (id, list, gap) => {
    if (queues.has(id)) return void queues.get(id).keys.push(...list);
    const q = { keys: [...list], after: '' };
    queues.set(id, q);
    const next = () => {
      if (queues.get(id) !== q) return; // 버려졌거나 새 큐로 바뀌었다
      if (q.keys.length) { write(id, q.keys.shift()); return void wait(next, gap); }
      queues.delete(id);
      if (q.after) write(id, q.after);
    };
    next();
  };
  return { write: typed, keys, drop: (id) => queues.delete(id), busy: (id) => queues.has(id) };
}

module.exports = { createKeyQueue };
