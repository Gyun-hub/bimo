// 서브 에이전트 transcript(JSONL) 해석. electron 의존 없음(단위 테스트용).
const fs = require('fs');

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

// JSONL 글을 대화 목록으로 줄인다. 깨진 줄(쓰는 중인 마지막 줄·잘린 첫 줄)은 건너뛴다.
function transcriptMessages(text) {
  const out = [];
  const handbacks = new Set(); // 최종 보고 도구의 결과({"success":true…})는 대화에서 뺀다
  for (const line of text.split('\n')) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const content = entry.message?.content;
    if (entry.type === 'user' && !entry.isMeta) {
      if (typeof content === 'string') out.push({ role: 'user', text: content });
      else for (const c of content || []) {
        if (c.type === 'text' && !c.text.startsWith('<system-reminder>')) out.push({ role: 'user', text: c.text });
        if (c.type === 'tool_result' && !handbacks.has(c.tool_use_id)) {
          const text = typeof c.content === 'string' ? c.content : (c.content || []).map((x) => x.text || '').join('\n');
          out.push({ role: 'result', text: clip(text, 6000), error: !!c.is_error });
        }
      }
    } else if (entry.type === 'assistant') {
      for (const c of content || []) {
        if (c.type === 'text' && c.text.trim()) out.push({ role: 'assistant', text: c.text });
        if (c.type === 'tool_use' && c.name === 'SubagentHandback') {
          handbacks.add(c.id);
          out.push({ role: 'assistant', text: c.input?.message || '' });
        }
        else if (c.type === 'tool_use') out.push({ role: 'tool', name: c.name, text: clip(JSON.stringify(c.input), 3000) });
      }
    }
  }
  return out;
}

// 사용자가 중단(Esc·권한 거부)했는지: 대화 목록의 마지막 항목이 중단 알림인 user 글이면 true.
// renderer 의 stopIfInterrupted 와 같은 기준. 파일 끝 일부만 받아도 되게 첫 줄이 잘렸으면 partial 로 버린다.
function interrupted(text, partial) {
  if (partial) text = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '';
  const m = transcriptMessages(text).at(-1);
  return m?.role === 'user' && !!m.text?.startsWith('[Request interrupted by user');
}

// 파일 끝 bytes 만 비동기로 읽는다. { text, partial } — partial 이면 첫 줄이 잘렸을 수 있다.
async function readTail(file, bytes) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    return { text: buf.toString('utf8', 0, bytesRead), partial: start > 0 };
  } finally {
    await fh.close().catch(() => {});
  }
}

// JSONL 의 마지막 assistant 답변. 최종 보고는 텍스트 블록이거나 SubagentHandback 도구의 message 로 온다.
function lastReplyText(text, partial) {
  const lines = text.trim().split('\n');
  for (let i = lines.length - 1; i >= (partial ? 1 : 0); i--) {
    try {
      const { type, message } = JSON.parse(lines[i]);
      const reply = type === 'assistant' && (message?.content || [])
        .map((c) => (c.type === 'text' ? c.text : c.type === 'tool_use' && c.name === 'SubagentHandback' ? c.input?.message : ''))
        .filter(Boolean)
        .join('\n');
      if (reply) return reply;
    } catch {}
  }
  return undefined;
}

// 끝 64KB 부터 읽고, 답이 없으면 범위를 배로 늘려 파일 전체까지 본다(긴 최종 보고 대비). 없는 파일·실패는 undefined
async function lastReply(file, first = 64 * 1024) {
  if (!file) return undefined;
  try {
    for (let bytes = first; ; bytes *= 2) {
      const { text, partial } = await readTail(file, bytes);
      const reply = lastReplyText(text, partial);
      if (reply || !partial) return reply;
    }
  } catch {
    return undefined;
  }
}

module.exports = { transcriptMessages, interrupted, readTail, lastReplyText, lastReply };
