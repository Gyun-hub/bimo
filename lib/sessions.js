// 세션 가져오기 목록: 다른 곳에서 만든 AI 대화를 찾는다. electron 의존 없음(단위 테스트용).
// Claude: ~/.claude/projects/*/<id>.jsonl / Codex: ~/.codex/sessions/**/rollout-*.jsonl (session_meta 에 id·cwd)
// Cursor: ~/.cursor/chats/<폴더 해시>/<id>/meta.json. 셋 다 공식 형식 문서가 없어 못 읽는 항목은 건너뛴다.
// 전부 비동기·부분 읽기다 — 메인 프로세스에서 동기로 읽으면 모든 터미널 출력이 멈춘다.
const fs = require('fs');
const path = require('path');
const fsp = fs.promises;

const SESSION_LIMIT = 150; // AI 별 최근 것만
const PARALLEL = 16; // stat·읽기 동시 수
// 최근 Claude Code 는 첫 user 줄 앞에 attachment(스킬 목록·CLAUDE.md 등) 80~130KB 를 둔다 (2026-11-16 실측: 최근 150개 중 58개가 64KB 뒤).
// 그래서 64KB 씩 이어 읽다가 제목을 찾으면 멈추고, 상한은 예전과 같은 256KB 로 둬 결과를 바꾸지 않는다.
const HEAD_STEP = 64 * 1024;
const HEAD_MAX = 256 * 1024;

const parse = (line) => { try { return JSON.parse(line); } catch { return null; } };
// 명령·시스템이 끼워 넣은 메시지(<command-name> 등)는 제목으로 쓰지 않는다
const realPrompt = (t) => typeof t === 'string' && t.trim() && !t.trimStart().startsWith('<') ? t.trim().replace(/\s+/g, ' ').slice(0, 120) : null;

// items 를 동시에 n 개까지만 fn 에 돌린다. 순서는 items 그대로.
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

async function newestFiles(root, match, depth) {
  const found = [];
  const walk = async (dir, d) => {
    const ents = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const ent of ents) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory() && d > 0) await walk(p, d - 1);
      else if (ent.isFile() && match(ent.name)) found.push(p);
    }
  };
  await walk(root, depth);
  const st = await pool(found, PARALLEL, (p) => fsp.stat(p).then((s) => ({ p, at: s.mtimeMs }), () => null));
  return st.filter(Boolean).sort((a, b) => b.at - a.at).slice(0, SESSION_LIMIT);
}

// 앞에서부터 줄마다 visit(json). true 를 돌려주면 멈춘다. 끝에 줄바꿈 없는 줄은 잘렸을 수 있어 넘기지 않는다.
async function scanHead(file, visit, max = HEAD_MAX) {
  const fh = await fsp.open(file, 'r');
  try {
    let rest = Buffer.alloc(0), pos = 0;
    while (pos < max) {
      const chunk = Buffer.alloc(Math.min(HEAD_STEP, max - pos));
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, pos);
      if (!bytesRead) return;
      pos += bytesRead;
      rest = Buffer.concat([rest, chunk.subarray(0, bytesRead)]);
      let nl;
      while ((nl = rest.indexOf(10)) >= 0) { // UTF-8 에서 0x0A 는 여러 바이트 글자 안에 나오지 않는다
        const j = parse(rest.toString('utf8', 0, nl));
        rest = rest.subarray(nl + 1);
        if (j && visit(j)) return;
      }
    }
  } finally {
    await fh.close();
  }
}

// 파일 하나 읽다 실패하면 그 파일만 뺀다
const each = (files, fn) => pool(files, PARALLEL, (f) => fn(f).catch(() => null)).then((a) => a.filter(Boolean));

async function claudeSessions(root) {
  return each(await newestFiles(root, (n) => /^[0-9a-f-]{36}\.jsonl$/i.test(n), 1), async ({ p, at }) => {
    let cwd = '', title = null;
    await scanHead(p, (j) => {
      cwd ||= j.cwd || '';
      if (!title && j.type === 'user' && !j.isMeta) {
        const c = j.message?.content;
        title = realPrompt(typeof c === 'string' ? c : Array.isArray(c) ? c.find((x) => x.type === 'text')?.text : null);
      }
      return cwd && title;
    });
    return title && { agent: 'claude', id: path.basename(p, '.jsonl'), cwd, title, at }; // 대화가 없는(바로 닫은) 세션은 뺀다
  });
}

async function codexSessions(root) {
  return each(await newestFiles(root, (n) => /^rollout-.*\.jsonl$/.test(n), 3), async ({ p, at }) => {
    let id = null, cwd = '', title = null;
    await scanHead(p, (j) => {
      const pl = j.payload ?? j;
      if (j.type === 'session_meta' || (!id && pl.id && pl.timestamp)) { id ??= pl.id; cwd ||= pl.cwd || ''; }
      if (!title && pl.type === 'user_message') title = realPrompt(pl.message);
      if (!title && pl.type === 'message' && pl.role === 'user') title = realPrompt(pl.content?.find?.((x) => x.type === 'input_text')?.text);
      return id && title;
    });
    id ??= path.basename(p).match(/[0-9a-f]{8}-[0-9a-f-]{27}/i)?.[0];
    return id && { agent: 'codex', id, cwd, title: title || '(첫 메시지 없음)', at };
  });
}

// Cursor CLI 대화: chats/<폴더 해시>/<대화 id>/meta.json 에 title·cwd·updatedAtMs (2026-10 맥 실측).
// projects/*/agent-transcripts 는 Cursor 에디터 대화라 cursor-agent 로 이어 열 수 없어 넣지 않는다.
async function cursorSessions(root) {
  return each(await newestFiles(root, (n) => n === 'meta.json', 2), async ({ p, at }) => {
    const m = parse(await fsp.readFile(p, 'utf8'));
    if (!m || m.hasConversation === false) return null;
    return { agent: 'cursor-agent', id: path.basename(path.dirname(p)), cwd: m.cwd || '', title: realPrompt(m.title) || '(제목 없음)', at: m.updatedAtMs || at };
  });
}

// roots = { claude, codex, cursor } 폴더. 하나가 실패해도 나머지는 돌려준다.
async function listSessions(roots) {
  const safe = (p) => p.catch(() => []);
  const [a, b, c] = await Promise.all([safe(claudeSessions(roots.claude)), safe(codexSessions(roots.codex)), safe(cursorSessions(roots.cursor))]);
  return [...a, ...b, ...c];
}

module.exports = { SESSION_LIMIT, HEAD_MAX, realPrompt, pool, newestFiles, scanHead, claudeSessions, codexSessions, cursorSessions, listSessions };
