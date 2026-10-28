// 크기·배율을 바꿔 가며 (1) pty 칸 수 = 화면 칸 수, (2) 드래그 선택·복사가 정확한지, (3) 긴 줄이 깨지지 않는지 본다.
// --smoke 로 띄운 앱에서 SMOKE_JS_FILE 로 실행한다. 결과는 SMOKE_JS: {...} 로 찍힌다.
(async () => {
  const w = (ms) => new Promise((r) => setTimeout(r, ms));
  const n = nodes.get('smoke');
  const t = n.term;
  const sizes = [[660, 420], [420, 300], [980, 620], [520, 520], [1200, 360], [360, 240], [800, 700]];
  const scales = [1, 0.5, 0.8, 1.3, 2];
  const lines = () => {
    const b = t.buffer.active;
    const out = [];
    // 화면에 보이는 칸(0 ~ cols)만. 좁힌 뒤에도 줄이 예전 칸 수만큼 글자를 들고 있을 수 있다.
    for (let i = 0; i < b.length; i++) out.push({ i, s: b.getLine(i).translateToString(true, 0, t.cols), wrapped: b.getLine(i).isWrapped });
    return out;
  };
  // 줄바꿈으로 이어진 줄(isWrapped)은 하나로 합친다
  const logical = () => {
    const out = [];
    for (const l of lines()) {
      if (l.wrapped && out.length) out[out.length - 1] += l.s;
      else out.push(l.s);
    }
    return out;
  };
  const resize = async (W, H, scale) => {
    n.data.w = W;
    n.data.h = H;
    place(n);
    view = { x: 60, y: 60, scale };
    applyView();
    await w(500); // 화면 맞춤(rAF) + pty 크기 변경(80ms) + ConPTY 다시 그리기
  };
  const results = [];
  let k = 0;
  let lastMarker = '';
  for (const scale of scales) {
    for (const [W, H] of sizes) {
      k++;
      await resize(W, H, scale);
      const marker = `M${k}-${'abcdefghij'.slice(0, 3 + (k % 7))}`;
      // pty 칸 수는 이번 회차 표시(W{k}=)를 붙여 찍어서 예전 출력과 헷갈리지 않게 한다
      api.write('smoke', `cls; echo "W${k}=$([Console]::WindowWidth)"; echo ${marker}\r`);
      let row = -1;
      let ptyCols = null;
      for (let tries = 0; tries < 40 && row < 0; tries++) {
        await w(150);
        const b = t.buffer.active;
        for (const l of lines()) {
          // ConPTY 가 다시 그릴 때 줄 끝을 실제 공백으로 채우므로 끝 공백은 무시
          if (l.s.trimEnd() === marker) row = l.i - b.viewportY;
          const m = l.s.match(new RegExp(`^W${k}=(\\d+)`));
          if (m) ptyCols = Number(m[1]);
        }
      }
      const scr = n.el.querySelector('.xterm-screen');
      const r = scr.getBoundingClientRect();
      const cw = r.width / t.cols;
      const ch = r.height / t.rows;
      const at = (c) => ({ clientX: r.left + (c + 0.5) * cw, clientY: r.top + (row + 0.5) * ch, bubbles: true, button: 0, buttons: 1, detail: 1 });
      scr.dispatchEvent(new MouseEvent('mousedown', at(0)));
      document.dispatchEvent(new MouseEvent('mousemove', at(Math.floor(marker.length / 2))));
      document.dispatchEvent(new MouseEvent('mousemove', at(marker.length)));
      document.dispatchEvent(new MouseEvent('mouseup', at(marker.length)));
      await w(150);
      const sel = t.getSelection();
      // 칸 수가 어긋났으면 1초 뒤 다시 물어 "잠깐 늦은 것"인지 "계속 어긋난 것"인지 가른다
      let laterCols = null;
      if (ptyCols !== t.cols) {
        await w(1000);
        api.write('smoke', `echo "L${k}=$([Console]::WindowWidth)"\r`);
        for (let tries = 0; tries < 20 && laterCols == null; tries++) {
          await w(150);
          for (const l of lines()) {
            const m = l.s.match(new RegExp(`^L${k}=(\\d+)`));
            if (m) laterCols = Number(m[1]);
          }
        }
      }
      const ok = row >= 0 && sel === marker && (ptyCols === t.cols || laterCols === t.cols);
      const lagged = ptyCols !== t.cols && laterCols === t.cols;
      // 실패하면 표시 문자열이 들어 있는 줄을 그대로 남긴다(다른 글자가 섞였는지 보려고)
      const near = ok ? undefined : lines().filter((l) => l.s.includes(`M${k}-`)).map((l) => JSON.stringify(l.s));
      results.push({ scale, W, H, cols: t.cols, ptyCols, laterCols, lagged, row, sel, ok, near });
      lastMarker = marker;
      t.clearSelection();
    }
  }
  // 위로 스크롤한 상태에서 선택·복사: 출력을 쌓고 여러 배율·스크롤 위치에서 특정 줄을 고른다
  await resize(760, 460, 1);
  api.write('smoke', `cls; 1..300 | ForEach-Object { "row-$_-end" }\r`);
  for (let tries = 0; tries < 60; tries++) {
    await w(200);
    if (lines().some((l) => l.s.trimEnd() === 'row-300-end')) break;
  }
  const scroll = [];
  for (const scale of [1, 0.6, 1.5]) {
    for (const up of [0, 37, 120, 260]) {
      view = { x: 60, y: 60, scale };
      applyView();
      t.scrollToBottom();
      t.scrollLines(-up);
      await w(200);
      const b = t.buffer.active;
      const visible = lines().filter((l) => l.i >= b.viewportY && l.i < b.viewportY + t.rows && /^row-\d+-end$/.test(l.s.trimEnd()));
      const pick = visible[Math.floor(visible.length / 2)];
      if (!pick) { scroll.push({ scale, up, ok: false, why: '보이는 줄 없음' }); continue; }
      const want = pick.s.trimEnd();
      const row = pick.i - b.viewportY;
      const scr = n.el.querySelector('.xterm-screen');
      const r = scr.getBoundingClientRect();
      const cw = r.width / t.cols;
      const ch = r.height / t.rows;
      const at = (c) => ({ clientX: r.left + (c + 0.5) * cw, clientY: r.top + (row + 0.5) * ch, bubbles: true, button: 0, buttons: 1, detail: 1 });
      scr.dispatchEvent(new MouseEvent('mousedown', at(0)));
      document.dispatchEvent(new MouseEvent('mousemove', at(want.length)));
      document.dispatchEvent(new MouseEvent('mouseup', at(want.length)));
      await w(150);
      const sel = t.getSelection();
      const viewportAfter = t.buffer.active.viewportY;
      scroll.push({ scale, up, want, sel, ok: sel === want && viewportAfter === b.viewportY, jumped: viewportAfter !== b.viewportY });
      lastMarker = sel;
      t.clearSelection();
    }
  }

  // 앱이 마우스 모드를 켠 상태(claude 전체 화면 등)에서도 그냥 드래그로 선택되는지
  t.write('\x1b[?1000h\x1b[?1006h');
  await w(100);
  const mouseMode = [];
  for (const scale of [1, 0.7]) {
    for (let rep = 0; rep < 3; rep++) {
      view = { x: 60, y: 60, scale };
      applyView();
      t.scrollToBottom();
      await w(150);
      const b = t.buffer.active;
      const visible = lines().filter((l) => l.i >= b.viewportY && l.i < b.viewportY + t.rows && /^row-\d+-end$/.test(l.s.trimEnd()));
      const pick = visible[(rep * 3) % Math.max(1, visible.length)];
      const want = pick?.s.trimEnd();
      const row = pick ? pick.i - b.viewportY : 0;
      const scr = n.el.querySelector('.xterm-screen');
      const r = scr.getBoundingClientRect();
      const cw = r.width / t.cols;
      const ch = r.height / t.rows;
      const at = (c) => ({ clientX: r.left + (c + 0.5) * cw, clientY: r.top + (row + 0.5) * ch, bubbles: true, button: 0, buttons: 1, detail: 1 });
      scr.dispatchEvent(new MouseEvent('mousedown', at(0)));
      document.dispatchEvent(new MouseEvent('mousemove', at(want?.length ?? 1)));
      document.dispatchEvent(new MouseEvent('mouseup', at(want?.length ?? 1)));
      await w(150);
      const sel = t.getSelection();
      mouseMode.push({ scale, rep, want, sel, ok: !!want && sel === want, mode: t.modes.mouseTrackingMode });
      lastMarker = sel || lastMarker;
    }
  }
  t.write('\x1b[?1000l\x1b[?1006l');

  // 긴 줄: 출력 뒤 좁혔다 넓혀도 글자가 빠지거나 섞이지 않는지
  const long = `L${'0123456789'.repeat(15)}R`;
  await resize(980, 420, 1);
  api.write('smoke', `cls; echo ('L' + ('0123456789' * 15) + 'R')\r`);
  await w(1200);
  const reflow = [];
  for (const [W, H] of [[980, 420], [420, 420], [1200, 420], [520, 300], [980, 420]]) {
    await resize(W, H, 1);
    await w(400);
    const ok = logical().some((s) => s.includes(long));
    // 실패하면 긴 줄이 들어 있던 화면 줄과 줄바꿈 표시(isWrapped)를 남긴다
    const dump = ok ? undefined : lines().filter((l) => /[0-9]{6}|L0|9R/.test(l.s)).map((l) => `${l.wrapped ? '↳' : '·'}${l.s.trimEnd()}`);
    reflow.push({ W, cols: t.cols, ok, dump });
  }
  return {
    total: results.length,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok),
    lagged: results.filter((r) => r.lagged).map((r) => `${r.scale} ${r.W}x${r.H}: ${r.ptyCols} -> ${r.laterCols}`),
    scroll,
    mouseMode,
    reflow,
    lastMarker,
  };
})()
