// board.json 읽기·쓰기. electron 의존 없음(단위 테스트용).
const fs = require('fs');

// 현재 형식 번호. 형식을 바꾸면 올리고 MIGRATIONS 에 변환을 추가한다.
const BOARD_VERSION = 1;
// 인덱스 i 는 (i+1) → (i+2) 변환. 건너뛴 업데이트에서도 순서대로 돈다.
const MIGRATIONS = [];

function migrate(board, migrations = MIGRATIONS, target = BOARD_VERSION) {
  let v = board.version ?? 1;
  // 새 버전 앱이 쓴 파일을 옛 앱이 읽는 경우 — 모르는 형식이니 손대지 않는다.
  if (v > target) return board;
  for (; v < target; v++) board = migrations[v - 1](board);
  return { ...board, version: target };
}

// 없으면 undefined, 깨졌으면 null. 읽기 오류(EPERM·EBUSY 등)는 던진다 — 정상 파일을 깨진 것으로 오인하지 않게.
function readJson(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return undefined; throw err; }
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

// 새 버전 앱이 쓴 파일인지. 옛 형식으로 덮어쓰지 않게 main 이 저장을 막는 데 쓴다.
const tooNew = (board) => (board?.version ?? 1) > BOARD_VERSION;

// 본 파일 → .bak → .tmp(두 rename 사이에서 죽었을 때의 최신 내용) 순으로 읽는다.
function loadBoard(file, log = console.error) {
  let main, err;
  try { main = readJson(file); } catch (e) { err = e; }
  if (main) return migrate(main);
  const why = err ? `읽히지 않아(${err.code})` : main === undefined ? '없어' : '깨져';
  for (const f of [file + '.bak', file + '.tmp']) {
    let b = null;
    try { b = readJson(f); } catch {}
    if (b) { log(`board.json 이 ${why} ${f} 으로 복구했습니다.`); return migrate(b); }
  }
  // 잠금 같은 일시적 오류를 "없음"으로 보면 renderer 가 빈 보드를 저장해 원본을 밀어낸다.
  if (err) throw err;
  return null;
}

// 백신·인덱서가 파일을 잠깐 잡는 경우가 있어 짧게 몇 번 다시 시도한다.
function retry(fn, tries = 5, ms = 50) {
  for (let i = 1; ; i++) {
    try { return fn(); } catch (err) {
      if (i >= tries || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    }
  }
}

function saveBoard(file, board) {
  // 읽기 오류면 여기서 던진다 — .bak·corrupt 처리 없이 저장 실패로 끝낸다.
  const cur = readJson(file);
  const tmp = file + '.tmp';
  const text = JSON.stringify({ ...board, version: BOARD_VERSION }, null, 2);
  retry(() => fs.writeFileSync(tmp, text));
  if (cur) retry(() => fs.copyFileSync(file, file + '.bak'));
  // 깨진 파일로 정상 .bak 을 덮어쓰면 마지막 사본을 잃는다. .bak 은 두고 깨진 파일은 수동 복구용으로 남긴다.
  else if (cur === null) { const dst = `${file}.corrupt-${Date.now()}`; retry(() => fs.renameSync(file, dst)); }
  // Node renameSync 는 Windows 에서도 대상 파일을 덮어쓴다.
  retry(() => fs.renameSync(tmp, file));
}

module.exports = { BOARD_VERSION, MIGRATIONS, migrate, tooNew, loadBoard, saveBoard };
