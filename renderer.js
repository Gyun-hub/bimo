// 감지할 AI CLI. 설치된 것만 런처에 버튼으로 나온다. PowerShell 은 항상.
const AGENTS = [
  ['claude', 'Claude Code'], ['codex', 'Codex (GPT)'], ['gemini', 'Gemini'], ['qwen', 'Qwen Code'], ['opencode', 'OpenCode'],
  ['aider', 'Aider'], ['cursor-agent', 'Cursor'], ['copilot', 'Copilot'], ['amp', 'Amp'],
];
const LABELS = { '': 'PowerShell', ...Object.fromEntries(AGENTS) };
const smoke = new URLSearchParams(location.search).get('smoke');
const $ = (id) => document.getElementById(id);
const viewport = $('viewport');
const boardEl = $('board');
const Term = window.Terminal.Terminal || window.Terminal;
const nodes = new Map(); // id -> { data, el, term, fit, agents?, rack? }
const cards = new Map(); // 문서 카드 id -> { data: { id, path, x, y, w, h }, el, body } (아래 '문서 카드' 절)
let view = { x: 0, y: 0, scale: 1 };
let winBuild = 0; // Windows 빌드 번호, xterm windowsPty 옵션용
// Mac 에선 Ctrl 대신 Cmd (Ctrl+클릭은 Mac 에서 우클릭이다)
const isMac = api.platform === 'darwin';
const mod = (e) => (isMac ? e.metaKey : e.ctrlKey);
const MOD_KEY = isMac ? 'Meta' : 'Control';
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 4;
let topZ = 1;
let saveTimer;

const basename = (p) => (p ? p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : tr('ui.home'));
const el = (tag, cls, text) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, text != null ? { textContent: text } : {});

// 선택값은 이 PC 에서만 기억하는 편의 기능이라 localStorage 로 충분하다.
const pref = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
// 아무것도 기억된 게 없으면 처음 설치한 것(업데이트 안내를 띄우지 않는다)
const firstRun = (() => { try { return localStorage.length === 0; } catch { return false; } })();
// 화면 언어: 설정값 → OS 언어(ko 면 한국어, 그 밖은 영어). 바꾸면 다시 시작해야 적용된다(동적 화면이 많아 실시간으로 다시 그리지 않는다).
const lang = ['ko', 'en'].includes(pref.get('lang')) ? pref.get('lang') : /^ko/i.test(navigator.language) ? 'ko' : 'en';
const tr = (k, v) => LOCALES.t(lang, k, v);
api.setLang?.(lang);
const STATUS = { running: tr('ui.status.running'), done: tr('ui.status.done'), error: tr('ui.status.error'), stopped: tr('ui.status.stopped') };
// index.html 고정 문구를 현재 언어로 덮어쓴다. 코드가 나중에 바꾸는 글자(접기 버튼 등)는 그 코드가 다시 쓴다.
document.documentElement.lang = lang;
document.querySelectorAll('[data-i18n]').forEach((e) => { e.textContent = tr(e.dataset.i18n); });
document.querySelectorAll('[data-i18n-title]').forEach((e) => { e.title = tr(e.dataset.i18nTitle); });
document.querySelectorAll('[data-i18n-aria]').forEach((e) => e.setAttribute('aria-label', tr(e.dataset.i18nAria)));
document.querySelectorAll('[data-i18n-ph]').forEach((e) => { e.placeholder = tr(e.dataset.i18nPh); });
// CSS ::before/::after 글자는 변수로 넘긴다
document.documentElement.style.setProperty('--t-drop-cancel', JSON.stringify(tr('ui.import.dropCancel')));
document.documentElement.style.setProperty('--t-perm', JSON.stringify(`${tr('ui.inbox.perm')} · `));
// 터미널 글꼴 크기 10~20, 이상한 값은 기본 13
const fontSize = (v = pref.get('fontSize')) => Math.min(20, Math.max(10, Math.round(Number(v)) || 13));

// --- 보드 ---

let zsTimer;
function applyView() {
  const { x, y, scale: s } = view;
  boardEl.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
  viewport.style.backgroundSize = `${24 * s}px ${24 * s}px`;
  viewport.style.backgroundPosition = `${x}px ${y}px`;
  $('zoom').textContent = `${Math.round(s * 100)}%`;
  // 멀리 보기 덮개: 이름 글자는 배율을 거꾸로 곱해 화면에서 늘 비슷한 크기로
  boardEl.classList.toggle('far', s <= FAR_SCALE);
  boardEl.style.setProperty('--inv', 1 / s);
  // PDF 카드 역보정 배율(style.css .doc-card iframe). 확대일 때만 — 축소 때도 하면 뷰어 도구 막대가 화면 실제 크기로 그려져 세션보다 커 보인다.
  // 휠마다 바꾸면 PDF 가 매번 다시 그려져 버벅여 멈춘 뒤에 반영한다.
  clearTimeout(zsTimer);
  zsTimer = setTimeout(() => boardEl.style.setProperty('--zs', Math.max(1, view.scale)), 180);
  drawMinimap();
}

function save() {
  $('empty').hidden = nodes.size + cards.size > 0;
  renderSidebar();
  renderGroups();
  drawMinimap();
  syncRoster();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api.saveBoard(boardData()), 300);
}
// 창을 닫기 직전용. 300ms 디바운스를 기다리면 마지막 변경(훅이 바꾼 sessionId 등)이 저장되지 않는다.
function flushSave() {
  save();
  clearTimeout(saveTimer);
  api.saveBoard(boardData());
}

// board.json 에 저장하는 내용. 프로젝트 색(groupColors)도 여기 들어가 재실행해도 유지된다.
const boardData = () => ({ view, nodes: [...nodes.values()].map((n) => n.data), cards: [...cards.values()].map((c) => c.data), links, groupColors });

// --- 세션끼리 호출: 사용자가 케이블로 이은 세션만 서로 부를 수 있다 ---

let links = []; // { a, b } 노드 id, 방향 없음
const activeCalls = new Map(); // callId -> { from, to, wait }
const linksSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
linksSvg.id = 'links';
boardEl.prepend(linksSvg);

const portOf = (n) => ({ x: n.data.x, y: n.data.y + n.data.h / 2 });
// 서브 에이전트 카드 줄은 세션 창 아래에 붙는다(케이블 자리 RACK_GAP + 줄 높이). 줄 높이는 카드 크기·보기 모드를 따른다.
const RACK_GAP = 56;
const rackH = (n) => (n.rack ? RACK_GAP + n.rack.offsetHeight : 0);
const rightEdge = (n) => n.data.x + n.data.w;
const bottomEdge = (n) => n.data.y + n.data.h + rackH(n);
function cablePath(p, q, sides = 'll') {
  const bend = Math.max(80, Math.abs(q.x - p.x) * 0.4, Math.hypot(q.x - p.x, q.y - p.y) * 0.3);
  const c1 = sides === 'rl' ? p.x + bend : p.x - bend;
  return `M${p.x} ${p.y} C${c1} ${p.y} ${q.x - bend} ${q.y} ${q.x} ${q.y}`;
}
// 좌우로 떨어져 있으면 왼쪽 노드(랙 포함) 오른쪽 끝 -> 오른쪽 노드 플러그, 겹쳐 있으면 둘 다 왼쪽 플러그에서 바깥으로 돌린다
function linkPath(a, b) {
  const [l, r] = a.data.x <= b.data.x ? [a, b] : [b, a];
  if (r.data.x > rightEdge(l) + 40) return cablePath({ x: rightEdge(l), y: l.data.y + l.data.h * 0.7 }, portOf(r), 'rl');
  return cablePath(portOf(a), portOf(b));
}

function renderLinks(temp) {
  const ns = 'http://www.w3.org/2000/svg';
  const parts = [];
  // 복원 중엔 아직 안 만든 노드가 있으니 지우지 말고 그리기만 건너뛴다
  for (const l of links.filter((x) => nodes.has(x.a) && nodes.has(x.b))) {
    const d = linkPath(nodes.get(l.a), nodes.get(l.b));
    const live = [...activeCalls.values()].some((c) => (c.from === l.a && c.to === l.b) || (c.from === l.b && c.to === l.a));
    const g = document.createElementNS(ns, 'g');
    g.setAttribute('class', `link${live ? ' live' : ''}`);
    g.innerHTML = `<path class="hit" d="${d}"/><path class="cable" d="${d}"/><path class="pulse" d="${d}"/>`;
    const hit = g.querySelector('.hit');
    hit.innerHTML = `<title>${tr('ui.link.cut')}</title>`;
    hit.addEventListener('click', () => {
      links = links.filter((x) => x !== l);
      renderLinks();
      save();
    });
    parts.push(g);
  }
  if (temp) {
    const g = document.createElementNS(ns, 'g');
    g.setAttribute('class', 'link temp');
    g.innerHTML = `<path class="cable" d="${cablePath(temp.from, temp.to)}"/>`;
    parts.push(g);
  }
  linksSvg.replaceChildren(...parts);
  paintLinkStates();
}

// 세션 헤더의 [협업] 버튼: 없으면 빨강, 있으면 초록 + 마우스를 올리면 협업 중인 세션 이름
function paintLinkStates() {
  if (collabFor) renderCollab();
  for (const n of nodes.values()) {
    const peers = links
      .filter((l) => l.a === n.data.id || l.b === n.data.id)
      .map((l) => nodes.get(l.a === n.data.id ? l.b : l.a))
      .filter(Boolean);
    const b = n.el.querySelector('.link-state');
    b.classList.toggle('on', peers.length > 0);
    b.querySelector('.link-label').textContent = peers.length ? tr('ui.collab.count', { n: peers.length }) : tr('ui.collab.add');
    b.querySelector('.link-list').textContent = peers.length
      ? `${peers.map((p) => `@${p.data.name}`).join('\n')}\n\n${tr('ui.collab.listHint')}`
      : tr('ui.collab.none');
  }
}

// [협업] 버튼 → 다른 세션 목록. 체크 = 협업(케이블 연결), 풀기 = 끊기.
let collabFor = null;
const linked = (a, b) => links.some((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a));
function openCollab(n) {
  closeCollab();
  collabFor = n;
  n.el.querySelector('.link-state').classList.add('open'); // 목록이 떠 있는 동안 호버 목록은 숨긴다
  renderCollab();
  const pop = $('collab-pop');
  pop.hidden = false;
  const r = n.el.querySelector('.link-state').getBoundingClientRect();
  pop.style.top = `${r.bottom + 6}px`;
  pop.style.left = `${Math.max(8, Math.min(r.right - pop.offsetWidth, innerWidth - pop.offsetWidth - 8))}px`;
}
function closeCollab() {
  collabFor?.el.querySelector('.link-state').classList.remove('open');
  collabFor = null;
  $('collab-pop').hidden = true;
}
function renderCollab() {
  const n = collabFor;
  if (!nodes.has(n.data.id)) return closeCollab();
  const others = [...nodes.values()].filter((m) => m !== n);
  const list = others.map((m) => {
    const row = el('label', 'collab-row');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = linked(n.data.id, m.data.id);
    box.addEventListener('change', () => {
      if (box.checked) addLink(n, m);
      else {
        links = links.filter((l) => !((l.a === n.data.id && l.b === m.data.id) || (l.a === m.data.id && l.b === n.data.id)));
        renderLinks();
        save();
      }
    });
    row.append(box, el('span', 'collab-name', `@${m.data.name}`), el('span', 'collab-meta', `${LABELS[m.data.command] ?? m.data.command}, ${basename(m.data.cwd)}`));
    return row;
  });
  const pick = el('button', 'collab-pick', tr('ui.collab.pick'));
  pick.addEventListener('click', () => { closeCollab(); startLinkMode(n); });
  $('collab-pop').replaceChildren(
    el('div', 'collab-title', tr('ui.collab.title', { name: n.data.name })),
    ...(list.length ? list : [el('p', 'collab-none', tr('ui.collab.empty'))]),
    pick,
  );
}
addEventListener('pointerdown', (e) => { if (collabFor && !e.target.closest('#collab-pop, .link-state')) closeCollab(); }, true);
addEventListener('keydown', (e) => { if (e.key === 'Escape' && collabFor) closeCollab(); });

function startLink(e, n) {
  e.stopPropagation();
  const r = viewport.getBoundingClientRect();
  const toBoard = (ev) => ({ x: (ev.clientX - r.left - view.x) / view.scale, y: (ev.clientY - r.top - view.y) / view.scale });
  let last = { clientX: e.clientX, clientY: e.clientY };
  drag(e, (dx, dy) => {
    last = { clientX: last.clientX + dx, clientY: last.clientY + dy };
    renderLinks({ from: portOf(n), to: toBoard(last) });
  }, () => {
    addLink(n, nodeOfEl.get(document.elementFromPoint(last.clientX, last.clientY)?.closest('.node')));
    renderLinks();
  });
}

function addLink(a, b) {
  if (!a || !b || a === b) return;
  if (links.some((l) => (l.a === a.data.id && l.b === b.data.id) || (l.b === a.data.id && l.a === b.data.id))) return;
  links.push({ a: a.data.id, b: b.data.id });
  renderLinks();
  save();
}

// 협업 목록의 [보드에서 눌러 고르기] → 상대 세션을 누르면 연결. Esc·빈 곳 클릭으로 취소.
let linkFrom = null;
function startLinkMode(n) {
  endLinkMode();
  linkFrom = n;
  n.el.classList.add('link-source');
  document.body.classList.add('linking');
  $('link-hint').hidden = false;
}
function endLinkMode() {
  linkFrom?.el.classList.remove('link-source');
  linkFrom = null;
  document.body.classList.remove('linking');
  $('link-hint').hidden = true;
}

// 메인 프로세스(MCP 요청 처리)가 쓸 세션 목록. 권한을 묻는 중인 세션은 입력창이 아니라 권한 창이 떠 있으니 일하는 중으로 알린다.
// 보내기 바의 대상 목록도 같은 시점에 갱신한다(사이드바가 닫혀 있어도).
function syncRoster() {
  renderCastTargets();
  const roster = [...nodes.values()].map((n) => ({
    id: n.data.id,
    name: n.data.name,
    agent: LABELS[n.data.command] ?? n.data.command,
    command: n.data.command,
    folder: n.data.cwd || '홈 폴더',
    state: n.exited ? 'exited' : n.state === 'waiting' && n.waitKind === 'permission' ? 'working' : effectiveState(n) ?? 'idle',
  }));
  api.setRoster(roster, links);
}

api.onCallStart((c) => { activeCalls.set(c.callId, c); renderLinks(); });
api.onCallEnd((id) => { activeCalls.delete(id); renderLinks(); });

// 세션 이름 바꾸기: 헤더 이름 더블클릭 → 입력칸. Enter 저장, Esc 취소. 다른 세션과 같은 이름은 안 된다.
function renameSession(n) {
  const span = n.el.querySelector('.where');
  const input = el('input', 'rename');
  input.value = n.data.name;
  input.maxLength = 50;
  input.spellcheck = false;
  span.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (keep) => {
    if (done) return;
    const v = input.value.trim().replace(/^@+/, '').replace(/\s+/g, ' ');
    const dup = [...nodes.values()].some((m) => m !== n && m.data.name.toLowerCase() === v.toLowerCase());
    if (keep && v && dup) {
      input.classList.add('bad');
      input.title = tr('ui.rename.dup');
      return false;
    }
    done = true;
    if (keep && v && v !== n.data.name) {
      n.data.name = v;
      rememberName(n);
      save();
    }
    span.textContent = n.data.name;
    input.replaceWith(span);
    paintLinkStates();
    return true;
  };
  input.addEventListener('pointerdown', (e) => e.stopPropagation()); // 헤더 끌기로 가지 않게
  input.addEventListener('input', () => input.classList.remove('bad'));
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => { if (finish(true) === false) finish(false); });
}

// 바꾼 세션 이름을 대화 id 로 기억한다. 세션 가져오기 목록에서 그 이름으로 보이고 찾아진다.
let sessNames = {};
try { sessNames = JSON.parse(pref.get('sessNames', '{}')); } catch {}
const nameOfSession = (agent, id) => sessNames[`${agent}:${id}`];
function rememberName(n) {
  if (!n.data.sessionId) return;
  sessNames[`${n.data.command}:${n.data.sessionId}`] = n.data.name;
  pref.set('sessNames', JSON.stringify(sessNames));
}

// 에이전트가 부를 세션 이름. 폴더 이름을 쓰고 겹치면 뒤에 번호를 붙인다.
function uniqueName(base) {
  const taken = new Set([...nodes.values()].map((n) => n.data.name));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`)) return `${base} ${i}`;
}

function drag(e, onMove, onEnd) {
  e.preventDefault();
  document.body.classList.add('dragging'); // 끄는 동안 문서 카드 iframe 이 포인터를 가로채지 않게
  let lx = e.clientX, ly = e.clientY;
  const move = (ev) => { onMove(ev.clientX - lx, ev.clientY - ly, ev); lx = ev.clientX; ly = ev.clientY; };
  // pointercancel(터치·창 전환 등)으로 끝나도 같이 정리해 body.dragging 이 남지 않게
  const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up); document.body.classList.remove('dragging'); onEnd?.(); save(); };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
  addEventListener('pointercancel', up);
}

// 크기 조절 한 걸음(보드 좌표). 왼쪽·위로 늘리면 위치도 같이 옮겨 반대편이 제자리에 있게 한다.
function resizeBy(data, d, dx, dy, minW, minH) {
  if (d.includes('e')) data.w = Math.max(minW, data.w + dx);
  if (d.includes('s')) data.h = Math.max(minH, data.h + dy);
  if (d.includes('w')) { const w = Math.max(minW, data.w - dx); data.x += data.w - w; data.w = w; }
  if (d.includes('n')) { const h = Math.max(minH, data.h - dy); data.y += data.h - h; data.h = h; }
}

// 세션 창 마그넷: 다른 창의 가장자리에서 화면 기준 14px 안이면 붙인다.
// 가로: 왼쪽끼리·오른쪽끼리 맞추기, 옆에 SNAP_GAP 띄워 붙이기 / 세로도 같은 방식.
const SNAP_GAP = 16;
function snapTo(n, x, y) {
  const t = 14 / view.scale;
  const { w } = n.data, h = n.data.h + rackH(n); // 끄는 노드의 카드 줄도 다른 창에 겹치지 않게
  let bx = null, by = null;
  for (const m of [...nodes.values(), ...cards.values()]) {
    if (m === n) continue;
    const o = m.data, oR = o.x + o.w, oB = bottomEdge(m);
    // 세로로 겹치거나 가까운 창만 가로로 붙이고, 가로로 겹치거나 가까운 창만 세로로 붙인다
    const nearY = y < oB + t + SNAP_GAP && y + h > o.y - t - SNAP_GAP;
    const nearX = x < oR + t + SNAP_GAP && x + w > o.x - t - SNAP_GAP;
    if (nearY) for (const cx of [oR + SNAP_GAP, o.x - w - SNAP_GAP, o.x, oR - w]) {
      if (Math.abs(cx - x) < t && (bx == null || Math.abs(cx - x) < Math.abs(bx - x))) bx = cx;
    }
    if (nearX) for (const cy of [oB + SNAP_GAP, o.y - h - SNAP_GAP, o.y, oB - h]) {
      if (Math.abs(cy - y) < t && (by == null || Math.abs(cy - y) < Math.abs(by - y))) by = cy;
    }
  }
  return { x: bx ?? x, y: by ?? y };
}

function place(n) {
  const { x, y, w, h } = n.data;
  Object.assign(n.el.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
  // 크기 조절 중 마우스 이동마다 맞추지 않고 한 프레임에 한 번만
  if (!n.fitPending) {
    n.fitPending = true;
    requestAnimationFrame(() => { n.fitPending = false; n.fit.fit(); });
  }
  if (n.rack) {
    const cx = w / 2, d = `M${cx} 4 L${cx} ${RACK_GAP - 4}`;
    n.el.querySelectorAll('.wire path').forEach((p) => p.setAttribute('d', d));
    for (const [cls, cy] of [['.plug-a', 4], ['.plug-b', RACK_GAP - 4]]) {
      const plug = n.el.querySelector(cls);
      plug.setAttribute('cx', cx);
      plug.setAttribute('cy', cy);
    }
  }
  if (links.some((l) => l.a === n.data.id || l.b === n.data.id)) renderLinks();
  renderGroups();
}

let focused = null;
function setFocused(n) {
  n.el.style.zIndex = ++topZ;
  // 나를 기다리던 세션을 열어 보면 확인한 것으로 친다
  if (n.state === 'waiting') setState(n, n.waitKind === 'permission' ? 'working' : 'idle');
  // 트리 맞추기는 여기서 하지 않는다 — insertPaths 등이 부르면 사이드바에서 펴 둔 다른 프로젝트 트리가 바뀐다.
  // 사용자가 카드를 직접 누를 때(addNode pointerdown)와 enterSession·focusNode 에서만 syncFilesTo 를 부른다.
  if (focused === n) return;
  focused?.el.classList.remove('focused');
  focused = n;
  n.el.classList.add('focused');
}
// 파일 탭을 보고 있으면 그 세션의 프로젝트 트리로 바꾼다
function syncFilesTo(n) {
  if (!$('sidebar').hidden && !$('side-files').hidden && n.data.cwd && !(fx.root && samePath(n.data.cwd, fx.root))) openFiles(n.data.cwd);
}

// --- 세션 상태: 빨강 = 일하는 중, 노랑 = 나를 기다림(답 옴·권한 요청), 초록 = 대기 ---

function effectiveState(n) {
  if (n.exited || (!n.state && !isBusy(n))) return null;
  if (n.state === 'waiting') return 'waiting';
  if (n.state === 'working' || isBusy(n)) return 'working';
  return 'idle';
}

function paintState(n) {
  const s = effectiveState(n);
  n.el.classList.remove('st-working', 'st-waiting', 'st-idle');
  if (s) n.el.classList.add(`st-${s}`);
  s === 'working' ? wander(n) : stopWander(n);
  paintCritter(n);
  renderInbox();
  renderSidebar();
  drawMinimap();
  syncRoster();
}

// --- 새 응답 미니 창: 나를 기다리는(노랑) 세션 목록. 누르면 그 세션으로 가고 목록에서 빠진다 ---
// 답변 미리보기 한 줄: 제목(#) 줄은 건너뛰고 본문 첫 줄. 본문이 없으면 제목이라도.
const firstLine = (t) => {
  const lines = (t || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const pick = lines.find((l) => !l.startsWith('#')) ?? lines[0] ?? '';
  return pick.replace(/[#*`>|]/g, '').replace(/^[-\d.]+\s+/, '').trim();
};
// 한 줄 = [AI 로고 타일] 세션 이름 · 시간. 최신이 위. 올리면 잠깐 이동, 누르면 이동.
function inboxItem(n) {
  const li = el('li', n.waitKind === 'permission' ? 'perm' : null);
  const tile = el('span', 'sess st-waiting');
  tile.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">${glyphOf(n.data.command)}</svg><i></i>`;
  li.append(tile, el('span', 'ib-name', n.data.name), el('span', 'ib-time', n.waitAt ? ago(n.waitAt) : ''));
  li.title = `${tr(n.waitKind === 'permission' ? 'ui.inbox.perm' : 'ui.inbox.reply')}${n.waitText ? `: ${n.waitText}` : ''}
${tr('ui.peekHint')}`;
  li.addEventListener('pointerenter', () => peekAt(n));
  li.addEventListener('click', () => enterSession(n));
  return li;
}
// 칩에 마우스만 올리면 보드 화면을 그 세션 입력칸 줄이 화면 2/3 높이에 오게 100% 로 옮긴다(위로 답변이 보이게).
// 확인 처리·포커스는 하지 않는다. 칩 줄을 벗어나면 원래 보던 화면으로 돌아간다.
let peekFrom = null;
// 입력칸 줄의 보드 y 좌표: 커서가 입력칸 표시(Claude ❯ / Codex ›) 줄에 있으면 그 줄,
// 아니면 화면에 보이는 줄 중 아래에서부터 그 표시로 시작하는 줄, 없으면 커서 줄.
// Claude 는 › 를 보지 않는다 — "› Message from @서브에이전트" 같은 대화 줄을 입력칸으로 잘못 잡는다.
function promptY(n) {
  const t = n.term, b = t.buffer.active;
  t.scrollToBottom(); // 위로 스크롤해 둔 터미널이면 입력칸이 화면 밖에 있다
  const mark = n.data.command === 'claude' ? /^\s*❯/ : /^\s*[❯›]/;
  const isPrompt = (i) => mark.test(b.getLine(b.viewportY + i)?.translateToString(true) ?? '');
  let row = b.cursorY;
  if (!isPrompt(row)) for (let i = t.rows - 1; i >= 0; i--) if (isPrompt(i)) { row = i; break; }
  const cell = t._core._renderService.dimensions.css.cell.height;
  const top = (t.element.getBoundingClientRect().top - n.el.getBoundingClientRect().top) / view.scale;
  return n.data.y + top + (row + 0.5) * cell;
}
function peekAt(n) {
  peekFrom ??= { ...view };
  if (docActive) $('docs').hidden = true; // 파일 화면을 보는 중이면 잠깐 보드를 보여 준다
  const py = promptY(n); // 배율을 바꾸기 전에 잰다
  const vw = viewport.clientWidth, vh = viewport.clientHeight;
  view.scale = 1;
  view.x = vw / 2 - (n.data.x + n.data.w / 2);
  view.y = vh * 0.66 - py;
  applyView();
}
// 그 세션으로 들어간다: 입력칸이 보이게 옮기고(peekAt 과 같은 자리) 확인 처리 + 입력 포커스
function enterSession(n) {
  if (docActive) showDoc(null);
  peekAt(n);
  peekFrom = null;
  save();
  syncFilesTo(n); // 이미 고른 세션이어도 트리가 다른 폴더로 바뀌어 있을 수 있어 직접 맞춘다
  setFocused(n);
  n.term.focus();
}
function endPeek() {
  if (!peekFrom) return;
  if (docActive) $('docs').hidden = false;
  Object.assign(view, peekFrom);
  peekFrom = null;
  applyView();
}
function renderInbox() {
  const list = [...nodes.values()].filter((n) => effectiveState(n) === 'waiting').sort((a, b) => (b.waitAt || 0) - (a.waitAt || 0));
  $('inbox').hidden = !list.length;
  $('inbox-count').textContent = list.length;
  $('inbox-list').replaceChildren(...list.map(inboxItem));
}
$('inbox').addEventListener('pointerleave', endPeek);
// 사이드바: 로고 타일 밖으로 나가면 원래 화면으로 (목록이 다시 그려져도 되게 위임으로 본다)
$('side-list').addEventListener('pointerover', (e) => { if (!e.target.closest('.sess')) endPeek(); });
$('side-list').addEventListener('pointerleave', endPeek);
setInterval(() => { if (!$('inbox').hidden) renderInbox(); }, 60000); // "n분 전" 갱신

