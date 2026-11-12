// 예약 실행(claude -p) 의 순수 부분: 권한 인자, 결과 파일 이름·내용, 폴더 신뢰 여부.
const path = require('path');

// 사람이 없을 때 도므로 예약마다 고른다. ask = Claude 기본(-p 에선 허용 안 된 도구는 거절).
// 전부 허용(--dangerously-skip-permissions)은 무인 실행 위험 때문에 두지 않는다.
const PERM_ARGS = {
  ask: [],
  read: ['--permission-mode', 'dontAsk', '--allowedTools', 'Read', 'Grep', 'Glob'],
  edit: ['--permission-mode', 'acceptEdits'],
};
// 화이트리스트: 모르는 값(프로토타입 키 포함)은 빈 인자
const permArgs = (perm) => (typeof perm === 'string' && Object.hasOwn(PERM_ARGS, perm) ? PERM_ARGS[perm] : []);

// 2026-11-12 14:05 → '2026-11-12-14-05' (현지 시각)
const stamp = (d) => d.toLocaleString('sv').replace(/[: ]/g, '-').slice(0, 16);
// 파일명 금지 문자·줄바꿈을 빼고 40자
const clean = (s) => String(s || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').trim().slice(0, 40).trim();
// '<제목> - <폴더 이름> <시각>.md'. 제목이 비거나 점으로만 되면 대체 이름, 폴더 이름이 그렇게 되면 뺀다.
// 같은 분에 같은 제목이 다른 폴더에서 돌아도 겹치지 않게 폴더 이름을 넣는다.
const schedFileName = (title, d, fallback, cwd) => {
  const t = clean(title), f = clean(path.basename(String(cwd || '').replace(/[\\/]+$/, '')));
  return `${/^\.*$/.test(t) ? fallback : t}${/^\.*$/.test(f) ? '' : ` - ${f}`} ${stamp(d)}.md`;
};
// dir/name 에 text 를 남긴다. 유일한 임시 파일에 쓴 뒤 link 로 붙인다 — 대상이 이미 있으면(EEXIST) 원자적으로 실패하므로
// 같은 이름이면 덮어쓰지 않고 ' -2', ' -3' … 을 붙인다. 쓴 경로를 돌려준다.
async function saveUnique(dir, name, text) {
  const fsp = require('fs').promises;
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${process.pid}-${require('crypto').randomBytes(6).toString('hex')}.tmp`);
  await fsp.writeFile(tmp, text);
  try {
    const base = name.replace(/\.md$/, '');
    for (let i = 1; i < 1000; i++) {
      const dest = path.join(dir, i === 1 ? name : `${base} -${i}.md`);
      try {
        await fsp.link(tmp, dest);
        return dest;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
    }
    throw new Error('too many files with the same name');
  } finally {
    await fsp.unlink(tmp).catch(() => {});
  }
}

// ~/.claude.json 의 projects 에서 cwd 나 그 상위 폴더가 신뢰(hasTrustDialogAccepted)됐는지
function trustedIn(projects, cwd, isWin) {
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  const key = (p) => (isWin ? norm(p).toLowerCase() : norm(p));
  const ok = new Set(Object.entries(projects || {}).filter(([, v]) => v?.hasTrustDialogAccepted).map(([k]) => key(k)));
  for (let p = norm(cwd); p && p !== '.'; ) {
    if (ok.has(key(p))) return true;
    const up = path.posix.dirname(p);
    if (up === p) break;
    p = up;
  }
  return false;
}

module.exports = { PERM_ARGS, permArgs, stamp, schedFileName, saveUnique, trustedIn };
