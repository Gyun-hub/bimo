// 세션 호출 대기. 받는 노드 id 하나에 대기 하나(waits: id -> { callId, done, ...entry }).
// done 은 Stop 훅·시간 초과·pty 종료·보낸 쪽 연결 끊김 어디서든 불릴 수 있어 한 번만 끝내고,
// 그 사이 같은 노드에 새 호출이 걸렸으면 그 대기는 지우지 않는다.
function startWait(waits, id, entry, ms, timeoutResult, onEnd) {
  let done;
  const promise = new Promise((resolve) => {
    let over = false;
    done = (r) => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      if (waits.get(id)?.callId === entry.callId) waits.delete(id);
      onEnd?.();
      resolve(r);
    };
    const timer = setTimeout(() => done(timeoutResult), ms);
    waits.set(id, { ...entry, done });
  });
  return { promise, done };
}

module.exports = { startWait };