function setState(n, state, waitKind) {
  n.state = state;
  n.waitKind = waitKind;
  paintState(n);
}

// 처음 신뢰한 폴더는 그 순간 ~/.claude.json 에 등록된다. 목록에 없는 폴더의 세션이 움직이면 사이드바 목록을 다시 읽는다.
let foldersTimer = 0;
function onHook(n, e) {
  if (!n.foldersChecked && n.data.cwd && !folders.some((f) => samePath(f.path, n.data.cwd))) {
    n.foldersChecked = true; // 목록 읽기는 git 상태까지 보느라 무거워 세션마다 한 번만
    clearTimeout(foldersTimer);
    foldersTimer = setTimeout(refreshFolders, 1500);
  }
  // /clear 등으로 세션이 바뀌면 이어하기 대상도 바꾼다
  if (!e.agent_id && e.session_id && e.session_id !== n.data.sessionId) {
    const named = nameOfSession(n.data.command, n.data.sessionId);
    n.data.sessionId = e.session_id;
    if (named) rememberName(n);
    save();
  }
  switch (e.hook_event_name) {
    case 'SessionStart': setState(n, 'idle'); break;
    case 'UserPromptSubmit': setState(n, 'working'); break;
    case 'PreToolUse': if (!e.agent_id && n.state !== 'working') setState(n, 'working'); break;
    case 'Notification':
      n.waitAt = Date.now();
      n.waitText = e.message || tr('ui.inbox.asking');
      setState(n, 'waiting', 'permission');
      break;
    case 'Stop':
      n.waitAt = Date.now();
      n.waitText = firstLine(e.last_assistant_message);
      setState(n, focused === n && document.hasFocus() ? 'idle' : 'waiting', 'reply');
      if (!n.waitText && e.transcript_path) api.readTranscript(e.transcript_path).then((t) => {
        n.waitText = firstLine(t?.findLast?.((x) => x.role === 'assistant')?.text);
        renderInbox();
      });
      break;
    case 'Usage':
      if (!e.usage) return;
      n.data.usage = e.usage;
      renderTokens(n);
      save();
      return;
  }
  onAgentEvent(n, e);
}

const fmtTokens = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : String(v));
function renderTokens(n) {
  const u = n.data.usage;
  const t = n.el.querySelector('.tokens');
  if (!u) return (t.textContent = '');
  t.textContent = tr('ui.tokens.total', { n: fmtTokens(u.input + u.output + u.cacheRead + u.cacheWrite) });
  t.title = tr('ui.tokens.detail', { input: fmtTokens(u.input), output: fmtTokens(u.output), cr: fmtTokens(u.cacheRead), cw: fmtTokens(u.cacheWrite) });
}

// --- 세션 창 위 픽셀 캐릭터(모든 세션, 귀여움용) ---
// 네 캐릭터(프롬프트 박스·말랑 슬라임·병아리·꼬마 유령) 중 하나가 세션마다 나온다. 기분(세션 상태)마다 고유한 동작:
//   일하는 중 = 산책, 나를 기다림(권한 요청) = 부르기, 응답 끝 = 기뻐하기, 대기 = 졸기, 종료 = 회색으로 졸기.
// 그림은 글자 지도(한 글자 = 한 칸, '.' = 빈칸)로 그리고 0.45초마다 장면을 바꾼다. 가로 위치는 wander 가 정한다.
const CR_PX = 5;
const crSvg = (rows, pal) => {
  let r = '';
  rows.forEach((row, y) => [...row].forEach((ch, x) => { if (pal[ch]) r += `<rect x="${x}" y="${y}" width="1" height="1" fill="${pal[ch]}"/>`; }));
  return `<svg width="${rows[0].length * CR_PX}" height="${rows.length * CR_PX}" viewBox="0 0 ${rows[0].length} ${rows.length}" shape-rendering="crispEdges">${r}</svg>`;
};
const critterMood = (n) => {
  if (n.exited) return 'exited';
  const s = effectiveState(n);
  if (s === 'waiting') return n.waitKind === 'permission' ? 'waiting' : 'done';
  return s === 'working' ? 'working' : 'idle';
};

// 프롬프트 박스: 화면 속 글자가 얼굴. >_  ?_?  !_!  ^_^  o_o  -_-
const BOX_GLYPH = {
  '>': ['g..', '.g.', 'g..', '...', '...'],
  '?': ['gg.', '..g', '.g.', '...', '.g.'],
  '!': ['.g.', '.g.', '.g.', '...', '.g.'],
  '^': ['...', '.g.', 'g.g', '...', '...'],
  'o': ['...', 'ggg', 'g.g', 'ggg', '...'],
  '-': ['...', '...', 'ggg', '...', '...'],
  ' ': ['...', '...', '...', '...', '...'],
};
const boxRows = (l, r, cursor, step) => [
  'BBBBBBBBBBBBBB',
  ...[0, 1, 2, 3, 4].map((y) => `B.${BOX_GLYPH[l][y]}.${y === 4 && cursor ? 'gg' : '..'}.${BOX_GLYPH[r][y]}.B`.replace(/\./g, 'K')),
  'BBBBBBBBBBBBBB',
  ...(step ? ['.L..........L.', '...L......L...'] : ['..L........L..', '..L........L..']),
];
const boxPal = (g) => ({ B: '#8fb8de', K: '#1e2a3d', g, L: '#8fb8de' });

const SLIME_PAL = { X: '#4fd1c5', h: '#c8fff7', e: '#0f2b2b', m: '#2c7a7b', D: '#2c7a7b' };
const SLIME = {
  normal: ['....XXXX....', '..XXXXXXXX..', '.XhXXXXXXXX.', '.XhXeXXXeXX.', 'XXXXeXXXeXXX', 'XXXXXXmXXXXX', 'XXXXXXXXXXXX', '.DDDDDDDDDD.', '............'],
  happy: ['....XXXX....', '..XXXXXXXX..', '.XhXXXXXXXX.', '.XhXeXXXeXX.', 'XXXeXeXeXeXX', 'XXXXXmmXXXXX', 'XXXXXXXXXXXX', '.DDDDDDDDDD.', '............'],
  droop: ['............', '............', '............', '....XXXX....', '.XXXXXXXXXX.', 'XhXeeXXXeeXX', 'XXXXXXmXXXXX', 'DDDDDDDDDDDD', '.DDDDDDDDDD.'],
};

const CHICK_PAL = { Y: '#f6d365', e: '#1b1b1b', b: '#f08c2e', w: '#d9b04a', l: '#f08c2e' };
const chickRows = (eyes, step) => [
  '....YYYY....', eyes === 'happy' ? '...YYeYYY...' : '...YYYYYY...',
  eyes === 'happy' ? '..YYeYeYYY..' : eyes === 'sleep' ? '..YYeeYYYY..' : '..YYYeYYYY..',
  '..YYYYYYYbb.', '.YYYYYYYYY..', '.YwwYYYYYY..', '.YYwYYYYYY..', '..YYYYYYY...',
  ...(step ? ['...l....l...', '..ll....ll..'] : ['....l..l....', '...ll..ll...']),
];

const GHOST_PAL = { G: '#e8ecf3', e: '#2a2f3a', p: '#f4a7b9' };
const GHOST = {
  normal: ['...GGGGGG...', '..GGGGGGGG..', '.GGGGGGGGGG.', '.GGeGGGGeGG.', '.GGeGGGGeGG.', '.GpGGGGGGpG.', '.GGGGGGGGGG.', '.GGGGGGGGGG.', '.G.GG.GG.GG.', '............'],
  wave: ['...GGGGGG...', '..GGGGGGGG..', '.GGGGGGGGGG.', '.GGeGGGGeGG.', '.GGeGGGGeGG.', '.GpGGGGGGpG.', '.GGGGGGGGGG.', '.GGGGGGGGGG.', '.GG.GG.GG.G.', '............'],
  boo: ['...GGGGGG...', 'G.GGGGGGGG.G', 'GGGGGGGGGGGG', '.GeeGGGGeeG.', '.GeeGGGGeeG.', '.GGGeeeeGGG.', '.GGGeeeeGGG.', '.GGGGGGGGGG.', '.G.GG.GG.GG.', '............'],
  happy: ['...GGGGGG...', '..GGGGGGGG..', '.GGGGGGGGGG.', '.GGGeGGeGGG.', '.GGeGeeGeGG.', '.GpGGGGGGpG.', '.GGGGeeGGGG.', '.GGGGGGGGGG.', '.G.GG.GG.GG.', '............'],
  sleep: ['...GGGGGG...', '..GGGGGGGG..', '.GGGGGGGGGG.', '.GGGGGGGGGG.', '.GeeGGGGeeG.', '.GpGGGGGGpG.', '.GGGGGGGGGG.', '.GGGGGGGGGG.', '.G.GG.GG.GG.', '............'],
};
const ghostBoo = (t) => t % 12 >= 8;

// frame(기분, 박자, 걷는 중) → [지도, 색], motion = 몸에 붙일 움직임, fx = 그 박자에 띄울 효과, look = 서서 좌우를 두리번
const CRITTERS = {
  box: {
    name: tr('ui.critter.box'),
    frame(mood, t, walking) {
      if (mood === 'working') {
        const [l, r] = t % 40 > 32 ? (t % 80 > 40 ? ['o', 'o'] : ['^', '^']) : ['>', ' '];
        return [boxRows(l, r, l !== '>' || t % 4 < 2, walking && t % 2), boxPal('#7ee787')];
      }
      if (mood === 'waiting') return [boxRows('?', '?', true), boxPal('#67e8f9')];
      if (mood === 'done') { const m = t % 8 < 4 ? '!' : '^'; return [boxRows(m, m, true), boxPal('#f2c94c')]; }
      return [boxRows('-', '-', t % 8 < 4), boxPal('#7c8696')];
    },
    motion: { working: 'bob', waiting: 'hop', done: 'bigjump', idle: '' },
    fx: { idle: (t) => t % 10 === 0 && ['zz', 'z', 62, 38] },
  },
  slime: {
    name: tr('ui.critter.slime'),
    frame: (mood) => [mood === 'done' ? SLIME.happy : mood === 'idle' || mood === 'exited' ? SLIME.droop : SLIME.normal, SLIME_PAL],
    motion: { working: 'hop', waiting: 'bigjump', done: 'wobble', idle: '' },
    fx: { idle: (t) => t % 8 === 0 && ['drop', '', 54, 26] },
  },
  chick: {
    name: tr('ui.critter.chick'),
    frame: (mood, t, walking) => [chickRows(mood === 'done' ? 'happy' : mood === 'idle' || mood === 'exited' ? 'sleep' : 'open', walking && t % 2), CHICK_PAL],
    motion: { working: '', waiting: 'hop', done: 'hop', idle: '' },
    fx: {
      done: (t) => t % 2 === 0 && ['heart', '♥', 10 + Math.random() * 40, 40 + Math.random() * 10],
      idle: (t) => t % 10 === 0 && ['zz', 'z', 56, 42],
    },
    look: { waiting: true },
  },
  ghost: {
    name: tr('ui.critter.ghost'),
    frame(mood, t) {
      if (mood === 'waiting' && ghostBoo(t)) return [GHOST.boo, GHOST_PAL];
      if (mood === 'done') return [GHOST.happy, GHOST_PAL];
      if (mood === 'idle' || mood === 'exited') return [GHOST.sleep, GHOST_PAL];
      return [t % 4 < 2 ? GHOST.normal : GHOST.wave, GHOST_PAL];
    },
    motion: { working: 'float', waiting: (t) => (ghostBoo(t) ? 'boo' : 'float'), done: 'float', idle: 'ghosty' },
    fx: {
      waiting: (t) => t % 12 === 8 && ['bubble', tr('ui.critter.boo'), 52, 52],
      done: (t) => t % 3 === 0 && ['spark', '✦', Math.random() * 60, 30 + Math.random() * 20],
      idle: (t) => t % 10 === 0 && ['zz', 'z', 60, 46],
    },
  },
};
const CRITTER_KINDS = Object.keys(CRITTERS);
let critterKind = pref.get('critterKind', 'random'); // random 이면 세션 창을 띄울 때마다(앱을 다시 켤 때도) 무작위
const pickCritter = () => (CRITTERS[critterKind] ? critterKind : CRITTER_KINDS[Math.floor(Math.random() * CRITTER_KINDS.length)]);
// 처음 서 있는 자리와 박자는 캐릭터마다 무작위로(여러 마리가 똑같이 움직이지 않게)
const critterHtml = (kind) => `<div class="critter" aria-hidden="true" data-kind="${kind}" data-seed="${Math.floor(Math.random() * 40)}"><div class="cr-move" style="left: ${10 + Math.round(Math.random() * 50)}%"><div class="cr-body"></div></div></div>`;
let crittersOn = pref.get('critters', '1') === '1';
document.body.classList.toggle('no-critters', !crittersOn);

function critterFx(c, [cls, text, x, y]) {
  const e = el('div', `cr-fx ${cls}`, text);
  e.style.left = `${c.querySelector('.cr-move').offsetLeft + x}px`;
  e.style.bottom = `${y}px`;
  e.style.setProperty('--dx', `${(Math.random() - 0.5) * 40}px`);
  c.append(e);
  setTimeout(() => e.remove(), 3600);
}
let critterBeat = 0;
function paintCritter(n) {
  const c = n.el.querySelector('.critter');
  if (!c) return;
  const k = CRITTERS[c.dataset.kind], mood = critterMood(n), t = critterBeat + Number(c.dataset.seed);
  const walking = c.classList.contains('walking');
  const body = c.firstChild.firstChild;
  const html = crSvg(...k.frame(mood, t, walking));
  if (body.dataset.html !== html) { body.innerHTML = html; body.dataset.html = html; }
  const m = k.motion[mood];
  const cls = `cr-body ${mood === 'exited' ? '' : typeof m === 'function' ? m(t) : m ?? ''}`.trim();
  if (body.className !== cls) body.className = cls;
  c.classList.toggle('gone', mood === 'exited');
  if (!walking && k.look?.[mood]) c.classList.toggle('left', t % 12 > 5);
  const f = mood !== 'exited' && !document.hidden && !matchMedia('(prefers-reduced-motion: reduce)').matches && k.fx?.[mood]?.(t);
  if (f) critterFx(c, f);
}
setInterval(() => {
  if (!crittersOn) return;
  critterBeat++;
  for (const n of nodes.values()) paintCritter(n);
}, 450);

// 일하는 중이면 산책: 가까운 곳을 골라 천천히 걸어가고, 도착하면 잠깐 서 있다가 다시 걷는다.
// 상태가 바뀌면 그 자리에서 멈춘다(자기·폴짝도 그 자리에서). 위치는 CSS 가 아니라 여기서 left 로 정한다.
const WALK_SPEED = 22; // 화면 px/초
function wander(n) {
  const c = n.el.querySelector('.critter');
  if (!c || n.wanderT || effectiveState(n) !== 'working' || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const step = () => {
    const mv = c.querySelector('.cr-move');
    const max = Math.max(0, c.clientWidth - mv.offsetWidth);
    const cur = mv.offsetLeft;
    const dist = 30 + Math.random() * 90; // 한 번에 몇 걸음만
    let dir = Math.random() < 0.5 ? -1 : 1;
    if (cur + dir * dist < 0 || cur + dir * dist > max) dir = -dir;
    const to = Math.max(0, Math.min(max, cur + dir * dist));
    const dur = Math.abs(to - cur) / WALK_SPEED;
    c.classList.add('walking');
    c.classList.toggle('left', to < cur);
    mv.style.transition = `left ${dur}s linear`;
    mv.style.left = `${to}px`;
    n.wanderT = setTimeout(() => {
      c.classList.remove('walking');
      n.wanderT = setTimeout(step, 900 + Math.random() * 2200); // 잠깐 쉬었다가
    }, dur * 1000);
  };
  step();
}
function stopWander(n) {
  if (!n.wanderT) return;
  clearTimeout(n.wanderT);
  n.wanderT = 0;
  const c = n.el.querySelector('.critter');
  if (!c) return;
  const mv = c.querySelector('.cr-move');
  mv.style.transition = '';
  mv.style.left = `${mv.offsetLeft}px`; // 걷던 도중이면 지금 자리에 멈춘다
  c.classList.remove('walking');
}

async function addNode(data) {
  if (nodes.has(data.id)) return; // 같은 id 로 두 번 만들면 pty 가 덮어써져 종료 때 정리되지 않는다
  // claude 는 앱이 세션 id 를 정해 두고 다음 실행 때 그 id 로 이어한다
  if (data.command === 'claude') data.sessionId ??= crypto.randomUUID();
  data.name ??= uniqueName(basename(data.cwd));
  const node = el('div', 'node');
  node.innerHTML = `<div class="head"><span class="agent"></span><span class="where"></span><span class="tokens"></span><span class="ended">${tr('ui.node.ended')}</span><button class="restart">${tr('ui.node.restart')}</button><button class="files-btn icon-btn" title="${tr('ui.node.filesTitle')}" aria-label="${tr('ui.node.files')}"><svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg></button><button class="close" aria-label="${tr('ui.node.close')}">×</button><button class="link-state"><span class="link-label"></span><span class="link-list"></span></button></div><div class="body"></div>${['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map((d) => `<div class="rz rz-${d}" data-dir="${d}"></div>`).join('')}<div class="port" title="${tr('ui.node.port')}"></div>${critterHtml(pickCritter())}`;
  node.querySelector('.agent').textContent = LABELS[data.command] ?? data.command;
  node.querySelector('.agent').title = tr('ui.node.switchAgent');
  // 카드 안에서 다른 CLI 를 직접 치면 Bimo 가 모른다(훅·세션 id 없음) → 이름을 눌러 그 AI 로 다시 실행 (2026-10-31 사용자 버그)
  node.querySelector('.agent').addEventListener('click', (e) => {
    if (n.dragMoved) return;
    const key = `agent:${data.id}`;
    if (groupMenuFor === key) return closeGroupMenu();
    showMenu(key, [el('div', 'gm-label', tr('ui.node.switchAgent')), ...agentItems((c) => switchAgent(n, c), true)], e.currentTarget);
  });
  node.querySelector('.where').textContent = data.name;
  node.querySelector('.where').title = `${data.cwd || tr('ui.home')}\n${tr('ui.node.renameHint')}`;
  node.querySelector('.where').addEventListener('dblclick', () => renameSession(n));
  boardEl.appendChild(node);

  const term = new Term({
    fontFamily: 'Cascadia Mono, Consolas, Menlo, monospace',
    fontSize: fontSize(),
    // ConPTY 뒤라는 걸 알려야 크기를 바꿀 때 xterm 이 ConPTY 와 다르게 줄을 다시 감지 않는다(글자 어긋남·선택 위치 틀어짐 방지)
    ...(isMac ? { macOptionClickForcesSelection: true } : { windowsPty: { backend: 'conpty', buildNumber: winBuild } }),
    theme: { background: '#1b1d23', foreground: '#e6e8ec', cursor: '#f0c94a', selectionBackground: '#ffffff26' },
    // AI 가 OSC 8 로 건 링크(Claude 의 "여기에 만들었어" 링크 등). 보이는 글자가 경로가 아니어도 주소로 연다.
    linkHandler: { allowNonHttpProtocols: true, activate: (e, uri) => { if (mod(e)) openLink(uri); }, hover: () => { n.overLink = true; }, leave: () => { n.overLink = false; } },
  });
  const openLink = async (uri) => {
    if (/^https?:/i.test(uri)) return api.openUpdate(uri);
    let p = uri, line = 0;
    if (/^file:/i.test(uri)) {
      const u = new URL(uri);
      p = decodeURIComponent(u.pathname);
      if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
      line = Number(u.hash.match(/\d+/)?.[0]) || 0;
    }
    const m = p.match(/^(.*?):(\d+)(?::\d+)?$/);
    if (m && !/^[A-Za-z]$/.test(m[1])) [p, line] = [m[1], Number(m[2])];
    const [abs] = await api.resolveFiles(data.cwd, [p]);
    if (abs) openViewer(n, abs, line);
  };
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(node.querySelector('.body'));
  const n = { data, el: node, term, fit };
  nodes.set(data.id, n);
  nodeOfEl.set(node, n);
  place(n);
  fit.fit(); // pty 를 처음부터 맞는 크기로 띄우도록 바로 한 번
  save();

  // 직접 누르면 이미 고른 세션이어도 트리를 이 세션 폴더로 되돌린다 (2026-10-31 사용자 요청, 10-28 "B" 보완)
  node.addEventListener('pointerdown', () => { syncFilesTo(n); setFocused(n); });
  setFocused(n);
  paintLinkStates();
  node.querySelector('.head').addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    // 마그넷: 끌던 위치(raw)는 따로 쌓고, 다른 세션 가장자리 근처면 거기에 붙인다. Alt 를 누르면 끈다.
    let rx = data.x, ry = data.y;
    n.dragMoved = false; // 끈 뒤의 click 은 AI 이름 메뉴를 열지 않는다
    drag(e, (dx, dy, ev) => {
      if (dx || dy) n.dragMoved = true;
      rx += dx / view.scale;
      ry += dy / view.scale;
      const s = ev.altKey ? { x: rx, y: ry } : snapTo(n, rx, ry);
      data.x = s.x;
      data.y = s.y;
      place(n);
    });
  });
  node.querySelector('.port').addEventListener('pointerdown', (e) => startLink(e, n));
  node.querySelector('.link-state').addEventListener('click', () => {
    if (linkFrom === n) return endLinkMode();
    collabFor === n ? closeCollab() : openCollab(n);
  });
  node.querySelector('.files-btn').addEventListener('click', () => openFiles(data.cwd));
  // 테두리·모서리 어디서든 크기 조절
  const MIN_W = 320, MIN_H = 200;
  for (const h of node.querySelectorAll('.rz')) h.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    const d = h.dataset.dir;
    drag(e, (dx, dy) => {
      resizeBy(data, d, dx / view.scale, dy / view.scale, MIN_W, MIN_H);
      place(n);
    });
  });
  node.querySelector('.close').addEventListener('click', () => {
    if (focused === n) focused = null;
    selection.delete(data.id);
    links = links.filter((l) => l.a !== data.id && l.b !== data.id);
    queueMicrotask(renderLinks); // 노드를 지운 뒤 남은 세션들의 연결 표시를 고친다
    stopWander(n);
    clearTimeout(n.switchTimer);
    n.rack?.querySelectorAll('.agent-card').forEach((card) => cardResize.unobserve(card));
    api.kill(data.id);
    term.dispose();
    node.remove();
    nodes.delete(data.id);
    renderInbox();
    save();
  });

  // Windows: Ctrl+V(·Ctrl+Shift+V) 로 붙여넣기. 클립보드에 글자가 없으면(이미지 등) Ctrl+V 를 그대로 앱에 넘긴다.
  // Mac 은 Cmd+V 가 메뉴로 이미 된다.
  // 터미널 글자 속 파일 경로 → Ctrl(Mac ⌘)+클릭으로 파일 서랍에서 열기. 실제로 있는 파일만 링크가 된다.
  term.registerLinkProvider({
    provideLinks(y, done) {
      // 한 줄의 글자와 글자마다의 화면 칸. 한글 같은 두 칸 글자 때문에 글자 순서 ≠ 화면 칸.
      const lineAt = (yy) => {
        const row = term.buffer.active.getLine(yy - 1);
        if (!row) return null;
        let text = '';
        const at = [];
        for (let c = 0; c < row.length; c++) {
          const cell = row.getCell(c);
          if (!cell || cell.getWidth() === 0) continue;
          const ch = cell.getChars() || ' ';
          for (const _ of ch) at.push({ x: c + 1, y: yy });
          text += ch;
        }
        return { text, at };
      };
      // 오른쪽 끝까지 찬 줄은 다음 줄로 이어진다고 본다(긴 경로가 창 폭에서 꺾인 것). 이어 붙여서 찾는다.
      const full = (l) => { const k = l?.text.trimEnd().length; return !!k && l.at[k - 1].x >= term.cols - 1; };
      let top = y, bottom = y;
      while (top > 1 && y - top < 4 && full(lineAt(top - 1))) top--;
      while (bottom - y < 4 && full(lineAt(bottom)) && lineAt(bottom + 1)) bottom++;
      let line = '';
      const at = [];
      for (let yy = top; yy <= bottom; yy++) {
        const l = lineAt(yy);
        const skip = yy === top ? 0 : l.text.length - l.text.trimStart().length; // 이어진 줄의 앞 들여쓰기는 뺀다
        line += (yy === bottom ? l.text : l.text.trimEnd()).slice(skip);
        at.push(...l.at.slice(skip, yy === bottom ? undefined : l.text.trimEnd().length));
      }
      const found = [...line.matchAll(PATH_RE)]
        .map((m) => ({ text: m[0], file: m[1], line: Number(m[2]) || 0, a: at[m.index], b: at[m.index + m[0].length - 1] }))
        .filter((f) => f.a.y <= y && f.b.y >= y);
      if (!found.length) return done(undefined);
      api.resolveFiles(data.cwd, found.map((f) => f.file)).then((abs) => done(found.flatMap((f, i) => (abs[i] ? [{
        text: f.text,
        range: { start: f.a, end: f.b },
        decorations: { underline: true, pointerCursor: true },
        activate: (e) => { if (mod(e)) openViewer(n, abs[i], f.line); },
        hover: () => { n.overLink = true; },
        leave: () => { n.overLink = false; },
      }] : []))));
    },
  });
  // 캡처 이미지 붙여넣기: 임시 PNG 로 저장해 그 경로를 넣는다. Claude 는 경로를 [Image #N] 으로 바꾸고 다른 AI 는 경로로 읽는다.
  // Claude 의 Alt+V 는 클립보드를 PowerShell 로 읽어 느리다(실측 0.8초 vs 경로 0.2초).
  const pasteImage = async (png) => {
    const f = await api.saveImage(await png.arrayBuffer());
    term.paste(/\s/.test(f) ? `"${f}" ` : `${f} `);
  };
  const pasteInto = async () => {
    const t = await api.readClipboard();
    if (t) return term.paste(t);
    const png = await clipboardPng();
    if (png) return pasteImage(png);
    api.write(data.id, '\x16');
  };
  // 입력한 프롬프트 통째로 지우기: Windows Alt+Backspace, Mac Cmd+Backspace
  // AI 화면(Claude·Codex·Cursor)은 Ctrl+U 가 커서 줄만 지우므로 "줄 끝 → 줄 지우기 → 윗줄과 합치기" 를 여러 번 보낸다.
  // 한 번에 몰아 보내면 붙여넣기로 읽혀 무시되므로 한 키씩 띄워 보낸다. 셸은 Windows Esc(PSReadLine 줄 되돌리기), Mac Ctrl+U.
  const clearPrompt = () => {
    if (!IMPORT_AGENTS.includes(data.command)) return api.write(data.id, isMac ? '\x15' : '\x1b');
    api.writeKeys(data.id, [...'\x05\x15\x7f'.repeat(20)], 6);
  };
  term.attachCustomKeyEventHandler((e) => {
    // Space: 톡 누르면 공백, 꾹 누르면(반복 keydown) 이동 모드. 공백은 keyup·다음 키 직전에 보내 순서를 지킨다. 한글 조합 중(229)은 건드리지 않는다.
    if (e.code === 'Space' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      if (e.type === 'keydown') {
        if (!e.repeat) { flushSpace(); spacePend = () => term.input(' '); }
        else if (spacePend) { spacePend = null; if (tool !== 'hand') { spaceHand = true; setTool('hand', true); } }
        else if (!spaceHand) return true; // 이미 공백을 보낸 뒤의 반복(다른 키가 끼었을 때)은 예전처럼 공백
        e.preventDefault(); // keypress·input 으로 공백이 새지 않게
      } else if (e.type === 'keyup') flushSpace();
      return false;
    }
    if (e.type === 'keydown') flushSpace();
    if (e.key === 'Backspace' && (isMac ? e.metaKey && !e.ctrlKey : e.altKey && !e.ctrlKey && !e.metaKey)) {
      if (e.type === 'keydown') {
        e.preventDefault();
        clearPrompt();
      }
      return false;
    }
    if (isMac) return true;
    const ctrlV = e.code === 'KeyV' && e.ctrlKey && !e.altKey && !e.metaKey;
    const shiftIns = e.code === 'Insert' && e.shiftKey && !e.ctrlKey && !e.altKey;
    if (!ctrlV && !shiftIns) return true;
    if (e.type === 'keydown') {
      e.preventDefault();
      pasteInto();
    }
    return false;
  });
  // Mac 의 Cmd+V 는 메뉴가 처리해 paste 이벤트로 온다. 글자 없이 이미지만 있으면 가로챈다.
  if (isMac) node.querySelector('.body').addEventListener('paste', (e) => {
    const types = [...(e.clipboardData?.types ?? [])];
    if (types.includes('text/plain') || !types.includes('Files')) return;
    const file = [...e.clipboardData.files].find((f) => f.type.startsWith('image/'));
    if (!file) return;
    e.preventDefault();
    e.stopPropagation();
    pasteImage(file);
  }, true);
  // 오른쪽 클릭: 고른 글자가 있으면 복사, 없으면 붙여넣기 (Windows 터미널과 같은 방식)
  if (!isMac) node.querySelector('.body').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (term.hasSelection()) {
      copySelection(n, true);
      term.clearSelection();
    } else {
      pasteInto();
    }
  });
  // mouseup 을 놓쳐도(드래그 중 Alt+Tab 등) 복사되게 선택이 멈추면 한 번 더 복사한다. 드래그 중에는 기다린다.
  term.onSelectionChange(() => {
    clearTimeout(n.selTimer);
    if (!term.hasSelection()) return void (n.copied = ''); // 지웠다가 같은 글자를 다시 고르면 다시 복사
    n.selTimer = setTimeout(() => mouseTerm !== n && copySelection(n), 120);
  });
  term.onData((d) => {
    api.write(data.id, d);
    // shortcut: Esc 로 응답을 끊으면 Stop 훅이 오지 않는다. Esc 단독 입력을 중단으로 보고 대기로 돌린다.
    if (d === '\x1b' && n.state === 'working') setState(n, 'idle');
  });
  // pty 크기는 조절이 멈춘 뒤 한 번만 바꾼다. 연달아 바꾸면 ConPTY 가 화면을 다시 그리다 꼬인다.
  term.onResize(({ cols, rows }) => {
    clearTimeout(n.resizeTimer);
    clearTimeout(n.resyncTimer);
    n.resizeTimer = setTimeout(() => api.resize(data.id, cols, rows), 80);
    // 번들 ConPTY 가 연달아 온 크기 변경을 가끔 놓쳐 pty 와 화면 칸 수가 어긋난다 → 잠시 뒤 지금 크기를 한 번 더(같은 값이면 무해)
    n.resyncTimer = setTimeout(() => api.resize(data.id, term.cols, term.rows), 400);
  });
  const start = async () => {
    const warn = await api.spawn({ id: data.id, command: data.command, cwd: data.cwd, cols: term.cols, rows: term.rows, sessionId: data.sessionId });
    if (warn) term.write(`\x1b[33m${warn.error ?? warn}\x1b[0m\r\n`);
    // 실행 실패({ error })면 pty 가 없다 → 끝난 카드로 둔다(AI 바꾸기·다시 시작이 exit 를 기다리지 않게)
    if (warn?.error) { n.exited = true; node.classList.add('exited'); paintState(n); }
  };
  n.restart = () => {
    if (n.switching) return; // AI 바꾸는 중엔 onExit 가 띄운다
    n.exited = false;
    node.classList.remove('exited');
    term.write(`\r\n\x1b[90m[${tr('ui.node.restart')}]\x1b[0m\r\n`);
    setState(n, null);
    start();
  };
  node.querySelector('.restart').addEventListener('click', n.restart);
  renderTokens(n);
  await start();
}

