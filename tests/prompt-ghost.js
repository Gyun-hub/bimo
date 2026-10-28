// claude 입력창에 글자를 쳤을 때 안내 문구(placeholder)가 지워지지 않고 남는지 본다.
// 조건을 바꿔 가며(배율, 크기 변경 직후, 빠른 입력) 입력창 줄의 실제 내용을 모은다. 마지막 상태는 스크린샷으로 남긴다.
(async () => {
  const w = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 60 && !nodes.get('smoke'); i++) await w(200);
  await addNode({ id: 'pg', command: 'claude', cwd: '', x: 40, y: 40, w: 900, h: 460 });
  const n = nodes.get('pg');
  const t = n.term;
  const screen = () => {
    const b = t.buffer.active;
    const out = [];
    for (let i = b.viewportY; i < b.viewportY + t.rows; i++) out.push(b.getLine(i).translateToString(true, 0, t.cols));
    return out;
  };
  const promptLine = () => screen().find((s) => /^\s*[>❯]/.test(s)) ?? '';
  let ready = false;
  for (let i = 0; i < 80 && !ready; i++) {
    await w(250);
    ready = /Try "/.test(promptLine());
  }
  const cases = [];
  const check = async (name, setup, keys) => {
    await setup();
    for (let i = 0; i < 20 && !/Try "/.test(promptLine()); i++) await w(150); // 안내 문구가 다시 보일 때까지
    const before = promptLine();
    for (const k of keys) { api.write('pg', k); if (keys.length > 1) await w(15); }
    await w(1000);
    const after = promptLine();
    cases.push({ name, before: before.trim(), after: after.trim(), ghost: /Try "|filepath|ry "/.test(after) });
    for (let i = 0; i < keys.length; i++) api.write('pg', '\x7f');
    await w(600);
  };
  const setView = (scale) => async () => { view = { x: 20, y: 20, scale }; applyView(); await w(200); };
  await check('배율 100%', setView(1), ['c']);
  await check('배율 70%', setView(0.7), ['c']);
  await check('배율 130%', setView(1.3), ['c']);
  await check('크기 변경 직후', async () => { view = { x: 20, y: 20, scale: 1 }; applyView(); n.data.w = 700; n.data.h = 380; place(n); await w(60); }, ['c']);
  await check('크게 바꾼 직후', async () => { n.data.w = 1100; n.data.h = 520; place(n); await w(60); }, ['c']);
  await check('빠르게 여러 글자', setView(1), [...'hello']);
  // 마지막은 지우지 않고 화면을 남긴다(스크린샷으로 실제 그려진 모습 확인)
  await setView(1)();
  for (let i = 0; i < 20 && !/Try "/.test(promptLine()); i++) await w(150);
  api.write('pg', 'c');
  await w(1000);
  return { ready, cases, finalPrompt: promptLine().trim() };
})()