// 보드를 transform: scale 로 줌하면 xterm 이 마우스 좌표를 배율만큼 어긋나게 계산한다(선택 영역이 드래그 위치와 다름).
// 터미널 마우스 이벤트의 좌표를 배율로 되돌려 넘긴다. 드래그가 터미널 밖으로 나가도 이어지게 캡처 단계에서 처리한다.
const nodeOfEl = new WeakMap(); // .node 요소 -> 노드
let mouseTerm = null; // 마우스 버튼을 누른 터미널
function unscale(e, n) {
  if (view.scale === 1) return;
  const r = n.el.querySelector('.xterm-screen')?.getBoundingClientRect();
  if (!r) return;
  Object.defineProperty(e, 'clientX', { value: r.left + (e.clientX - r.left) / view.scale });
  Object.defineProperty(e, 'clientY', { value: r.top + (e.clientY - r.top) / view.scale });
}
for (const type of ['mousedown', 'mousemove', 'mouseup', 'click', 'dblclick', 'contextmenu']) {
  addEventListener(type, (e) => {
    if (type === 'mousedown') mouseTerm = null; // 놓친 mouseup 이 남긴 값이 새 클릭을 엉뚱한 터미널로 보내지 않게
    const n = mouseTerm ?? nodeOfEl.get(e.target.closest?.('.xterm')?.closest('.node'));
    if (!n) return;
    if (type === 'mousedown') mouseTerm = n;
    unscale(e, n);
    // 앱이 마우스 모드를 켜면(claude 전체 화면 등) xterm 은 Shift 드래그만 선택으로 받는다 → 그냥 드래그도 선택이 되게 Shift 로 바꿔 준다.
    // Alt+드래그는 그대로 앱에 넘긴다. 휠은 손대지 않아 앱 스크롤이 된다.
    // Mac 의 xterm 은 Shift 대신 Option(Alt) 드래그를 선택으로 받으므로 Alt 로 바꾸고, 앱에 넘기는 키는 Shift 가 된다.
    if (n.term.modes.mouseTrackingMode !== 'none' && e.button === 0 && !e.altKey && !e.shiftKey) {
      if (type === 'mousedown') n.term.clearSelection(); // Shift 클릭은 선택 늘리기라, 새 드래그가 이전 선택을 늘리지 않게
      Object.defineProperty(e, isMac ? 'altKey' : 'shiftKey', { value: true });
    }
    if (type === 'mouseup') {
      mouseTerm = null;
      setTimeout(() => copySelection(n, true)); // xterm 이 선택을 확정한 뒤. 직접 뗀 드래그는 같은 글자여도 다시 복사(그사이 클립보드가 바뀌었을 수 있다)
    }
  }, true);
}
// 창이 포커스를 잃거나 포인터가 취소되면 mouseup 이 오지 않는다 → 드래그를 끝난 것으로 보고 복사한다
const releaseMouse = () => {
  const n = mouseTerm;
  mouseTerm = null;
  if (n) setTimeout(() => copySelection(n));
};
addEventListener('blur', releaseMouse);
addEventListener('pointercancel', releaseMouse, true);

// 터미널에서 드래그·더블클릭으로 고른 글자는 바로 클립보드로. mouseup 과 선택 변경이 겹쳐도 같은 글자는 한 번만 (force = 오른쪽 클릭·mouseup)
function copySelection(n, force) {
  const s = n.term.hasSelection() ? n.term.getSelection() : '';
  if (!s || (!force && s === n.copied)) return;
  n.copied = s;
  api.copy(s);
  toast(tr('ui.toast.copied'), 'copy');
}

// 여러 세션 고르기: Ctrl+세션 클릭으로 넣고 빼기. 고른 세션은 보내기 바의 대상이 된다.
const selection = new Set(); // node id
function setSelection(ids) {
  selection.clear();
  ids.forEach((id) => selection.add(id));
  for (const n of nodes.values()) n.el.classList.toggle('selected', selection.has(n.data.id));
  renderCastTargets();
  if (selection.size) {
    $('cast-to').value = 'sel';
    $('cast-text').focus();
  }
}

const pan = (dx, dy) => {
  document.body.classList.add('panning'); // 끄는 동안 쥔 손 커서
  view.x += dx;
  view.y += dy;
  applyView();
};
addEventListener('pointerup', () => document.body.classList.remove('panning'));

// 선택(V) 모드 빈 곳 클릭 = 선택 해제. 보드 이동은 H 모드·휠 버튼 드래그·휠로 한다 (멀리 보기는 빈 곳 끌기도).
viewport.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if (e.target !== viewport && e.target !== boardEl && !e.target.closest('.group-frame, .group-cover')) return;
  document.activeElement?.blur(); // 터미널 포커스를 풀어야 H/V 단축키가 터미널로 가지 않는다
  if (linkFrom) return endLinkMode();
  if (selection.size) setSelection([]);
  // 멀리 보기에선 빈 곳 끌기도 보드 이동 (덮개 끌기는 dragGroup 이 맡는다)
  if (boardEl.classList.contains('far') && !e.target.closest('.group-cover')) drag(e, pan);
});

// 연결 모드에서 세션 클릭 = 연결 / Ctrl+세션 클릭 = 고르기·빼기. 터미널로 클릭이 가지 않게 캡처 단계에서 막는다.
boardEl.addEventListener('pointerdown', (e) => {
  if (linkFrom) {
    const target = nodeOfEl.get(e.target.closest('.node'));
    if (!target || e.target.closest('.link-state')) return; // 빈 곳은 viewport 쪽에서 취소, 연결 버튼 다시 누르면 버튼이 끈다
    e.preventDefault();
    e.stopPropagation();
    addLink(linkFrom, target);
    endLinkMode();
    return;
  }
  if (!mod(e) || tool === 'hand') return;
  const n = nodeOfEl.get(e.target.closest('.node'));
  if (!n || e.target.closest('button, .port, .rack')) return;
  if (n.overLink) return; // 터미널 속 파일 링크 위면 Ctrl+클릭은 링크 열기
  e.preventDefault();
  e.stopPropagation();
  const ids = new Set(selection);
  if (!ids.delete(n.data.id)) ids.add(n.data.id);
  setSelection([...ids]);
}, true);

// --- 같은 프로젝트(같은 저장소, 워크트리 포함) 세션이 둘 이상이면 테두리로 묶는다 ---

const groupsEl = el('div');
groupsEl.id = 'groups';
boardEl.prepend(groupsEl);

// 세션이 속한 프로젝트 = 워크트리면 원래 저장소, 아니면 그 폴더
function projectOf(n) {
  if (!n.data.cwd) return { key: '', name: tr('ui.home') };
  const root = folders.find((x) => samePath(x.path, n.data.cwd))?.worktreeOf || n.data.cwd;
  return { key: root.replace(/[\\/]+$/, '').toLowerCase(), name: basename(root) };
}

// 프로젝트 색: 사용자가 고른 색(groupColors) > 이름으로 정한 기본색(상태색과 안 겹치는 파랑~보라~청록)
let groupColors = {}; // 프로젝트 key -> hue
const DEFAULT_HUES = [205, 250, 280, 185, 225, 310];
const PALETTE = [
  [210, tr('ui.color.blue')], [235, tr('ui.color.navy')], [265, tr('ui.color.violet')], [295, tr('ui.color.purple')], [325, tr('ui.color.pink')],
  [185, tr('ui.color.teal')], [160, tr('ui.color.mint')], [95, tr('ui.color.lime')], [40, tr('ui.color.orange')], [0, tr('ui.color.red')],
];
function groupHue(key, name) {
  if (groupColors[key] != null) return groupColors[key];
  const hash = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  return DEFAULT_HUES[hash % DEFAULT_HUES.length];
}

function openColorPicker(key, anchor) {
  const pop = $('color-pop');
  const r = anchor.getBoundingClientRect();
  const vr = viewport.getBoundingClientRect();
  Object.assign(pop.style, { left: `${r.left - vr.left}px`, top: `${r.bottom - vr.top + 6}px` });
  const swatches = PALETTE.map(([hue, label]) => {
    const b = el('button', 'swatch');
    b.style.setProperty('--hue', hue);
    b.title = label;
    b.setAttribute('aria-label', label);
    if (groupColors[key] === hue) b.setAttribute('aria-pressed', 'true');
    b.addEventListener('click', () => { groupColors[key] = hue; closeColorPicker(); renderGroups(); save(); });
    return b;
  });
  const reset = el('button', 'swatch-reset', tr('ui.color.reset'));
  reset.addEventListener('click', () => { delete groupColors[key]; closeColorPicker(); renderGroups(); save(); });
  pop.replaceChildren(...swatches, reset);
  pop.hidden = false;
}
function closeColorPicker() { $('color-pop').hidden = true; }
addEventListener('pointerdown', (e) => { if (!$('color-pop').hidden && !e.target.closest('#color-pop, .group-label')) closeColorPicker(); }, true);

// 프로젝트 세션 전체를 끌어 옮긴다. 움직이지 않고 놓으면 onClick. 놓을 때 drag() 가 저장한다.
function dragGroup(e, list, onClick) {
  let moved = false;
  drag(e, (dx, dy) => {
    moved = true;
    for (const n of list) { n.data.x += dx / view.scale; n.data.y += dy / view.scale; place(n); }
  }, () => { if (!moved) onClick?.(); });
}

function renderGroups() {
  const byProject = new Map();
  for (const n of nodes.values()) {
    const { key, name } = projectOf(n);
    const g = byProject.get(key) ?? { name, list: [] };
    g.list.push(n);
    byProject.set(key, g);
  }
  const frames = [];
  const covers = [];
  for (const [key, { name, list }] of byProject) {
    const pad = 24;
    const x = Math.min(...list.map((n) => n.data.x)) - pad;
    const y = Math.min(...list.map((n) => n.data.y)) - pad - 32; // 이름 배지 자리
    const r = Math.max(...list.map(rightEdge)) + pad;
    const b = Math.max(...list.map(bottomEdge)) + pad;
    const hue = groupHue(key, name);
    // 멀리서 볼 때(배율이 낮을 때) 덮는 반투명 판 + 프로젝트 이름. 세션 하나짜리 프로젝트도 덮는다.
    const cover = el('div', 'group-cover');
    Object.assign(cover.style, { left: `${x}px`, top: `${y}px`, width: `${r - x}px`, height: `${b - y}px` });
    cover.style.setProperty('--hue', hue);
    cover.append(el('span', 'cover-name', name));
    // 덮개 끌기 = 프로젝트 세션 전체 이동. 이동(H) 모드도 같다 (viewport 캡처가 덮개는 넘겨 준다).
    cover.addEventListener('pointerdown', (e) => { if (e.button === 0) dragGroup(e, list); });
    covers.push(cover);
    const frame = el('div', 'group-frame');
    Object.assign(frame.style, { left: `${x}px`, top: `${y}px`, width: `${r - x}px`, height: `${b - y}px` });
    frame.style.setProperty('--hue', hue);
    const label = el('button', 'group-label', tr('ui.group.label', { name, n: list.length }));
    label.title = tr('ui.group.labelTitle');
    // 끌기 = 프로젝트 세션 전체 이동, 그냥 누르기 = 색 고르기
    label.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation(); // 보드 이동으로 가지 않게
      dragGroup(e, list, () => openColorPicker(key, label));
    });
    const add = el('button', 'group-add', '+');
    add.title = tr('ui.group.addTitle', { name });
    add.setAttribute('aria-label', add.title);
    add.setAttribute('aria-haspopup', 'menu');
    add.addEventListener('pointerdown', (e) => e.stopPropagation());
    add.addEventListener('click', () => (groupMenuFor === key ? closeGroupMenu() : openGroupMenu(key, name, list, add)));
    const tag = el('div', 'group-tag');
    tag.append(label, add);
    const kill = el('button', 'group-close', tr('ui.group.closeAll'));
    kill.title = tr('ui.group.closeAllTitle', { name, n: list.length });
    kill.addEventListener('pointerdown', (e) => e.stopPropagation());
    kill.addEventListener('click', () => closeGroup(name, list));
    frame.append(tag, kill);
    frames.push(frame);
  }
  groupsEl.replaceChildren(...frames);
  coversEl.replaceChildren(...covers);
}

// 덮개 층은 세션들 위(노드 z-index 보다 높게). 층 자체는 클릭을 통과시키고, 멀리 보기의 덮개만 받는다.
const coversEl = el('div');
coversEl.id = 'covers';
boardEl.append(coversEl);
const FAR_SCALE = 0.45; // 이 배율 이하면 멀리 보기: 프로젝트 이름으로 덮는다

// 피그마식 도구: V = 선택, H = 이동(손). 이동 모드에선 세션 위에서 끌어도 보드가 움직인다.
let tool = 'select';
// 모드가 바뀌면 화면 가운데에 잠깐 띄웠다가 사라지게 한다(맥 볼륨 표시처럼). Space 로 잠깐 이동할 때는 띄우지 않는다.
let modeHudT = 0;
function setTool(t, quiet) {
  const changed = tool !== t;
  tool = t;
  document.body.classList.toggle('hand', t === 'hand');
  $('tool-select').setAttribute('aria-pressed', t === 'select');
  $('tool-hand').setAttribute('aria-pressed', t === 'hand');
  if (!changed || quiet) return;
  const hud = $('mode-hud');
  hud.querySelector('kbd').textContent = t === 'hand' ? 'H' : 'V';
  hud.querySelector('span').textContent = tr(t === 'hand' ? 'ui.mode.hand' : 'ui.mode.select');
  hud.classList.remove('show');
  void hud.offsetWidth; // 연달아 바꿔도 처음부터 다시 보이게
  hud.classList.add('show');
  clearTimeout(modeHudT);
  modeHudT = setTimeout(() => hud.classList.remove('show'), 400);
}
viewport.addEventListener('pointerdown', (e) => {
  if (tool !== 'hand' || e.target.closest('#corner, #cast, #keys')) return;
  if (boardEl.classList.contains('far') && e.target.closest('.group-cover')) return; // 멀리 보기 덮개 끌기는 V 와 같이 dragGroup 이 맡는다
  e.stopImmediatePropagation(); // 같은 viewport 의 선택(사각형) 리스너까지 막는다
  document.activeElement?.blur();
  drag(e, pan); // pointerdown 기본 동작을 막아 xterm 의 mousedown(텍스트 선택)도 생기지 않는다
}, true);
addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.altKey || e.metaKey || e.target.closest?.('input, textarea, select, .xterm')) return;
  // 한/영과 상관없이 키 자리로 본다. 바뀌면 가운데 표시(mode-hud)로 알려서 눌린 걸 바로 안다.
  if (e.code === 'KeyH') setTool('hand');
  else if (e.code === 'KeyV') setTool('select');
});
// Space 를 누르고 있는 동안만 이동 모드 (피그마처럼). 입력칸에선 그대로 공백, 터미널은 꾹 누를 때만 이동(attachCustomKeyEventHandler).
let spaceHand = false;
// 터미널에서 눌렀지만 아직 안 보낸 공백. 포커스가 빠져도 버리지 않고 보낸다(짧게 누른 공백 유실 방지).
let spacePend = null;
const flushSpace = () => { const f = spacePend; spacePend = null; f?.(); };
addEventListener('focusout', flushSpace, true);
addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.ctrlKey || e.altKey || e.metaKey || e.target.closest?.('input, textarea, select, .xterm')) return;
  e.preventDefault(); // 포커스 남은 버튼이 눌리지 않게
  if (e.repeat || tool === 'hand') return;
  spaceHand = true;
  setTool('hand', true);
});
const endSpaceHand = () => { if (spaceHand) { spaceHand = false; setTool('select', true); } };
addEventListener('keyup', (e) => { if (e.code === 'Space') endSpaceHand(); });
addEventListener('blur', endSpaceHand);
$('tool-select').addEventListener('click', () => setTool('select'));
// 단축키 안내: 접힘 상태만 기억한다
const setKeysOpen = (open) => {
  $('keys-list').hidden = !open;
  $('keys-toggle').setAttribute('aria-expanded', open);
  $('keys-toggle').textContent = tr(open ? 'ui.keys.collapse' : 'ui.keys.title');
  try { localStorage.setItem('keysOpen', open ? '1' : '0'); } catch {}
};
try { setKeysOpen(localStorage.getItem('keysOpen') !== '0'); } catch { setKeysOpen(true); }
$('keys-toggle').addEventListener('click', () => setKeysOpen($('keys-list').hidden));
// Claude 사용량은 공개되지 않은 API 를 로그인 토큰으로 부른다 — 사용자가 켰을 때만 묻는다.
let claudeUsageOn = pref.get('claudeUsage', '0') === '1';
$('opt-claude-usage').checked = claudeUsageOn;
// 설명 괄호는 둘째 줄로 내린다 (키 하나를 첫 ' (' 에서 나눈다 — ko·en 같은 꼴)
{ const s = $('opt-claude-usage').nextElementSibling, t = s.textContent, i = t.indexOf(' ('); if (i > 0) s.replaceChildren(t.slice(0, i), el('span', 'opt-sub', t.slice(i + 1))); }
$('opt-claude-usage').addEventListener('change', (e) => {
  claudeUsageOn = e.target.checked;
  pref.set('claudeUsage', claudeUsageOn ? '1' : '0');
  refreshFill();
});
$('opt-critters').checked = crittersOn;
$('opt-critters').addEventListener('change', (e) => {
  crittersOn = e.target.checked;
  pref.set('critters', crittersOn ? '1' : '0');
  document.body.classList.toggle('no-critters', !crittersOn);
});
// 캐릭터 고르기: 무작위(세션마다) 또는 하나로 고정. 바꾸면 지금 떠 있는 캐릭터도 바로 바꾼다.
$('opt-critter-kind').replaceChildren(el('option', null, tr('ui.critter.random')), ...CRITTER_KINDS.map((k) => Object.assign(el('option', null, CRITTERS[k].name), { value: k })));
$('opt-critter-kind').firstChild.value = 'random';
$('opt-critter-kind').value = critterKind;
$('opt-critter-kind').addEventListener('change', (e) => {
  critterKind = e.target.value;
  pref.set('critterKind', critterKind);
  for (const n of nodes.values()) {
    const c = n.el.querySelector('.critter');
    if (!c) continue;
    c.dataset.kind = pickCritter();
    delete c.firstChild.firstChild.dataset.html;
    paintCritter(n);
  }
});
if (isMac) {
  for (const k of document.querySelectorAll('#keys kbd')) if (k.textContent === 'Ctrl' || k.textContent === 'Alt') k.textContent = '⌘';
  $('cast-text').placeholder = $('cast-text').placeholder.replace('Ctrl+K', '⌘K');
}
$('tool-hand').addEventListener('click', () => setTool('hand'));
addEventListener('keydown', (e) => {
  if (e.key === MOD_KEY) document.body.classList.add('ctrl');
  if (e.key === 'Escape' && linkFrom) return endLinkMode();
  if (e.key === 'Escape' && !$('color-pop').hidden) return closeColorPicker();
  if (e.key === 'Escape' && selection.size && !e.target.closest?.('.node')) setSelection([]);
});
addEventListener('keyup', (e) => { if (e.key === MOD_KEY) document.body.classList.remove('ctrl'); });
addEventListener('blur', () => document.body.classList.remove('ctrl'));
// 휠 버튼(가운데) 드래그 = 어디서든 보드 이동. 터미널 포커스는 그대로 둬서 이동 후 바로 이어서 입력할 수 있다.
viewport.addEventListener('pointerdown', (e) => {
  if (e.button !== 1) return;
  e.preventDefault(); // 브라우저 자동 스크롤 막기
  e.stopImmediatePropagation();
  const focusedEl = document.activeElement;
  drag(e, pan, () => focusedEl?.focus?.());
}, true);
viewport.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });

// 휠: Ctrl+휠 = 어디서든 확대·축소, H 모드 = 어디서든 보드 이동, V 모드 = 빈 곳만 보드 이동(터미널 위는 터미널 스크롤).
// 터미널(xterm)이 휠을 먼저 가져가지 않게 캡처 단계에서 받는다.
viewport.addEventListener('wheel', (e) => {
  if (e.target.closest('#corner, #cast, #color-pop')) return; // 패널 안 스크롤은 그대로
  if (!e.ctrlKey && !e.metaKey) { // Mac 트랙패드 핀치는 ctrlKey 로 온다
    if (tool !== 'hand' && e.target !== viewport && e.target !== boardEl && !e.target.closest('.group-frame, .group-cover')) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.shiftKey) view.x -= e.deltaY || e.deltaX;
    else { view.x -= e.deltaX; view.y -= e.deltaY; }
    applyView();
    clearTimeout(viewport.wheelSave);
    viewport.wheelSave = setTimeout(save, 300);
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  const r = viewport.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, view.scale * (e.deltaY < 0 ? 1.1 : 0.9))) / view.scale;
  view.x = mx - (mx - view.x) * k;
  view.y = my - (my - view.y) * k;
  view.scale *= k;
  applyView();
  save();
}, { passive: false, capture: true });
$('zoom').addEventListener('click', () => { view = { x: 0, y: 0, scale: 1 }; applyView(); save(); });

// --- 서브 에이전트 랙 (Claude Code 훅 이벤트) ---

const sameAgent = (a, b) => String(a).replace(/^agent-/, '') === String(b).replace(/^agent-/, '');

function elapsed(a) {
  const s = Math.floor(((a.end ?? Date.now()) - a.start) / 1000);
  return s < 60 ? tr('ui.time.sec', { s }) : tr('ui.time.minSec', { m: Math.floor(s / 60), s: s % 60 });
}

function finish(a, status, result, stats) {
  if (a.status === 'running') {
    a.status = status;
    a.end = Date.now();
  }
  a.result ??= result;
  if (stats?.totalToolUseCount != null) a.tools = stats.totalToolUseCount;
}

// 서브 에이전트 transcript 위치 = 부모 transcript 이름의 폴더/subagents/agent-{id}.jsonl
function transcriptOf(e) {
  if (!e.transcript_path || !e.agent_id) return undefined;
  if (/[\\/]subagents[\\/]/.test(e.transcript_path)) return e.transcript_path;
  const sep = e.transcript_path.includes('\\') ? '\\' : '/'; // Windows \, 맥·리눅스 /
  return `${e.transcript_path.replace(/\.jsonl$/, '')}${sep}subagents${sep}agent-${String(e.agent_id).replace(/^agent-/, '')}.jsonl`;
}

function stopOrRemove(n, a) {
  if (a.status === 'running') {
    if (!a.agentId) return;
    a.stopRequested = true;
    api.stopAgent(a.agentId);
  } else {
    n.agents.delete(a.key);
  }
  renderRack(n);
}

// 서브 에이전트 카드: 세션 창 바로 아래에 가로로 늘어선다. 카드 하나 = 그 서브 에이전트의 대화 기록(읽기 전용).
// 서브 에이전트는 부모 claude 안에서 돌아 붙을 터미널이 없어, 기록 파일을 일하는 동안 2초마다 다시 읽어 이어 보여 준다.
// 도구 호출·결과는 눌러서 전체를 펼친다. 카드가 많으면 줄 안에서 가로로 스크롤.
// 카드 크기는 세션 창처럼 테두리·모서리 어디서든 끌어서 바꾼다. 마지막으로 바꾼 크기를 새 카드의 기본 크기로 기억한다.
const cardSize = { w: Number(pref.get('cardW', '460')) || 460, h: Number(pref.get('cardH', '470')) || 470 };
const CARD_MIN_W = 300, CARD_MIN_H = 160;
const cardResize = new ResizeObserver(() => renderGroups()); // 카드 줄 높이가 바뀌면 프로젝트 테두리도 따라간다
function resizableCard(box) {
  box.insertAdjacentHTML('beforeend', ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map((d) => `<div class="crz crz-${d}" data-dir="${d}"></div>`).join(''));
  for (const h of box.querySelectorAll('.crz')) h.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    const d = h.dataset.dir;
    let w = box.offsetWidth - 2, hh = box.offsetHeight - 2; // 테두리 1px 씩 뺀 내용 크기
    drag(e, (dx, dy) => {
      dx /= view.scale;
      dy /= view.scale;
      // 카드는 줄 안에 차례로 놓여 위치가 없다 → 왼쪽·위 가장자리도 크기만 바꾼다
      if (d.includes('e')) w += dx;
      if (d.includes('w')) w -= dx;
      if (d.includes('s')) hh += dy;
      if (d.includes('n')) hh -= dy;
      cardSize.w = Math.max(CARD_MIN_W, Math.round(w));
      cardSize.h = Math.max(CARD_MIN_H, Math.round(hh));
      Object.assign(box.style, { width: `${cardSize.w}px`, height: `${cardSize.h}px` });
    }, () => {
      pref.set('cardW', String(cardSize.w));
      pref.set('cardH', String(cardSize.h));
    });
  });
}
// 보기 모드: 자세히(카드마다 대화 기록) / 간략히(한 줄씩 이름·상태·시간만). 모든 세션에 같이 적용.
let rackBrief = pref.get('rackBrief', '0') === '1';
document.body.classList.toggle('rack-brief', rackBrief);
function setRackBrief(on) {
  rackBrief = on;
  pref.set('rackBrief', on ? '1' : '0');
  document.body.classList.toggle('rack-brief', on);
  for (const n of nodes.values()) {
    if (!n.rack) continue;
    renderRack(n);
    if (!on) for (const a of n.agents.values()) if (a.card) { a.card.loaded = false; a.card.final = false; loadCard(a.card); }
  }
  renderGroups();
}

function agentCard(n, a) {
  const box = el('section', 'agent-card');
  Object.assign(box.style, { width: `${cardSize.w}px`, height: `${cardSize.h}px` });
  box.innerHTML = '<div class="ac-head"><i class="led"></i><div class="ac-titles"><span class="ac-title"></span><span class="ac-meta"></span></div><span class="sub-time"></span><button class="sub-x">×</button></div><div class="ac-list"></div>';
  const c = { el: box, list: box.querySelector('.ac-list'), a, open: new Set() };
  a.timeEl = box.querySelector('.sub-time');
  // 본문에서 끌어 고른 글자는 터미널처럼 바로 클립보드로
  c.list.addEventListener('mouseup', () => setTimeout(() => {
    const sel = getSelection(), text = sel.toString();
    if (!text || !c.list.contains(sel.anchorNode) || !c.list.contains(sel.focusNode)) return;
    api.copy(text);
    toast(tr('ui.toast.copied'), 'copy');
  }));
  box.querySelector('.sub-x').addEventListener('click', () => stopOrRemove(n, a));
  // 간략히 보기에서 카드를 누르면 자세히 보기로
  box.querySelector('.ac-head').addEventListener('click', (e) => { if (rackBrief && !e.target.closest('button')) setRackBrief(false); });
  resizableCard(box);
  cardResize.observe(box);
  return c;
}

function renderCardHead(c) {
  const { a, el: box } = c;
  box.className = `agent-card ${a.status}`;
  box.querySelector('.ac-title').textContent = a.description;
  box.querySelector('.ac-meta').textContent = `${a.type}, ${a.status === 'running'
    ? (a.stopRequested ? tr('ui.agent.stopping') : a.lastTool ? tr('ui.agent.toolsNow', { n: a.tools, tool: a.lastTool }) : tr('ui.agent.tools', { n: a.tools }))
    : `${STATUS[a.status]}, ${tr('ui.agent.tools', { n: a.tools })}`}`;
  a.timeEl.textContent = elapsed(a);
  const x = box.querySelector('.sub-x');
  x.title = tr(a.status !== 'running' ? 'ui.agent.clear' : a.agentId ? 'ui.agent.stop' : 'ui.agent.noStop');
  x.setAttribute('aria-label', x.title);
  x.disabled = a.status === 'running' && (!a.agentId || a.stopRequested);
}

async function loadCard(c) {
  const { a, list } = c;
  if (!list.clientHeight) return; // 간략히 보기(기록 숨김)에선 읽지 않는다. 자세히로 돌아오면 다시 읽는다
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  const src = a.transcript;
  // 기록 파일 위치를 알기 전에는 프롬프트(와 결과)만
  const msgs = (src && await api.readTranscript(src))
    || [{ role: 'user', text: a.prompt }, ...(a.result ? [{ role: 'assistant', text: a.result }] : [])];
  if (a.card !== c) return;
  if (a.status !== 'running') c.final = true; // 끝난 뒤 한 번 더 읽고 멈춘다(기록 위치가 바뀌면 다시 읽는다)
  c.src = src;
  // 기록은 뒤에만 붙는다 → 늘어난 항목만 덧붙여 읽던 자리·선택을 지킨다. 줄었거나(앞이 잘림) 출처가 바뀌면 새로 그린다.
  const same = c.shown && c.shownSrc === src && msgs.length >= c.shown && msgs.length < 300;
  if (same && msgs.length === c.shown) return;
  const from = same ? c.shown : 0;
  const items = msgs.slice(from).map((m, k) => {
    const i = from + k;
    const item = el('div', `msg ${m.role}${m.error ? ' error' : ''}${c.open.has(i) ? ' open' : ''}`);
    if (m.role === 'tool') item.append(el('span', 'msg-tool', m.name));
    item.append(el('div', 'msg-text', m.text));
    if (m.role === 'tool' || m.role === 'result') {
      item.title = tr('ui.agent.expand');
      item.addEventListener('click', () => getSelection().isCollapsed && (item.classList.toggle('open') ? c.open.add(i) : c.open.delete(i)));
    }
    return item;
  });
  if (same) list.append(...items);
  else list.replaceChildren(...items);
  c.shown = msgs.length;
  c.shownSrc = src;
  if (atBottom || !c.loaded) list.scrollTop = list.scrollHeight;
  c.loaded = true;
}
const dropCard = (card) => { cardResize.unobserve(card); card.remove(); };

function renderRack(n) {
  const list = [...n.agents.values()];
  if (!list.length) { // 카드를 다 지우면 카드 줄과 케이블도 걷는다
    n.el.querySelector('.wire')?.remove();
    n.rack?.querySelectorAll('.agent-card').forEach((card) => cardResize.unobserve(card));
    n.rack?.remove();
    n.rack = null;
    n.el.classList.remove('busy');
    place(n);
    paintState(n);
    return;
  }
  if (!n.rack) {
    n.el.insertAdjacentHTML('beforeend',
      '<svg class="wire"><path class="cable"/><path class="pulse"/><circle class="plug plug-a" r="5"/><circle class="plug plug-b" r="5"/></svg>'
      + `<section class="rack"><div class="rack-head"><span class="rack-title">${tr('ui.rack.title')}</span><span class="rack-count"></span><button class="rack-mode" role="switch">${tr('ui.rack.brief')}<i></i></button><button class="rack-clear">${tr('ui.rack.clear')}</button></div><div class="rack-list"></div></section>`);
    n.rack = n.el.querySelector('.rack');
    n.rack.querySelector('.rack-mode').addEventListener('click', () => setRackBrief(!rackBrief));
    n.rack.querySelector('.rack-clear').addEventListener('click', () => {
      for (const [key, a] of n.agents) if (a.status !== 'running') n.agents.delete(key);
      renderRack(n);
    });
    place(n);
  }
  const running = list.filter((a) => a.status === 'running').length;
  n.rack.querySelector('.rack-count').textContent = running ? tr('ui.rack.running', { n: running }) : tr('ui.rack.done', { n: list.length });
  n.rack.querySelector('.rack-mode').setAttribute('aria-checked', rackBrief);
  n.el.classList.toggle('busy', running > 0);
  const row = n.rack.querySelector('.rack-list');
  for (const a of list) {
    if (a.card) continue;
    a.card = agentCard(n, a);
    row.append(a.card.el);
    loadCard(a.card);
  }
  const keep = new Set(list.map((a) => a.card.el));
  for (const card of [...row.children]) if (!keep.has(card)) dropCard(card);
  for (const a of list) renderCardHead(a.card);
  paintState(n);
}

setInterval(() => {
  for (const n of nodes.values()) {
    for (const a of n.agents?.values() ?? []) if (a.card && (a.status === 'running' || !a.card.final || a.card.src !== a.transcript)) loadCard(a.card);
  }
}, 2000);

function onAgentEvent(n, e) {
  const agents = (n.agents ??= new Map());
  const byAgentId = (id) => [...agents.values()].find((a) => a.agentId && sameAgent(a.agentId, id));
  switch (e.hook_event_name) {
    case 'PreToolUse': {
      if (e.tool_name === 'Agent') {
        const input = e.tool_input || {};
        agents.set(e.tool_use_id, {
          key: e.tool_use_id,
          description: input.description || tr('ui.agent.noDesc'),
          type: input.subagent_type || 'general-purpose',
          prompt: input.prompt || '',
          status: 'running',
          start: Date.now(),
          tools: 0,
        });
      } else if (e.agent_id && e.tool_name !== 'SubagentHandback') {
        const a = byAgentId(e.agent_id);
        if (!a) return;
        a.tools++;
        a.lastTool = e.tool_name;
        a.transcript ??= transcriptOf(e);
      } else return;
      break;
    }
    case 'SubagentStart': {
      if (byAgentId(e.agent_id)) return;
      // shortcut: SubagentStart 엔 tool_use_id 가 없어 같은 타입의 가장 오래된 미연결 카드에 붙인다. 같은 타입을 병렬로 띄우면 카드가 뒤바뀔 수 있다.
      const a = [...agents.values()].find((x) => x.status === 'running' && !x.agentId && x.type === e.agent_type);
      if (!a) return;
      a.agentId = e.agent_id;
      a.transcript ??= transcriptOf(e);
      break;
    }
    case 'SubagentStop': {
      const a = byAgentId(e.agent_id);
      if (!a) return;
      a.transcript = e.agent_transcript_path || a.transcript;
      finish(a, a.stopRequested ? 'stopped' : 'done', e.last_assistant_message);
      break;
    }
    case 'PostToolUse': {
      const a = agents.get(e.tool_use_id);
      if (!a) return;
      const r = e.tool_response || {};
      a.agentId ??= r.agentId;
      // 백그라운드 실행은 async_launched 로 바로 돌아온다 — 완료는 SubagentStop 이 알려준다.
      if (r.status === 'completed') finish(a, a.stopRequested ? 'stopped' : 'done', (r.content || []).map((c) => c.text).join('\n'), r);
      break;
    }
    case 'PostToolUseFailure': {
      const a = agents.get(e.tool_use_id);
      if (!a) return;
      finish(a, 'error', e.error);
      break;
    }
    default:
      return;
  }
  renderRack(n);
}


setInterval(() => {
  for (const n of nodes.values()) {
    for (const a of n.agents?.values() ?? []) if (a.status === 'running' && a.timeEl) a.timeEl.textContent = elapsed(a);
  }
}, 1000);

api.onData((id, d) => nodes.get(id)?.term.write(d));
api.onExit((id, code) => {
  const n = nodes.get(id);
  if (!n) return;
  n.term.write(`\r\n\x1b[90m[${tr('ui.node.exitedCode', { code })}]\x1b[0m\r\n`);
  n.el.classList.add('exited');
  n.exited = true;
  paintState(n);
  if (n.agents) {
    for (const a of n.agents.values()) finish(a, 'stopped');
    renderRack(n);
  }
  // AI 바꾸기: 옛 pty 가 끝난 뒤에 띄운다(먼저 띄우면 옛 onExit 가 같은 id 의 새 pty 를 지운다)
  const after = n.afterExit;
  n.afterExit = null;
  clearTimeout(n.switchTimer);
  n.switching = false;
  after?.();
});
// main 이 알아낸 대화 id(Codex 등). 다음 실행 때 이어 연다. 형식 검사·중복 방지는 main 이 한다.
api.onAgentSession((id, sessionId) => {
  const n = nodes.get(id);
  // 바꾸는 중·이미 다른 AI 로 바꾼 카드에 늦게 온 옛 Codex id 를 붙이지 않는다
  if (!n || n.switching || n.data.command !== 'codex') return;
  n.data.sessionId = sessionId;
  save();
});
// 카드 머리 AI 이름 메뉴: 같은 카드·같은 자리에서 다른 AI 로 다시 실행한다. 지금 대화는 끝나고 새 대화로 시작한다.
async function switchAgent(n, c) {
  if (n.switching || c === n.data.command) return; // 바꾸는 중(kill~exit) 겹치면 이중 spawn
  if (effectiveState(n) === 'working' && !await confirmBox(tr('ui.node.switchTitle'), tr('ui.node.switchText', { name: n.data.name, agent: LABELS[c] }), tr('ui.node.switchOk'))) return;
  if (!nodes.has(n.data.id) || n.switching) return; // 확인하는 사이 닫혔거나 다른 바꾸기가 시작됐으면
  const prev = { command: n.data.command, sessionId: n.data.sessionId };
  n.data.command = c;
  delete n.data.sessionId;
  if (c === 'claude') n.data.sessionId = crypto.randomUUID(); // addNode 와 같은 규칙
  n.el.querySelector('.agent').textContent = LABELS[c] ?? c;
  save();
  if (n.exited) return n.restart();
  n.switching = true;
  n.afterExit = n.restart;
  // exit 가 안 오면 영영 못 띄운다 → 포기하고 되돌린다. 강제 spawn 은 안 한다(늦게 온 옛 onExit 가 새 pty 를 지운다)
  n.switchTimer = setTimeout(() => {
    if (!nodes.has(n.data.id)) return; // 기다리는 사이 닫힌 카드
    n.switching = false;
    n.afterExit = null;
    Object.assign(n.data, prev);
    if (prev.sessionId === undefined) delete n.data.sessionId;
    n.el.querySelector('.agent').textContent = LABELS[prev.command] ?? prev.command;
    save();
    toast(tr('ui.node.switchFail'), true);
  }, 3000);
  api.kill(n.data.id);
}
api.onAgentEvent((id, e) => {
  const n = nodes.get(id);
  if (n) onHook(n, e);
});
api.onFocusNode((id) => nodes.has(id) && focusNode(nodes.get(id)));

// --- 런처: 에이전트 · 폴더 선택 ---

let cmd = pref.get('cmd', 'claude');
let cwd = pref.get('cwd', '');
let folders = [];
let shown = [];
let active = 0;

let installed = []; // 감지된 AI CLI 명령어

function renderAgentPick() {
  const avail = [...AGENTS.filter(([c]) => installed.includes(c)).map(([c]) => c), ''];
  if (!avail.includes(cmd)) cmd = avail[0]; // 고른 CLI 가 사라졌으면 첫 번째로
  renderNewAgents();
  document.querySelector('.agents-pick').replaceChildren(...avail.map((c) => {
    const b = el('button');
    b.dataset.agent = c;
    b.append(el('span', 'water'), el('span', 'week'), el('span', 'agent-name', LABELS[c]));
    paintFill(b);
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', c === cmd);
    b.addEventListener('click', () => {
      cmd = c;
      pref.set('cmd', cmd);
      renderAgentPick();
    });
    if (c) {
      b.addEventListener('pointerenter', () => showUsage(b, c));
      b.addEventListener('pointerleave', hideUsage);
      b.addEventListener('focus', () => showUsage(b, c));
      b.addEventListener('blur', hideUsage);
    }
    return b;
  }));
}

// AI 버튼 배경 = 사용량. 물 높이(왼쪽→오른쪽) = 5시간, 바닥 줄 = 주간. 70%↑ 노랑, 90%↑ 빨강.
// 5분마다 다시 묻는다(메인이 1분 캐시, 너무 자주 물으면 사용량 서버가 막는다).
const usageFill = new Map(); // agent -> { five, week } 사용 %
function paintFill(b) {
  const u = usageFill.get(b.dataset.agent);
  b.classList.toggle('metered', !!u);
  if (!u) return;
  const worst = Math.max(u.five ?? 0, u.week ?? 0);
  b.classList.toggle('warm', worst >= 70 && worst < 90);
  b.classList.toggle('hot', worst >= 90);
  b.style.setProperty('--fill', `${Math.min(100, u.five ?? 0)}%`);
  b.style.setProperty('--week', `${Math.min(100, u.week ?? 0)}%`);
}
async function refreshFill(only = ['claude', 'codex']) {
  for (const agent of only.filter((a) => installed.includes(a))) {
    const u = agent === 'claude' && !claudeUsageOn ? {} : await api.getUsage(agent);
    const pick = (label) => u.limits?.find((l) => l.label === label)?.used;
    if (u.limits?.length) usageFill.set(agent, { five: pick('5시간'), week: pick('주간') });
    else usageFill.delete(agent);
  }
  document.querySelectorAll('.agents-pick button').forEach(paintFill);
}
setInterval(refreshFill, 5 * 60 * 1000);
// Codex 는 이 PC 기록 파일만 읽어 가볍다 → 1분마다 따로 새로 본다(답이 끝난 뒤 바로 반영되게)
setInterval(() => installed.includes('codex') && refreshFill(['codex']), 60 * 1000);

// AI 버튼에 마우스를 올리면 남은 사용량 박스. 잠깐 머물러야 뜨고(지나가는 마우스에 안 뜨게), 결과는 메인이 1분 캐시.
let usageTimer = null;
let usageFor = null;
const untilText = (iso) => {
  if (!iso) return '';
  const min = Math.max(0, Math.round((new Date(iso) - Date.now()) / 60000));
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
  return tr('ui.time.resetIn', { t: [d && tr('ui.time.days', { n: d }), h && tr('ui.time.hours', { n: h }), !d && tr('ui.time.mins', { n: m })].filter(Boolean).join(' ') });
};
// getUsage 의 label 은 한국어 키('5시간'·'주간'·'주간 Opus' 등)라 비교는 그대로 하고 보여 줄 때만 번역한다
const limitLabel = (s) => {
  let m;
  if ((m = /^(\d+)시간$/.exec(s))) return tr('ui.usage.hours', { n: m[1] });
  if (s === '주간') return tr('ui.usage.week');
  if ((m = /^주간 (.+)$/.exec(s))) return tr('ui.usage.weekModel', { model: m[1] });
  return s;
};
function showUsage(btn, agent) {
  clearTimeout(usageTimer);
  usageTimer = setTimeout(async () => {
    usageFor = agent;
    const box = $('usage-pop');
    const r = btn.getBoundingClientRect();
    Object.assign(box.style, { left: `${r.left}px`, top: `${r.bottom + 8}px` });
    box.replaceChildren(el('div', 'u-title', LABELS[agent]), el('p', 'u-note', tr('ui.loading')));
    box.hidden = false;
    const u = agent === 'claude' && !claudeUsageOn
      ? { error: tr('ui.settings.usageOff') }
      : await api.getUsage(agent);
    if (usageFor !== agent || box.hidden) return;
    const parts = [el('div', 'u-title', `${LABELS[agent]}${u.plan ? ` (${tr('ui.usage.plan', { plan: u.plan })})` : ''}`)];
    if (u.error) parts.push(el('p', 'u-note', u.error));
    for (const l of u.limits ?? []) {
      const left = Math.max(0, 100 - l.used);
      const row = el('div', `u-row${l.used >= 90 ? ' hot' : l.used >= 70 ? ' warm' : ''}`);
      const bar = el('div', 'u-bar');
      bar.append(el('i'));
      bar.firstChild.style.width = `${Math.min(100, l.used)}%`;
      row.append(el('span', 'u-label', limitLabel(l.label)), el('span', 'u-left', tr('ui.usage.left', { n: Math.round(left) })), bar, el('span', 'u-reset', untilText(l.resetsAt)));
      parts.push(row);
    }
    if (u.note) parts.push(el('p', 'u-note', u.note));
    box.replaceChildren(...parts);
  }, 250);
}
function hideUsage() {
  clearTimeout(usageTimer);
  usageFor = null;
  $('usage-pop').hidden = true;
}

let lastDetect = 0;
async function detectAgents() {
  lastDetect = Date.now();
  installed = await api.detectAgents();
  renderAgentPick();
  refreshFill();
}
$('agents-refresh').addEventListener('click', (e) => withSpin(e.currentTarget, async () => {
  await detectAgents();
  const names = AGENTS.filter(([c]) => installed.includes(c)).map(([, label]) => label);
  return tr('ui.agents.refreshed', { list: names.length ? names.join(', ') : tr('ui.agents.none') });
}));

// 새로고침 버튼: 도는 동안 잠그고, 끝나면 입력창 위에 짧은 알림. 너무 빨리 끝나도 도는 게 보이게 최소 0.5초.
async function withSpin(btn, work, failPrefix = tr('ui.refreshFail')) {
  if (btn.classList.contains('spinning')) return;
  btn.classList.add('spinning');
  btn.disabled = true;
  try {
    const [msg] = await Promise.all([work(), new Promise((r) => setTimeout(r, 500))]);
    toast(msg);
  } catch (err) {
    toast(`${failPrefix}: ${err.message}`, true);
  } finally {
    btn.classList.remove('spinning');
    btn.disabled = false;
  }
}

let toastTimer;
function toast(text, kind) { // kind: true = 실패, 'copy' = 복사 알림(노란 굵은 글자)
  const t = $('toast');
  t.textContent = text;
  t.classList.toggle('bad', kind === true);
  t.classList.toggle('copy', kind === 'copy');
  t.hidden = false;
  t.classList.remove('show');
  void t.offsetWidth; // 연달아 떠도 애니메이션이 다시 돌게
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, kind === 'copy' ? 1300 : 2600); // 복사 알림만 짧게 (css #toast.copy.show 와 맞춘다)
}
// 앱 창으로 돌아오면 다시 찾는다(새로 설치한 CLI). 너무 자주 돌지 않게 10초 간격.
addEventListener('focus', () => { if (Date.now() - lastDetect > 10000) detectAgents(); });

// 저장소 아래에 그 워크트리를 붙여 계층으로 보여준다.
function orderedFolders() {
  const roots = folders.filter((f) => !f.worktreeOf);
  const out = [{ path: '', name: tr('ui.home'), tag: '' }];
  const add = (f, child) => out.push({
    path: f.path,
    name: basename(f.path),
    tag: [f.branch, child ? tr('ui.folder.worktree') : (f.trusted ? null : tr('ui.folder.untrusted'))].filter(Boolean).join(', '),
    untrusted: !child && !f.trusted,
    child,
  });
  for (const r of roots) {
    add(r, false);
    folders.filter((f) => f.worktreeOf === r.path).forEach((f) => add(f, true));
  }
  folders.filter((f) => f.worktreeOf && !roots.some((r) => r.path === f.worktreeOf)).forEach((f) => add(f, true));
  return out;
}

function renderFolderList() {
  const q = $('folder-search').value.trim();
  const ql = q.toLowerCase();
  shown = orderedFolders().filter((f) => !q || f.name.toLowerCase().includes(ql) || f.path.toLowerCase().includes(ql));
  if (/^([a-z]:)?[\\/]/i.test(q) && !shown.some((f) => f.path.toLowerCase() === ql)) shown.unshift({ path: q, name: tr('ui.folder.usePath'), tag: '' });
  active = Math.min(active, Math.max(0, shown.length - 1));
  const list = $('folder-list');
  if (!shown.length) return list.replaceChildren(el('li', 'none', tr('ui.folder.none')));
  list.replaceChildren(...shown.map((f, i) => {
    const li = el('li', f.child ? 'child' : '');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', i === active);
    li.append(el('span', 'name', f.name), el('span', 'tag', f.tag), el('span', 'path', f.path || tr('ui.folder.homeDir')));
    li.addEventListener('pointerdown', (e) => { e.preventDefault(); launchFrom(f); });
    li.addEventListener('pointerenter', () => { active = i; renderFolderList(); });
    return li;
  }));
  list.children[active]?.scrollIntoView({ block: 'nearest' });
}

// --- 새 세션 창: [+ 새 세션]·Ctrl+N(⌘N) → 가운데 창. 위에서 AI, 아래 폴더를 고르면 바로 실행 ---
function openNew() {
  $('new-pop').hidden = false;
  $('folder-search').value = '';
  renderNewAgents();
  const list = orderedFolders();
  active = Math.max(0, list.findIndex((f) => samePath(f.path, cwd))); // 마지막에 쓴 폴더에서 시작
  renderFolderList();
  $('folder-search').focus();
  api.listPaths(customDirs).then((items) => { folders = items; renderFolderList(); });
}
function closeNew() { $('new-pop').hidden = true; }
function renderNewAgents() {
  if ($('new-pop').hidden) return;
  const avail = [...AGENTS.filter(([c]) => installed.includes(c)).map(([c]) => c), ''];
  document.querySelector('.new-agents').replaceChildren(...avail.map((c) => {
    const b = el('button', null, LABELS[c]);
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', c === cmd);
    b.addEventListener('pointerdown', (e) => e.preventDefault()); // 검색칸 포커스 유지
    b.addEventListener('click', () => { cmd = c; pref.set('cmd', cmd); renderAgentPick(); });
    return b;
  }));
}
// 사이드바에서 폴더 줄을 누르면 그 폴더가 '마지막 폴더'가 된다(새 세션 창이 거기서 시작)
function choose(f) {
  cwd = f.path;
  pref.set('cwd', cwd);
  renderSidebar();
}
function launchFrom(f) {
  closeNew();
  choose(f);
  launch(f.path);
}

$('folder-search').addEventListener('input', () => { active = 0; renderFolderList(); });
$('folder-search').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') active = Math.min(active + 1, shown.length - 1);
  else if (e.key === 'ArrowUp') active = Math.max(active - 1, 0);
  else if (e.key === 'Enter') return shown[active] && launchFrom(shown[active]);
  else if (e.key === 'Escape') return closeNew();
  else return;
  e.preventDefault();
  renderFolderList();
});
$('new-pop').addEventListener('pointerdown', (e) => { if (e.target === $('new-pop')) closeNew(); }); // 바깥 누르면 닫기
// 목록에 없는 폴더: 탐색기(Finder)에서 고른다
$('folder-browse').addEventListener('click', async () => {
  closeNew();
  const dir = await api.pickFolder(cwd);
  if (dir) launchFrom({ path: dir });
});
// --- 확인 창 (앱 안): 앱 종료, 프로젝트 세션 전체 종료 등 되돌릴 수 없는 동작 앞에 띄운다 ---
let confirmDone = null;
function confirmBox(title, text, okLabel = tr('ui.quit.ok')) {
  confirmDone?.(false);
  $('quit-title').textContent = title;
  $('quit-text').textContent = text;
  $('quit-ok').textContent = okLabel;
  $('quit-pop').hidden = false;
  $('quit-ok').focus();
  return new Promise((resolve) => { confirmDone = resolve; });
}
function answerConfirm(ok) {
  $('quit-pop').hidden = true;
  const done = confirmDone;
  confirmDone = null;
  done?.(ok);
}
$('quit-ok').addEventListener('click', () => answerConfirm(true));
$('quit-cancel').addEventListener('click', () => answerConfirm(false));
$('quit-pop').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); answerConfirm(false); } });
$('quit-pop').addEventListener('pointerdown', (e) => { if (e.target === $('quit-pop')) answerConfirm(false); });

// X·Cmd+Q 를 누르면 메인이 묻는다
api.onConfirmClose(async (running) => {
  const unsaved = docs.filter((d) => d.dirty).length;
  const ok = await confirmBox(tr('ui.quit.title'), `${tr('ui.quit.text')}${unsaved ? `\n${tr('ui.quit.unsaved', { n: unsaved })}` : ''}`);
  if (!ok) return;
  flushSave();
  api.closeApp();
});

// 프로젝트 테두리 오른쪽 위 [전체 종료]
async function closeGroup(name, list) {
  const ok = await confirmBox(tr('ui.group.closeTitle'), tr('ui.group.closeText', { name, n: list.length }), tr('ui.group.closeAll'));
  if (ok) list.forEach((n) => nodes.has(n.data.id) && n.el.querySelector('.close').click());
}

// --- 버전·업데이트: 헤더 버전 글자를 누르면 바로 확인. 새 버전이 오면 위쪽 막대로 알린다 ---
api.appVersion().then((v) => {
  $('app-version').textContent = `v${v}`;
  $('set-version').textContent = `v${v}`;
  if (firstRun) pref.set('newsSeen', v);
  if (pref.get('newsSeen', '') !== v && CHANGES.some((c) => c.v === v)) openNews(v);
});

// 업데이트 뒤 처음 켜면 바뀐 점 목록. "닫기" 는 다음에 켤 때 또 뜨고, "다시 보지 않기" 는 이 버전에서 다시 안 뜬다.
// 버전을 올릴 때 맨 위에 한 덩어리 추가한다.
const CHANGES = [
  { v: '1.2.1', items: [
    { ko: '+ 를 누르면 깔린 AI(Claude Code·Codex·PowerShell 등) 중에서 골라 실행합니다.', en: 'Clicking + now lets you pick which installed AI (Claude Code, Codex, PowerShell, …) to start.' },
    { ko: '사이드바 프로젝트에 [세션 목록] 버튼이 생겼습니다. 그 프로젝트에서 했던 대화를 골라 이어 엽니다.', en: 'Sidebar projects have a new [Sessions] button to reopen past conversations from that project.' },
    { ko: 'Codex (GPT) 세션도 앱을 다시 켜면 하던 대화로 이어 열립니다.', en: 'Codex (GPT) sessions now resume the same conversation after restarting the app.' },
    { ko: '세션 머리의 AI 이름을 누르면 그 세션을 다른 AI 로 바꿔 다시 실행합니다.', en: 'Click the AI name on a session header to restart it with a different AI.' },
    { ko: '파일 트리가 멈추던 문제와, 세션을 눌러도 그 폴더로 돌아오지 않던 문제를 고쳤습니다.', en: 'Fixed the file tree freezing and not returning to the session folder when you click a session.' },
    { ko: 'Space 를 꾹 눌러 이동할 때 커서가 깜빡이던 문제를 고쳤습니다.', en: 'Fixed the cursor flickering while holding Space to pan.' },
  ] },
  { v: '1.2.0', items: [
    { ko: 'PDF·이미지(png·jpg·gif·webp)를 보드 위 카드로 엽니다. 세션 창처럼 끌고 크기를 바꿀 수 있고, 다시 켜도 남습니다. 확대해도 PDF 글자가 선명합니다.', en: 'PDFs and images (png, jpg, gif, webp) now open as cards on the board. Drag and resize them like session windows; they stay after restart, and PDF text stays sharp when zoomed in.' },
    { ko: '미리보기 못 하는 큰 파일·바이너리는 [OS 앱으로 열기]로 엽니다. 실행 파일은 열지 않습니다.', en: 'Files too large or not text to preview can be opened with [Open in default app]. Executables are never opened.' },
    { ko: '서브 에이전트 카드의 글자도 드래그하면 바로 복사됩니다.', en: 'Text in sub-agent cards is now copied as soon as you select it.' },
    { ko: '복사하면 보내기 바 위에 "복사 완료"가 잠깐 뜹니다. 드래그를 놓치는 경우에도 복사가 빠지지 않습니다.', en: 'Copying shows a short "Copied" notice above the send bar, and copies are no longer missed when a drag ends unexpectedly.' },
    { ko: '멀리 보기(프로젝트 이름으로 덮기)가 45% 이하에서 켜집니다.', en: 'The zoomed-out project view now turns on at 45% or less.' },
  ] },
  { v: '1.1.0', items: [
    { ko: '영어를 지원합니다. 처음엔 OS 언어를 따르고, 설정에서 한국어/영어를 고를 수 있습니다.', en: 'English is now supported. Bimo follows your OS language at first, and you can switch between Korean and English in Settings.' },
    { ko: '오른쪽 위 톱니에 설정 창이 생겼습니다: 언어, 캐릭터, 사용량 보기, 터미널 글꼴 크기, 업데이트 확인.', en: 'New Settings window (gear, top right): language, characters, usage display, terminal font size, and update check.' },
    { ko: '보드 저장이 더 안전해졌습니다. 저장 파일이 깨져도 자동으로 복구합니다.', en: 'Saving the board is safer. A broken save file is repaired automatically.' },
    { ko: '파일 트리가 지금 고른 세션의 폴더를 따라갑니다.', en: 'The file tree now follows the folder of the selected session.' },
    { ko: '멀리 볼 때(30% 이하) 프로젝트 판을 끌면 그 프로젝트 세션이 통째로 옮겨집니다.', en: 'When zoomed out (30% or less), drag a project panel to move all of its sessions at once.' },
    { ko: 'Codex 세션도 케이블 협업을 합니다: 다른 세션에 말을 걸 수 있고, 받은 요청의 답도 돌려줍니다.', en: 'Codex sessions now join cable collaboration: they can message linked sessions and send replies back.' },
  ] },
  { v: '1.0.0', items: [
    '이름이 Bimo 로 바뀌고 새 아이콘(B + 커서)이 생겼습니다.',
    'GitHub 에 공개했습니다. 업데이트도 GitHub Releases 에서 받습니다.',
  ] },
];
// 버전 하나가 한 장. 좌우 버튼·점·←/→ 키로 넘긴다. 첫 장 = 지금 버전.
let newsShown = [], newsAt = 0;
function openNews(v) {
  newsShown = CHANGES.slice(CHANGES.findIndex((c) => c.v === v));
  $('news-track').replaceChildren(...newsShown.map((c) => {
    const ul = el('ul');
    ul.append(...c.items.map((t) => el('li', null, typeof t === 'string' ? t : t[lang] ?? t.ko))); // 1.1.0 부터 { ko, en }, 이전 기록은 원문
    const sec = el('section');
    sec.append(ul);
    return sec;
  }));
  $('news-dots').replaceChildren(...newsShown.map((c, i) => {
    const d = el('button', 'news-dot');
    d.setAttribute('aria-label', `v${c.v}`);
    d.addEventListener('click', () => showNews(i));
    return d;
  }));
  $('news').hidden = false;
  showNews(0);
  $('news-close').focus();
}
function showNews(i) {
  newsAt = Math.max(0, Math.min(newsShown.length - 1, i));
  const c = newsShown[newsAt];
  $('news-title').textContent = tr('ui.news.title', { v: c.v });
  $('news-track').style.transform = `translateX(${-100 * newsAt}%)`;
  $('news-prev').disabled = newsAt === 0;
  $('news-next').disabled = newsAt === newsShown.length - 1;
  [...$('news-dots').children].forEach((d, k) => d.classList.toggle('on', k === newsAt));
}
$('news-prev').addEventListener('click', () => showNews(newsAt - 1));
$('news-next').addEventListener('click', () => showNews(newsAt + 1));
addEventListener('keydown', (e) => {
  if ($('news').hidden) return;
  if (e.key === 'ArrowLeft') showNews(newsAt - 1);
  if (e.key === 'ArrowRight') showNews(newsAt + 1);
});
$('news-close').addEventListener('click', () => { $('news').hidden = true; });
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('news').hidden) $('news').hidden = true; });
$('news-never').addEventListener('click', () => {
  api.appVersion().then((v) => pref.set('newsSeen', v));
  $('news').hidden = true;
});
let updateAction = null;
function showUpdateBar(text, label, action) {
  $('update-text').textContent = text;
  $('update-go').textContent = label;
  updateAction = action;
  $('update-bar').hidden = false;
}
api.onUpdateReady((v) => showUpdateBar(tr('ui.update.ready', { v }), tr('ui.update.restart'), () => { flushSave(); api.installUpdate(); }));
api.onUpdateManual(({ version, url }) => showUpdateBar(tr('ui.update.manual', { v: version }), tr('ui.update.get'), () => api.openUpdate(url)));
$('update-go').addEventListener('click', () => updateAction?.());
$('update-later').addEventListener('click', () => { $('update-bar').hidden = true; });
// 버전 글자: 바뀐 점 창을 열고, 같이 업데이트도 확인해 결과를 알린다(0.2.3 에서 빠졌던 확인을 되살림)
// 업데이트 확인 결과 문구. 버전 글자와 설정 창이 같이 쓴다. 확인 못 하면 throw.
async function updateMessage() {
  const r = await api.checkUpdate();
  if (r.status === 'latest') return tr('ui.update.latest', { v: r.version });
  if (r.status === 'downloading') return tr('ui.update.downloading', { v: r.version });
  if (r.status === 'ready' || r.status === 'manual') return tr('ui.update.available', { v: r.version });
  throw new Error(r.message || tr('ui.update.unknownErr'));
}
$('app-version').addEventListener('click', (e) => {
  api.appVersion().then(openNews);
  withSpin(e.currentTarget, updateMessage, tr('ui.update.fail'));
});

// --- 설정 창: 언어·캐릭터·사용량·글꼴 크기·업데이트 ---
function openSettings() {
  $('settings-pop').hidden = false;
  $('settings-btn').setAttribute('aria-expanded', true);
  $('set-lang').focus();
}
function closeSettings() {
  $('settings-pop').hidden = true;
  $('settings-btn').setAttribute('aria-expanded', false);
}
$('settings-btn').addEventListener('click', () => ($('settings-pop').hidden ? openSettings() : closeSettings()));
$('settings-close').addEventListener('click', closeSettings);
$('settings-pop').addEventListener('pointerdown', (e) => { if (e.target === $('settings-pop')) closeSettings(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('settings-pop').hidden) closeSettings(); });
// 언어는 저장하고 main 에도 바로 알린다(알림·오류 문구). 화면은 다시 시작할 때 적용한다.
// [다시 시작] 은 종료 확인 창을 거친다. relaunch 가 없는 main 이면 버튼을 숨기고 안내만 둔다.
$('set-lang').value = lang;
$('set-lang').addEventListener('change', (e) => {
  pref.set('lang', e.target.value);
  api.setLang?.(e.target.value);
  $('set-lang-note').hidden = $('set-restart').hidden = e.target.value === lang;
  if (typeof api.relaunch !== 'function') $('set-restart').hidden = true;
});
$('set-restart').addEventListener('click', async () => {
  const running = [...nodes.values()].filter((n) => !n.exited).length;
  const unsaved = docs.filter((d) => d.dirty).length;
  const ok = await confirmBox(tr('ui.restart.title'), `${tr('ui.restart.text', { n: running })}${unsaved ? `\n${tr('ui.quit.unsaved', { n: unsaved })}` : ''}`, tr('ui.update.restart'));
  if (!ok) return;
  flushSave();
  api.relaunch();
});
// 글꼴 크기: 새 터미널은 fontSize() 로 열고, 열린 터미널은 바로 바꿔 fit(→ onResize → pty resize) 한다
$('set-font').value = fontSize();
$('set-font').addEventListener('change', (e) => {
  const v = fontSize(e.target.value);
  e.target.value = v;
  pref.set('fontSize', v);
  nodes.forEach((n) => { n.term.options.fontSize = v; n.fit.fit(); });
});
$('set-update').addEventListener('click', async (e) => {
  const b = e.currentTarget, msg = $('set-update-msg');
  b.disabled = true;
  msg.textContent = tr('ui.settings.checking');
  try { msg.textContent = await updateMessage(); } catch (err) { msg.textContent = tr('ui.settings.updateFail', { error: err.message }); }
  b.disabled = false;
});

// 터미널에 입력 중이어도 열리게 캡처 단계에서 받는다
addEventListener('keydown', (e) => {
  if (!mod(e) || e.shiftKey || e.altKey || e.code !== 'KeyN') return;
  e.preventDefault();
  e.stopPropagation();
  $('new-pop').hidden ? openNew() : closeNew();
}, true);

// 새 노드는 겹치지 않는 빈 칸에 둔다. 보이는 영역 왼쪽 위부터 격자로 훑고, 서브 에이전트 카드 줄 자리까지 비워 둔다.
function freeSpot(w, h) {
  const gap = 110; // 프로젝트 테두리(24)·이름표(32)가 옆 프로젝트와 겹치지 않게
  const taken = [...nodes.values(), ...cards.values()].map((m) => ({ x: m.data.x, y: m.data.y, r: rightEdge(m), b: bottomEdge(m) }));
  const x0 = -view.x / view.scale + gap;
  const y0 = -view.y / view.scale + gap;
  for (let row = 0; row < 20; row++) {
    for (let col = 0; col < 6; col++) {
      const x = x0 + col * (w + gap);
      const y = y0 + row * (h + gap);
      if (taken.every((t) => x + w + gap <= t.x || x >= t.r + gap || y + h + gap <= t.y || y >= t.b + gap)) return { x, y };
    }
  }
  return { x: x0, y: y0 };
}

// 새 세션 창 크기. Claude Code 입력창·표가 줄바꿈 없이 들어가는 너비(약 110칸)
const NEW_SIZE = [1040, 660];
function launch(dir, spot, agent = cmd) {
  const [w, h] = NEW_SIZE;
  spot ??= freeSpot(w, h);
  const id = crypto.randomUUID();
  addNode({ id, command: agent, cwd: dir, ...spot, w, h }).then(() => nodes.has(id) && focusNode(nodes.get(id)));
}
$('add').addEventListener('click', openNew);

// 프로젝트 바로 옆(오른쪽, 안 되면 아래) 빈자리. 둘 다 막혀 있으면 undefined → 아무 빈 칸.
function groupSpot(list) {
  const [w, h] = NEW_SIZE, g = SNAP_GAP;
  const free = (x, y) => [...nodes.values(), ...cards.values()].every((m) =>
    x + w + g <= m.data.x || x >= rightEdge(m) + g || y + h + g <= m.data.y || y >= bottomEdge(m) + g);
  const right = Math.max(...list.map(rightEdge)) + g, top = Math.min(...list.map((n) => n.data.y));
  const left = Math.min(...list.map((n) => n.data.x)), bottom = Math.max(...list.map(bottomEdge)) + g;
  return free(right, top) ? { x: right, y: top } : free(left, bottom) ? { x: left, y: bottom } : undefined;
}

// 프로젝트 이름표 옆 [+] 메뉴: 새 세션(깔린 AI 중 고르기) / 세션 가져오기(이 프로젝트에서 했던 대화, 7개 높이로 스크롤)
// 사이드바 폴더 줄의 [+]·[세션 목록] 도 같은 #group-menu 를 쓴다.
const projectKeyOfPath = (p) => (p ? (folders.find((x) => samePath(x.path, p))?.worktreeOf || p).replace(/[\\/]+$/, '').toLowerCase() : '');
let groupMenuFor = null;
const availAgents = () => [...AGENTS.filter(([c]) => installed.includes(c)).map(([c]) => c), ''];
// 깔린 AI + PowerShell. 고르면 그 AI 로 실행하고 다음 기본값(헤더 cmd)도 그걸로 바꾼다(keepCmd 면 그대로 — 카드 AI 바꾸기).
function agentItems(run, keepCmd) {
  return availAgents().map((c) => {
    const b = el('button', 'gm-item gm-agent');
    b.dataset.agent = c;
    b.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">${glyphOf(c)}</svg>`; // 고정 아이콘만
    b.append(el('span', null, LABELS[c]));
    b.addEventListener('click', () => {
      closeGroupMenu();
      if (!keepCmd) { cmd = c; pref.set('cmd', cmd); renderAgentPick(); }
      run(c);
    });
    return b;
  });
}
// 버튼 아래에 두되 화면 밖으로 나가면 오른쪽·위로 당긴다. r 은 연 순간의 버튼 자리(사이드바 버튼은 마우스가 떠나면 숨는다).
function placeMenu(r) {
  const menu = $('group-menu'), h = menu.offsetHeight;
  const top = r.bottom + 6 + h > innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6;
  Object.assign(menu.style, { left: `${Math.max(8, Math.min(r.left, innerWidth - menu.offsetWidth - 8))}px`, top: `${top}px` });
}
function showMenu(key, parts, anchor) {
  closeGroupMenu();
  groupMenuFor = key;
  $('group-menu').replaceChildren(...parts);
  $('group-menu').hidden = false;
  const r = anchor.getBoundingClientRect();
  placeMenu(r);
  return r;
}
const projectSessions = (key) => api.listSessions().catch(() => [])
  .then((all) => (all ?? []).filter((s) => projectKeyOfPath(s.cwd) === key).sort((a, b) => b.at - a.at));
// at: 누를 때 자리를 정하는 함수(없으면 아무 빈 칸)
function sessRow(s, at) {
  const li = el('li', 'gm-sess');
  li.append(el('span', 'gm-title', nameOfSession(s.agent, s.id) ?? s.title), el('span', 'gm-meta', `${LABELS[s.agent] ?? s.agent}, ${openOnBoard(s) ? tr('ui.onBoard') : ago(s.at)}`));
  li.addEventListener('click', () => { closeGroupMenu(); openImported(s, at?.()); });
  return li;
}
function openGroupMenu(key, name, list, anchor) {
  const imp = el('button', 'gm-item gm-has-sub', tr('ui.import'));
  const sub = el('ul', 'gm-sub');
  sub.hidden = true;
  sub.append(el('li', 'gm-none', tr('ui.loading')));
  const showSub = () => {
    sub.hidden = false;
    const r = imp.getBoundingClientRect();
    const room = innerWidth - r.right > 330;
    Object.assign(sub.style, { top: `${r.top - 6}px`, left: room ? `${r.right + 4}px` : `${r.left - 324}px` });
  };
  imp.addEventListener('pointerenter', showSub);
  imp.addEventListener('click', showSub);
  showMenu(key, [el('div', 'gm-label', tr('ui.menu.newLabel')), ...agentItems((c) => launch(list[0].data.cwd, groupSpot(list), c)), el('div', 'gm-sep'), imp, sub], anchor);
  projectSessions(key).then((mine) => {
    if (groupMenuFor !== key) return;
    if (!mine.length) return sub.replaceChildren(el('li', 'gm-none', tr('ui.menu.noHistory', { name })));
    sub.replaceChildren(...mine.map((s) => sessRow(s, () => groupSpot(list))));
  });
}
// 사이드바 폴더 줄 [+]: 고를 AI 가 하나(PowerShell 만)면 메뉴 없이 바로 연다
function openSideNew(f, anchor) {
  const avail = availAgents();
  if (avail.length === 1) return launch(f.path, undefined, cmd); // AI 감지 전(installed=[])이면 저장된 기본 AI 유지
  showMenu(`new:${f.path}`, [el('div', 'gm-label', tr('ui.menu.newLabel')), ...agentItems((c) => launch(f.path, undefined, c))], anchor);
}
// 사이드바 폴더 줄 [세션 목록]: 이 프로젝트(워크트리 포함)에서 했던 대화, 최신순
function openSideSessions(f, name, anchor) {
  const key = `sess:${f.path}`;
  const ul = el('ul', 'gm-list');
  ul.append(el('li', 'gm-none', tr('ui.loading')));
  const r = showMenu(key, [el('div', 'gm-label', tr('ui.side.sessions')), ul], anchor);
  projectSessions(projectKeyOfPath(f.path)).then((mine) => {
    if (groupMenuFor !== key) return;
    ul.replaceChildren(...(mine.length ? mine.map((s) => sessRow(s)) : [el('li', 'gm-none', tr('ui.menu.noHistory', { name }))]));
    placeMenu(r);
  });
}
function closeGroupMenu() {
  groupMenuFor = null;
  $('group-menu').hidden = true;
}
addEventListener('pointerdown', (e) => { if (groupMenuFor != null && !e.target.closest('#group-menu, .group-add, .wt-new, .wt-sessions, .node .agent')) closeGroupMenu(); }, true);
addEventListener('keydown', (e) => { if (e.key === 'Escape' && groupMenuFor != null) closeGroupMenu(); });

// --- 세션 가져오기: 다른 터미널에서 했던 Claude·Codex·Cursor 대화를 보드에서 이어 열기 ---
const IMPORT_AGENTS = ['claude', 'codex', 'cursor-agent'];
let importAgent = pref.get('importAgent', 'claude');
let importable = [];
const ago = (ms) => {
  const min = Math.round((Date.now() - ms) / 60000);
  return min < 1 ? tr('main.ago.now') : min < 60 ? tr('main.ago.min', { n: min }) : min < 1440 ? tr('main.ago.hour', { n: Math.round(min / 60) }) : tr('main.ago.day', { n: Math.round(min / 1440) });
};
const openOnBoard = (s) => [...nodes.values()].find((n) => n.data.command === s.agent && n.data.sessionId === s.id);

async function openImport() {
  $('import-pop').hidden = false;
  $('import').setAttribute('aria-expanded', 'true');
  $('import-search').value = '';
  $('import-list').replaceChildren(el('li', 'none', tr('ui.loading')));
  $('import-search').focus();
  importable = await api.listSessions();
  renderImport();
}
function closeImport() {
  $('import-pop').hidden = true;
  $('import').setAttribute('aria-expanded', 'false');
}

function renderImport() {
  if ($('import-pop').hidden) return;
  $('import-pop').querySelector('.import-tabs').replaceChildren(...IMPORT_AGENTS.map((a) => {
    const b = el('button', null, `${LABELS[a]} ${importable.filter((s) => s.agent === a).length}`);
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', a === importAgent);
    b.addEventListener('click', () => { importAgent = a; pref.set('importAgent', a); renderImport(); $('import-search').focus(); });
    return b;
  }));
  const q = $('import-search').value.trim().toLowerCase();
  const list = importable.filter((s) => s.agent === importAgent && (!q || [s.title, s.cwd, nameOfSession(s.agent, s.id) ?? ''].some((t) => t.toLowerCase().includes(q))));
  if (!list.length) {
    const why = q ? tr('ui.import.noMatch')
      : !installed.includes(importAgent) ? tr('ui.import.notInstalled', { agent: LABELS[importAgent] })
      : tr('ui.import.noHistory', { agent: LABELS[importAgent] });
    return $('import-list').replaceChildren(el('li', 'none', why));
  }
  $('import-list').replaceChildren(...list.map((s) => {
    const open = openOnBoard(s);
    const li = el('li');
    // 2분 안에 기록된 대화는 다른 터미널에서 아직 쓰는 중일 수 있다(같이 열면 기록이 엉킬 수 있다)
    const busy = !open && Date.now() - s.at < 120000;
    const named = nameOfSession(s.agent, s.id);
    li.append(el('span', 'name', named ?? s.title), el('span', `tag${open ? ' open' : ''}`, open ? tr('ui.onBoard') : busy ? tr('ui.import.busy') : ago(s.at)),
      ...(named ? [el('span', 'path', s.title)] : []),
      el('span', 'path', s.cwd || tr('ui.import.noCwd')));
    li.addEventListener('click', () => openImported(s));
    // 보드로 끌어다 놓으면 놓은 자리에 연다. 끄는 동안 목록은 비켜 준다(지우면 끌기가 끊긴다).
    li.draggable = true;
    li.addEventListener('dragstart', (e) => {
      importDrag = s;
      e.dataTransfer.setData('text/plain', s.title);
      e.dataTransfer.effectAllowed = 'copy';
      requestAnimationFrame(() => $('import-pop').classList.add('dragging'));
    });
    li.addEventListener('dragend', () => {
      importDrag = null;
      $('import-pop').classList.remove('dragging', 'cancel');
    });
    return li;
  }));
}

let importDrag = null;
function openImported(s, at) {
  closeImport();
  const open = openOnBoard(s);
  if (open) return focusNode(open);
  if (!installed.includes(s.agent)) return toast(tr('ui.import.cantOpen', { agent: LABELS[s.agent] }), true);
  const [w, h] = NEW_SIZE;
  const id = crypto.randomUUID();
  const named = nameOfSession(s.agent, s.id);
  addNode({ id, command: s.agent, cwd: s.cwd || cwd, ...(at ?? freeSpot(w, h)), w, h, sessionId: s.id, ...(named && { name: uniqueName(named) }) })
    .then(() => nodes.has(id) && (at ? setFocused(nodes.get(id)) : focusNode(nodes.get(id))));
}
// 끄는 동안 목록 창은 마우스를 통과시키므로, 목록 창 위인지는 좌표로 본다. 거기 놓으면 취소.
const overImportPop = (e) => {
  const r = $('import-pop').getBoundingClientRect();
  return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
};
viewport.addEventListener('dragover', (e) => {
  if (!importDrag) return;
  e.preventDefault();
  const cancel = overImportPop(e);
  e.dataTransfer.dropEffect = cancel ? 'none' : 'copy';
  $('import-pop').classList.toggle('cancel', cancel);
});
viewport.addEventListener('drop', (e) => {
  if (!importDrag) return;
  e.preventDefault();
  if (overImportPop(e)) return; // dragend 가 목록 창을 되살린다
  const r = viewport.getBoundingClientRect();
  // 놓은 점이 창의 머리(왼쪽 위 근처)가 되게
  const x = (e.clientX - r.left - view.x) / view.scale - 40, y = (e.clientY - r.top - view.y) / view.scale - 18;
  const s = importDrag;
  importDrag = null;
  $('import-pop').classList.remove('dragging');
  openImported(s, { x, y });
});
$('import').addEventListener('click', () => ($('import-pop').hidden ? openImport() : closeImport()));
$('import-search').addEventListener('input', renderImport);
$('import-pop').addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeImport(); $('import').focus(); } });
addEventListener('pointerdown', (e) => { if (!$('import-pop').hidden && !e.target.closest('.importer')) closeImport(); });

// --- 파일 서랍: 세션·프로젝트 폴더의 트리, git 상태, 찾기, 미리보기, 세션으로 끌어 놓기 ---
const fx = { root: null, top: null, changes: {}, open: new Set(), cache: new Map(), active: null };
const sepOf = (p) => (p.includes('\\') ? '\\' : '/');
const joinPath = (dir, name) => `${dir.replace(/[\\/]+$/, '')}${sepOf(dir)}${name}`;
// base 아래면 base 기준 상대 경로('/' 구분), 아니면 null
function relTo(base, p) {
  const norm = (s) => s.replace(/\\/g, '/').replace(/\/+$/, '');
  const b = norm(base), q = norm(p);
  const same = isMac ? q.startsWith(`${b}/`) : q.toLowerCase().startsWith(`${b.toLowerCase()}/`);
  return same ? q.slice(b.length + 1) : null;
}
const changeOf = (abs) => (fx.top ? fx.changes[relTo(fx.top, abs)] : undefined);
const dirChanged = (abs) => {
  const r = fx.top && relTo(fx.top, abs);
  return !!r && Object.keys(fx.changes).some((k) => k.startsWith(`${r}/`));
};

// 사이드바 [파일] 탭에 그 폴더의 트리를 연다. 이미 열린 폴더면 탭만 보여 준다.
async function openFiles(dir) {
  if (!dir) return toast(tr('ui.files.homeNo'), true);
  if ($('sidebar').hidden) setSidebar(true);
  const same = !!fx.root && samePath(fx.root, dir);
  // root 를 탭 전환보다 먼저 정한다. 비어 있으면 setSideTab 이 다시 openFiles 를 불러 끝없이 돈다(스택 넘침 + git 호출 수천 번).
  if (!same) Object.assign(fx, { root: dir, top: null, changes: {}, open: new Set(), cache: new Map(), active: null });
  setSideTab('files');
  if (same) return;
  $('files-title').textContent = basename(dir);
  $('files-meta').textContent = dir;
  $('files-search').value = '';
  $('files-only-changed').checked = false;
  $('files-tree').replaceChildren();
  const st = await api.gitChanges(dir).catch(() => ({})); // git 조회가 실패해도 트리는 그린다
  if (fx.root !== dir) return;
  Object.assign(fx, { top: st.top ?? null, changes: st.changes ?? {} });
  $('files-only-changed').disabled = !st.top;
  renderFiles();
}
// 사이드바 탭: 프로젝트 목록 / 지금 세션의 파일 트리
function setSideTab(t) {
  const files = t === 'files';
  $('tab-projects').setAttribute('aria-selected', !files);
  $('tab-files').setAttribute('aria-selected', files);
  $('side-list').hidden = files;
  $('side-files').hidden = !files;
  $('sidebar').classList.toggle('tab-files', files);
  if (files) $('wt-form').hidden = true;
  pref.set('sideTab', t);
  if (files && !fx.root && focused?.data.cwd) openFiles(focused.data.cwd);
}
$('tab-projects').addEventListener('click', () => setSideTab('projects'));
$('tab-files').addEventListener('click', () => setSideTab('files'));


function fileRow(abs, name, depth, isDir, sub) {
  const row = el('div', `f-row${isDir ? ' is-dir' : ''}${fx.open.has(abs) ? ' open' : ''}${fx.active === abs ? ' active' : ''}`);
  row.style.paddingLeft = `${8 + depth * 14}px`;
  row.setAttribute('role', 'treeitem');
  Object.assign(row.dataset, { abs, depth });
  row.addEventListener('contextmenu', (e) => openFileMenu(e, abs, isDir));
  const chev = el('span', 'chev');
  if (isDir) chev.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M3 2l3.5 3L3 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  row.append(chev, el('span', 'f-name', name));
  if (sub) row.append(el('span', 'f-sub', sub));
  const c = isDir ? (dirChanged(abs) ? 'dot' : null) : changeOf(abs);
  if (c) {
    const b = el('span', `f-badge ${c === '?' ? 'U' : c}`, c === 'dot' ? '•' : c === '?' ? 'U' : c);
    b.title = { M: tr('ui.git.M'), A: tr('ui.git.A'), D: tr('ui.git.D'), R: tr('ui.git.R'), '?': tr('ui.git.new'), dot: tr('ui.git.dot') }[c] ?? c;
    row.append(b);
  }
  if (isDir) {
    row.addEventListener('click', () => {
      fx.open.has(abs) ? fx.open.delete(abs) : fx.open.add(abs);
      renderFiles();
    });
  } else {
    row.addEventListener('click', () => {
      fx.active = abs;
      renderFiles();
      openViewer({ data: { cwd: fx.root } }, abs, 0);
    });
    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
      fileDrag = abs;
      e.dataTransfer.setData('text/plain', abs);
      e.dataTransfer.effectAllowed = 'copy';
    });
    row.addEventListener('dragend', () => { fileDrag = null; document.querySelector('.node.file-drop')?.classList.remove('file-drop'); });
  }
  return row;
}

async function treeRows(dir, depth) {
  if (!fx.cache.has(dir)) fx.cache.set(dir, await api.listDir(dir).catch((e) => ({ error: e.message })));
  const ents = fx.cache.get(dir);
  if (ents.error) return [el('div', 'f-none', tr('ui.files.readFail', { error: ents.error }))];
  const rows = [];
  for (const d of ents) {
    const abs = joinPath(dir, d.name);
    const row = fileRow(abs, d.name, depth, d.dir);
    if (d.ignored) row.classList.add('ignored'); // .gitignore 에 걸린 것
    rows.push(row);
    if (d.dir && fx.open.has(abs)) rows.push(...await treeRows(abs, depth + 1));
  }
  return rows;
}

let filesRender = 0;
async function renderFiles() {
  const root = fx.root;
  if (!root) return;
  const ticket = ++filesRender; // 빨리 타자 칠 때 늦게 온 결과가 덮어쓰지 않게
  const q = $('files-search').value.trim();
  let rows;
  if (q) {
    const found = await api.searchFiles(root, q);
    rows = found.map((r) => fileRow(joinPath(root, r.replace(/\//g, sepOf(root))), r.split('/').pop(), 0, false, r.includes('/') ? r.slice(0, r.lastIndexOf('/')) : ''));
    if (!rows.length) rows = [el('div', 'f-none', tr('ui.files.noMatch'))];
  } else if ($('files-only-changed').checked) {
    rows = Object.entries(fx.changes)
      .map(([r]) => [joinPath(fx.top, r.replace(/\//g, sepOf(fx.top))), r])
      .filter(([abs]) => relTo(root, abs) != null)
      .map(([abs, r]) => fileRow(abs, r.split('/').pop(), 0, false, relTo(root, abs).split('/').slice(0, -1).join('/')));
    if (!rows.length) rows = [el('div', 'f-none', tr('ui.files.noChanges'))];
  } else {
    rows = await treeRows(root, 0);
    if (!rows.length) rows = [el('div', 'f-none', tr('ui.files.empty'))];
  }
  if (ticket !== filesRender || fx.root !== root) return;
  $('files-tree').replaceChildren(...rows);
}
$('files-search').addEventListener('input', renderFiles);
$('files-only-changed').addEventListener('change', renderFiles);

// --- 파일 트리 오른쪽 클릭 메뉴: 열기·새 파일/폴더·이름 바꾸기(F2)·휴지통·경로 복사·탐색기에서 보기·세션에 보내기 ---
// 실제 파일 작업은 메인이 프로젝트 폴더 안인지 확인하고 한다. 삭제는 휴지통으로만.
const dirOf = (p) => p.replace(/[\\/][^\\/]+$/, '');
const under = (p, base) => sameFile(p, base) || relTo(base, p) != null;
let fileMenuOpen = false;
function closeFileMenu() {
  if (!fileMenuOpen) return;
  fileMenuOpen = false;
  $('group-menu').hidden = true;
}
function openFileMenu(e, abs, isDir) {
  e.preventDefault();
  e.stopPropagation();
  closeGroupMenu();
  const root = fx.root;
  const isRoot = sameFile(abs, root);
  const item = (label, fn, cls = '') => {
    const b = el('button', `gm-item ${cls}`, label);
    b.addEventListener('click', () => { closeFileMenu(); fn(); });
    return b;
  };
  const sep = () => el('div', 'gm-sep');
  const parts = [];
  if (!isDir) parts.push(item(tr('ui.fm.open'), () => { fx.active = abs; renderFiles(); openViewer({ data: { cwd: root } }, abs, 0); }));
  const into = isDir ? abs : dirOf(abs);
  parts.push(item(tr('ui.fm.newFile'), () => newEntry(into, false)), item(tr('ui.fm.newFolder'), () => newEntry(into, true)));
  if (!isRoot) {
    parts.push(sep(), item(tr('ui.fm.rename'), () => renameEntry(abs), 'gm-key-f2'), item(tr('ui.fm.trash'), () => trashEntry(abs, isDir), 'gm-danger'));
  }
  parts.push(sep(), item(tr('ui.fm.copyPath'), () => { api.copy(abs); toast(tr('ui.fm.copiedPath')); }));
  if (!isRoot) parts.push(item(tr('ui.fm.copyRel'), () => { api.copy(relTo(root, abs)); toast(tr('ui.fm.copiedRel')); }));
  parts.push(item(tr(isMac ? 'ui.fm.revealMac' : 'ui.fm.reveal'), () => api.fileOp('reveal', root, abs, null)));
  const sessions = [...nodes.values()];
  if (sessions.length && !isRoot) {
    parts.push(sep(), el('div', 'gm-label', tr('ui.fm.send')));
    // 지금 고른 세션이 맨 위
    sessions.sort((a, b) => (b === focused) - (a === focused));
    for (const n of sessions.slice(0, 8)) parts.push(item(`${LABELS[n.data.command] ?? n.data.command} · ${n.data.name}`, () => insertPaths(n, [abs]), 'gm-sess-item'));
  }
  const menu = $('group-menu');
  menu.replaceChildren(...parts);
  menu.hidden = false;
  fileMenuOpen = true;
  // 화면 밖으로 나가지 않게
  const w = menu.offsetWidth, h = menu.offsetHeight;
  Object.assign(menu.style, { left: `${Math.min(e.clientX, innerWidth - w - 8)}px`, top: `${Math.min(e.clientY, innerHeight - h - 8)}px` });
}
addEventListener('pointerdown', (e) => { if (fileMenuOpen && !e.target.closest('#group-menu')) closeFileMenu(); }, true);
addEventListener('keydown', (e) => { if (e.key === 'Escape') closeFileMenu(); });
$('files-tree').addEventListener('scroll', closeFileMenu);
// 트리 빈 곳 오른쪽 클릭 = 프로젝트 맨 위 폴더에 대한 메뉴
$('files-tree').addEventListener('contextmenu', (e) => { if (fx.root && !e.target.closest('.f-row')) openFileMenu(e, fx.root, true); });

// 트리 다시 읽기(만들기·이름 바꾸기·삭제 뒤). git 상태도 다시 본다.
async function reloadTree() {
  fx.cache.clear();
  const st = await api.gitChanges(fx.root);
  if (st) Object.assign(fx, { top: st.top, changes: st.changes });
  await renderFiles();
}
// 트리 줄 자리에 이름 입력칸. Enter = 확정, Esc·포커스 잃음 = 취소.
function nameInput(row, value, selectTo, done) {
  const input = el('input', 'f-edit');
  input.value = value;
  const name = row.querySelector('.f-name');
  name.replaceWith(input);
  input.focus();
  input.setSelectionRange(0, selectTo ?? value.length);
  let finished = false;
  const finish = (ok) => {
    if (finished) return;
    finished = true;
    done(ok ? input.value.trim() : null);
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(false));
  input.addEventListener('click', (e) => e.stopPropagation());
}
const rowOf = (abs) => [...$('files-tree').querySelectorAll('.f-row')].find((r) => r.dataset.abs && sameFile(r.dataset.abs, abs));

async function newEntry(dir, isDir) {
  if ($('files-search').value || $('files-only-changed').checked) {
    $('files-search').value = '';
    $('files-only-changed').checked = false;
  }
  if (!sameFile(dir, fx.root)) fx.open.add(dir);
  await renderFiles();
  // 그 폴더 바로 아래(맨 위 폴더면 트리 맨 위)에 임시 줄
  const parent = rowOf(dir);
  const depth = parent ? Number(parent.dataset.depth) + 1 : 0;
  const temp = fileRow(joinPath(dir, ''), '', depth, isDir);
  temp.classList.add('f-new');
  if (parent) parent.after(temp); else $('files-tree').prepend(temp);
  nameInput(temp, '', 0, async (name) => {
    temp.remove();
    if (!name) return;
    const r = await api.fileOp('create', fx.root, dir, { name, isDir });
    if (r.error) return toast(tr('ui.fm.createFail', { error: r.error }), true);
    await reloadTree();
    if (!isDir) { fx.active = r.path; renderFiles(); openViewer({ data: { cwd: fx.root } }, r.path, 0); }
  });
}

async function renameEntry(abs) {
  const row = rowOf(abs);
  if (!row) return;
  const old = basename(abs);
  const dot = old.lastIndexOf('.');
  nameInput(row, old, dot > 0 ? dot : old.length, async (name) => {
    if (!name || name === old) return renderFiles();
    const r = await api.fileOp('rename', fx.root, abs, name);
    if (r.error) { toast(tr('ui.fm.renameFail', { error: r.error }), true); return renderFiles(); }
    // 열린 탭·펼친 폴더·고른 파일도 새 경로를 따라간다
    const moved = (p) => (under(p, abs) ? r.path + p.slice(abs.length) : p);
    for (const d of docs) d.abs = moved(d.abs);
    if (docActive) { docActive = moved(docActive); $('doc-path').textContent = docActive; }
    fx.open = new Set([...fx.open].map(moved));
    if (fx.active) fx.active = moved(fx.active);
    renderDocTabs();
    await reloadTree();
  });
}

async function trashEntry(abs, isDir) {
  const name = basename(abs);
  if (!await confirmBox(tr('ui.fm.trash'), `${tr(isDir ? 'ui.fm.trashFolder' : 'ui.fm.trashFile', { name })}${isDir ? `\n${tr('ui.fm.trashInside')}` : ''}\n${tr('ui.fm.trashRestore')}`, tr('ui.fm.delete'))) return;
  const r = await api.fileOp('trash', fx.root, abs);
  if (r.error) return toast(tr('ui.fm.deleteFail', { error: r.error }), true);
  // 지운 파일·폴더 안의 파일 탭은 닫는다(저장 안 한 내용도 같이 사라짐)
  const gone = docs.filter((d) => under(d.abs, abs));
  for (const d of gone) docs.splice(docs.indexOf(d), 1);
  if (docActive && under(docActive, abs)) showDoc(docs[0]?.abs ?? null);
  else renderDocTabs();
  toast(tr('ui.fm.trashed', { name }));
  await reloadTree();
}

// F2: 파일 트리에서 고른 파일 이름 바꾸기 (입력칸·편집기·터미널에 있을 땐 그대로)
addEventListener('keydown', (e) => {
  if (e.key !== 'F2' || $('side-files').hidden || !fx.active || e.target.closest?.('input, textarea, .xterm, .CodeMirror')) return;
  e.preventDefault();
  renameEntry(fx.active);
});

// 파일 화면 편집기(CodeMirror 5). 탭마다 CodeMirror.Doc 하나 — 되돌리기·커서·스크롤이 탭별로 남는다.
// Ctrl+F 찾기(Enter 다음 / Shift+Enter 이전), Ctrl+S 저장, Esc 보드로. 언어는 파일 이름으로 고른다(모르면 글자만).
const editor = CodeMirror($('doc-code'), {
  theme: 'bimo',
  lineNumbers: true,
  styleActiveLine: true,
  matchBrackets: true,
  indentUnit: 2,
  tabSize: 4,
  extraKeys: {
    'Ctrl-S': () => saveDoc(), 'Cmd-S': () => saveDoc(),
    'Ctrl-F': 'findPersistent', 'Cmd-F': 'findPersistent',
    'Ctrl-H': 'replace', 'Cmd-Alt-F': 'replace',
    Esc: () => showDoc(null),
  },
});
function modeOf(file) {
  const info = CodeMirror.findModeByFileName(file.split(/[\\/]/).pop());
  return info && CodeMirror.modes[info.mode] ? info.mime || info.mode : null;
}
const docDirty = (d) => !!d.cm && !d.cm.isClean(d.clean);
// .md 는 고치는 대로 오른쪽 해석도 따라 바꾼다(잠깐 멈췄을 때)
let mdTimer = 0;
editor.on('change', () => {
  const d = docActive && docs.find((x) => sameFile(x.abs, docActive));
  if (!d) return;
  if (d.dirty !== docDirty(d)) { d.dirty = docDirty(d); renderDocTabs(); }
  if (isMd(d.abs)) { clearTimeout(mdTimer); mdTimer = setTimeout(() => renderMd(editor.getValue()), 250); }
});
// 남의 저장소 .md 를 열 수도 있다 — 입력·폼·내장 창은 지운다(눌렀을 때 앱 창이 다른 곳으로 넘어가지 않게)
function renderMd(text) {
  const top = $('doc-md').scrollTop;
  $('doc-md').innerHTML = DOMPurify.sanitize(marked.parse(text), { FORBID_TAGS: ['form', 'input', 'button', 'select', 'textarea', 'iframe', 'object', 'embed', 'style'], FORBID_ATTR: ['formaction', 'action'] });
  $('doc-md').scrollTop = top;
}
// 저장: 연 뒤 다른 곳(AI 등)에서 파일이 바뀌었으면 덮어쓸지 묻는다. 줄바꿈(CRLF/LF)은 원래 파일대로.
async function saveDoc() {
  const d = docActive && docs.find((x) => sameFile(x.abs, docActive));
  if (!d?.cm) return;
  const text = d.cm.getValue(d.eol);
  let res = await api.writeFile(d.abs, text, d.mtime, false);
  if (res.conflict) {
    if (!await confirmBox(tr('ui.doc.changedTitle'), tr('ui.doc.changedText', { name: basename(d.abs) }), tr('ui.doc.overwrite'))) return;
    res = await api.writeFile(d.abs, text, d.mtime, true);
  }
  if (res.error) return toast(tr('ui.doc.saveFail', { error: res.error }), true);
  d.mtime = res.mtime;
  d.clean = d.cm.changeGeneration();
  d.dirty = false;
  renderDocTabs();
  toast(tr('ui.doc.saved', { name: basename(d.abs) }));
}

// 클립보드의 캡처 이미지(PNG Blob). 없으면 null.
async function clipboardPng() {
  try {
    for (const it of await navigator.clipboard.read()) if (it.types.includes('image/png')) return await it.getType('image/png');
  } catch {}
  return null;
}

// 터미널 경로 인식: C:\a\b.java, /a/b.ts, src/a.js, ./a.md, main.js 처럼 확장자가 있는 것 + 뒤의 :줄(:칸)
// 1 = 경로, 2 = 줄 번호
const PATH_RE = /((?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\\/])?(?:[\w.\-@\[\]]+[\\/])*[\w\-@\[\]]+(?:\.[\w\-]+)*\.[A-Za-z][\w]{0,9})(?::(\d+)(?::\d+)?)?/g;

// --- 파일 탭 화면: 트리·경로 링크로 연 파일이 헤더 아래 탭으로 쌓이고 보드 자리를 덮는다 ---
// [보드] 탭 = 터미널 화면. 파일 탭은 × 를 누르기 전까지 남는다(앱이 켜져 있는 동안). .md 는 왼쪽 원문 / 오른쪽 해석.
const docs = []; // { abs, line }
let docActive = null; // 지금 보는 파일 경로, null = 보드
const isMd = (abs) => /\.(md|markdown)$/i.test(abs);
const sameFile = (a, b) => (isMac ? a === b : a.toLowerCase() === b.toLowerCase());

function openViewer(n, abs, line) {
  if (isCardFile(abs)) return openCard(abs); // PDF·이미지는 글자 탭 대신 보드 위 카드로
  const d = docs.find((x) => sameFile(x.abs, abs));
  if (d) d.line = line;
  else docs.push({ abs, line });
  showDoc(abs);
}
function renderDocTabs() {
  const bar = $('doc-tabs');
  bar.hidden = !docs.length;
  document.body.classList.toggle('has-docs', !!docs.length);
  const board = el('button', `doc-tab board${docActive ? '' : ' on'}`, tr('ui.doc.board'));
  board.addEventListener('click', () => showDoc(null));
  bar.replaceChildren(board, ...docs.map((d) => {
    const t = el('div', `doc-tab${docActive && sameFile(d.abs, docActive) ? ' on' : ''}`);
    t.title = d.abs;
    t.classList.toggle('dirty', !!d.dirty);
    t.append(el('span', 'doc-name', basename(d.abs)));
    const x = el('button', 'doc-x', '×');
    x.setAttribute('aria-label', tr('ui.doc.close', { name: basename(d.abs) }));
    x.addEventListener('click', (e) => { e.stopPropagation(); closeDoc(d.abs); });
    t.append(x);
    t.addEventListener('click', () => showDoc(d.abs));
    t.addEventListener('auxclick', (e) => { if (e.button === 1) closeDoc(d.abs); }); // 휠 버튼 클릭으로도 닫기
    return t;
  }));
  bar.querySelector('.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
async function showDoc(abs) {
  // 떠나는 탭의 오른쪽 해석 스크롤을 기억해 두었다가 돌아오면 그 자리로(편집기 쪽은 Doc 이 기억한다)
  const prev = docActive && docs.find((x) => sameFile(x.abs, docActive));
  if (prev && !$('docs').hidden) prev.mdTop = $('doc-md').scrollTop;
  docActive = abs;
  renderDocTabs();
  $('docs').hidden = !abs;
  nodes.forEach((n) => n.fit.fit()); // 탭 줄이 생기거나 없어지면 보드 높이가 바뀐다
  if (!abs) return;
  const d = docs.find((x) => sameFile(x.abs, abs));
  const md = isMd(abs);
  $('docs').classList.toggle('split', md);
  $('doc-path').textContent = abs;
  $('doc-ext').hidden = true;
  // 고치지 않은 탭은 열 때마다 다시 읽어 AI 가 고친 내용이 바로 보이게. 고치던 탭은 그대로 둔다.
  if (!d.cm || !docDirty(d)) {
    const r = await api.readFile(abs);
    if (docActive !== abs) return;
    if (r.error) {
      d.cm = null;
      $('doc-ext').hidden = false; // 미리보기 못 하는 파일(큼·바이너리)은 OS 앱으로
      editor.swapDoc(CodeMirror.Doc(r.error));
      editor.setOption('readOnly', true);
      $('doc-md').replaceChildren();
      return;
    }
    const eol = r.text.includes('\r\n') ? '\r\n' : '\n';
    if (!d.cm) {
      d.cm = CodeMirror.Doc(r.text, modeOf(abs));
      d.clean = d.cm.changeGeneration();
    } else if (r.mtime !== d.mtime && d.cm.getValue(eol) !== r.text) {
      const { left, top } = editor.getScrollInfo();
      const cur = d.cm.getCursor();
      d.cm.setValue(r.text);
      d.cm.setCursor(cur);
      d.clean = d.cm.changeGeneration();
      requestAnimationFrame(() => editor.scrollTo(left, top));
    }
    d.mtime = r.mtime;
    d.eol = eol;
  }
  editor.setOption('readOnly', false);
  if (editor.getDoc() !== d.cm) editor.swapDoc(d.cm);
  editor.refresh();
  if (md) renderMd(d.cm.getValue()); else $('doc-md').replaceChildren();
  if (d.line > 0) {
    const line = Math.min(d.line, d.cm.lineCount()) - 1;
    d.cm.setCursor({ line, ch: 0 });
    editor.scrollIntoView({ line, ch: 0 }, editor.getScrollInfo().clientHeight / 2);
    d.cm.addLineClass(line, 'background', 'cm-jump');
    setTimeout(() => d.cm.removeLineClass(line, 'background', 'cm-jump'), 1600);
    d.line = 0; // 줄 이동은 처음 한 번만. 다음부터는 보던 자리로
  } else if (md) $('doc-md').scrollTop = d.mdTop || 0;
  editor.focus();
}
async function closeDoc(abs) {
  const i = docs.findIndex((x) => sameFile(x.abs, abs));
  if (i < 0) return;
  if (docs[i].dirty && !await confirmBox(tr('ui.doc.unsavedTitle'), tr('ui.doc.unsavedText', { name: basename(abs) }), tr('ui.close'))) return;
  docs.splice(i, 1);
  if (docActive && sameFile(docActive, abs)) showDoc(docs[Math.min(i, docs.length - 1)]?.abs ?? null);
  else renderDocTabs();
  if (!docs.length) nodes.forEach((n) => n.fit.fit());
}
// 해석된 마크다운 속 링크: 웹 주소는 브라우저로, 상대 경로 파일은 탭으로. 앱 창이 다른 페이지로 넘어가지 않게 막는다.
$('doc-md').addEventListener('click', async (e) => {
  const a = e.target.closest('a[href]');
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute('href');
  if (/^https?:/i.test(href)) return api.openUpdate(href);
  if (href.startsWith('#')) return;
  const dir = docActive.replace(/[\\/][^\\/]+$/, '');
  const [abs] = await api.resolveFiles(dir, [decodeURIComponent(href.split('#')[0])]);
  if (abs) openViewer(null, abs, 0);
});
// .md 원문/해석 경계 끌기. 비율은 이 PC 에서 기억한다(20~80%).
let docLeft = Number(pref.get('docLeft', '50')) || 50;
$('docs').style.setProperty('--doc-left', `${docLeft}%`);
document.querySelector('.doc-split').addEventListener('pointerdown', (e) => {
  const grip = e.currentTarget, w = grip.parentElement.clientWidth;
  grip.classList.add('on');
  drag(e, (dx) => {
    docLeft = Math.max(20, Math.min(80, docLeft + (dx / w) * 100));
    $('docs').style.setProperty('--doc-left', `${docLeft}%`);
  }, () => { grip.classList.remove('on'); pref.set('docLeft', String(Math.round(docLeft))); });
});
// Esc: 파일 화면에서 보드로 (탭은 남는다)
addEventListener('keydown', (e) => { if (e.key === 'Escape' && docActive && !e.target.closest?.('input, textarea, .xterm')) showDoc(null); });

// 파일을 세션 창에 끌어 놓으면 입력칸에 @경로. 세션 폴더 안이면 상대 경로, 밖이면 전체 경로.
let fileDrag = null;
boardEl.addEventListener('dragover', (e) => {
  if (!fileDrag) return;
  const n = nodeOfEl.get(e.target.closest?.('.node'));
  document.querySelectorAll('.node.file-drop').forEach((x) => x !== n?.el && x.classList.remove('file-drop'));
  if (!n) return;
  e.preventDefault();
  e.stopPropagation();
  e.dataTransfer.dropEffect = 'copy';
  n.el.classList.add('file-drop');
}, true);
boardEl.addEventListener('drop', (e) => {
  if (!fileDrag) return;
  const n = nodeOfEl.get(e.target.closest?.('.node'));
  if (!n) return;
  e.preventDefault();
  e.stopPropagation();
  n.el.classList.remove('file-drop');
  insertPaths(n, [fileDrag]);
  fileDrag = null;
}, true);
function insertPaths(n, files) {
  api.write(n.data.id, files.map((f) => {
    const p = (n.data.cwd && relTo(n.data.cwd, f)) ?? f.replace(/\\/g, '/');
    return /\s/.test(p) ? `@"${p}" ` : `@${p} `;
  }).join(''));
  n.term.focus();
  setFocused(n);
}

// 탐색기(Finder)에서 끌어온 파일: 세션 창 위에 놓으면 입력칸에 @경로, 빈 곳에 놓으면 큰 창으로 보기
const osFiles = (e) => !fileDrag && !importDrag && e.dataTransfer?.types.includes('Files');
viewport.addEventListener('dragover', (e) => {
  if (!osFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  const n = nodeOfEl.get(e.target.closest?.('.node'));
  document.querySelectorAll('.node.file-drop').forEach((x) => x !== n?.el && x.classList.remove('file-drop'));
  n?.el.classList.add('file-drop');
}, true);
viewport.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.querySelectorAll('.node.file-drop').forEach((x) => x.classList.remove('file-drop')); });
viewport.addEventListener('drop', (e) => {
  if (!osFiles(e)) return;
  e.preventDefault();
  e.stopPropagation();
  document.querySelectorAll('.node.file-drop').forEach((x) => x.classList.remove('file-drop'));
  const files = [...e.dataTransfer.files].map((f) => api.pathOfFile(f)).filter(Boolean);
  if (!files.length) return;
  const n = nodeOfEl.get(e.target.closest?.('.node'));
  if (n) insertPaths(n, files);
  else openViewer({ data: {} }, files[0], 0);
}, true);
// 창 밖(헤더·사이드바)에 떨어뜨려도 앱이 그 파일로 넘어가 버리지 않게
addEventListener('dragover', (e) => { if (osFiles(e)) e.preventDefault(); });
addEventListener('drop', (e) => { if (osFiles(e)) e.preventDefault(); });

// --- 프로젝트 사이드바: 저장소 > 브랜치·워크트리 > 열린 세션 ---

const samePath = (a, b) => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();

// --- 문서 카드(PDF·이미지): 보드 위 읽기 전용 창 ---
// 터미널을 가정한 코드(n.term·n.fit·협업·보내기)가 많아 nodes 와 따로 둔다. 미니맵·전체 보기·빈 칸 찾기에만 같이 든다.
const isCardFile = (p) => /\.(pdf|png|jpe?g|gif|webp)$/i.test(p);
const docSize = () => NEW_SIZE; // 새 세션 창과 같은 크기. 저장된 카드는 저장 크기 그대로
const openExt = (abs) => api.openExternal(abs).then((r) => r?.error && toast(r.error, true), (err) => toast(err.message, true));

async function openCard(abs) {
  if (docActive) showDoc(null); // 글자 탭이 보드를 덮고 있으면 카드가 안 보인다
  const old = [...cards.values()].find((c) => sameFile(c.data.path, abs));
  if (old) return focusCard(old);
  const r = await api.openDoc(abs).catch((err) => ({ error: err.message }));
  if (r?.error || !r?.url) return toast(r?.error || tr('ui.doc.openFail'), true);
  const [w, h] = docSize(abs);
  focusCard(addCard({ id: `doc-${crypto.randomUUID()}`, path: abs, ...freeSpot(w, h), w, h }, r));
}

function addCard(data, doc) {
  const name = basename(data.path);
  const c = { data, el: el('div', 'node doc-card'), body: el('div', 'body') };
  const head = el('div', 'head');
  const title = el('span', 'where', name);
  title.title = data.path;
  const ext = el('button', 'doc-ext', tr('ui.doc.openExternal'));
  ext.addEventListener('click', () => openExt(data.path));
  const x = el('button', 'close', '×');
  x.setAttribute('aria-label', tr('ui.doc.close', { name }));
  x.addEventListener('click', () => { c.el.remove(); cards.delete(data.id); save(); });
  head.append(title, ext, x);
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    // 세션 창과 같은 마그넷. Alt 를 누르면 끈다.
    let rx = data.x, ry = data.y;
    drag(e, (dx, dy, ev) => {
      rx += dx / view.scale;
      ry += dy / view.scale;
      const s = ev.altKey ? { x: rx, y: ry } : snapTo(c, rx, ry);
      data.x = s.x;
      data.y = s.y;
      placeCard(c);
    });
  });
  c.el.append(head, c.body);
  for (const d of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
    const rz = el('div', `rz rz-${d}`);
    rz.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      drag(e, (dx, dy) => { resizeBy(data, d, dx / view.scale, dy / view.scale, 240, 160); placeCard(c); });
    });
    c.el.append(rz);
  }
  c.el.addEventListener('pointerdown', () => { c.el.style.zIndex = ++topZ; });
  boardEl.appendChild(c.el);
  cards.set(data.id, c);
  placeCard(c);
  fillCard(c, doc);
  save();
  return c;
}
// 앱을 다시 켜면 main 의 등록이 비어 있어 복원 때마다 다시 등록한다(doc 없음). 파일이 없어졌으면 카드 안에 안내만.
async function fillCard(c, doc) {
  const r = doc ?? await api.openDoc(c.data.path).catch((err) => ({ error: err.message }));
  if (r?.error || !r?.url) return c.body.replaceChildren(el('p', 'doc-msg', r?.error || tr('ui.doc.openFail')));
  const v = r.type === 'application/pdf' ? el('iframe') : el('img');
  v.src = v.tagName === 'IFRAME' ? `${r.url}#navpanes=0` : r.url; // 썸네일 칸은 기본으로 접는다
  if (v.tagName === 'IMG') v.alt = basename(c.data.path); else v.title = basename(c.data.path);
  c.body.replaceChildren(v);
}
function placeCard(c) {
  const { x, y, w, h } = c.data;
  Object.assign(c.el.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
}
function focusCard(c) {
  const { x, y, w, h } = c.data;
  view.x = viewport.clientWidth / 2 - (x + w / 2) * view.scale;
  view.y = viewport.clientHeight / 2 - (y + h / 2) * view.scale;
  applyView();
  save();
  c.el.style.zIndex = ++topZ;
  c.el.classList.remove('flash');
  void c.el.offsetWidth;
  c.el.classList.add('flash');
}
$('doc-ext').addEventListener('click', () => docActive && openExt(docActive));

function focusNode(n) {
  const { x, y, h } = n.data;
  const { w } = n.data;
  view.x = viewport.clientWidth / 2 - (x + w / 2) * view.scale;
  view.y = viewport.clientHeight / 2 - (y + h / 2) * view.scale;
  applyView();
  save();
  syncFilesTo(n); // 사용자가 직접 옮겨 가는 길(목록·미니맵·Ctrl+숫자·가져오기)은 트리도 따라간다
  setFocused(n);
  n.el.classList.remove('flash');
  void n.el.offsetWidth; // 같은 노드를 연달아 눌러도 애니메이션이 다시 돌게 리플로우
  n.el.classList.add('flash');
  n.term.focus();
}

// AI 기호(없으면 이름 첫 글자)
const glyphOf = (cmd) => ICONS[cmd] ?? `<text x="8" y="12" text-anchor="middle" font-size="11" font-weight="600" fill="#c9cdd6">${(LABELS[cmd] ?? '?')[0]}</text>`;
// 에이전트 구분용 기호. 공식 로고가 아니라 모양만 다르게 그린 것.
const ICONS = {
  claude: '<path d="M8 1.5v13M1.5 8h13M3.4 3.4l9.2 9.2M12.6 3.4l-9.2 9.2" stroke="#e39a6f" stroke-width="1.8" stroke-linecap="round"/>',
  codex: '<path d="M8 1.8l5.4 3.1v6.2L8 14.2l-5.4-3.1V4.9z" fill="none" stroke="#d8dee9" stroke-width="1.6" stroke-linejoin="round"/>',
  gemini: '<path d="M8 1c.6 3.9 3.1 6.4 7 7-3.9.6-6.4 3.1-7 7-.6-3.9-3.1-6.4-7-7 3.9-.6 6.4-3.1 7-7z" fill="#7fa6f0"/>',
  '': '<path d="M2.5 4l4 4-4 4M8 12.5h5.5" fill="none" stroke="#8fb8de" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
};
const isBusy = (n) => [...(n.agents?.values() ?? [])].some((a) => a.status === 'running');

const STATE_TEXT = { working: tr('ui.state.working'), waiting: tr('ui.state.waiting'), idle: tr('ui.state.idle') };

function sessionIcon(n) {
  const s = effectiveState(n);
  const b = el('button', `sess${s ? ` st-${s}` : ''}${n.exited ? ' exited' : ''}`);
  const label = LABELS[n.data.command] ?? n.data.command;
  const stateText = n.exited ? tr('ui.node.ended') : STATE_TEXT[s] ?? STATUS.running;
  b.title = tr('ui.side.sessTitle', { label, state: stateText });
  b.setAttribute('aria-label', b.title);
  b.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">${glyphOf(n.data.command)}</svg><i></i>`;
  b.title = `${n.data.name}, ${label}, ${stateText}
${tr('ui.peekHint')}`;
  b.addEventListener('pointerenter', () => peekAt(n));
  b.addEventListener('click', (e) => { e.stopPropagation(); enterSession(n); });
  return b;
}

let collapsed;
try { collapsed = new Set(JSON.parse(pref.get('collapsed', '[]'))); } catch { collapsed = new Set(); }
// 사이드바에 직접 추가한 폴더, 프로젝트 별칭 묶음(저장소 경로 소문자 -> 묶음 이름). 이 PC 설정으로만 남긴다.
const readJson = (k, d) => { try { return JSON.parse(pref.get(k, JSON.stringify(d))); } catch { return d; } };
let customDirs = readJson('customDirs', []);
let aliases = readJson('aliases', {});
const aliasKey = (p) => p.replace(/[\\/]+$/, '').toLowerCase();
function setAlias(repo, name) {
  name = name?.trim();
  if (name) aliases[aliasKey(repo)] = name;
  else delete aliases[aliasKey(repo)];
  pref.set('aliases', JSON.stringify(aliases));
  renderSidebar();
}
async function addCustomDir() {
  const dir = await api.pickFolder(cwd);
  if (!dir) return;
  if (!customDirs.some((d) => samePath(d, dir))) customDirs.unshift(dir);
  pref.set('customDirs', JSON.stringify(customDirs));
  await refreshFolders();
  toast(tr('ui.side.added', { name: basename(dir) }));
}
function removeCustomDir(dir) {
  customDirs = customDirs.filter((d) => !samePath(d, dir));
  pref.set('customDirs', JSON.stringify(customDirs));
  refreshFolders();
}
$('side-add').addEventListener('click', addCustomDir);

// 사이드바 폭: 오른쪽 가장자리를 끌어 바꾼다(220~520px). 이 PC 설정으로 기억.
const setSideW = (w) => document.documentElement.style.setProperty('--side-w', `${w}px`);
let sideW = Number(pref.get('sideW', '300')) || 300;
setSideW(sideW);
document.querySelector('.side-resize').addEventListener('pointerdown', (e) => {
  const grip = e.currentTarget;
  grip.classList.add('on');
  drag(e, (dx) => {
    sideW = Math.max(220, Math.min(520, sideW + dx));
    setSideW(sideW);
  }, () => {
    grip.classList.remove('on');
    pref.set('sideW', String(sideW));
    nodes.forEach((n) => n.fit.fit());
  });
});

// 묶음 이름 고르기: 기존 묶음 버튼 + 새 이름 입력 + 묶음에서 빼기
function openAliasPop(repo, anchor) {
  const pop = $('alias-pop');
  const cur = aliases[aliasKey(repo)];
  const input = el('input');
  input.placeholder = tr('ui.alias.ph');
  input.value = cur ?? '';
  input.maxLength = 30;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { setAlias(repo, input.value); closeAliasPop(); }
    if (e.key === 'Escape') closeAliasPop();
  });
  const names = [...new Set(Object.values(aliases))].filter((n) => n !== cur);
  const chips = names.map((n) => {
    const b = el('button', 'alias-chip', n);
    b.addEventListener('click', () => { setAlias(repo, n); closeAliasPop(); });
    return b;
  });
  pop.replaceChildren(el('div', 'alias-title', tr('ui.alias.title', { name: basename(repo) })), input);
  if (chips.length) {
    const box = el('div', 'alias-chips');
    box.append(...chips);
    pop.append(box);
  }
  if (cur) {
    const out = el('button', 'alias-out', tr('ui.alias.out', { name: cur }));
    out.addEventListener('click', () => { setAlias(repo, ''); closeAliasPop(); });
    pop.append(out);
  }
  const r = anchor.getBoundingClientRect();
  Object.assign(pop.style, { left: `${r.left}px`, top: `${r.bottom + 6}px` });
  pop.hidden = false;
  input.focus();
}
function closeAliasPop() { $('alias-pop').hidden = true; }

// 묶음 색: 처음 보는 묶음은 다른 묶음이 안 쓴 팔레트 색을 차례로 받는다. 색 점을 눌러 바꾼다.
let aliasColors = readJson('aliasColors', {});
const ALIAS_ORDER = [210, 40, 160, 295, 0, 95, 265, 185, 325, 235]; // 이웃한 묶음끼리 확 다른 색이 되게 섞은 순서
function aliasHue(name) {
  if (aliasColors[name] == null) {
    const used = new Set(Object.values(aliasColors));
    aliasColors[name] = ALIAS_ORDER.find((h) => !used.has(h)) ?? ALIAS_ORDER[Object.keys(aliasColors).length % ALIAS_ORDER.length];
    pref.set('aliasColors', JSON.stringify(aliasColors));
  }
  return aliasColors[name];
}
function openAliasColor(name, anchor) {
  const pop = $('alias-pop');
  const swatches = PALETTE.map(([hue, label]) => {
    const b = el('button', 'swatch');
    b.style.setProperty('--hue', hue);
    b.title = label;
    b.setAttribute('aria-label', label);
    if (aliasColors[name] === hue) b.setAttribute('aria-pressed', 'true');
    b.addEventListener('click', () => {
      aliasColors[name] = hue;
      pref.set('aliasColors', JSON.stringify(aliasColors));
      closeAliasPop();
      renderSidebar();
    });
    return b;
  });
  const box = el('div', 'alias-swatches');
  box.append(...swatches);
  pop.replaceChildren(el('div', 'alias-title', tr('ui.alias.color', { name })), box);
  const r = anchor.getBoundingClientRect();
  Object.assign(pop.style, { left: `${r.left}px`, top: `${r.bottom + 6}px` });
  pop.hidden = false;
}
addEventListener('pointerdown', (e) => { if (!$('alias-pop').hidden && !e.target.closest('#alias-pop, .alias-btn, .alias-dot')) closeAliasPop(); }, true);
const TAG_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 8.6V3a.5.5 0 0 1 .5-.5h5.6l5 5-6.1 6.1zM5.5 5.5h.01" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/></svg>';
function aliasButton(repo) {
  const b = el('button', 'icon-btn alias-btn');
  b.innerHTML = TAG_ICON;
  b.title = aliases[aliasKey(repo)] ? tr('ui.alias.current', { name: aliases[aliasKey(repo)] }) : tr('ui.alias.add');
  b.setAttribute('aria-label', b.title);
  b.addEventListener('click', (e) => { e.stopPropagation(); openAliasPop(repo, b); });
  return b;
}

function toggleProject(key) {
  if (!collapsed.delete(key)) collapsed.add(key);
  pref.set('collapsed', JSON.stringify([...collapsed]));
  renderSidebar();
}

const BRANCH_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 2.5v11M5 10c0-3 6-2 6-5.5M11 4.5a1.5 1.5 0 1 0 0-.1M5 13.5a1.5 1.5 0 1 0 0-.1" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

function worktreeButton(repo) {
  const b = el('button', 'icon-btn wt-add');
  b.innerHTML = BRANCH_ICON;
  b.title = tr('ui.side.addWt');
  b.setAttribute('aria-label', b.title);
  b.addEventListener('click', (e) => { e.stopPropagation(); openWorktreeForm(repo); });
  return b;
}

function projectGroup(key, name, rows, sessions, repo) {
  const proj = el('section', 'proj');
  const open = !collapsed.has(key);
  const head = el('div', 'proj-head');
  const toggle = el('button', 'proj-name');
  toggle.setAttribute('aria-expanded', open);
  toggle.innerHTML = '<svg class="chev" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M3 2l3.5 3L3 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  toggle.append(el('span', 'proj-label', name));
  if (!open && sessions.length) {
    const sum = el('span', 'sessions');
    sum.append(...sessions.map(sessionIcon));
    toggle.append(sum);
  }
  toggle.addEventListener('click', () => toggleProject(key));
  head.append(toggle);
  if (repo) head.append(aliasButton(repo), worktreeButton(repo));
  proj.append(head);
  if (open) proj.append(...rows);
  return proj;
}

const SESSIONS_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5a4.5 4.5 0 1 1-4.2 2.9M8 5.5V8l1.8 1.2M1.8 4.5l2 1.9 1.9-2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
function folderRow(f, label, badge, sessions, repo, branch, aliasable) {
  const row = el('div', 'wt');
  row.tabIndex = 0;
  const states = sessions.map(effectiveState);
  const s = ['waiting', 'working', 'idle'].find((x) => states.includes(x));
  if (s) row.classList.add(`st-${s}`);
  if (samePath(f.path, cwd)) row.classList.add('selected');
  const main = el('div', 'wt-main');
  const line = el('div', 'wt-line');
  line.append(el('span', 'wt-branch', label));
  if (badge) line.append(el('span', 'badge', badge));
  // 둘째 줄: 브랜치와 git 상태. 이름이 잘리지 않게 첫 줄과 나눈다
  const meta = el('div', 'wt-meta');
  if (branch) meta.append(el('span', 'wt-sub', branch));
  if (f.changes) meta.append(el('span', 'git', tr('ui.side.changes', { n: f.changes })));
  if (f.ahead || f.behind) meta.append(el('span', 'git', [f.ahead && `↑${f.ahead}`, f.behind && `↓${f.behind}`].filter(Boolean).join(' ')));
  main.append(line);
  if (meta.childElementCount) main.append(meta);
  main.append(el('span', 'wt-path', f.path));
  const actions = el('div', 'wt-actions');
  if (f.path) {
    const fb = el('button', 'icon-btn wt-files');
    fb.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    fb.title = tr('ui.node.files');
    fb.setAttribute('aria-label', fb.title);
    fb.addEventListener('click', (e) => { e.stopPropagation(); openFiles(f.path); });
    actions.append(fb);
  }
  if (aliasable) actions.append(aliasButton(f.path));
  if (repo) actions.append(worktreeButton(repo));
  if (f.custom) {
    const rm = el('button', 'icon-btn wt-remove', '×');
    rm.title = tr('ui.side.remove');
    rm.setAttribute('aria-label', rm.title);
    rm.addEventListener('click', (e) => { e.stopPropagation(); removeCustomDir(f.path); });
    actions.append(rm);
  }
  if (f.path) {
    const sb = el('button', 'icon-btn wt-sessions');
    sb.innerHTML = SESSIONS_ICON;
    sb.title = tr('ui.side.sessions');
    sb.setAttribute('aria-label', sb.title);
    sb.setAttribute('aria-haspopup', 'menu');
    sb.addEventListener('click', (e) => { e.stopPropagation(); groupMenuFor === `sess:${f.path}` ? closeGroupMenu() : openSideSessions(f, label, sb); });
    actions.append(sb);
  }
  const add = el('button', 'icon-btn wt-new', '+');
  add.title = availAgents().length > 1 ? tr('ui.side.newHere') : tr('ui.side.runHere', { agent: LABELS[cmd] });
  add.setAttribute('aria-label', add.title);
  add.setAttribute('aria-haspopup', 'menu');
  add.addEventListener('click', (e) => { e.stopPropagation(); groupMenuFor === `new:${f.path}` ? closeGroupMenu() : openSideNew(f, add); });
  actions.append(add);
  row.append(el('i', 'state'), main, actions);
  if (sessions.length) {
    const box = el('div', 'sessions');
    box.append(...sessions.map(sessionIcon));
    row.append(box);
  }
  const pick = () => { choose(f); };
  row.addEventListener('click', pick);
  row.addEventListener('keydown', (e) => { if (e.key === 'Enter') pick(); });
  return row;
}

function renderSidebar() {
  if ($('sidebar').hidden) return;
  const all = [...nodes.values()];
  const claimed = new Set();
  const sessionsAt = (p) => all.filter((n) => n.data.cwd && samePath(n.data.cwd, p) && claimed.add(n));
  const groups = [];
  const byAlias = new Map(); // 묶음 이름 -> { sections, sessions }
  for (const root of folders.filter((f) => !f.worktreeOf)) {
    const members = [root, ...folders.filter((f) => f.worktreeOf && samePath(f.worktreeOf, root.path))];
    let section, sessions;
    // 워크트리가 없는 저장소는 그룹 헤더 없이 한 줄: 저장소 이름 + 브랜치 배지
    if (members.length === 1) {
      section = el('section', 'proj');
      sessions = sessionsAt(root.path);
      section.append(folderRow(root, basename(root.path), null, sessions, root.branch ? root.path : null, root.branch, true));
    } else {
      const rows = [];
      sessions = [];
      members.forEach((f, i) => {
        const list = sessionsAt(f.path);
        sessions.push(...list);
        rows.push(folderRow(f, i ? f.branch : root.branch ?? tr('ui.side.folder'), tr(i ? 'ui.folder.worktree' : 'ui.side.main'), list));
      });
      section = projectGroup(root.path, basename(root.path), rows, sessions, root.path);
    }
    const alias = aliases[aliasKey(root.path)];
    if (!alias) { groups.push(section); continue; }
    if (!byAlias.has(alias)) {
      byAlias.set(alias, { sections: [], sessions: [] });
      groups.push(alias); // 첫 프로젝트 자리에 묶음을 놓는다
    }
    byAlias.get(alias).sections.push(section);
    byAlias.get(alias).sessions.push(...sessions);
  }
  // 묶음 자리 표시를 묶음 섹션으로 바꾼다
  groups.forEach((g, i) => {
    if (typeof g !== 'string') return;
    const { sections, sessions } = byAlias.get(g);
    const box = projectGroup(`\0alias:${g}`, g, sections, sessions);
    box.classList.add('alias-group');
    box.style.setProperty('--hue', aliasHue(g));
    box.querySelector('.proj-label').append(el('span', 'alias-count', ` ${sections.length}`));
    const dot = el('button', 'alias-dot');
    dot.title = tr('ui.alias.recolor', { name: g });
    dot.setAttribute('aria-label', dot.title);
    dot.addEventListener('click', (e) => { e.stopPropagation(); openAliasColor(g, dot); });
    box.querySelector('.proj-head').prepend(dot);
    groups[i] = box;
  });
  const rest = all.filter((n) => !claimed.has(n));
  if (rest.length) {
    const byPath = new Map();
    for (const n of rest) byPath.set(n.data.cwd, [...(byPath.get(n.data.cwd) ?? []), n]);
    const rows = [...byPath].map(([p, list]) => folderRow({ path: p }, basename(p), null, list));
    groups.push(projectGroup('\0other', tr('ui.side.other'), rows, rest));
  }
  $('side-list').replaceChildren(...(groups.length ? groups : [el('p', 'side-empty', tr('ui.side.empty'))]));
}

// 워크트리 추가 폼은 사이드바 아래에 고정 — 목록이 자주 다시 그려져도 입력이 날아가지 않게 목록 밖에 둔다.
let wtRepo = null;
function openWorktreeForm(repo) {
  wtRepo = repo;
  $('wt-form').hidden = false;
  $('wt-repo').textContent = tr('ui.wt.title', { name: basename(repo) });
  $('wt-error').textContent = '';
  $('wt-branch').value = '';
  $('wt-branch').focus();
}
function closeWorktreeForm() {
  wtRepo = null;
  $('wt-form').hidden = true;
}
$('wt-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const branch = $('wt-branch').value.trim();
  if (!branch || !wtRepo) return;
  $('wt-submit').disabled = true;
  $('wt-error').textContent = '';
  const res = await api.addWorktree(wtRepo, branch);
  $('wt-submit').disabled = false;
  if (res.error) return ($('wt-error').textContent = res.error);
  closeWorktreeForm();
  await refreshFolders();
  launch(res.path);
});
$('wt-cancel').addEventListener('click', closeWorktreeForm);
$('wt-branch').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeWorktreeForm(); });

// --- 여러 세션에 같은 말 보내기 ---

function castGroups() {
  const live = [...nodes.values()].filter((n) => !n.exited);
  const out = [
    ...(selection.size ? [{ key: 'sel', label: tr('ui.cast.selected'), list: live.filter((n) => selection.has(n.data.id)) }] : []),
    { key: 'claude', label: tr('ui.cast.claude'), list: live.filter((n) => n.data.command === 'claude') },
    { key: 'all', label: tr('ui.cast.all'), list: live },
  ];
  for (const root of folders.filter((f) => !f.worktreeOf)) {
    const paths = [root.path, ...folders.filter((f) => f.worktreeOf && samePath(f.worktreeOf, root.path)).map((f) => f.path)];
    const list = live.filter((n) => n.data.cwd && paths.some((p) => samePath(p, n.data.cwd)));
    if (list.length) out.push({ key: `p:${root.path}`, label: basename(root.path), list });
  }
  return out;
}

function renderCastTargets() {
  const sel = $('cast-to');
  const keep = sel.value || 'claude';
  sel.replaceChildren(...castGroups().map((g) => Object.assign(el('option', null, `${g.label} (${g.list.length})`), { value: g.key })));
  sel.value = [...sel.options].some((o) => o.value === keep) ? keep : 'claude';
}

// "@API @프론트 할 일" → 앞쪽 @이름들을 대상 세션으로. 이름에 공백이 있을 수 있어 긴 이름부터 맞춘다.
function parseMentions(text) {
  const live = [...nodes.values()].filter((n) => !n.exited);
  const names = live.map((n) => n.data.name).sort((a, b) => b.length - a.length);
  const targets = [];
  let rest = text.trimStart();
  while (rest.startsWith('@')) {
    const body = rest.slice(1);
    const name = names.find((nm) => body.toLowerCase().startsWith(nm.toLowerCase()) && (body.length === nm.length || /\s/.test(body[nm.length])));
    if (!name) break;
    const n = live.find((x) => x.data.name === name);
    if (!targets.includes(n)) targets.push(n);
    rest = body.slice(name.length).trimStart();
  }
  return { targets, rest };
}

$('cast').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!$('mention-list').hidden) return; // 자동완성이 열려 있으면 Enter 는 고르기
  let text = $('cast-text').value;
  let list;
  if (text.trimStart().startsWith('@')) {
    const m = parseMentions(text);
    if (!m.targets.length) {
      $('cast-text').classList.add('bad');
      $('cast-text').title = tr('ui.cast.noSession', { name: text.trim().split(/\s/)[0] });
      return;
    }
    list = m.targets;
    text = m.rest;
  } else {
    list = castGroups().find((g) => g.key === $('cast-to').value)?.list;
  }
  if (!text.trim() || !list?.length) return;
  const group = { list };
  for (const n of group.list) {
    api.write(n.data.id, text);
    // 글자와 Enter 를 한 번에 보내면 붙여넣기로 인식돼 줄바꿈만 될 수 있어 Enter 는 따로 보낸다
    setTimeout(() => api.write(n.data.id, '\r'), 80);
  }
  $('cast-text').value = '';
  $('cast-text').placeholder = tr('ui.cast.sent', { names: group.list.map((n) => n.data.name).join(', ') });
});

// @ 자동완성: 커서 앞이 "@글자" 면 이름 목록을 띄운다. ↑↓ 이동, Tab·Enter 넣기, Esc 닫기.
let mentionActive = 0;
let mentionItems = [];
function mentionQuery() {
  const inp = $('cast-text');
  return inp.value.slice(0, inp.selectionStart).match(/(^|\s)@([^@\s]*)$/)?.[2];
}
function renderMentions() {
  const q = mentionQuery();
  const box = $('mention-list');
  mentionItems = q == null ? [] : [...nodes.values()].filter((n) => !n.exited && n.data.name.toLowerCase().includes(q.toLowerCase()));
  box.hidden = !mentionItems.length;
  mentionActive = Math.min(mentionActive, Math.max(0, mentionItems.length - 1));
  box.replaceChildren(...mentionItems.map((n, i) => {
    const li = el('li');
    li.setAttribute('aria-selected', i === mentionActive);
    li.append(el('span', 'm-name', `@${n.data.name}`), el('span', 'm-meta', `${LABELS[n.data.command] ?? n.data.command}, ${basename(n.data.cwd)}`));
    li.addEventListener('pointerdown', (e) => { e.preventDefault(); pickMention(n); });
    return li;
  }));
}
function pickMention(n) {
  const inp = $('cast-text');
  const before = inp.value.slice(0, inp.selectionStart).replace(/@[^@\s]*$/, `@${n.data.name} `);
  inp.value = before + inp.value.slice(inp.selectionStart);
  inp.setSelectionRange(before.length, before.length);
  $('mention-list').hidden = true;
  inp.focus();
}
$('cast-text').addEventListener('input', () => {
  $('cast-text').classList.remove('bad');
  $('cast-text').title = '';
  mentionActive = 0;
  renderMentions();
});
$('cast-text').addEventListener('keydown', (e) => {
  if ($('mention-list').hidden) return;
  if (e.key === 'ArrowDown') mentionActive = (mentionActive + 1) % mentionItems.length;
  else if (e.key === 'ArrowUp') mentionActive = (mentionActive - 1 + mentionItems.length) % mentionItems.length;
  else if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); return pickMention(mentionItems[mentionActive]); }
  else if (e.key === 'Escape') { e.stopPropagation(); return ($('mention-list').hidden = true); }
  else return;
  e.preventDefault();
  renderMentions();
});
$('cast-text').addEventListener('blur', () => setTimeout(() => ($('mention-list').hidden = true), 100));

// Ctrl+K: 어디서든(터미널 입력 중에도) 보내기 바로. 비어 있으면 @ 를 넣고 이름 목록을 연다.
addEventListener('keydown', (e) => {
  if (!mod(e) || e.shiftKey || e.altKey || e.code !== 'KeyK') return;
  e.preventDefault();
  e.stopPropagation();
  const inp = $('cast-text');
  inp.focus();
  if (!inp.value) {
    inp.value = '@';
    inp.setSelectionRange(1, 1);
    renderMentions();
  } else inp.select();
}, true);

// --- 보드 정리: 자동 정렬, 미니맵, Ctrl+1~9 ---

// Ctrl+1~9 는 보이는 순서(위에서 아래, 왼쪽에서 오른쪽), 자동 정렬은 폴더별로 모은다
const ordered = () => [...nodes.values()].sort((a, b) => Math.round(a.data.y / 200) - Math.round(b.data.y / 200) || a.data.x - b.data.x);

function tidy() {
  // 같은 프로젝트끼리는 40, 프로젝트가 바뀌면 테두리·이름표 자리만큼 더 띄운다
  const gap = 40, projGap = 110, rowGap = 120;
  let x = gap, y = gap + 56, rowH = 0, prev = null;
  const maxW = Math.max(1200, (viewport.clientWidth / view.scale) * 1.5);
  // 문서 카드는 옮기지 않고 세션 창이 피해 간다
  const hit = (x, y, w, h) => [...cards.values()].find((c) => x < rightEdge(c) + gap && x + w + gap > c.data.x && y < bottomEdge(c) + gap && y + h + gap > c.data.y);
  for (const n of [...nodes.values()].sort((a, b) => projectOf(a).key.localeCompare(projectOf(b).key) || (a.data.cwd || '').localeCompare(b.data.cwd || ''))) {
    const { w } = n.data;
    const key = projectOf(n).key;
    if (prev !== null && key !== prev) x += projGap - gap;
    prev = key;
    for (let c; ; x = rightEdge(c) + gap) {
      if (x > gap && x + w > maxW) { x = gap; y += rowH + rowGap; rowH = 0; }
      if (!(c = hit(x, y, w, n.data.h + rackH(n)))) break;
    }
    n.data.x = x;
    n.data.y = y;
    place(n);
    x += w + gap;
    rowH = Math.max(rowH, n.data.h + rackH(n));
  }
  fitAll();
}

function bounds() {
  const list = [...nodes.values(), ...cards.values()];
  if (!list.length) return null;
  return {
    x: Math.min(...list.map((n) => n.data.x)),
    y: Math.min(...list.map((n) => n.data.y)),
    r: Math.max(...list.map(rightEdge)),
    b: Math.max(...list.map(bottomEdge)),
  };
}

function fitAll() {
  const bb = bounds();
  if (!bb) return;
  const pad = 40;
  view.scale = Math.min(1, Math.max(ZOOM_MIN, Math.min((viewport.clientWidth - pad * 2) / (bb.r - bb.x), (viewport.clientHeight - pad * 2) / (bb.b - bb.y))));
  view.x = pad - bb.x * view.scale + ((viewport.clientWidth - pad * 2) - (bb.r - bb.x) * view.scale) / 2;
  view.y = pad - bb.y * view.scale;
  applyView();
  save();
}

const MINI_COLOR = { working: '#e06c6c', waiting: '#f0c94a', idle: '#6fbf8e' };
let miniMap = null; // 미니맵 좌표 -> 보드 좌표 변환값
function drawMinimap() {
  const c = $('minimap');
  const ctx = c.getContext('2d');
  const W = c.width, H = c.height;
  ctx.clearRect(0, 0, W, H);
  const bb = bounds();
  $('corner').classList.toggle('no-map', !bb);
  if (!bb) return;
  const vx = -view.x / view.scale, vy = -view.y / view.scale;
  const vw = viewport.clientWidth / view.scale, vh = viewport.clientHeight / view.scale;
  const x0 = Math.min(bb.x, vx), y0 = Math.min(bb.y, vy);
  const s = Math.min((W - 12) / (Math.max(bb.r, vx + vw) - x0), (H - 12) / (Math.max(bb.b, vy + vh) - y0));
  miniMap = { x0, y0, s };
  const m = (x, y) => [6 + (x - x0) * s, 6 + (y - y0) * s];
  for (const n of nodes.values()) {
    const [x, y] = m(n.data.x, n.data.y);
    ctx.fillStyle = n === focused ? '#e6e8ec' : '#ffffff40';
    ctx.fillRect(x, y, n.data.w * s, n.data.h * s);
    const st = effectiveState(n);
    if (st) { ctx.strokeStyle = MINI_COLOR[st]; ctx.lineWidth = 1.5; ctx.strokeRect(x, y, n.data.w * s, n.data.h * s); }
  }
  ctx.fillStyle = '#7aa2f755'; // 문서 카드는 세션과 구분되게 파랗게
  for (const c of cards.values()) {
    const [x, y] = m(c.data.x, c.data.y);
    ctx.fillRect(x, y, c.data.w * s, c.data.h * s);
  }
  const [x, y] = m(vx, vy);
  ctx.strokeStyle = '#f0c94a99';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, vw * s, vh * s);
}

$('minimap').addEventListener('pointerdown', (e) => {
  const go = (ev) => {
    if (!miniMap) return;
    const r = $('minimap').getBoundingClientRect();
    const bx = miniMap.x0 + (ev.clientX - r.left - 6) / miniMap.s;
    const by = miniMap.y0 + (ev.clientY - r.top - 6) / miniMap.s;
    view.x = viewport.clientWidth / 2 - bx * view.scale;
    view.y = viewport.clientHeight / 2 - by * view.scale;
    applyView();
  };
  let px = e.clientX, py = e.clientY;
  go(e);
  drag(e, (dx, dy) => go({ clientX: (px += dx), clientY: (py += dy) }));
});
$('tidy').addEventListener('click', tidy);

// 터미널보다 먼저 받아야 하므로 캡처 단계에서 처리한다
addEventListener('keydown', (e) => {
  if (!mod(e) || e.altKey || e.shiftKey || !/^[1-9]$/.test(e.key)) return;
  const n = ordered()[Number(e.key) - 1];
  if (!n) return;
  e.preventDefault();
  e.stopPropagation();
  focusNode(n);
}, true);

function setSidebar(open) {
  $('sidebar').hidden = !open;
  document.body.classList.toggle('side-open', open);
  $('side-toggle').setAttribute('aria-expanded', open);
  pref.set('sidebar', open ? '1' : '0');
  nodes.forEach((n) => n.fit.fit());
  if (open) refreshFolders();
}

async function refreshFolders() {
  folders = await api.listPaths(customDirs);
  renderSidebar();
  renderGroups();
}

$('side-toggle').addEventListener('click', () => setSidebar($('sidebar').hidden));
$('side-refresh').addEventListener('click', (e) => withSpin(e.currentTarget, async () => {
  await refreshFolders();
  const roots = folders.filter((f) => !f.worktreeOf).length;
  const wts = folders.length - roots;
  return wts ? tr('ui.side.refreshedWt', { n: roots, w: wts }) : tr('ui.side.refreshed', { n: roots });
}));
addEventListener('focus', () => { if (!$('sidebar').hidden) refreshFolders(); });

(async () => {
  document.body.classList.add(`os-${api.platform}`); // 제목 표시줄 버튼 자리(Windows 오른쪽, Mac 왼쪽)
  winBuild = (await api.sysInfo()).build;
  await detectAgents();
  // 폴더 목록(git status 포함)은 큰 저장소에서 몇 초 걸려 보드를 먼저 띄우고 뒤에서 받는다. 오면 사이드바·프로젝트 묶음만 다시 그린다.
  refreshFolders();
  setSidebar(pref.get('sidebar', '1') === '1');
  setSideTab(pref.get('sideTab', 'projects'));
  // 읽기 실패로 초기화가 멈추면 빈 화면이 된다. 새 보드로 계속 간다.
  const saved = await api.loadBoard().catch(() => (toast(tr('ui.board.loadFail'), true), null));
  if (saved) {
    view = saved.view;
    links = saved.links ?? [];
    groupColors = saved.groupColors ?? {};
    saved.nodes.forEach(addNode);
    // 옛 보드엔 cards 가 없다. 손으로 고친 파일 대비로 경로가 글자인 것만.
    // 좌표·크기가 빠졌으면 버리지 않고 기본 크기와 빈 칸을 준다 (NaN 이면 bounds·미니맵이 깨진다)
    (Array.isArray(saved.cards) ? saved.cards : []).filter((d) => typeof d?.path === 'string' && d.id).forEach((d) => {
      if (!Number.isFinite(d.w) || !Number.isFinite(d.h)) [d.w, d.h] = docSize(d.path);
      if (!Number.isFinite(d.x) || !Number.isFinite(d.y)) Object.assign(d, freeSpot(d.w, d.h));
      addCard(d);
    });
    renderLinks();
  }
  applyView();
  save();
  if (smoke) {
    if (!nodes.has('smoke')) await addNode({ id: 'smoke', command: '', cwd: '', x: 40, y: 40, w: 660, h: 420 });
    setTimeout(() => api.write('smoke', `${smoke}\r`), 2000);
  }
})();
