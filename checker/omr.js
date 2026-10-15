/* ============================================================
   Bubblemark sheet reader (OMR engine).
   Plain script shared by the page, the Web Worker (omr-worker.js) and the Node tests (tests/run.mjs).
   ============================================================ */
const OMR = (() => {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const LET = 'ABCDE';
  const tick = () => new Promise(r => setTimeout(r, 0));
  const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
  const r3 = v => Math.round(v * 1000) / 1000;
  const tracing = () => !!globalThis.OMR_TRACE;   // debugging aid: set globalThis.OMR_TRACE = [] to collect the reader's decisions
  const trace = (...a) => globalThis.OMR_TRACE?.push(a);
  function pctile(arr, p) { if (!arr.length) return 0; const a = Float64Array.from(arr).sort(); return a[clamp(Math.floor(p * (a.length - 1)), 0, a.length - 1)]; }
  // a canvas that works on the page, inside a worker (OffscreenCanvas) and in Node tests (globalThis.OffscreenCanvas shim)
  const mkCanvas = (w, h) => { if (typeof document !== 'undefined') { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; } return new OffscreenCanvas(w, h); };
  // debug pictures: a data URL on the page, an ImageBitmap in the worker (the page turns it into a URL)
  const toUrl = (c, q) => c.toDataURL ? c.toDataURL('image/jpeg', q) : { bitmap: c.transferToImageBitmap() };
  const W = 1000, H = 1414, OMR_W = W, OMR_H = H;
  const MK = [[50, 50], [950, 50], [950, 1364], [50, 1364]];   // corner marker centres (canonical)
  const ORI = [112, 50];                                        // orientation square next to top-left

  function layout(exam) {
    const n = exam.numQ, no = exam.numOpts;
    const cols = Math.max(1, Math.ceil(n / 25)), rows = Math.ceil(n / cols);
    const colW = 220, x0 = (1000 - cols * colW) / 2, qs = [];
    for (let i = 0; i < n; i++) {
      const c = Math.floor(i / rows), r = i % rows, cx = x0 + c * colW, y = 432 + r * 36;
      qs.push({ q: i + 1, c, r, cx, y, opts: Array.from({ length: no }, (_, o) => [cx + 72 + o * 32, y]) });
    }
    const D = exam.idDigits || 0, id = [];
    for (let j = 0; j < D; j++) { const x = 915 - (D - 1 - j) * 30; id.push(Array.from({ length: 10 }, (_, d) => [x, 180 + d * 20])); }
    return { qs, id, rQ: 11, rId: 8, rows, cols };
  }

  /* ---------- sheet code: a row of bars between the bottom corner squares ----------
     It says which layout (questions, options, roll digits) and which exam the sheet was printed for, so a sheet
     from another exam is caught instead of being read against the wrong bubble positions. Sheets printed before
     the code existed have blank paper there and are read as before.
     40 cells: black, white, 28 data bits, CRC-8 of the data, white, black. Data: format (3 bits) · options − 4 (1)
     · roll digits (4) · questions − 1 (7) · exam fingerprint (13). */
  const CODE = { x0: 120, pitch: 19, bw: 16, bh: 8, y: 1333, n: 40 };
  function examFp(exam) { let h = 2166136261; for (const ch of String(exam.id || '')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) & 0x1fff; }
  function crc8(bits) { let c = 0; for (const b of bits) { const top = (c >> 7) & 1; c = (c << 1) & 0xff; if (top ^ b) c ^= 0x07; } return c; }
  const toBits = (v, n) => Array.from({ length: n }, (_, i) => (v >> (n - 1 - i)) & 1);
  const fromBits = b => b.reduce((v, x) => v * 2 + x, 0);
  function codeBits(exam) {
    const data = [...toBits(1, 3), ...toBits((exam.numOpts || 4) - 4, 1), ...toBits(exam.idDigits || 0, 4), ...toBits(exam.numQ - 1, 7), ...toBits(examFp(exam), 13)];
    return [1, 0, ...data, ...toBits(crc8(data), 8), 0, 1];
  }
  // read the bars from the straightened, evened-out sheet; { present: false } on sheets without them
  function readCode(N) {
    let best = null;
    for (let oy = -4; oy <= 4; oy += 2) for (let ox = -4; ox <= 4; ox += 2) {
      const v = Array.from({ length: CODE.n }, (_, i) => {
        const cx = Math.round(CODE.x0 + (i + 0.5) * CODE.pitch + ox), cy = CODE.y + oy; let s = 0, n = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -5; dx <= 5; dx++) { s += 255 - N[(cy + dy) * W + cx + dx]; n++; }
        return s / n;
      });
      const blk = (v[0] + v[CODE.n - 1]) / 2, wht = (v[1] + v[CODE.n - 2]) / 2, con = blk - wht, t = (blk + wht) / 2;
      const margin = Math.min(...v.map(x => Math.abs(x - t))) / Math.max(1, con / 2);
      const score = con * Math.min(1, margin);
      if (!best || score > best.score) best = { v, con, t, margin, score };
    }
    if (best.con < 60) return { present: false };
    const bits = best.v.map(x => x > best.t ? 1 : 0), data = bits.slice(2, 30);
    const ok = best.margin >= 0.3 && bits[0] && !bits[1] && !bits[38] && bits[39] && fromBits(bits.slice(30, 38)) === crc8(data);
    if (!ok) return { present: true, ok: false, margin: r3(best.margin) };
    return { present: true, ok: true, format: fromBits(data.slice(0, 3)), numOpts: 4 + data[3], idDigits: fromBits(data.slice(4, 8)), numQ: fromBits(data.slice(8, 15)) + 1, fp: fromBits(data.slice(15, 28)), margin: r3(best.margin) };
  }

  /* ---------- printable sheet ---------- */
  function examCode(exam) { return (exam.id || 'xxxxx').replace(/[^a-z0-9]/gi, '').slice(-5).toUpperCase(); }
  function renderSheet(exam, scale = 1) {
    const L = layout(exam), cv = mkCanvas(Math.round(W * scale), Math.round(H * scale));
    const g = cv.getContext('2d'); g.setTransform(scale, 0, 0, scale, 0, 0);
    const F = 'Helvetica, Arial, sans-serif';
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#000';
    for (const [x, y] of MK) g.fillRect(x - 20, y - 20, 40, 40);
    g.fillRect(ORI[0] - 11, ORI[1] - 11, 22, 22);
    const D = exam.idDigits || 0; const idLeft = D ? 915 - (D - 1) * 30 : 1000;
    const fieldsR = D ? Math.min(600, idLeft - 60) : 940;
    g.textBaseline = 'middle'; g.textAlign = 'left';
    g.fillStyle = '#111'; g.font = `700 24px ${F}`; g.fillText(exam.name || 'Untitled exam', 140, 48, 780);
    g.font = `13px ${F}`; g.fillStyle = '#555';
    g.fillText([exam.subject, `${exam.numQ} questions`, `Options A–${LET[exam.numOpts - 1]}`, `Code ${examCode(exam)}`].filter(Boolean).join('   ·   '), 140, 80, 780);
    const label = (t, x, y) => { g.font = `700 10.5px ${F}`; g.fillStyle = '#6a7080'; g.fillText(t.toUpperCase(), x, y); };
    const line = (x1, y, x2) => { g.fillStyle = '#9aa0ad'; g.fillRect(x1, y, x2 - x1, 1.2); };
    label('Student name', 60, 122); line(60, 162, fieldsR);
    label('Class / section', 60, 190); line(60, 224, Math.min(300, fieldsR - 120)); label('Date', Math.min(330, fieldsR - 100), 190); line(Math.min(330, fieldsR - 100), 224, fieldsR);
    g.strokeStyle = '#cfd3dc'; g.lineWidth = 1.2; g.beginPath(); g.roundRect ? g.roundRect(60, 246, fieldsR - 60, 120, 8) : g.rect(60, 246, fieldsR - 60, 120); g.stroke();
    g.font = `12px ${F}`; g.fillStyle = '#333';
    ['Fill one bubble completely with a dark pencil or black pen.', 'Erase changes cleanly. Do not fold or staple this sheet.', 'Keep the four black corner squares visible in the photo.'].forEach((t, i) => g.fillText('•  ' + t, 76, 268 + i * 20, fieldsR - 90));
    g.font = `600 11.5px ${F}`; g.fillStyle = '#333'; g.fillText('Correct', 76, 343);
    g.beginPath(); g.arc(138, 343, 9, 0, 7); g.fill();
    g.fillText('Wrong', 172, 343);
    [[232, '✓'], [262, '✕'], [292, '/']].forEach(([x, t]) => { g.strokeStyle = '#555'; g.lineWidth = 1.2; g.beginPath(); g.arc(x, 343, 9, 0, 7); g.stroke(); g.fillStyle = '#333'; g.textAlign = 'center'; g.fillText(t, x, 344); g.textAlign = 'left'; });
    if (D) {
      label('Roll number', idLeft - 12, 118);
      for (let j = 0; j < D; j++) {
        const x = L.id[j][0][0];
        g.strokeStyle = '#9aa0ad'; g.lineWidth = 1.2; g.strokeRect(x - 12, 132, 24, 30);
        for (let d = 0; d < 10; d++) { const [bx, by] = L.id[j][d]; g.strokeStyle = '#3a3f4a'; g.lineWidth = 1.2; g.beginPath(); g.arc(bx, by, 8, 0, 7); g.stroke(); g.fillStyle = '#a5abb6'; g.font = `600 9px ${F}`; g.textAlign = 'center'; g.fillText(String(d), bx, by + .5); }
      }
      g.textAlign = 'left';
    }
    g.fillStyle = '#c8ccd6'; g.fillRect(60, 392, 880, 1.2);
    for (const q of L.qs) {
      g.textAlign = 'right'; g.fillStyle = '#222'; g.font = `700 13px ${F}`; g.fillText(String(q.q), q.cx + 54, q.y + .5);
      q.opts.forEach(([x, y], o) => {
        g.strokeStyle = '#3a3f4a'; g.lineWidth = 1.3; g.beginPath(); g.arc(x, y, 11, 0, 7); g.stroke();
        g.fillStyle = '#a3a9b5'; g.font = `700 10px ${F}`; g.textAlign = 'center'; g.fillText(LET[o], x, y + .5);
      });
      if (q.r % 5 === 4 && q.r !== L.rows - 1) { g.fillStyle = '#e1e4ea'; g.fillRect(q.cx + 24, q.y + 18, 184, 1); }
    }
    g.fillStyle = '#000';
    codeBits(exam).forEach((b, i) => { if (b) g.fillRect(CODE.x0 + i * CODE.pitch + (CODE.pitch - CODE.bw) / 2, CODE.y - CODE.bh / 2, CODE.bw, CODE.bh); });
    g.textAlign = 'center'; g.fillStyle = '#8a90a0'; g.font = `11px ${F}`;
    g.fillText('Bubblemark answer sheet  ·  keep corner squares clear  ·  do not fold', 500, 1364);
    return cv;
  }

  /* ---------- image helpers ---------- */
  // high-quality shrink: halve step by step so thin printed lines stay smooth whatever the camera size
  function scaleCanvas(src, maxDim) {
    const w0 = src.videoWidth || src.naturalWidth || src.width, h0 = src.videoHeight || src.naturalHeight || src.height;
    const s = Math.min(1, maxDim / Math.max(w0, h0)), tw = Math.max(1, Math.round(w0 * s)), th = Math.max(1, Math.round(h0 * s));
    let cur = src, cw = w0, ch = h0;
    while (cw / 2 >= tw * 1.05) {
      const t = mkCanvas(Math.round(cw / 2), Math.round(ch / 2));
      const tg = t.getContext('2d'); tg.imageSmoothingEnabled = true; tg.imageSmoothingQuality = 'high'; tg.drawImage(cur, 0, 0, t.width, t.height);
      cur = t; cw = t.width; ch = t.height;
    }
    const c = mkCanvas(tw, th);
    const g = c.getContext('2d', { willReadFrequently: true }); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; g.drawImage(cur, 0, 0, tw, th);
    return c;
  }
  function gray(cv) {
    const d = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height).data;
    const n = cv.width * cv.height, g = new Uint8Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
    return { g, w: cv.width, h: cv.height };
  }
  function binarize(G, ratio = 0.68) {
    const { g, w, h } = G, W1 = w + 1, I = new Uint32Array(W1 * (h + 1));
    for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += g[y * w + x]; I[(y + 1) * W1 + x + 1] = I[y * W1 + x + 1] + row; } }
    const R = Math.max(6, Math.round(Math.max(w, h) / 16)), B = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - R), y1 = Math.min(h, y + R + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - R), x1 = Math.min(w, x + R + 1), area = (x1 - x0) * (y1 - y0);
        const sum = I[y1 * W1 + x1] - I[y0 * W1 + x1] - I[y1 * W1 + x0] + I[y0 * W1 + x0];
        if (g[y * w + x] * area < sum * ratio) B[y * w + x] = 1;
      }
    }
    return B;
  }
  function markerCandidates(B, G) {
    const { w, h, g } = G, seen = new Uint8Array(w * h), stack = new Int32Array(w * h), out = [];
    const maxN = w * h * 0.02;
    for (let i = 0; i < w * h; i++) {
      if (!B[i] || seen[i]) continue;
      let sp = 0; stack[sp++] = i; seen[i] = 1;
      let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, minx = w, maxx = 0, miny = h, maxy = 0, sg = 0;
      while (sp) {
        const p = stack[--sp], x = p % w, y = (p - x) / w;
        n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sg += g[p];
        if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
        if (x > 0 && B[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[sp++] = p - 1; }
        if (x < w - 1 && B[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[sp++] = p + 1; }
        if (y > 0 && B[p - w] && !seen[p - w]) { seen[p - w] = 1; stack[sp++] = p - w; }
        if (y < h - 1 && B[p + w] && !seen[p + w]) { seen[p + w] = 1; stack[sp++] = p + w; }
      }
      if (n < 16 || n > maxN) continue;
      const bw = maxx - minx + 1, bh = maxy - miny + 1;
      if (bw / bh > 2.4 || bh / bw > 2.4) continue;
      const cx = sx / n, cy = sy / n, vxx = sxx / n - cx * cx, vyy = syy / n - cy * cy, vxy = sxy / n - cx * cy;
      const tr = vxx + vyy, det = vxx * vyy - vxy * vxy, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
      const l1 = tr / 2 + disc, l2 = tr / 2 - disc;
      if (l2 <= 0 || l1 / l2 > 1.9) continue;
      const solidity = n / (12 * Math.sqrt(l1 * l2));
      if (solidity < 0.78 || solidity > 1.25) continue;
      out.push({ n, cx: cx + 0.5, cy: cy + 0.5, side: Math.sqrt(n), mg: sg / n, border: minx <= 1 || miny <= 1 || maxx >= w - 2 || maxy >= h - 2 });
    }
    return out;
  }
  function orderPts(ps) {
    const cx = mean(ps.map(p => p.cx)), cy = mean(ps.map(p => p.cy));
    return ps.slice().sort((a, b) => Math.atan2(a.cy - cy, a.cx - cx) - Math.atan2(b.cy - cy, b.cx - cx));
  }
  const dist = (a, b) => Math.hypot(a.cx - b.cx, a.cy - b.cy);
  function quadScore(ps) {
    const o = orderPts(ps);
    for (let i = 0; i < 4; i++) {
      const a = o[i], b = o[(i + 1) % 4], c = o[(i + 2) % 4];
      if ((b.cx - a.cx) * (c.cy - b.cy) - (b.cy - a.cy) * (c.cx - b.cx) <= 0) return null;
    }
    const s = [0, 1, 2, 3].map(i => dist(o[i], o[(i + 1) % 4]));
    if (Math.max(s[0], s[2]) / Math.min(s[0], s[2]) > 1.8 || Math.max(s[1], s[3]) / Math.min(s[1], s[3]) > 1.8) return null;
    const a1 = (s[0] + s[2]) / 2, a2 = (s[1] + s[3]) / 2, ar = Math.max(a1, a2) / Math.min(a1, a2);
    if (ar < 1.12 || ar > 2.1) return null;
    const ms = mean(ps.map(p => p.side)), ratio = (a1 + a2) / 2 / ms;
    if (ratio < 13 || ratio > 50) return null;
    let area = 0; for (let i = 0; i < 4; i++) { const a = o[i], b = o[(i + 1) % 4]; area += a.cx * b.cy - b.cx * a.cy; }
    return { pts: o, area: Math.abs(area) / 2, ms };
  }
  function inQuad(pts, p, f) {
    const cx = mean(pts.map(q => q.cx)), cy = mean(pts.map(q => q.cy));
    const q = pts.map(t => ({ cx: cx + (t.cx - cx) * f, cy: cy + (t.cy - cy) * f }));
    for (let i = 0; i < 4; i++) { const a = q[i], b = q[(i + 1) % 4]; if ((b.cx - a.cx) * (p.cy - a.cy) - (b.cy - a.cy) * (p.cx - a.cx) < 0) return false; }
    return true;
  }
  function findPaper(G) {
    const B = binarize(G), cands = markerCandidates(B, G);
    const inner = cands.filter(c => !c.border).sort((a, b) => b.n - a.n).slice(0, 18);
    let best = null; const k = inner.length;
    for (let a = 0; a < k; a++) for (let b = a + 1; b < k; b++) for (let c = b + 1; c < k; c++) for (let d = c + 1; d < k; d++) {
      const set = [inner[a], inner[b], inner[c], inner[d]];
      const ns = set.map(s => s.n); if (Math.max(...ns) / Math.min(...ns) > 2.8) continue;
      const q = quadScore(set); if (!q) continue;
      if (!best || q.area > best.area) best = { ...q, set };
    }
    if (!best) {
      const edge = cands.filter(c => c.border && c.n > 30).length;
      return { error: edge >= 1 && cands.length >= 3 ? 'partial' : 'notfound', cands };
    }
    const med = pctile(best.set.map(s => s.n), 0.5);
    const others = inner.filter(c => !best.set.includes(c) && c.n > med * 0.5 && c.n < med * 2 && !inQuad(best.pts, c, 1.1));
    if (others.length >= 3) return { error: 'multiple' };
    return best;
  }

  /* ---------- geometry ---------- */
  function solve(A, b) {
    const n = b.length, M = A.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < n; c++) {
      let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      [M[c], M[p]] = [M[p], M[c]];
      const v = M[c][c]; if (Math.abs(v) < 1e-12) return null;
      for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / v; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
    }
    return M.map((r, i) => r[n] / r[i]);
  }
  function homog(src, dst) { // maps src[i] -> dst[i]
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i], [u, v] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    const h = solve(A, b); return h ? [...h, 1] : null;
  }
  const applyH = (Hm, x, y) => { const d = Hm[6] * x + Hm[7] * y + 1; return [(Hm[0] * x + Hm[1] * y + Hm[2]) / d, (Hm[3] * x + Hm[4] * y + Hm[5]) / d]; };
  function sampleB(G, x, y) {
    const { g, w, h } = G; if (x < 0 || y < 0 || x >= w - 1 || y >= h - 1) return 255;
    const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * w + x0;
    return (g[i] * (1 - fx) + g[i + 1] * fx) * (1 - fy) + (g[i + w] * (1 - fx) + g[i + w + 1] * fx) * fy;
  }
  function warp(G, Hm, ow = W, oh = H) {
    const out = new Uint8Array(ow * oh);
    for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) { const [sx, sy] = applyH(Hm, x, y); out[y * ow + x] = sampleB(G, sx, sy); }
    return out;
  }
  function orientContrast(G, Hm) {
    let mk = 0, pp = 0, n = 0;
    for (let dy = -6; dy <= 6; dy += 3) for (let dx = -6; dx <= 6; dx += 3) {
      const a = applyH(Hm, ORI[0] + dx, ORI[1] + dy), b = applyH(Hm, ORI[0] + dx, ORI[1] + 44 + dy);
      mk += sampleB(G, a[0], a[1]); pp += sampleB(G, b[0], b[1]); n++;
    }
    return (pp - mk) / n;
  }
  function refine(C, Hm) {
    const src = [];
    for (const [mx, my] of MK) {
      let mn = 255, mxv = 0; const x0 = Math.max(0, mx - 44), x1 = Math.min(W - 1, mx + 44), y0 = Math.max(0, my - 44), y1 = Math.min(H - 1, my + 44);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const v = C[y * W + x]; if (v < mn) mn = v; if (v > mxv) mxv = v; }
      if (mxv - mn < 40) return Hm;
      const t = (mn + mxv) / 2; let sw = 0, sx = 0, sy = 0;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const v = C[y * W + x]; if (v < t) { const wgt = t - v; sw += wgt; sx += wgt * x; sy += wgt * y; } }
      if (!sw) return Hm;
      src.push(applyH(Hm, sx / sw + 0.5, sy / sw + 0.5));
    }
    return homog(MK, src) || Hm;
  }
  function flatten(C, W = OMR_W, H = OMR_H) {
    const bs = 16, bw = Math.ceil(W / bs), bh = Math.ceil(H / bs);
    let M = new Float32Array(bw * bh);
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
      let mx = 0; const ye = Math.min(H, by * bs + bs), xe = Math.min(W, bx * bs + bs);
      for (let y = by * bs; y < ye; y += 2) for (let x = bx * bs; x < xe; x += 2) { const v = C[y * W + x]; if (v > mx) mx = v; }
      M[by * bw + bx] = mx;
    }
    const filt = (A, op) => { const O = new Float32Array(A.length); for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) { let m = op === 'max' ? 0 : 0, n = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const yy = y + dy, xx = x + dx; if (yy < 0 || xx < 0 || yy >= bh || xx >= bw) continue; const v = A[yy * bw + xx]; if (op === 'max') { if (v > m) m = v; } else { m += v; n++; } } O[y * bw + x] = op === 'max' ? m : m / n; } return O; };
    M = filt(filt(M, 'max'), 'max'); M = filt(filt(M, 'avg'), 'avg');
    const out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      const fy = (y + .5) / bs - .5, y0 = clamp(Math.floor(fy), 0, bh - 1), y1 = Math.min(bh - 1, y0 + 1), ty = clamp(fy - y0, 0, 1);
      for (let x = 0; x < W; x++) {
        const fx = (x + .5) / bs - .5, x0 = clamp(Math.floor(fx), 0, bw - 1), x1 = Math.min(bw - 1, x0 + 1), tx = clamp(fx - x0, 0, 1);
        const bg = (M[y0 * bw + x0] * (1 - tx) + M[y0 * bw + x1] * tx) * (1 - ty) + (M[y1 * bw + x0] * (1 - tx) + M[y1 * bw + x1] * tx) * ty;
        const v = C[y * W + x] / Math.max(30, bg) * 242; out[y * W + x] = v > 255 ? 255 : v;
      }
    }
    return out;
  }
  function box3(N, w, h) {
    const O = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) { const yy = y + dy; if (yy < 0 || yy >= h) continue; for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx < 0 || xx >= w) continue; s += N[yy * w + xx]; n++; } }
      O[y * w + x] = s / n;
    }
    return O;
  }
  function ringDark(N, x, y, r, W = OMR_W, H = OMR_H) { let s = 0; for (let k = 0; k < 16; k++) { const a = k * Math.PI / 8, px = Math.round(x + Math.cos(a) * r), py = Math.round(y + Math.sin(a) * r); s += (px < 0 || py < 0 || px >= W || py >= H) ? 0 : 255 - N[py * W + px]; } return s / 16 / 255; }
  // like ringDark, but judged on the weaker half of the circle: a straight line (the border of a table, the edge of a column) darkens
  // only a few points of a circle laid across it, a printed ring darkens all of them
  function ringDarkEven(N, x, y, r, W = OMR_W, H = OMR_H) { const v = []; for (let k = 0; k < 16; k++) { const a = k * Math.PI / 8, px = Math.round(x + Math.cos(a) * r), py = Math.round(y + Math.sin(a) * r); v.push((px < 0 || py < 0 || px >= W || py >= H) ? 0 : 255 - N[py * W + px]); } v.sort((p, q) => p - q); let s = 0; for (let k = 0; k < 10; k++) s += v[k]; return s / 10 / 255; }
  function discDark(N, x, y, r, W = OMR_W, H = OMR_H) { const ri = Math.ceil(r), cx = Math.round(x), cy = Math.round(y); let s = 0, n = 0; for (let dy = -ri; dy <= ri; dy++) for (let dx = -ri; dx <= ri; dx++) { if (dx * dx + dy * dy > r * r) continue; const px = cx + dx, py = cy + dy; if (px < 0 || py < 0 || px >= W || py >= H) continue; s += 255 - N[py * W + px]; n++; } return n ? s / n / 255 : 0; }
  function snap(N, pts, r) {
    let best = -1, bx = 0, by = 0;
    for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) { let s = 0; for (const [x, y] of pts) s += ringDark(N, x + dx, y + dy, r); if (s > best) { best = s; bx = dx; by = dy; } }
    return [bx, by];
  }
  // Washed-out questions (C: the straightened photo before lighting is evened out, N: after). A reflection turns
  // pencil as white as the paper, so a filled bubble there would read blank. Brightness alone can't tell (a sheet
  // can be bright all over and read fine); what gives it away is that the printed ring outlines fade too.
  // Each question's ring visibility is compared with the sheet's typical question.
  const HOT = 253;
  function glareRows(C, N, qPts, r) {
    // best spot within ±2 px: on bent or blurred paper the rings sit a little off their expected place
    const at = (x, y) => { let b = 0; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) b = Math.max(b, ringDark(N, x + dx, y + dy, r)); return b; };
    const vis = qPts.map(pts => mean(pts.map(([x, y]) => at(x, y))));
    const typ = pctile(vis, 0.5);
    if (tracing()) trace('ring visibility', vis.map(v => r3(v / Math.max(1e-3, typ))).join(' '));
    return vis.map(v => v < typ * VIS_MIN);
  }
  const VIS_MIN = 0.82;
  function glareShare(G, box) {
    const { g, w } = G, [x0, y0, x1, y1] = box, vals = []; let hot = 0, n = 0;
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { const v = g[y * w + x]; n++; if (v >= HOT) hot++; if ((n & 7) === 0) vals.push(v); }
    return !n || pctile(vals, 0.5) >= 240 ? 0 : hot / n;   // paper clipped all over: exposure, not a reflection
  }
  function sharpness(G, box) {
    const { g, w } = G, [x0, y0, x1, y1] = box, gh = new Uint32Array(512), ih = new Uint32Array(256); let n = 0;
    for (let y = y0 + 1; y < y1 - 1; y++) for (let x = x0 + 1; x < x1 - 1; x++) { const i = y * w + x; gh[Math.abs(g[i + 1] - g[i - 1]) + Math.abs(g[i + w] - g[i - w])]++; ih[g[i]]++; n++; }
    if (!n) return 0;
    const pc = (h, p) => { let t = n * p, a = 0; for (let k = 0; k < h.length; k++) { a += h[k]; if (a >= t) return k; } return h.length - 1; };
    return pc(gh, 0.998) / Math.max(24, pc(ih, 0.98) - pc(ih, 0.02));
  }

  /* ---------- reading marks ----------
     Each bubble gets a "mark amount": the share of its inside that is inked, with light pencil
     counted partly. Half fills, ticks, crosses and light shading all register; the printed letter
     is removed by subtracting what that option looks like when empty on this same sheet. */
  function coverage(N, x, y, r, W = OMR_W, H = OMR_H, D = 140, Lt = 212) {
    const ri = Math.ceil(r), cx = Math.round(x), cy = Math.round(y); let s = 0, n = 0;
    for (let dy = -ri; dy <= ri; dy++) for (let dx = -ri; dx <= ri; dx++) {
      if (dx * dx + dy * dy > r * r) continue; const px = cx + dx, py = cy + dy; if (px < 0 || py < 0 || px >= W || py >= H) continue;
      const v = N[py * W + px]; s += v <= D ? 1 : v < Lt ? (Lt - v) / (Lt - D) : 0; n++;
    }
    return n ? s / n : 0;
  }
  // best reading position within ±2px (absorbs small printing / photo misalignment per bubble)
  function markAt(N, x, y, r, W, H, k = 2) {
    let best = 0;
    for (let dy = -k; dy <= k; dy += Math.max(1, k)) for (let dx = -k; dx <= k; dx += Math.max(1, k)) { const v = coverage(N, x + dx, y + dy, r, W, H); if (v > best) best = v; }
    return best;
  }
  function calibrate(raw) {
    const no = Math.max(...raw.map(r => r.length));
    const base = Array.from({ length: no }, (_, o) => pctile(raw.map(r => r[o]).filter(v => v != null), 0.3));
    const baseAll = pctile(base, 0.5);
    const tops = raw.map(r => Math.max(...r.map((v, o) => v - base[o])));
    const strong = tops.filter(t => t > 0.3);
    let full = strong.length >= 3 ? pctile(strong, 0.6) : 0.7; full = Math.max(full, 0.35);
    return { base, baseAll, full, scale: (v, o) => (v - (base[o] ?? baseAll)) / full };
  }
  function classify(s, cfg) {
    const F = cfg.fill, P = cfg.partial ?? 0.2, idx = s.map((v, i) => i).sort((a, b) => s[b] - s[a]);
    const top = s[idx[0]], sec = idx.length > 1 ? s[idx[1]] : 0;
    if (top < P) return { st: 'blank', det: null, cand: [], c: 0.5 + 0.5 * clamp((P - top) / (P * 0.7), 0, 1) };
    const strong = idx.filter(i => s[i] >= F * 0.8);
    if (strong.length >= 2 && s[strong[1]] >= top * 0.6) return { st: 'multiple', det: null, cand: strong, c: 0.5 + 0.5 * clamp((s[strong[1]] - F * 0.8) / 0.3, 0, 1) };
    // faint, evenly spread smudge across several options (printed text, shadow, finger) is background, not a mark
    if (top < 0.3 && sec > top * 0.5) return { st: 'blank', det: null, cand: [], c: 0.7 };
    const dominant = sec < P * 0.7 || top >= sec * 2.2 + 0.08;
    // a lone mark is fully trusted from 0.45 of a full fill: fainter ones (light pencil, but also an erased mark once
    // photo noise is added in dim light) need the others to be clean to pass, and otherwise go to review
    const c = 0.5 + 0.5 * Math.min(clamp((top - P) / 0.3, 0, 1), clamp((top - sec * 1.6) / 0.3, 0, 1));
    if (!dominant || c < cfg.minConf) return { st: 'uncertain', det: idx[0], cand: [idx[0], ...idx.slice(1).filter(i => s[i] >= P * 0.7)], c };
    return { st: 'answered', det: idx[0], cand: [idx[0]], c, partial: top < F };
  }
  // snap a bubble position onto its printed ring (fixes small errors on curled or bent paper)
  function snapRing(N, w, h, x, y, rr) {
    const k = Math.max(2, Math.round(rr * 0.7)); let best = -1, bx = x, by = y;
    for (let dy = -k; dy <= k; dy++) for (let dx = -k; dx <= k; dx++) { const v = ringDarkEven(N, x + dx, y + dy, rr, w, h) - 0.02 * Math.hypot(dx, dy) / k; if (v > best) { best = v; bx = x + dx; by = y + dy; } }
    return [bx, by];
  }
  function readAll(N, w, h, qPts, idCols, rIn, rId, cfg, rRing = 0) {
    let align = null;
    if (rRing) {
      qPts = qPts.map(q => { const sn = q.map(([x, y]) => snapRing(N, w, h, x, y, rRing)); const dx = pctile(sn.map((p, o) => p[0] - q[o][0]), 0.5), dy = pctile(sn.map((p, o) => p[1] - q[o][1]), 0.5); return q.map(([x, y], o) => Math.hypot(sn[o][0] - x - dx, sn[o][1] - y - dy) < rRing * 0.3 ? sn[o] : [x + dx, y + dy]); });
      // how well each question sits on printed circles; a poor fit means the position is unreliable
      const q = qPts.map(pts => mean(pts.map(([x, y]) => ringDark(N, x, y, rRing, w, h))));
      const med = pctile(q, 0.5); align = q.map(v => v / Math.max(0.01, med));
      // bubbles of one question must be evenly spaced in a line; if not, the geometry there can't be trusted
      const gaps = qPts.flatMap(pts => pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1])));
      const ug = pctile(gaps, 0.5);
      qPts.forEach((pts, i) => { for (let k = 1; k < pts.length; k++) { const g = Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]); if (Math.abs(g - ug) > ug * 0.33) { align[i] = 0; break; } } });
    }
    const raw = qPts.map(q => q.map(([x, y]) => markAt(N, x, y, rIn, w, h, rRing ? 0 : 2)));
    // ink right at the centre: a real mark covers it, ink spilling in from a neighbour or a circled letter does not
    const cen = qPts.map(q => q.map(([x, y]) => coverage(N, x, y, rIn * 0.38, w, h)));
    const dk = qPts.map(q => q.map(([x, y]) => coverage(N, x, y, rIn * 0.9, w, h, 95, 125)));
    const dkBase = Array.from({ length: Math.max(...dk.map(r => r.length)) }, (_, o) => pctile(dk.map(r => r[o]).filter(v => v != null), 0.3));
    const cenBase = Array.from({ length: Math.max(...cen.map(r => r.length)) }, (_, o) => pctile(cen.map(r => r[o]).filter(v => v != null), 0.3));
    const cal = calibrate(raw);
    const answers = raw.map((r, qi) => { let s = r.map((v, o) => cal.scale(v, o));
      const strong = s.filter(v => v >= cfg.fill * 0.8).length;
      // a second "strong" reading must be backed by real dark ink inside the bubble: shading, a shadow or a page edge
      // lightens the paper evenly and reads like a faint mark, but has no pixels that dark
      if (strong >= 2) s = s.map((v, o) => v >= cfg.fill * 0.8 && ((cen[qi][o] - cenBase[o]) / Math.max(0.15, 1 - cenBase[o]) < 0.35 || (dk[qi][o] - dkBase[o]) / Math.max(0.15, 1 - dkBase[o]) < 0.3) ? Math.min(v, 0.3) : v);
      if (tracing()) trace('row', qi + 1, 'raw', r.map(r3), 'cen', cen[qi].map(r3), 'cenBase', cenBase.map(r3), 'base', cal.base.map(r3), 'full', r3(cal.full), 'dk', dk[qi].map(r3), 'dkBase', dkBase.map(r3));
      let c = classify(s, cfg);
      if (align && align[qi] < 0.55) c = { st: 'uncertain', det: c.det, cand: c.cand.length ? c.cand : s.map((v, o) => o).filter(o => s[o] >= (cfg.partial ?? 0.2)), c: Math.min(c.c, 0.5) };
      const a = { s: s.map(r3), st: c.st, det: c.det, cand: c.cand, c: Math.round(c.c * 100) / 100 }; if (c.partial) a.p = 1; if (align && align[qi] < 0.55) a.al = 1; return a; });
    let id = null;
    if (idCols && idCols.length) {
      const vals = idCols.map(col => col.map(([x, y]) => markAt(N, x, y, rId, w, h)));
      const base = vals[0].map((_, dgt) => pctile(vals.map(v => v[dgt]), idCols.length >= 4 ? 0.35 : 0.2));
      // as with answers, a runner-up reading counts only when it has real dark ink behind it (a stain or a print flaw does not)
      const dks = idCols.map(col => col.map(([x, y]) => coverage(N, x, y, rId * 0.9, w, h, 95, 125)));
      const dkb = vals[0].map((_, dgt) => pctile(dks.map(v => v[dgt]), idCols.length >= 4 ? 0.35 : 0.2));
      if (tracing()) dks.forEach((v, ci) => trace('iddk', ci, v.map(r3), dkb.map(r3)));
      const cols = vals.map((v, ci) => {
        const sc = v.map((t, dgt) => (t - Math.min(base[dgt], pctile(v, 0.5) + 0.1)) / cal.full), top = Math.max(...sc);
        const ink = dgt => (dks[ci][dgt] - dkb[dgt]) / Math.max(0.15, 1 - dkb[dgt]);
        return classify(sc.map((x, dgt) => (x < top || x < 0.4) && x >= cfg.partial && ink(dgt) < 0.3 ? Math.min(x, 0.1) : x), cfg);
      });
      if (tracing()) vals.forEach((v, ci) => trace('idcol', ci, v.map(r3), cols[ci].st, cols[ci].det, r3(cols[ci].c)));
      if (tracing()) vals.forEach((v, ci) => trace('idsc', ci, v.map((t, dgt) => r3((t - Math.min(base[dgt], pctile(v, 0.5) + 0.1)) / cal.full)), r3(cal.full)));
      const allBlank = cols.every(c => c.st === 'blank'), allOk = cols.every(c => c.st === 'answered');
      id = { roll: allBlank ? '' : cols.map(c => c.st === 'answered' ? String(c.det) : '?').join(''), state: allOk ? 'detected' : allBlank ? 'missing' : 'unclear', conf: Math.round(Math.min(...cols.map(c => c.c)) * 100) / 100 };
    }
    return { answers, id, cal, qPts };
  }

  const FAIL = {
    decode: ['Unable to open this file', 'Use a JPG or PNG photo of the answer sheet.'],
    notfound: ['Paper not detected', 'We could not find the four black corner squares. Photograph the whole sheet on a plain, contrasting surface.'],
    partial: ['Paper partially outside frame', 'A corner square is cut off. Step back so the whole sheet fits in the photo.'],
    multiple: ['Multiple papers detected', 'Photograph one answer sheet at a time.'],
    small: ['Move closer', 'The sheet is too small in the photo to read the bubbles reliably. Let the paper fill most of the frame.'],
    blurry: ['Image is too blurry', 'Hold the phone steady and tap the screen to focus before taking the photo.'],
    dark: ['Too dark', 'Move to better light and keep your shadow off the sheet.'],
    orientation: ['Could not tell which way is up', 'The small square beside the top-left corner is hidden or smudged. Keep it visible.'],
    layout: ['Bubbles could not be read', 'The printed bubbles were not found where expected. Check that this sheet belongs to this exam.'],
    nobubbles: ['Answer bubbles not found', 'Hold the phone straight above the sheet, fill the frame with the page and make sure the bubbles are in focus.'],
    glare: ['Too much glare', 'Light is reflecting off the sheet. Tilt the phone a little, or switch off the flashlight, and scan again.'],
    wrongsheet: ['Sheet from another exam', 'This sheet was printed for a different exam.']
  };

  // Whether the bubble finder locks onto a sheet can hinge on a few pixels of scale, with no pattern to it (the same photo reads at
  // 2000 px and not at 2100). So a sheet it could not line up is looked at again a little smaller before giving up.
  async function process(src, exam, cfg, onStage = () => {}) {
    const first = await processOnce(src, exam, cfg, onStage);
    if (first.ok || !['fewq', 'nobubbles', 'layout'].includes(first.code)) return first;
    for (const f of [0.85, 0.72]) {
      const r = await processOnce(scaleCanvas(src, Math.round(Math.max(src.width, src.height) * f)), exam, cfg, onStage);
      if (r.ok) { if (tracing()) trace('rescaled', f); return r; }
    }
    return first;
  }
  async function processOnce(src, exam, cfg, onStage = () => {}) {
    const fail = (code, extra) => ({ ok: false, code, title: FAIL[code][0], reason: FAIL[code][1], ...extra });
    onStage('Detecting paper', 0.18); await tick();
    const small = scaleCanvas(src, 900), Gs = gray(small), sc = src.width / small.width;
    const bright = mean(Array.from(Gs.g.filter((_, i) => i % 7 === 0)));
    const found = findPaper(Gs);
    // the corner squares or the printed grid could not be used: when a large reflection is the reason, say so
    // instead of a generic "not found" from the fallback reader
    const glared = glareShare(Gs, [0, 0, Gs.w, Gs.h]) > 0.04;
    if (found.error) {
      if (glared) return fail('glare');
      if (bright < 60) return fail('dark');
      if (sharpness(Gs, [0, 0, Gs.w, Gs.h]) < cfg.minSharp) return fail('blurry');
      const auto = await processAuto(src, Gs, sc, bright, exam, cfg, onStage, fail);
      if (!auto.ok && auto.code === 'nobubbles' && (found.error === 'multiple' || found.error === 'partial')) return fail(found.error);
      return auto;
    }
    const xs = found.pts.map(p => p.cx), ys = found.pts.map(p => p.cy);
    const box = [Math.max(0, Math.floor(Math.min(...xs))), Math.max(0, Math.floor(Math.min(...ys))), Math.min(Gs.w, Math.ceil(Math.max(...xs))), Math.min(Gs.h, Math.ceil(Math.max(...ys)))];
    const minSide = Math.min(...[0, 1, 2, 3].map(i => dist(found.pts[i], found.pts[(i + 1) % 4]))) * sc;
    if (minSide < 420) return fail('small');
    const sharp = sharpness(Gs, box);
    if (sharp < cfg.minSharp) return fail('blurry', { sharpness: sharp });
    onStage('Correcting perspective', 0.34); await tick();
    const Gf = gray(src);
    const pts = found.pts.map(p => [p.cx * sc - 0.5 * (sc - 1), p.cy * sc - 0.5 * (sc - 1)]);
    const tries = [0, 1, 2, 3].map(k => { const Hm = homog(MK, [0, 1, 2, 3].map(i => pts[(i + k) % 4])); return { k, Hm, c: Hm ? orientContrast(Gf, Hm) : -999 }; }).sort((a, b) => b.c - a.c);
    if (tries[0].c < 22 || tries[1].c > tries[0].c * 0.6) return glared ? fail('glare') : processAuto(src, Gs, sc, bright, exam, cfg, onStage, fail);
    let Hm = tries[0].Hm, C = warp(Gf, Hm);
    Hm = refine(C, Hm); C = warp(Gf, Hm);
    const tl = applyH(Hm, MK[0][0], MK[0][1]), tr = applyH(Hm, MK[1][0], MK[1][1]);
    const rotation = Math.round(Math.atan2(tr[1] - tl[1], tr[0] - tl[0]) * 180 / Math.PI);
    onStage('Normalizing lighting', 0.52); await tick();
    const paperLevel = pctile(Array.from(C.filter((_, i) => i % 97 === 0)), 0.8);
    if (paperLevel < 55) return fail('dark');
    const N = flatten(C);
    // the printed sheet code: a sheet for another layout would be read at the wrong bubble positions, so stop;
    // one for another exam with the same layout is read, and the app warns about it
    const sheet = readCode(N);
    if (sheet.ok && (sheet.numQ !== exam.numQ || sheet.numOpts !== exam.numOpts || sheet.idDigits !== (exam.idDigits || 0))) {
      return fail('wrongsheet', { sheet, reason: `This sheet was printed for an exam with ${sheet.numQ} questions (A–${LET[sheet.numOpts - 1]}${sheet.idDigits ? `, ${sheet.idDigits}-digit roll` : ''}); this exam has ${exam.numQ} questions (A–${LET[exam.numOpts - 1]}${exam.idDigits ? `, ${exam.idDigits}-digit roll` : ''}). Open the exam this sheet belongs to, or print sheets for this exam from its ⋯ menu.` });
    }
    const otherExam = sheet.ok && sheet.fp !== examFp(exam);
    onStage('Reading bubbles', 0.7); await tick();
    const L = layout(exam), off = L.qs.map(() => [0, 0]);
    // local alignment per block of 5 rows per column (absorbs paper curl)
    const groups = {};
    L.qs.forEach((q, i) => { const k = q.c + ':' + Math.floor(q.r / 5); (groups[k] = groups[k] || []).push(i); });
    let ringSum = 0;
    for (const ids of Object.values(groups)) {
      const o = snap(N, ids.flatMap(i => L.qs[i].opts), L.rQ);
      ids.forEach(i => { off[i] = o; });
      ringSum += mean(ids.flatMap(i => L.qs[i].opts.map(([x, y]) => ringDark(N, x + o[0], y + o[1], L.rQ))));
    }
    const ringAvg = ringSum / Object.keys(groups).length;
    if (ringAvg < 0.12) return glared ? fail('glare') : processAuto(src, Gs, sc, bright, exam, cfg, onStage, fail);
    const io = L.id.length ? snap(N, L.id.flat(), L.rId) : [0, 0];
    // marks are measured on a lightly smoothed copy: photo noise (strong in dim light, once the lighting is evened
    // out) would otherwise add up inside a faint or erased mark and make it look like a real one
    const rd = readAll(box3(N, W, H), W, H, L.qs.map((q, i) => q.opts.map(([x, y]) => [x + off[i][0], y + off[i][1]])), L.id.map(col => col.map(([x, y]) => [x + io[0], y + io[1]])), L.rQ * 0.78, L.rId * 0.72, cfg);
    // glare: a pencil mark under a reflection turns as white as the paper, so a question with glare on its bubbles
    // is never trusted (a filled bubble could read blank). Only a hot spot counts, not a sheet that is evenly bright.
    const glare = glareRows(C, N, L.qs.map((q, i) => q.opts.map(([x, y]) => [x + off[i][0], y + off[i][1]])), L.rQ);
    const nGlare = glare.filter(Boolean).length;
    if (nGlare > Math.max(3, exam.numQ * 0.25)) return fail('glare', { glare: nGlare });
    const answers = rd.answers.map((a, i) => glare[i] ? { ...a, st: 'uncertain', cand: a.det != null ? [a.det] : a.cand || [], c: Math.min(a.c, 0.5), why: 'glare', o: off[i] } : { ...a, o: off[i] });
    const id = rd.id ? { ...rd.id, o: io } : { roll: '', state: 'none' };
    const empty = rd.cal.baseAll, full = rd.cal.full;
    onStage('Grading', 0.9); await tick();
    return { ok: true, N, w: W, h: H, answers, id, meta: { mode: 'sheet', sheet: sheet.ok ? { format: sheet.format, match: !otherExam } : { present: !!sheet.present }, otherExam: otherExam || undefined, glare: nGlare || undefined, rotation, sharpness: r3(sharp), brightness: Math.round(bright), paperLevel: Math.round(paperLevel), empty: r3(empty), full: r3(full), ring: r3(ringAvg), size: [src.width, src.height] } };
  }

  // Live camera check on a small frame (~640 px): is a readable sheet in view, and if not, what should the user do?
  // `code` is machine-readable (the capture gate and tests use it), `msg` is the hint shown on screen,
  // `kind` says whether the four corner squares were found ('markers') or only the page outline ('page').
  function quickCheck(frame, cfg) {
    const small = scaleCanvas(frame, 640), G = gray(small), bright = mean(Array.from(G.g.filter((_, i) => i % 11 === 0)));
    const res = (code, msg, extra) => ({ ok: code === 'ok', code, msg, ...extra });
    if (bright < 45) return res('dark', 'Too dark — move to better light');
    const f = findPaper(G);
    if (f.error === 'multiple') return res('multiple', 'More than one sheet in view');
    let pts, kind;
    if (f.error) {
      const q = findSheetQuad(G);
      if (!q || q.frac < 0.25) return res(f.error === 'partial' ? 'partial' : 'notfound', f.error === 'partial' ? 'Move the whole sheet into the frame' : 'Point at the answer sheet');
      pts = q.q.map(([cx, cy]) => ({ cx, cy })); kind = 'page';
    } else {
      pts = f.pts; kind = 'markers';
      // strongly slanted (opposite sides very different in length): holding the phone flat fixes size too, so say that first
      const o = orderPts(pts), s = [0, 1, 2, 3].map(i => dist(o[i], o[(i + 1) % 4]));
      if (Math.max(s[0], s[2]) / Math.min(s[0], s[2]) > 1.45 || Math.max(s[1], s[3]) / Math.min(s[1], s[3]) > 1.45) return res('tilt', 'Hold the phone flat above the sheet', { pts, kind, w: G.w, h: G.h });
      const frac = f.area / (G.w * G.h);
      if (frac < 0.22) return res('small', 'Move closer', { pts, kind, w: G.w, h: G.h });
      const m = Math.min(G.w, G.h) * 0.03;
      if (pts.some(p => p.cx < m || p.cy < m || p.cx > G.w - m || p.cy > G.h - m)) return res('far', 'Move farther away', { pts, kind, w: G.w, h: G.h });
    }
    const at = { pts, kind, w: G.w, h: G.h };
    const xs = pts.map(p => p.cx), ys = pts.map(p => p.cy);
    const box = [Math.max(0, Math.floor(Math.min(...xs))), Math.max(0, Math.floor(Math.min(...ys))), Math.min(G.w, Math.ceil(Math.max(...xs))), Math.min(G.h, Math.ceil(Math.max(...ys)))];
    if (glareShare(G, box) > 0.01) return res('glare', 'Glare on the sheet — tilt the phone a little', at);
    if (sharpness(G, box) < cfg.minSharp * 0.9) return res('blurry', 'Hold steady — image is blurry', at);
    return res('ok', 'Hold steady…', at);
  }

  /* ---------- automatic capture ----------
     Fires once a readable sheet has stayed still: every corner within `drift` (share of the frame diagonal) of where
     it was when the hold began, for at least `holdMs` and `minChecks` checks in a row. After a capture it waits until
     the sheet leaves the view or clearly moves, so the same sheet is never taken twice. Pure logic, no camera. */
  function captureGate(opts = {}) {
    const o = { holdMs: 700, minChecks: 3, drift: 0.012, rearm: 0.15, ...opts };
    let ref = null, since = 0, n = 0, armed = true, last = null;
    const span = (a, b, r) => Math.max(...a.map((p, i) => Math.hypot(p.cx - b[i].cx, p.cy - b[i].cy))) / Math.hypot(r.w, r.h);
    const same = (a, b) => a && b && a.length === b.length;
    return {
      update(r, t) {
        if (!r || !r.pts) { ref = null; n = 0; if (!armed) armed = true; return { state: 'search', progress: 0, fire: false }; }
        const pts = orderPts(r.pts);
        if (!armed && same(last, pts) && span(pts, last, r) > o.rearm) armed = true;
        if (!r.ok) { ref = null; n = 0; return { state: 'adjust', progress: 0, fire: false }; }
        if (!armed) return { state: 'wait', progress: 0, fire: false };
        if (!ref || span(pts, ref, r) > o.drift) { ref = pts; since = t; n = 1; } else n++;
        const progress = Math.min(1, (t - since) / o.holdMs), fire = n >= o.minChecks && t - since >= o.holdMs;
        if (fire) { armed = false; last = pts; ref = null; n = 0; }
        return { state: fire ? 'fire' : 'hold', progress: fire ? 1 : progress, fire };
      },
      // after a manual capture: same "wait for the next sheet" rule
      disarm(r) { armed = false; last = r?.pts ? orderPts(r.pts) : last; ref = null; n = 0; },
      get armed() { return armed; },
    };
  }

  /* ---------- auto mode: any printed bubble sheet, no corner squares needed ---------- */
  function otsu(g) {
    const hist = new Float64Array(256); for (let i = 0; i < g.length; i += 2) hist[g[i]]++;
    let total = 0, sum = 0; for (let t = 0; t < 256; t++) { total += hist[t]; sum += t * hist[t]; }
    let sB = 0, wB = 0, best = 0, th = 128;
    for (let t = 0; t < 256; t++) { wB += hist[t]; if (!wB) continue; const wF = total - wB; if (!wF) break; sB += t * hist[t]; const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) * (mB - mF); if (v > best) { best = v; th = t; } }
    return th;
  }
  // the paper = largest bright region; its corners = extreme points along the diagonals
  function findSheetQuad(G) {
    const { g, w, h } = G, t = otsu(g), seen = new Uint8Array(w * h), stack = new Int32Array(w * h);
    const bright = i => g[i] > t;
    let best = null;
    for (let i = 0; i < w * h; i++) {
      if (seen[i] || !bright(i)) continue;
      let sp = 0; stack[sp++] = i; seen[i] = 1; let n = 0;
      let tl = [0, 0, 1e9], br = [0, 0, -1e9], tr = [0, 0, -1e9], bl = [0, 0, 1e9];
      while (sp) {
        const p = stack[--sp], x = p % w, y = (p - x) / w; n++;
        const a = x + y, d = x - y;
        if (a < tl[2]) tl = [x, y, a]; if (a > br[2]) br = [x, y, a]; if (d > tr[2]) tr = [x, y, d]; if (d < bl[2]) bl = [x, y, d];
        if (x > 0 && !seen[p - 1] && bright(p - 1)) { seen[p - 1] = 1; stack[sp++] = p - 1; }
        if (x < w - 1 && !seen[p + 1] && bright(p + 1)) { seen[p + 1] = 1; stack[sp++] = p + 1; }
        if (y > 0 && !seen[p - w] && bright(p - w)) { seen[p - w] = 1; stack[sp++] = p - w; }
        if (y < h - 1 && !seen[p + w] && bright(p + w)) { seen[p + w] = 1; stack[sp++] = p + w; }
      }
      if (!best || n > best.n) best = { n, c: [tl, tr, br, bl] };
    }
    if (!best || best.n < w * h * 0.12) return null;
    const q = best.c.map(p => [p[0] + .5, p[1] + .5]);
    let area = 0; for (let i = 0; i < 4; i++) { const a = q[i], b = q[(i + 1) % 4]; area += a[0] * b[1] - b[0] * a[1]; } area = Math.abs(area) / 2;
    if (best.n > area * 1.2 || best.n < area * 0.5) return null;
    return { q, area, frac: area / (w * h) };
  }
  function labelComps(B, w, h) {
    const lab = new Int32Array(w * h), stack = new Int32Array(w * h), out = []; let id = 0;
    for (let i = 0; i < w * h; i++) {
      if (!B[i] || lab[i]) continue; id++;
      let sp = 0; stack[sp++] = i; lab[i] = id; let n = 0, minx = w, maxx = 0, miny = h, maxy = 0;
      while (sp) {
        const p = stack[--sp], x = p % w, y = (p - x) / w; n++;
        if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
        if (x > 0 && B[p - 1] && !lab[p - 1]) { lab[p - 1] = id; stack[sp++] = p - 1; }
        if (x < w - 1 && B[p + 1] && !lab[p + 1]) { lab[p + 1] = id; stack[sp++] = p + 1; }
        if (y > 0 && B[p - w] && !lab[p - w]) { lab[p - w] = id; stack[sp++] = p - w; }
        if (y < h - 1 && B[p + w] && !lab[p + w]) { lab[p + w] = id; stack[sp++] = p + w; }
      }
      out.push({ id, n, minx, maxx, miny, maxy });
    }
    return { lab, out };
  }
  // circles: printed rings (with or without a letter inside) or filled discs, all about the same size.
  // A shape counts as round when its outer edge is the same distance from the centre in every direction.
  // ink maps: the page is already evened out, so "darker than the paper" works for faint grey print too
  // erase printed table lines (long, thin, straight) so circles touching them stay separate.
  // Thick ink such as filled bubbles is kept: a run only counts as a line if there is little ink just above/below it.
  function removeLines(B, w, h) {
    const L = Math.max(28, Math.round(w * 0.024)), T = 3, kill = new Uint8Array(w * h);
    for (let y = T; y < h - T; y++) { let x = 0; while (x < w) { if (!B[y * w + x]) { x++; continue; } let e = x; while (e < w && B[y * w + e]) e++;
      if (e - x >= L) { let side = 0; for (let k = x; k < e; k++) side += B[(y - T) * w + k] + B[(y + T) * w + k]; if (side < (e - x) * 0.6) for (let k = x; k < e; k++) kill[y * w + k] = 1; } x = e; } }
    for (let x = T; x < w - T; x++) { let y = 0; while (y < h) { if (!B[y * w + x]) { y++; continue; } let e = y; while (e < h && B[e * w + x]) e++;
      if (e - y >= L) { let side = 0; for (let k = y; k < e; k++) side += B[k * w + x - T] + B[k * w + x + T]; if (side < (e - y) * 0.6) for (let k = y; k < e; k++) kill[k * w + x] = 1; } y = e; } }
    for (let i = 0; i < w * h; i++) if (kill[i]) B[i] = 0;
    return B;
  }
  function inkMap(N, w, h, mode) { return removeLines(rawInk(N, w, h, mode), w, h); }
  function rawInk(N, w, h, mode) {
    if (mode === 'a80') return binarize({ g: N, w, h }, 0.8);
    const T = mode === 'g170' ? 170 : 208, B = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) B[i] = N[i] < T ? 1 : 0;
    if (mode === 'g208d') { // bridge 1-pixel breaks in thin circles
      const O = new Uint8Array(w * h);
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; O[i] = B[i] | B[i - 1] | B[i + 1] | B[i - w] | B[i + w]; }
      return O;
    }
    return B;
  }
  // Finding circles is the slow part, and turning the photo does not move them: find them once per ink map on the
  // upright image (memo) and turn the coordinates for each orientation that is tried.
  function turnedBubbles(memo, N, w, h, mode, rot) {
    const get = m => (memo[m] = memo[m] || circleCands(N, w, h, m, true));
    const tw = rot === 90 || rot === 270 ? h : w, minS = Math.max(7, tw * 0.0055), maxS = tw * 0.08;
    const turn = list => list.map(b => {
      const [x, y] = rot === 180 ? [w - 1 - b.x, h - 1 - b.y] : rot === 90 ? [h - 1 - b.y, b.x] : rot === 270 ? [b.y, w - 1 - b.x] : [b.x, b.y];
      const [bw, bh] = rot === 90 || rot === 270 ? [b.bh, b.bw] : [b.bw, b.bh];
      return { x, y, d: b.d, bw, bh, filled: b.filled };
    }).filter(b => b.bw >= minS && b.bh >= minS && b.bw <= maxS && b.bh <= maxS);
    let c;
    if (mode === 'union') { c = turn(get('g208')); for (const b of turn(get('a80'))) if (!c.some(a => Math.abs(a.x - b.x) < a.d * 0.4 && Math.abs(a.y - b.y) < a.d * 0.4)) c.push(b); }
    else c = turn(get(mode));
    return sizeModes(c);
  }
  function findBubbles(N, w, h, mode = 'g208') {
    let c;
    if (mode === 'union') {
      // two ink maps see different bubbles (printed digits/letters inside rings confuse each one differently): combine them
      c = circleCands(N, w, h, 'g208');
      for (const b of circleCands(N, w, h, 'a80')) if (!c.some(a => Math.abs(a.x - b.x) < a.d * 0.4 && Math.abs(a.y - b.y) < a.d * 0.4)) c.push(b);
    } else c = circleCands(N, w, h, mode);
    return sizeModes(c);
  }
  function circleCands(N, w, h, mode, anyTurn) {
    const B = inkMap(N, w, h, mode), { lab, out } = labelComps(B, w, h);
    // anyTurn: size limits loose enough for the image turned either way (filterSize() applies the exact ones later)
    const minS = Math.max(7, (anyTurn ? Math.min(w, h) : w) * 0.0055), maxS = (anyTurn ? Math.max(w, h) : w) * 0.08, c = [];
    const SEC = 16, maxR = new Float32Array(SEC);
    for (const o of out) {
      const bw = o.maxx - o.minx + 1, bh = o.maxy - o.miny + 1;
      if (bw < minS || bh < minS || bw > maxS || bh > maxS) continue;
      const ar = bw / bh; if (ar < 0.7 || ar > 1.43) continue;
      const fill = o.n / (bw * bh); if (fill < 0.1 || fill > 0.9) continue;
      const cx = (o.minx + o.maxx) / 2, cy = (o.miny + o.maxy) / 2;
      maxR.fill(0);
      for (let y = o.miny; y <= o.maxy; y++) for (let x = o.minx; x <= o.maxx; x++) {
        if (lab[y * w + x] !== o.id) continue;
        const dx = x - cx, dy = y - cy, r = Math.hypot(dx, dy); if (r < 1) continue;
        const k = Math.min(SEC - 1, Math.floor((Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI) * SEC)); if (r > maxR[k]) maxR[k] = r;
      }
      let n = 0, m = 0, q = 0; for (let k = 0; k < SEC; k++) if (maxR[k] > 0) { n++; m += maxR[k]; q += maxR[k] * maxR[k]; }
      if (n < SEC - 2) continue;
      m /= n; const sd = Math.sqrt(Math.max(0, q / n - m * m));
      if (sd / m > 0.1) continue;
      c.push({ x: cx, y: cy, d: (bw + bh) / 2, bw, bh, filled: fill > 0.55 });
    }
    return c;
  }
  function sizeModes(c) {
    if (c.length < 8) return null;
    // sheets often mix bubble sizes (answers vs. roll / registration grids): find each size group
    const modes = []; let rest = c.slice();
    for (let m = 0; m < 3 && rest.length >= 8; m++) {
      const ds = rest.map(b => b.d).sort((a, b) => a - b); let best = 0, d0 = ds[0];
      for (let i = 0, j = 0; i < ds.length; i++) { while (ds[j] < ds[i] * 0.87) j++; let k = i; while (k < ds.length && ds[k] <= ds[i] * 1.13) k++; if (k - j > best) { best = k - j; d0 = ds[i]; } }
      if (best < 8) break;
      // filled marks usually spill over the circle, so they are allowed to be larger
      modes.push({ d: d0, bubs: c.filter(b => Math.abs(b.d - d0) < d0 * 0.28 || (b.filled && b.d > d0 * 0.8 && b.d < d0 * 1.75)) });
      rest = rest.filter(b => Math.abs(b.d - d0) >= d0 * 0.2);
    }
    return modes.length ? { bubs: modes[0].bubs, d: modes[0].d, modes, all: c } : null;
  }
  // Normalised cross-correlation between the image of a known bubble row and the same strip one step away.
  // Rows of printed rings match well (even when some bubbles are filled); blank paper, borders and text do not.
  // How much a row looks like a row of bubbles: ring outlines darker than the clean paper between bubbles.
  // Header text and ruled lines darken the gaps as well, so they score low even when their outline correlates.
  function rowRings(img, back, pts, r) {
    const { N, w, h } = img, at = p => back(p);
    let ring = 0, gap = 0;
    for (const [x, y] of pts) { const [ix, iy] = at([x, y]); ring += Math.max(...[0.85, 1, 1.15].map(k => ringDark(N, ix, iy, r * k, w, h))); }
    for (let o = 1; o < pts.length; o++) { const [ix, iy] = at([(pts[o - 1][0] + pts[o][0]) / 2, (pts[o - 1][1] + pts[o][1]) / 2]); gap += discDark(N, ix, iy, r * 0.3, w, h); }
    return ring / pts.length - gap / Math.max(1, pts.length - 1);
  }
  function rowMatch(img, back, pts, ox, py, r, unit, win) {
    const { N, w, h } = img, y0 = pts[0][1], x0 = pts[0][0] - r * 1.4, x1 = pts[pts.length - 1][0] + r * 1.4, hh = r * 1.4;
    const ex = back([1, 0]), ey = back([0, 1]);   // image-space steps for one unit along the row and down it
    const inner = (r * 0.72) ** 2, st = Math.max(1, Math.round(r / 5));   // skip the inside of each bubble: that is exactly where rows differ (filled or not)
    const U = [], V = [];
    for (let v = -hh; v <= hh; v += st) for (let u = x0; u <= x1; u += st) { if (!pts.some(([px]) => (u - px) ** 2 + v * v < inner)) { U.push(u); V.push(v); } }
    const n = U.length; if (n < 20) return null;
    const sample = (du, vy, out) => {   // pixels of the strip whose centre line is at vy, shifted du along the row
      const [bx, by] = back([du, vy]);
      for (let k = 0; k < n; k++) { const xi = Math.round(bx + U[k] * ex[0] + V[k] * ey[0]), yi = Math.round(by + U[k] * ex[1] + V[k] * ey[1]); if (xi < 0 || yi < 0 || xi >= w || yi >= h) return false; out[k] = N[yi * w + xi]; }
      return true;
    };
    const A = new Float32Array(n), B = new Float32Array(n);
    if (!sample(0, y0, A)) return null;
    let ma = 0; for (let k = 0; k < n; k++) ma += A[k]; ma /= n;
    let va = 0; for (let k = 0; k < n; k++) { A[k] -= ma; va += A[k] * A[k]; } if (va < n * 25) return null;
    const ncc = (dx, dy) => {
      if (!sample(ox + dx, py + dy, B)) return -1;
      let sb = 0, sbb = 0, sab = 0; for (let k = 0; k < n; k++) { const b = B[k]; sb += b; sbb += b * b; sab += A[k] * b; }
      const vb = sbb - sb * sb / n; return vb < n * 25 ? -1 : sab / Math.sqrt(va * vb);
    };
    // win: search only around a position predicted from the neighbouring rows
    const R = win ? win.R : Math.max(2, Math.round(unit * 0.22)), RY = win ? win.RY : Math.max(2, Math.round(r * 0.8)), cx = win ? win.dx : 0, cy = win ? win.dy : 0;
    // coarse grid, then climb pixel by pixel to the best spot
    let best = { ncc: -1, dx: 0, dy: 0 }; const cs = win ? 1 : Math.max(2, Math.round(r / 4));
    for (let dy = cy - RY; dy <= cy + RY; dy += cs) for (let dx = cx - R; dx <= cx + R; dx += cs) { const c = ncc(dx, dy); if (c > best.ncc) best = { ncc: c, dx, dy }; }
    for (let moved = true, k = 0; moved && k < 12; k++) {
      moved = false;
      for (const [ddx, ddy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1], [-1, 1], [1, -1]]) { const c = ncc(best.dx + ddx, best.dy + ddy); if (c > best.ncc) { best = { ncc: c, dx: best.dx + ddx, dy: best.dy + ddy }; moved = true; } }
    }
    return best.ncc > -1 ? best : null;
  }
  function buildGrid(bubs0, d, no, D, numQ, order, img) {
    // 1. undo any remaining tilt: the typical direction from a bubble to its right-hand neighbour
    const ang = [];
    for (const a of bubs0) { let bd = 1e9, bb = null; for (const b of bubs0) { const dx = b.x - a.x, dy = b.y - a.y; if (dx > d * 0.7 && Math.abs(dy) < dx * 0.6) { const dd = dx * dx + dy * dy; if (dd < bd) { bd = dd; bb = b; } } } if (bb && bd < (d * 3.5) ** 2) ang.push(Math.atan2(bb.y - a.y, bb.x - a.x)); }
    let th = ang.length >= 5 ? pctile(ang, 0.5) : 0; if (Math.abs(th) > 0.35) th = 0;
    const ct = Math.cos(th), st = Math.sin(th);
    const bubs = bubs0.map(b => ({ x: b.x * ct + b.y * st, y: -b.x * st + b.y * ct }));
    const back = ([u, v]) => [u * ct - v * st, u * st + v * ct];
    // 2. rows, then groups of evenly spaced bubbles within a row
    const s = bubs.slice().sort((a, b) => a.y - b.y), rows = [];
    for (const b of s) { const r = rows[rows.length - 1]; if (r && Math.abs(b.y - r.y) < d * 0.45) { r.items.push(b); r.y += (b.y - r.y) / r.items.length; } else rows.push({ y: b.y, items: [b] }); }
    const gaps = [];
    rows.forEach(r => { r.items.sort((a, b) => a.x - b.x); for (let i = 1; i < r.items.length; i++) { const g = r.items[i].x - r.items[i - 1].x; if (g > d * 0.85 && g < d * 3.2) gaps.push(g); } });
    if (gaps.length < 6) return null;
    const unit = pctile(gaps, 0.3), groups = [];
    const even = g => { for (let i = 1; i < g.length; i++) { const x = g[i].x - g[i - 1].x; if (x < unit * 0.72 || x > unit * 1.38) return false; } return true; };
    rows.forEach(r => {
      const rg = []; let cur = [r.items[0]];
      for (let i = 1; i < r.items.length; i++) { const g = r.items[i].x - cur[cur.length - 1].x; if (g < d * 0.6) continue; if (g > unit * 1.5) { rg.push(cur); cur = []; } cur.push(r.items[i]); }
      rg.push(cur);
      // a group that carries on, a missed bubble later, into more evenly spaced bubbles is a piece of a longer row
      // (a roll or registration digit grid), not a row of answer options
      rg.forEach((g, i) => { for (const n of [rg[i - 1], rg[i + 1]]) if (n && n.length >= 2 && even(n) && Math.abs(n === rg[i - 1] ? g[0].x - n[n.length - 1].x : n[0].x - g[g.length - 1].x) < unit * 2.5) g.frag = true; });
      groups.push(...rg);
    });
    if (!no) { const cnt = {}; groups.forEach(g => { if (g.length >= 2 && g.length <= 6 && even(g)) cnt[g.length] = (cnt[g.length] || 0) + 1; }); const top = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0]; if (!top) return null; no = +top[0]; }
    // 3. blocks = columns of questions; a column may drift sideways a little from row to row (perspective)
    // a row added at a column's edge must sit one step from its neighbour: the image match can slide onto header
    // text or a table border just above or below the column
    // the print drifts only a few pixels from one row to the next, so a row added at a column's end is searched for close to where
    // the step puts it; a wider search can lock onto header text or a table border just beyond the column
    const near0 = { dx: 0, dy: 0, R: Math.max(3, Math.round(d * 0.3)), RY: Math.max(3, Math.round(d * 0.3)) };
    const rowOk = (row, ref, step) => { const g = Math.abs(row.y - ref.y) / step; return g >= 0.8 && g <= 1.25; };
    const mkBlocks = len => {
      const blocks = [];
      const full = groups.filter(g => g.length === len && even(g) && !g.frag).map(g => ({ y: mean(g.map(t => t.y)), pts: g.map(t => [t.x, t.y]) })).sort((a, b) => a.y - b.y);
      for (const r of full) {
        let bl = null, bd = 1e9;
        for (const b of blocks) { const last = b.rows[b.rows.length - 1], dx = Math.abs(last.pts[0][0] - r.pts[0][0]); if (dx < unit * 0.6 && dx < bd) { bd = dx; bl = b; } }
        if (!bl) blocks.push(bl = { rows: [] });
        bl.rows.push(r);
      }
      const near = (b, y) => b.rows.reduce((a, r) => Math.abs(r.y - y) < Math.abs(a.y - y) ? r : a, b.rows[0]);
      const steps = () => blocks.forEach(b => { const ys = b.rows.map(r => r.y); b.step = ys.length > 1 ? pctile(ys.slice(1).map((y, i) => y - ys[i]), 0.5) : d * 2; });
      steps();
      // a curled or bent page can split one column into pieces: join pieces that line up vertically
      const gstep = pctile(blocks.filter(b => b.rows.length > 2).map(b => b.step), 0.5) || d * 2;
      for (let merged = true; merged;) {
        merged = false;
        blocks.sort((a, b) => a.rows[0].y - b.rows[0].y);
        for (const A of blocks) for (const B of blocks) {
          if (A === B || merged) continue;
          const a = A.rows[A.rows.length - 1], b = B.rows[0], dy = b.y - a.y;
          if (dy > d * 0.5 && dy < gstep * 3.6 && Math.abs(a.pts[0][0] - b.pts[0][0]) < unit * 0.9) { A.rows.push(...B.rows); blocks.splice(blocks.indexOf(B), 1); merged = true; }
        }
      }
      steps();
      // rows where some bubbles were missed (heavy, messy or merged marks): rebuild from the neighbouring row
      for (const g of groups) {
        if (g.length >= len && even(g)) continue; const gy = mean(g.map(t => t.y));
        for (const b of blocks) {
          if (gy < b.rows[0].y - b.step * 1.3 || gy > b.rows[b.rows.length - 1].y + b.step * 1.3) continue;
          const ref = near(b, gy), optX = ref.pts.map(p => p[0]);
          if (!g.some(t => Math.min(...optX.map(x => Math.abs(x - t.x))) < unit * 0.4)) continue;
          if (b.rows.some(r => Math.abs(r.y - gy) < d * 0.5)) break;
          b.rows.push({ y: gy, pts: optX.map(x => { const hit = g.find(t => Math.abs(t.x - x) < unit * 0.4); return hit ? [hit.x, hit.y] : [x, gy]; }) });
          b.rows.sort((p, q) => p.y - q.y); break;
        }
      }
      // whole rows that were missed: fill gaps of two or three steps by interpolating
      steps();
      for (const b of blocks) {
        if (b.rows.length < 3) continue;
        const add = [];
        for (let i = 1; i < b.rows.length; i++) {
          const a = b.rows[i - 1], c = b.rows[i], k = Math.round((c.y - a.y) / b.step);
          if (k >= 2 && k <= 3 && Math.abs((c.y - a.y) / k - b.step) < b.step * 0.2)
            for (let j = 1; j < k; j++) { const t = j / k; add.push({ y: a.y + (c.y - a.y) * t, pts: a.pts.map((p, o) => [p[0] + (c.pts[o][0] - p[0]) * t, p[1] + (c.pts[o][1] - p[1]) * t]) }); }
        }
        if (add.length) { b.rows.push(...add); b.rows.sort((p, q) => p.y - q.y); }
      }
      // edge rows: look above the first row and below the last for bubbles in the same option columns.
      // Solidly filled bubbles are not found as circles, so a run of answered rows at the end of a column
      // is recognised from the image itself (probe: an empty ring or a filled disc at that spot).
      for (const b of blocks) {
        if (b.rows.length < 3) continue;
        for (const dir of [-1, 1]) for (let k = 1; k <= 6; k++) {
          const ref = dir < 0 ? b.rows[0] : b.rows[b.rows.length - 1], py = ref.y + dir * b.step;
          const hits = ref.pts.map(([x]) => bubs.find(t => Math.abs(t.y - py) < b.step * 0.35 && Math.abs(t.x - x) < unit * 0.35));
          const nHit = hits.filter(Boolean).length;
          let row;
          if (nHit >= Math.max(2, Math.ceil(len * 0.75))) {
            const hy = pctile(hits.filter(Boolean).map(t => t.y), 0.5);
            row = { y: hy, pts: ref.pts.map(([x], o) => hits[o] ? [hits[o].x, hits[o].y] : [x, hy]) };
          } else {
            // too few circles found: does the photo here look like the row we already have (same rings, maybe filled)?
            const edge = dir < 0 ? b.rows : b.rows.slice().reverse(), tmpl = edge.find(q => !q.matched) || ref;   // a row really seen, not one inferred
            const m = img && rowMatch(img, back, tmpl.pts, ref.pts[0][0] - tmpl.pts[0][0], py, d / 2, unit, near0);
            if (!m || m.ncc < 0.45) break;
            row = { y: py + m.dy, pts: ref.pts.map(([x, y]) => [x + m.dx, y - ref.y + py + m.dy]), matched: r3(m.ncc) };
            // a very close match is a bubble row; a middling one must also show rings with paper between them (not header text)
            if (m.ncc < 0.7 && rowRings(img, back, row.pts, d / 2) < rowRings(img, back, tmpl.pts, d / 2) * 0.5) break;
            if (!rowOk(row, ref, b.step)) break;
          }
          if (dir < 0) b.rows.unshift(row); else b.rows.push(row);
        }
      }
      // columns printed side by side span the same lines: grow a short column toward its neighbours' first and last rows,
      // one row at a time, while the photo there still looks like a row of this column (a column that really is
      // shorter, like the last one on a sheet, has blank paper below it and stops)
      if (img && len === no) for (const A of blocks) {
        if (A.rows.length < 3) continue;
        for (const B of blocks) {
          if (A === B || B.rows.length < 3 || Math.abs(B.rows[0].pts[0][0] - A.rows[0].pts[0][0]) < unit * 2) continue;
          if (!(A.rows[0].y < B.rows[B.rows.length - 1].y && B.rows[0].y < A.rows[A.rows.length - 1].y)) continue;
          for (const dir of [-1, 1]) for (let k = 0; k < 40; k++) {
            const ref = dir < 0 ? A.rows[0] : A.rows[A.rows.length - 1], py = ref.y + dir * A.step, lim = dir < 0 ? B.rows[0].y : B.rows[B.rows.length - 1].y;
            if (dir < 0 ? py < lim - A.step * 0.5 : py > lim + A.step * 0.5) break;
            const edge = dir < 0 ? A.rows : A.rows.slice().reverse(), tmpl = edge.find(q => !q.matched) || ref;
            const m = rowMatch(img, back, tmpl.pts, ref.pts[0][0] - tmpl.pts[0][0], py, d / 2, unit, near0);
            if (tracing()) trace('grow', dir, k, Math.round(py), m && [r3(m.ncc), m.dx, m.dy], m && r3(rowRings(img, back, ref.pts.map(([x, y]) => [x + m.dx, y - ref.y + py + m.dy]), d / 2)), r3(rowRings(img, back, tmpl.pts, d / 2)));
            if (!m || m.ncc < 0.3) break;
            const row = { y: py + m.dy, pts: ref.pts.map(([x, y]) => [x + m.dx, y - ref.y + py + m.dy]), matched: r3(m.ncc) };
            if (rowRings(img, back, row.pts, d / 2) < rowRings(img, back, tmpl.pts, d / 2) * 0.5 || !rowOk(row, ref, A.step)) break;
            if (dir < 0) A.rows.unshift(row); else A.rows.push(row);
          }
        }
      }
      blocks.forEach(b => { b.x0 = pctile(b.rows.map(r => r.pts[0][0]), 0.5); });
      return blocks.filter(b => b.rows.length >= 2);
    };
    let qBlocks = mkBlocks(no), id = null;
    if (D) {
      const pool = D === no ? qBlocks : mkBlocks(D);
      const cands = pool.filter(b => b.rows.length === 10).sort((a, b) => a.rows[0].y - b.rows[0].y);
      const total = qBlocks.reduce((t, b) => t + b.rows.length, 0);
      const cand = cands.find(b => D !== no || total - 10 >= numQ);
      if (cand) { id = Array.from({ length: D }, (_, j) => cand.rows.map(r => back(r.pts[j]))); if (D === no) qBlocks = qBlocks.filter(b => b !== cand); }
    }
    let qs; const suspect = new Set(), lost = [];
    // A whole column can go unseen when most of its bubbles are filled (a filled bubble is not found as a circle).
    // Then the next column would be read as questions 1, 2, 3 ... Look for bubbles left over on a column's lines,
    // to its left: if they sit at the option spacing, rebuild that column on those lines and check every row
    // against the photo; if it cannot be rebuilt, everything from there on goes to review.
    if (img && order !== 'rows' && qBlocks.length) {
      qBlocks.sort((a, b) => a.x0 - b.x0);
      const taken = qBlocks.flatMap(b => b.rows.flatMap(r => r.pts)).concat(id ? id.flat().map(p => { const [x, y] = p, c = Math.cos(th), sn = Math.sin(th); return [x * c + y * sn, -x * sn + y * c]; }) : []);
      const free = bubs.filter(t => !taken.some(([x, y]) => Math.abs(x - t.x) < unit * 0.45 && Math.abs(y - t.y) < d * 0.6));
      for (let i = 0; i < qBlocks.length; i++) {
        const B = qBlocks[i], prevEnd = i ? Math.max(...qBlocks[i - 1].rows.map(r => r.pts[r.pts.length - 1][0])) + unit : -Infinity;
        const lo = [];
        for (const r of B.rows) for (const t of free) if (Math.abs(t.y - r.y) < d * 0.45 && t.x < r.pts[0][0] - unit * 1.6 && t.x > prevEnd) lo.push({ off: t.x - r.pts[0][0], r });
        const nRows = new Set(lo.map(o => o.r)).size;
        if (tracing()) trace('hidden?', { block: i, rows: B.rows.length, x0: Math.round(B.x0), leftovers: lo.length, nRows, free: free.length, bubs: bubs.length });
        if (nRows < Math.max(3, B.rows.length * 0.3)) continue;
        let best = null;   // where the hidden column starts, relative to B's first option
        for (const { off } of lo) for (let k = 0; k < no; k++) {
          const st = off - k * unit; if (st + (no - 1) * unit > -unit * 1.6) continue;
          const n = lo.filter(o => { const q = (o.off - st) / unit, kk = Math.round(q); return kk >= 0 && kk < no && Math.abs(q - kk) < 0.25; }).length;
          if (!best || n > best.n || (n === best.n && st > best.st)) best = { st, n };
        }
        if (tracing()) trace('hidden best', best, nRows);
        if (!best || best.n < nRows * 0.8) continue;
        const A = { rows: [], step: B.step };
        // a row where most bubbles are filled correlates weakly with an empty one and can lock onto the wrong spot, but the
        // print drifts smoothly from row to row: rows that match well fix the drift, the others are searched again close to it
        const ms = B.rows.map(r => rowMatch(img, back, r.pts, best.st, r.y, d / 2, unit));
        const good = ms.map(m => !!m && m.ncc >= 0.3);
        const trend = i0 => {
          const dirs = [-1, 1].map(dr => { for (let j = i0 + dr; j >= 0 && j < ms.length; j += dr) if (good[j]) return { j, m: ms[j] }; return null; });
          const [lo, hi] = dirs;
          if (lo && hi) { const t = (i0 - lo.j) / (hi.j - lo.j); return { dx: lo.m.dx + (hi.m.dx - lo.m.dx) * t, dy: lo.m.dy + (hi.m.dy - lo.m.dy) * t }; }
          const n = lo || hi; return n ? { dx: n.m.dx, dy: n.m.dy } : null;
        };
        const at = (r, m, sp) => r.pts.map(([x, y], o) => [r.pts[0][0] + best.st + m.dx + o * sp, y + m.dy]);
        const spOf = r => (r.pts[r.pts.length - 1][0] - r.pts[0][0]) / Math.max(1, r.pts.length - 1);
        const ringsGood = ms.map((m, k) => good[k] ? rowRings(img, back, at(B.rows[k], m, spOf(B.rows[k])), d / 2) : null).filter(v => v != null).sort((p, q) => p - q);
        const ringRef = ringsGood.length ? ringsGood[Math.floor(ringsGood.length / 2)] : 0;
        const fixed = ms.map((m, k) => {
          if (good[k]) return m;
          const tr = trend(k); if (!tr) return null;
          const r = B.rows[k], m2 = rowMatch(img, back, r.pts, best.st, r.y, d / 2, unit, { dx: Math.round(tr.dx), dy: Math.round(tr.dy), R: 3, RY: 3 });
          // it must also look like a row of printed rings (outlines darker than the paper between them), as the rows that matched do
          const rg = m2 && rowRings(img, back, at(r, m2, spOf(r)), d / 2);
          if (tracing()) trace('retry', Math.round(r.y), m2 && r3(m2.ncc), rg && r3(rg), r3(ringRef));
          return m2 && m2.ncc >= 0.12 && rg >= ringRef * 0.6 ? m2 : null;
        });
        B.rows.forEach((r, k) => {
          const m = fixed[k], sp = (r.pts[r.pts.length - 1][0] - r.pts[0][0]) / Math.max(1, r.pts.length - 1), ox = best.st;
          if (tracing()) trace('hrow', Math.round(r.y), m && [r3(m.ncc), m.dx, m.dy], good[k] ? '' : 'retry');
          if (m) A.rows.push({ y: r.y + m.dy, pts: r.pts.map(([x, y], o) => [r.pts[0][0] + ox + m.dx + o * sp, y + m.dy]), matched: r3(m.ncc) });
        });
        if (tracing()) trace('hidden rebuilt', A.rows.length, 'of', B.rows.length);
        if (A.rows.length >= B.rows.length * 0.9) { A.x0 = pctile(A.rows.map(r => r.pts[0][0]), 0.5); qBlocks.splice(i, 0, A); i++; }
        else lost.push(B);
      }
    }
    // inside a column every row sits one step below the last; a bigger jump means rows were lost there,
    // a smaller one means a row that isn't real, and either way every question after it is misnumbered
    const irregular = b => { const gs = b.rows.slice(1).map((r, i) => r.y - b.rows[i].y), m = pctile(gs, 0.5); return gs.findIndex(g => g < m * 0.72 || g > m * 1.35) + 1; };
    if (order === 'rows') {
      const all = qBlocks.flatMap(b => b.rows).sort((a, b) => a.y - b.y), lines = [];
      for (const r of all) { const L = lines[lines.length - 1]; if (L && Math.abs(r.y - L.y) < d * 0.6) L.items.push(r); else lines.push({ y: r.y, items: [r] }); }
      qs = lines.flatMap(L => L.items.sort((a, b) => a.pts[0][0] - b.pts[0][0]).map(r => r.pts));
    } else {
      qBlocks.sort((a, b) => a.x0 - b.x0); qs = qBlocks.flatMap(b => b.rows.map(r => r.pts));
      { let at = 0; for (const b of qBlocks) { if (lost.includes(b)) { for (let q = at; q < qs.length; q++) suspect.add(q); break; } at += b.rows.length; } }
      // columns printed side by side hold the same number of rows. If a column is shorter than the one after it,
      // some of its rows were not found, and every question numbered after its end would be read from the wrong place.
      // Printed columns start on the same line, so a column starting lower than a neighbour lost its top rows
      // (its questions are all shifted), and one ending higher than the next lost its bottom rows.
      let at = 0;
      for (const b of qBlocks) { const k = b.rows.length > 2 ? irregular(b) : 0; if (k > 0) { for (let q = at + k; q < qs.length; q++) suspect.add(q); break; } at += b.rows.length; }
      at = 0;
      const overlap = (A, B) => A.rows[0].y < B.rows[B.rows.length - 1].y && B.rows[0].y < A.rows[A.rows.length - 1].y;
      for (let i = 0; i < qBlocks.length; i++) {
        const A = qBlocks[i], tol = A.step * 0.6, nb = [qBlocks[i - 1], qBlocks[i + 1]].filter(B => B && overlap(A, B));
        const next = qBlocks[i + 1];
        const from = next && !overlap(A, next) ? at + A.rows.length   // answer columns side by side always share lines
          : nb.some(B => A.rows[0].y > B.rows[0].y + tol) ? at
          : qBlocks[i + 1] && overlap(A, qBlocks[i + 1]) && A.rows[A.rows.length - 1].y < qBlocks[i + 1].rows[qBlocks[i + 1].rows.length - 1].y - tol ? at + A.rows.length : -1;
        if (from >= 0) for (let q = from; q < qs.length; q++) suspect.add(q);
        at += A.rows.length;
      }
    }
    if (tracing()) trace('gridrows', qBlocks.map(b => b.rows.slice(0, 3).map(r => [Math.round(r.pts[0][0]), Math.round(r.y), r.matched ?? 'f'])));
    if (tracing()) trace('grid', qBlocks.map(b => `x${Math.round(b.x0)} y${Math.round(b.rows[0].y)}-${Math.round(b.rows[b.rows.length - 1].y)} n${b.rows.length} st${Math.round(b.step || 0)}`).join(' | '), 'sus', suspect.size ? Math.min(...suspect) : -1);
    return { qs: qs.map(q => q.map(back)), suspect: [...suspect], id, unit, no, blocks: qBlocks.length, tilt: th, blockRows: qBlocks.map(b => b.rows.map(r => r.pts.map(back))) };
  }
  function rotateImg(N, w, h, rot) {
    const O = new Uint8Array(w * h);
    if (rot === 180) { for (let i = 0; i < w * h; i++) O[i] = N[w * h - 1 - i]; return { N: O, w, h }; }
    const nw = h, nh = w;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = N[y * w + x]; if (rot === 90) O[x * nw + (nw - 1 - y)] = v; else O[(nh - 1 - x) * nw + y] = v; }
    return { N: O, w: nw, h: nh };
  }
  // question numbers are printed just left of each row; if that ink sits on the right, the photo is upside down.
  // Straight box lines that run past every row are ignored, so bordered columns don't confuse it.
  function labelSide(N, w, h, qs, d, unit) {
    const band = Math.max(4, Math.round(unit * 1.15)), gap = d * 0.62, hh = Math.max(3, Math.round(d * 0.8));
    const side = dir => {
      const hist = new Float64Array(band); let rows = 0;
      for (const q of qs) {
        const p = dir < 0 ? q[0] : q[q.length - 1], y0 = Math.round(p[1] - hh / 2);
        if (y0 < 0 || y0 + hh >= h) continue; rows++;
        for (let k = 0; k < band; k++) { const x = Math.round(p[0] + dir * (gap + k)); if (x < 0 || x >= w) continue; let c = 0; for (let y = y0; y < y0 + hh; y++) if (N[y * w + x] < 150) c++; hist[k] += c / hh; }
      }
      let s = 0; for (let k = 0; k < band; k++) { const f = hist[k] / Math.max(1, rows); if (f < 0.55) s += hist[k]; }
      return s / Math.max(1, rows);
    };
    const L = side(-1), R = side(1);
    return { L, R, flip: R > L * 1.6 + 0.3 };
  }
  // Perspective from the bubbles themselves. Rows of bubbles are straight lines, and so are the columns; in a photo
  // taken at an angle each family of lines meets at a vanishing point. Sending both points back to infinity and then
  // turning the rows level and the columns upright undoes the perspective, even when the page edge can't be found
  // (paper held in a hand, lying on other paper). Returns a transform of image points, or null.
  function symEigMin(M) {   // eigenvector of the smallest eigenvalue of a symmetric 3x3 matrix (Jacobi rotations)
    const A = M.map(r => r.slice()), V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let sweep = 0; sweep < 30; sweep++) {
      let off = 0; for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) off += A[i][j] * A[i][j];
      if (off < 1e-20) break;
      for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) {
        if (Math.abs(A[p][q]) < 1e-30) continue;
        const th = (A[q][q] - A[p][p]) / (2 * A[p][q]), t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), sn = t * c;
        for (let k = 0; k < 3; k++) { const akp = A[k][p], akq = A[k][q]; A[k][p] = c * akp - sn * akq; A[k][q] = sn * akp + c * akq; }
        for (let k = 0; k < 3; k++) { const apk = A[p][k], aqk = A[q][k]; A[p][k] = c * apk - sn * aqk; A[q][k] = sn * apk + c * aqk; }
        for (let k = 0; k < 3; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - sn * vkq; V[k][q] = sn * vkp + c * vkq; }
      }
    }
    let m = 0; for (let i = 1; i < 3; i++) if (A[i][i] < A[m][m]) m = i;
    return [V[0][m], V[1][m], V[2][m]];
  }
  function bubblePerspective(cands, d0) {
    const bs = cands.filter(b => b.d > d0 * 0.7 && b.d < d0 * 1.4);
    if (bs.length < 30) return null;
    // normalised coordinates keep the line fits well conditioned
    const mx = mean(bs.map(b => b.x)), my = mean(bs.map(b => b.y)), sc = 1 / Math.max(1, mean(bs.map(b => Math.hypot(b.x - mx, b.y - my))));
    const P = bs.map(b => [(b.x - mx) * sc, (b.y - my) * sc]), R = d0 * sc;
    // nearest neighbour in each of four directions gives the local row and column directions
    const vecs = [];
    P.forEach((a, i) => {
      const best = [null, null, null, null];
      P.forEach((b, j) => { if (i === j) return; const dx = b[0] - a[0], dy = b[1] - a[1], r = Math.hypot(dx, dy); if (r < R * 0.8 || r > R * 3) return;
        const q = Math.round(Math.atan2(dy, dx) / (Math.PI / 2)) & 3; if (!best[q] || r < best[q].r) best[q] = { j, r, ang: Math.atan2(dy, dx) }; });
      for (const n of best) if (n && n.j > i) vecs.push(n.ang);
    });
    if (vecs.length < 40) return null;
    const hist = new Float64Array(180); for (const a of vecs) { const deg = ((a * 180 / Math.PI) % 180 + 180) % 180; for (let k = -3; k <= 3; k++) hist[(Math.round(deg) + k + 180) % 180] += 1 - Math.abs(k) / 4; }
    let pa = 0; for (let k = 1; k < 180; k++) if (hist[k] > hist[pa]) pa = k;
    let pb = -1; for (let k = 0; k < 180; k++) { const sep = Math.min(Math.abs(k - pa), 180 - Math.abs(k - pa)); if (sep < 50) continue; if (pb < 0 || hist[k] > hist[pb]) pb = k; }
    if (pb < 0 || hist[pb] < hist[pa] * 0.2) return null;
    // chains of bubbles along each family, then one straight line per chain
    const family = deg => {
      const th = deg * Math.PI / 180, ux = Math.cos(th), uy = Math.sin(th), next = new Int32Array(P.length).fill(-1), prev = new Int32Array(P.length).fill(-1);
      P.forEach((a, i) => {
        let bj = -1, br = 1e9;
        P.forEach((b, j) => { const dx = b[0] - a[0], dy = b[1] - a[1], along = dx * ux + dy * uy, across = Math.abs(-dx * uy + dy * ux); if (along < R * 0.8 || along > R * 2.6 || across > along * 0.2) return; if (along < br) { br = along; bj = j; } });
        if (bj >= 0 && prev[bj] < 0) { next[i] = bj; prev[bj] = i; }
      });
      const lines = [];
      P.forEach((_, i) => {
        if (prev[i] >= 0) return; const ch = []; for (let k = i; k >= 0 && ch.length < 400; k = next[k]) ch.push(P[k]);
        if (ch.length < 3) return;
        const cx = mean(ch.map(p => p[0])), cy = mean(ch.map(p => p[1]));
        let sxx = 0, sxy = 0, syy = 0; for (const [x, y] of ch) { sxx += (x - cx) ** 2; sxy += (x - cx) * (y - cy); syy += (y - cy) ** 2; }
        const t = 0.5 * Math.atan2(2 * sxy, sxx - syy), nx = -Math.sin(t), ny = Math.cos(t);   // normal of the best line
        const rms = Math.sqrt(ch.reduce((s, [x, y]) => s + ((x - cx) * nx + (y - cy) * ny) ** 2, 0) / ch.length);
        if (rms > R * 0.15) return;
        const span = Math.hypot(ch[0][0] - ch[ch.length - 1][0], ch[0][1] - ch[ch.length - 1][1]);
        lines.push({ l: [nx, ny, -(nx * cx + ny * cy)], w: span * span * ch.length });
      });
      return lines;
    };
    const La = family(pa), Lb = family(pb);
    if (La.length < 4 || Lb.length < 4) return null;
    const vp = L => { const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], W = L.reduce((s, x) => s + x.w, 0); for (const { l, w } of L) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) M[i][j] += l[i] * l[j] * w / W; return symEigMin(M); };
    const Va = vp(La), Vb = vp(Lb);
    let vl = [Va[1] * Vb[2] - Va[2] * Vb[1], Va[2] * Vb[0] - Va[0] * Vb[2], Va[0] * Vb[1] - Va[1] * Vb[0]];   // the vanishing line
    if (Math.abs(vl[2]) < 1e-9) return null;
    vl = vl.map(v => v / vl[2]);
    // the bubbles must all stay well on one side of the vanishing line, and the correction must stay moderate
    const ws = P.map(([x, y]) => vl[0] * x + vl[1] * y + 1);
    if (Math.min(...ws) < 0.5 || Math.max(...ws) > 2) return null;
    const proj = ([x, y]) => { const w = vl[0] * x + vl[1] * y + 1; return [x / w, y / w]; };
    const dirOf = V => { const n = Math.hypot(V[0], V[1]); return [V[0] / n, V[1] / n]; };   // both points lie on the vanishing line, so they go to infinity in these directions
    let da = dirOf(Va), db = dirOf(Vb);
    if (Math.abs(da[0]) < Math.abs(db[0])) [da, db] = [db, da];   // da: the family nearer horizontal
    if (da[0] < 0) da = [-da[0], -da[1]];
    if (db[1] < 0) db = [-db[0], -db[1]];
    const det = da[0] * db[1] - db[0] * da[1]; if (Math.abs(det) < 0.5) return null;   // families less than 30° apart
    const Ai = [[db[1] / det, -db[0] / det], [-da[1] / det, da[0] / det]];   // inverse of [da db]
    const fwd = ([x, y]) => { const [u, v] = proj([(x - mx) * sc, (y - my) * sc]); return [(Ai[0][0] * u + Ai[0][1] * v) / sc, (Ai[1][0] * u + Ai[1][1] * v) / sc]; };
    const inv = ([X, Y]) => { const u = (da[0] * X + db[0] * Y) * sc, v = (da[1] * X + db[1] * Y) * sc, w = 1 - vl[0] * u - vl[1] * v; return [u / w / sc + mx, v / w / sc + my]; };
    return { fwd, inv, bubbles: bs, deg: [pa, pb] };
  }
  // Tries several views of the photo (detected page, whole photo, zoomed on the bubble area),
  // several contrast levels and all four rotations, and keeps the most complete grid.
  async function locateGrid(src, Gs, sc, opts, onStage) {
    const quad = findSheetQuad(Gs), Gf = gray(src), need = opts.numQ || 999, TW = 1400;
    const rectView = (x0, y0, x1, y1) => { const W0 = x1 - x0, H0 = y1 - y0, th = Math.round(TW * H0 / W0); return { TW, TH: th, Hm: [W0 / TW, 0, x0, 0, H0 / th, y0, 0, 0, 1] }; };
    const views = [];
    let box = [0, 0, Gs.w, Gs.h];
    if (quad && quad.frac > 0.18) {
      const q = quad.q.map(([x, y]) => [x * sc, y * sc]), len = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
      const TH = Math.round(TW * clamp((len(q[0], q[3]) + len(q[1], q[2])) / (len(q[0], q[1]) + len(q[3], q[2])), 0.45, 2.4));
      const Hm = homog([[0, 0], [TW, 0], [TW, TH], [0, TH]], q); if (Hm) views.push({ TW, TH, Hm, kind: 'page' });
      const xs = quad.q.map(p => p[0]), ys = quad.q.map(p => p[1]);
      box = [Math.max(0, Math.floor(Math.min(...xs))), Math.max(0, Math.floor(Math.min(...ys))), Math.min(Gs.w, Math.ceil(Math.max(...xs))), Math.min(Gs.h, Math.ceil(Math.max(...ys)))];
    }
    views.push({ ...rectView(0, 0, src.width, src.height), kind: 'photo' });
    const sharp = sharpness(Gs, box);
    let best = null, paperLevel = null, tries = 0;
    // photos arrive upright almost always (phone orientation is already applied), so turning the page needs clear evidence
    // Which way is up: printed Bengali text (মাত্রা) when the sheet has it, else question-number side, else "as photographed"
    const textVote = (R, th) => { const m = matraVotes(R.N, R.w, R.h, th); const n = m.up + m.down; return (n >= 12 && Math.abs(m.score) > 0.3) || (n >= 6 && Math.abs(m.score) >= 0.8) ? m.score : null; /* many votes, or fewer but near-unanimous */ };
    // Every view keeps the photo's way up (page, zoom and straightened views turn it by less than 45°), so when a
    // view's own crop has too little printed text to tell, the text of the whole photo decides.
    let gText = null;
    const photoText = rot => {
      if (!gText) { const v = views.find(x => x.kind === 'photo'), N = flatten(warp(Gf, v.Hm, v.TW, v.TH), v.TW, v.TH); gText = { 0: textVote({ N, w: v.TW, h: v.TH }, 0), 90: textVote(rotateImg(N, v.TW, v.TH, 90), 0) }; }
      const t = gText[rot % 180]; return t == null ? null : rot >= 180 ? -t : t;
    };
    const orient = c => { if (c.text === undefined) { c.text = textVote(c.R, c.grid.tilt); if (c.text == null) c.text = photoText(c.rot); } return c.text; };
    const bad = c => (c.grid.suspect || []).filter(i => i < need).length + (c.text != null && c.text < -0.25 ? need : 0);   // broken columns; or text says this way up is wrong   // questions that would come from a broken column
    const score = c => { const t = Math.min(c.grid.qs.length, need) >= need * 0.8 ? orient(c) : null;
      return (Math.min(c.grid.qs.length, need) - bad(c)) * 10 + (t != null ? t * 60 : (c.side.flip ? 0 : 5) + (c.side.L > c.side.R ? 3 : 0)) - (c.rot ? 12 : 0) + Math.min(c.grid.qs.length, need * 2) * 0.01; };
    // The longest column of answers seen in any attempt on this photo. A grid whose columns are all clearly shorter
    // lost rows at their ends (a bent or shaded edge), and when every column loses the same rows nothing inside the
    // grid looks wrong, yet the next column would be numbered from the wrong question.
    // A length counts once two different views of the photo reach it (one view alone can add a stray row).
    const viewLongest = {};
    let longest = 0;
    const colLen = c => Math.max(0, ...(c.grid.blockRows || []).map(b => b.length));
    const short = c => colLen(c) < longest;
    const seen = c => {
      viewLongest[c.view.kind] = Math.max(viewLongest[c.view.kind] || 0, colLen(c));
      const v = Object.values(viewLongest).sort((a, b) => b - a); longest = v.length > 1 ? v[1] : v[0] - 1;
    };
    const good = c => { if (!c || c.grid.qs.length < need || bad(c) || short(c)) return false; const t = orient(c); return t != null ? t > 0.25 : !c.side.flip && (c.rot === 0 || c.side.R > c.side.L * 1.6); };
    const tryView = async (v, rots) => {
      onStage(v.kind === 'zoom' ? 'Zooming in on the answers' : 'Finding bubbles', 0.45 + Math.min(0.25, tries * 0.03)); await tick();
      const C = warp(Gf, v.Hm, v.TW, v.TH);
      if (paperLevel == null) paperLevel = pctile(Array.from(C.filter((_, i) => i % 97 === 0)), 0.8);
      const N0 = flatten(C, v.TW, v.TH), memo = v.memo = {}, turned = {};
      for (const ratio of ['union', 'g208', 'a80', 'g208d', 'g170']) for (const rot of rots) {
        tries++;
        const found = turnedBubbles(memo, N0, v.TW, v.TH, ratio, rot); if (!found) continue;
        const R = turned[rot] = turned[rot] || (rot ? rotateImg(N0, v.TW, v.TH, rot) : { N: N0, w: v.TW, h: v.TH });
        for (const mode of found.modes) {
          const fb = { bubs: mode.bubs, d: mode.d, modes: found.modes, all: found.all };
          const grid = buildGrid(fb.bubs, fb.d, opts.numOpts, opts.idDigits, need, opts.order, R);
          if (!grid || !grid.qs.length) continue;
          const cand = { rot, R, fb, grid, view: v, side: labelSide(R.N, R.w, R.h, grid.qs, fb.d, grid.unit) };
          if (!(photoText(rot) < -0.25)) seen(cand);   // a reading the wrong way up can merge columns: leave it out
          if (!best || score(cand) > score(best)) best = cand;
          if (good(cand)) return cand;
        }
        await tick();
      }
      return null;
    };
    // share of grid positions that sit on a circle actually seen in the photo (how trustworthy the geometry is)
    // (a filled bubble is no circle to the finder, but it is plainly there, so it counts too)
    const fit = c => {
      if (c.fitv === undefined) {
        const pts = c.grid.qs.slice(0, need).flat(), d = c.fb.d, { N, w, h } = c.R;
        // each grid position must sit on a printed ring (ink all the way round it) or a filled bubble
        const on = ([x, y]) => discDark(N, x, y, d * 0.3, w, h) > 0.6 || Math.max(...[0.9, 1, 1.1].map(k => ringDarkEven(N, x, y, d / 2 * k, w, h))) > 0.2;
        c.fitv = pts.filter(on).length / Math.max(1, pts.length);
      }
      return c.fitv;
    };
    const goods = [];
    for (const v of views) { const g = await tryView(v, [0, 180, 90, 270]); if (g) { goods.push(g); if (fit(g) > 0.8) break; } }
    // photo taken at an angle: straighten the bubble area using the bubbles' own rows and columns, zoom in, read again
    const base = goods[0] || best;
    if (base?.view.memo) {
      const m = base.view.memo, cands = (m.g208 || []).slice();
      for (const b of m.a80 || []) if (!cands.some(a => Math.abs(a.x - b.x) < a.d * 0.4 && Math.abs(a.y - b.y) < a.d * 0.4)) cands.push(b);
      const d0 = base.fb.d, pe = bubblePerspective(cands, d0);
      if (tracing()) trace('perspective', pe && { deg: pe.deg, n: pe.bubbles.length });
      if (pe) {
        // generous margins: bubbles missed at this resolution (often a column's last rows) must still be in view
        const T = pe.bubbles.map(b => pe.fwd([b.x, b.y])), tx = T.map(p => p[0]), ty = T.map(p => p[1]);
        const pad = d0 * 5 + 0.15 * Math.max(Math.max(...tx) - Math.min(...tx), Math.max(...ty) - Math.min(...ty));
        const X0 = Math.min(...tx) - pad, X1 = Math.max(...tx) + pad, Y0 = Math.min(...ty) - pad, Y1 = Math.max(...ty) + pad;
        const TH = Math.round(clamp(TW * (Y1 - Y0) / (X1 - X0), TW * 0.3, TW * 2.2)), out = [[0, 0], [TW, 0], [TW, TH], [0, TH]];
        const srcPts = [[X0, Y0], [X1, Y0], [X1, Y1], [X0, Y1]].map(pe.inv).map(([x, y]) => applyH(base.view.Hm, x, y));
        const Hm = homog(out, srcPts);
        if (Hm) { const g = await tryView({ TW, TH, Hm, kind: 'rect' }, [0, 180, 90, 270]); if (g) goods.unshift(g); }
      }
    }
    if (tracing()) trace('views', goods.map(g => [g.view.kind, g.rot, r3(fit(g)), g.grid.qs.length]));
    // The straightened view is the more trustworthy geometry: a grid from the raw photo can sit on real bubbles yet
    // number them wrongly (a row lost to perspective shifts every answer after it), so a complete grid there wins.
    // and a grid that also holds the columns another one lacks (the answer column on its left, hidden by heavy filling) is the
    // fuller reading of the same sheet: read alone, the column on the right would be taken for questions 1, 2, 3 ...
    // a grid whose longest column is much shorter than another's is made of the wrong pieces (the roll and registration digit
    // grids are 10 rows long, answer columns 25 or more)
    const maxLen = Math.max(0, ...goods.map(colLen));
    const pref = c => fit(c) + (colLen(c) < maxLen * 0.7 ? -20 : 0) + (c.view.kind === 'rect' && fit(c) >= 0.5 ? 10 : 0) + (fit(c) >= 0.5 && goods.some(o => o !== c && c.grid.qs.length >= o.grid.qs.length * 1.5) ? 5 : 0);
    const kept = goods.filter(g => !short(g));   // a longer column may have turned up after this grid was accepted
    if (tracing()) trace('goods', goods.map(g => [g.view.kind, g.rot, r3(fit(g)), g.grid.qs.length, g.grid.qs[0].map(p => p.map(Math.round)), colLen(g)]), 'kept', kept.length);
    if (kept.length) { best = kept.sort((a, b) => pref(b) - pref(a))[0]; findIdGrid(best, opts.idDigits); return { best, sharp, paperLevel: paperLevel ?? 255, quad: !!quad }; }
    if (goods.length && !best) best = goods[0];
    // zoom: crop the photo to where the bubbles are and look again at higher resolution
    if (!good(best) && best) {
      const { R, rot, view: v, fb } = best;
      const allB = fb.modes ? fb.modes.flatMap(m => m.bubs) : fb.bubs, xs = allB.map(b => b.x), ys = allB.map(b => b.y), pad = fb.d * 4;
      const bx0 = Math.max(0, Math.min(...xs) - pad), by0 = Math.max(0, Math.min(...ys) - pad), bx1 = Math.min(R.w, Math.max(...xs) + pad), by1 = Math.min(R.h, Math.max(...ys) + pad);
      const unrot = ([x, y]) => rot === 180 ? [R.w - x, R.h - y] : rot === 90 ? [y, R.w - x] : rot === 270 ? [R.h - y, x] : [x, y];
      const corners = [[bx0, by0], [bx1, by0], [bx1, by1], [bx0, by1]].map(unrot).map(([x, y]) => applyH(v.Hm, x, y));
      const X = corners.map(p => p[0]), Y = corners.map(p => p[1]);
      const x0 = clamp(Math.min(...X), 0, src.width), x1 = clamp(Math.max(...X), 0, src.width), y0 = clamp(Math.min(...Y), 0, src.height), y1 = clamp(Math.max(...Y), 0, src.height);
      if (x1 - x0 > 50 && y1 - y0 > 50 && (x1 - x0) * (y1 - y0) < src.width * src.height * 0.8) { const g = await tryView({ ...rectView(x0, y0, x1, y1), kind: 'zoom' }, rot === 0 || rot === 180 ? [0, 180] : [rot, (rot + 180) % 360]); if (g) best = g; }
    }
    if (best) findIdGrid(best, opts.idDigits);
    // never grade from a cut-short grid, or one the printed text says is the wrong way up
    if (best && need < 999 && (short(best) || (best.grid.qs.length >= need && orient(best) != null && orient(best) < -0.25))) best.grid.suspect = best.grid.qs.map((_, i) => i);
    return { best, sharp, paperLevel: paperLevel ?? 255, quad: !!quad };
  }
  // Which way is up, from ordinary printed text: Bengali letters hang from a top line (মাত্রা) and Latin text has
  // more ascenders than descenders, so upright text lines carry more ink in their upper part.
  function textUp(N, w, h, th = 0) {
    const ct = Math.cos(th), st = Math.sin(th), SW = 160, nS = Math.ceil(w / SW), H2 = h + Math.ceil(w * Math.abs(st)) + 2;
    const prof = Array.from({ length: nS }, () => new Float32Array(H2));
    const off = w * Math.abs(st);
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
      if (N[y * w + x] >= 140) continue;
      const u = x * ct + y * st, v = Math.round(-x * st + y * ct + off), s = Math.min(nS - 1, Math.max(0, Math.floor(u / SW)));
      if (v >= 0 && v < H2) prof[s][v]++;
    }
    let up = 0, tot = 0;
    for (const P of prof) {
      let y = 0;
      while (y < H2) {
        if (P[y] < 3) { y++; continue; }
        let e = y; while (e < H2 && P[e] >= 3) e++;
        const lh = e - y;
        if (lh >= 8 && lh <= 60) {
          let t = 0, bt = 0, sum = 0; const third = lh / 3;
          for (let k = y; k < e; k++) { sum += P[k]; if (k < y + third) t += P[k]; else if (k >= e - third) bt += P[k]; }
          const mx = Math.max(...P.slice(y, e)); const flat = sum / lh / mx;
          if (flat < 0.8) { up += (t - bt); tot += sum; }   // skip solid bars and filled blobs
        }
        y = e;
      }
    }
    return tot ? up / tot : 0;
  }
  // Bengali words hang from one continuous head-line (মাত্রা). Each printed word votes: line at its top = upright.
  function matraVotes(N, w, h, th = 0) {
    const B = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) B[i] = N[i] < 150 ? 1 : 0;
    const { lab, out } = labelComps(B, w, h), tn = Math.tan(th);
    let up = 0, down = 0;
    for (const o of out) {
      const bw = o.maxx - o.minx + 1, bh = o.maxy - o.miny + 1;
      if (bh < 9 || bh > 70 || bw < bh * 1.7 || bw > w * 0.4 || o.n > bw * bh * 0.6) continue;
      const cx = (o.minx + o.maxx) / 2; let bestL = 0, bestR = 0;
      for (let r = o.miny - 3; r <= o.maxy + 3; r++) {
        let run = 0, longest = 0;
        for (let x = o.minx; x <= o.maxx; x++) { const y = Math.round(r + (x - cx) * tn); const hit = y >= 0 && y < h && (lab[y * w + x] === o.id || (y + 1 < h && lab[(y + 1) * w + x] === o.id)); run = hit ? run + 1 : 0; if (run > longest) longest = run; }
        if (longest > bestL) { bestL = longest; bestR = r; }
      }
      if (bestL < bw * 0.68) continue;
      const pos = (bestR - o.miny) / bh;
      if (pos < 0.28) up++; else if (pos > 0.72) down++;
    }
    return { up, down, score: (up - down) / Math.max(8, up + down) };
  }
  // Lattice fit: link bubbles that sit one grid step apart, number them (column, row), and fit the grid.
  // Works even when only part of a tightly packed grid was detected (touching circles, printed digits inside).
  function lattices(bubs, d) {
    const hx = [], vy = [];
    for (const a of bubs) for (const b of bubs) { const dx = b.x - a.x, dy = b.y - a.y;
      if (dx > d * 0.8 && dx < d * 2.2 && Math.abs(dy) < d * 0.35) hx.push(dx);
      if (dy > d * 0.8 && dy < d * 2.2 && Math.abs(dx) < d * 0.35) vy.push(dy); }
    if (hx.length < 4 || vy.length < 4) return [];
    const px = pctile(hx, 0.3), py = pctile(vy, 0.3), tol = 0.3;
    const seen = new Map(), comps = [];
    bubs.forEach((b0, s) => {
      if (seen.has(s)) return; const comp = [{ b: b0, i: 0, j: 0 }]; seen.set(s, true); const q = [comp[0]];
      while (q.length) {
        const c = q.shift();
        bubs.forEach((b, t) => {
          if (seen.has(t)) return; const di = (b.x - c.b.x) / px, dj = (b.y - c.b.y) / py, ri = Math.round(di), rj = Math.round(dj);
          if (Math.abs(ri) + Math.abs(rj) === 0 || Math.abs(ri) > 2 || Math.abs(rj) > 2 || (ri && rj)) return;
          if (Math.abs(di - ri) > tol || Math.abs(dj - rj) > tol) return;
          seen.set(t, true); const n = { b, i: c.i + ri, j: c.j + rj }; comp.push(n); q.push(n);
        });
      }
      if (comp.length >= 6) comps.push(comp);
    });
    return comps.map(comp => {
      const mi = Math.min(...comp.map(c => c.i)), mj = Math.min(...comp.map(c => c.j));
      comp.forEach(c => { c.i -= mi; c.j -= mj; });
      const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], bx = [0, 0, 0], by = [0, 0, 0];
      comp.forEach(({ b, i, j }) => { const v = [1, i, j]; for (let r = 0; r < 3; r++) { for (let k = 0; k < 3; k++) A[r][k] += v[r] * v[k]; bx[r] += v[r] * b.x; by[r] += v[r] * b.y; } });
      const fx = solve(A.map(r => r.slice()), bx), fy = solve(A.map(r => r.slice()), by);
      return { cols: Math.max(...comp.map(c => c.i)) + 1, rows: Math.max(...comp.map(c => c.j)) + 1, n: comp.length, at: (i, j) => [fx[0] + fx[1] * i + fx[2] * j, fy[0] + fy[1] * i + fy[2] * j], ok: !!(fx && fy) };
    }).filter(l => l.ok);
  }
  // roll-number grid: D columns of 0–9, often printed smaller than the answer bubbles
  function findIdGrid(cand, D) {
    if (!D || cand.grid.id) { if (cand.grid.id) cand.idD = cand.fb.d; return; }
    const ansPts = cand.grid.qs.flat();
    for (const m of cand.fb.modes) {
      const bubs = m.bubs.filter(b => !ansPts.some(([x, y]) => Math.abs(x - b.x) < m.d * 0.5 && Math.abs(y - b.y) < m.d * 0.5));
      if (bubs.length < D * 8) continue;
      const g = buildGrid(bubs, m.d, D, 0, 0, 'columns');
      const blk = g && g.blockRows.filter(rows => rows.length === 10).sort((a, b) => a[0][0][1] - b[0][0][1])[0];
      if (blk) { cand.grid.id = Array.from({ length: D }, (_, j) => blk.map(r => r[j])); cand.idD = m.d; return; }
    }
    // tightly packed grids: pool what every ink map found, then fit the lattice
    const R = cand.R; let pool = [];
    for (const mode of ['union', 'g208d', 'g170']) { const f = findBubbles(R.N, R.w, R.h, mode); if (f) for (const b of f.modes.flatMap(m => m.bubs)) if (!pool.some(a => Math.abs(a.x - b.x) < a.d * 0.4 && Math.abs(a.y - b.y) < a.d * 0.4)) pool.push(b); }
    const pm = sizeModes(pool); const modes = pm ? pm.modes : cand.fb.modes;
    for (const m of modes) {
      const bubs = m.bubs.filter(b => !ansPts.some(([x, y]) => Math.abs(x - b.x) < m.d * 0.5 && Math.abs(y - b.y) < m.d * 0.5));
      const L = lattices(bubs, m.d).filter(l => l.cols === D && l.rows === 10 && l.n >= D * 10 * 0.3).sort((a, b) => b.n - a.n)[0];
      if (L) { cand.grid.id = Array.from({ length: D }, (_, i) => Array.from({ length: 10 }, (_, j) => L.at(i, j))); cand.idD = m.d; return; }
    }
  }
  function debugImage(best) {
    if (!best) return null;
    const { R, fb, grid } = best, c = toCanvas(R.N, R.w, R.h), g = c.getContext('2d'), r = fb.d / 2 + 3;
    g.lineWidth = Math.max(2, R.w / 400);
    g.strokeStyle = 'rgba(120,120,140,.9)'; fb.bubs.forEach(b => { g.beginPath(); g.arc(b.x, b.y, r, 0, 7); g.stroke(); });
    g.strokeStyle = '#14924A'; grid.qs.forEach((q, i) => { q.forEach(([x, y]) => { g.beginPath(); g.arc(x, y, r + 2, 0, 7); g.stroke(); }); g.fillStyle = '#2F5BFF'; g.font = `bold ${Math.round(fb.d * 0.9)}px sans-serif`; g.textAlign = 'right'; g.textBaseline = 'middle'; g.fillText(String(i + 1), q[0][0] - r - 6, q[0][1]); });
    return OMR_scaleUrl(c);
  }
  const OMR_scaleUrl = c => toUrl(scaleCanvas(c, 1100), 0.75);
  // Last check on the chosen grid: is there a whole column of bubbles left of the first one that was never seen?
  // (A column where nearly every bubble is filled can hide from the circle finder; the next column would then be
  // read as questions 1, 2, 3 ...) Printed columns look alike, so slide the first column's rows to the left and
  // see whether the photo matches there, on most rows, at one consistent distance.
  function hiddenColumn(best) {
    const { R, grid, fb } = best, th = grid.tilt || 0, ct = Math.cos(th), st = Math.sin(th);
    const back = ([u, v]) => [u * ct - v * st, u * st + v * ct], fwd = ([x, y]) => [x * ct + y * st, -x * st + y * ct];
    const first = grid.blockRows?.[0]; if (!first || first.length < 4) return null;
    const rows = first.map(q => q.map(fwd)), unit = grid.unit, r = fb.d / 2, span = rows[0][rows[0].length - 1][0] - rows[0][0][0];
    const probes = [0.05, 0.2, 0.35, 0.5, 0.65, 0.8, 0.95].map(f => rows[Math.round(f * (rows.length - 1))]);
    let hits = probes.map(p => {
      let b = null;
      for (let ox = -(span + unit * 1.8); ox >= -(span + unit * 8); ox -= Math.max(2, unit * 0.3)) { const m = rowMatch(R, back, p, ox, p[0][1], r, unit); if (m && (!b || m.ncc > b.ncc)) b = { ncc: m.ncc, ox: ox + m.dx, dy: m.dy, y: p[0][1], p }; }
      return b;
    });
    if (tracing()) trace('hiddenColumn', hits.map(h => h && [r3(h.ncc), Math.round(h.ox)]));
    // several rows agreeing on where the column is gives a real column away; single good matches do not. On a tilted page the
    // distance drifts steadily down the column, so rows agree on a line (distance against height), not on one value
    hits = hits.filter(b => b && b.ncc >= 0.22);
    let line = null;
    for (const a of hits) for (const b of hits) {
      if (b.y <= a.y + r) continue;
      const k = (b.ox - a.ox) / (b.y - a.y); if (Math.abs(k) > 0.4) continue;
      const inl = hits.filter(h => Math.abs(h.ox - (a.ox + k * (h.y - a.y))) < unit * 0.3);
      if (!line || inl.length > line.inl.length) line = { a, k, inl };
    }
    if (!line || line.inl.length < 3) return null;
    // the places the rows matched must hold bubbles (an empty ring, or a filled disc: heavy filling is the reason this column
    // was missed). Row numbers and borders can correlate a little with a row of bubbles without any of that
    const bubbleAt = ([x, y]) => discDark(R.N, x, y, r * 0.55, R.w, R.h) > 0.6 || Math.max(...[0.9, 1, 1.1].map(k => ringDarkEven(R.N, x, y, r * k, R.w, R.h))) > 0.2;
    const onShare = line.inl.map(h => { const q = h.p.map(([x, y]) => back([x + h.ox, y + h.dy])); return q.filter(bubbleAt).length / q.length; }).sort((p, q) => p - q);
    if (tracing()) trace('hid-on', onShare.map(r3));
    if (onShare[Math.floor(onShare.length / 2)] < 0.5) return null;
    const oxAt = y => line.a.ox + line.k * (y - line.a.y);
    // rows that match poorly (heavily filled ones do) are searched again close to the drift of the rows that matched
    const ms = rows.map(p => rowMatch(R, back, p, oxAt(p[0][1]), p[0][1], r, unit));
    const good = ms.map(m => !!m && m.ncc >= 0.2);
    const near = (k, dr) => { for (let j = k + dr; j >= 0 && j < ms.length; j += dr) if (good[j]) return { j, m: ms[j] }; return null; };
    const fixed = ms.map((m, k) => {
      if (good[k]) return m;
      const lo = near(k, -1), hi = near(k, 1), n = lo || hi; if (!n) return null;
      const t = lo && hi ? (k - lo.j) / (hi.j - lo.j) : 0, tr = lo && hi ? { dx: lo.m.dx + (hi.m.dx - lo.m.dx) * t, dy: lo.m.dy + (hi.m.dy - lo.m.dy) * t } : { dx: n.m.dx, dy: n.m.dy };
      const m2 = rowMatch(R, back, rows[k], oxAt(rows[k][0][1]), rows[k][0][1], r, unit, { dx: Math.round(tr.dx), dy: Math.round(tr.dy), R: 3, RY: 3 });
      return m2 && m2.ncc >= 0.12 ? m2 : null;
    });
    if (tracing()) trace('hid-why', 'matched', fixed.filter(Boolean).length, 'of', rows.length);
    // few rows matching at all means nothing was there after all (the probes had only found a chance likeness); a good share matching
    // with some rows missing or out of line means a column was there but could not be rebuilt
    if (fixed.filter(Boolean).length < rows.length * 0.5) return null;
    if (fixed.filter(Boolean).length < rows.length * 0.85) return { rebuilt: null };
    // the rings repeat every option, so a row can lock on one option off; but the shift cannot jump from one row to the next
    const offs = fixed.map((m, k) => m && oxAt(rows[k][0][1]) + m.dx);
    if (tracing()) trace('hoffs', unit, line.k, offs.map(v => v == null ? null : Math.round(v)), ms.map(m => m && r3(m.ncc)));
    for (let k = 0, last = -1; k < offs.length; k++) if (offs[k] != null) { if (last >= 0 && Math.abs(offs[k] - offs[last]) > 3 + unit * 0.08 * (k - last)) { if (tracing()) trace('hid-why', 'jump', k); return { rebuilt: null }; } last = k; }
    // what was found there must really be printed rings, as in the rows already read
    const place = (p, m) => p.map(([x, y]) => [x + oxAt(p[0][1]) + m.dx, y + m.dy]);
    const rg = rs => { const v = rs.map(([p, m]) => rowRings(R, back, place(p, m), r)).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
    const pairs = rows.map((p, k) => [p, fixed[k]]).filter(([, m]) => m);
    if (tracing()) trace('hid-why', 'rings', r3(rg(pairs)), r3(rowRingMedian(R, back, rows, r)));
    if (rg(pairs) < rowRingMedian(R, back, rows, r) * 0.6) return { rebuilt: null };
    const A = [];
    rows.forEach((p, k) => {
      const m = fixed[k] || (() => { const lo = near(k, -1), hi = near(k, 1), n = lo || hi; return n && n.m; })();   // a row still missing takes its neighbour's shift
      if (m) A.push(place(p, m).map(back));
    });
    if (A.length < rows.length) return { rebuilt: null };
    return { rebuilt: A };
  }
  function rowRingMedian(R, back, rows, r) { const v = rows.map(p => rowRings(R, back, p, r)).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; }
  // Filled bubbles are not found as circles, so a column of mostly filled ones can go unseen, and the empty column beside it would be
  // read as the first answers. Solid dark discs standing on the rows' own lines to the left of the first column give it away.
  function discsLeft(best) {
    const { R, grid, fb } = best, first = grid.blockRows?.[0]; if (!first || first.length < 4) return 0;
    const r = fb.d / 2, unit = grid.unit, { N, w, h } = R; let rowsWith = 0;
    for (const row of first) {
      const [x0, y0] = row[0]; let run = 0, found = false;
      for (let x = x0 - unit * 1.8; x > Math.max(r, x0 - unit * 11); x -= 3) {
        if (discDark(N, x, y0, r * 0.55, w, h) > 0.75) run += 3;
        else {
          // a bubble has clean paper in the gap beside it; the dark keys of a keyboard under the page, a table or a shadow do not
          if (run >= r * 0.9 && run <= r * 3) { const cx = x + 3 + run / 2; if (discDark(N, cx - unit / 2, y0, r * 0.4, w, h) < 0.3 && discDark(N, cx + unit / 2, y0, r * 0.4, w, h) < 0.3) found = true; }
          run = 0;
        }
      }
      if (found) rowsWith++;
    }
    if (tracing()) trace('discsLeft', rowsWith, 'of', first.length);
    return rowsWith;
  }
  async function processAuto(src, Gs, sc, bright, exam, cfg, onStage, fail) {
    onStage('Finding the sheet', 0.3); await tick();
    const { best, sharp, paperLevel } = await locateGrid(src, Gs, sc, { numQ: exam.numQ, numOpts: exam.numOpts, idDigits: exam.idDigits, order: cfg.order }, onStage);
    if (sharp < cfg.minSharp) return fail('blurry');
    if (paperLevel < 55) return fail('dark');
    if (!best) return fail('nobubbles');
    if (cfg.order !== 'rows') {
      let hid = hiddenColumn(best);
      if (!hid && discsLeft(best) >= 4) hid = { rebuilt: null };
      if (hid && !hid.rebuilt) return { ok: false, code: 'fewq', debug: debugImage(best), title: 'A column of answers was not found', reason: 'There seem to be answers left of the ones that were found. Retake the photo flat, in even light, with the whole answer area in view.' };
      if (hid) { const n = hid.rebuilt.length; best.grid.qs = hid.rebuilt.concat(best.grid.qs); best.grid.suspect = (best.grid.suspect || []).map(i => i + n); best.grid.blockRows = [hid.rebuilt, ...best.grid.blockRows]; }
    }
    const found = best.grid.qs.length;
    if (tracing()) trace('chosen', best.view.kind, best.rot, best.grid.blockRows.map(b => `n${b.length} ${b[0][0].map(Math.round)}..${b[b.length - 1][0].map(Math.round)}`), 'sus', best.grid.suspect);
    if (found < exam.numQ) return { ok: false, code: 'fewq', debug: debugImage(best), title: `Found ${found} of ${exam.numQ} questions`, reason: `Make sure the whole answer area is in the photo, flat and in focus. If it is, check that this exam is set to ${exam.numQ} questions with options A–${LET[exam.numOpts - 1]}.` };
    const nSus = (best.grid.suspect || []).filter(i => i < exam.numQ).length;
    if (nSus > Math.max(2, exam.numQ * 0.3)) return { ok: false, code: 'fewq', debug: debugImage(best), title: `Could not line up ${nSus} of ${exam.numQ} questions`, reason: 'Part of a column of bubbles was not found, so answers could land on the wrong question. Retake the photo flat, in even light, with the whole answer area in view.' };
    onStage('Reading marks', 0.75); await tick();
    const { N, w, h } = best.R, qs = best.grid.qs.slice(0, exam.numQ), d = best.fb.d;
    const rd = readAll(N, w, h, qs, exam.idDigits ? best.grid.id : null, d / 2 * 0.64, (best.idD || d) / 2 * 0.6, cfg, d / 2 * 0.9);
    const cal = { empty: rd.cal.baseAll, full: rd.cal.full };
    // questions placed after a column that came out short cannot be trusted: send them to review, never guess
    const sus = new Set(best.grid.suspect || []);
    const answers = rd.answers.map((a, i) => sus.has(i) ? { ...a, st: 'uncertain', det: null, cand: a.det != null ? [a.det] : a.cand || [], why: 'grid', o: [0, 0] } : { ...a, o: [0, 0] });
    const id = !exam.idDigits ? { roll: '', state: 'none' } : rd.id || { roll: '', state: 'missing' };
    const rnd = p => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10];
    onStage('Grading', 0.9); await tick();
    return { ok: true, N, w, h, answers, id, geo: { w, h, r: Math.round(d / 2 * 10) / 10, qs: rd.qPts.map(q => q.map(rnd)), id: best.grid.id ? best.grid.id.map(c => c.map(rnd)) : null },
      meta: { mode: 'auto', view: best.view.kind, tilt: Math.round(best.grid.tilt * 573) / 10, rotation: best.rot, sharpness: r3(sharp), brightness: Math.round(bright), paperLevel: Math.round(paperLevel), empty: r3(cal.empty), full: r3(cal.full), found, size: [src.width, src.height] } };
  }
  // look at a photo of a sheet and work out how many questions / options / roll digits it has
  async function detectLayout(src, cfg) {
    const small = scaleCanvas(src, 900), Gs = gray(small), sc = src.width / small.width;
    const { best } = await locateGrid(src, Gs, sc, { numQ: 0, numOpts: 0, idDigits: 0, order: cfg.order }, () => {});
    if (!best) return null;
    let idDigits = 0;
    const ansPts = best.grid.qs.flat();
    for (const m of best.fb.modes) {
      const bubs = m.bubs.filter(b => !ansPts.some(([x, y]) => Math.abs(x - b.x) < m.d * 0.5 && Math.abs(y - b.y) < m.d * 0.5));
      const L = lattices(bubs, m.d).filter(l => l.rows === 10 && l.cols >= 4 && l.cols <= 8 && l.n >= l.cols * 3.5).sort((a, b) => b.n - a.n)[0];
      if (L) { idDigits = L.cols; break; }
    }
    return { numQ: Math.min(100, best.grid.qs.length), numOpts: best.grid.no, idDigits };
  }

  function toCanvas(N, W = OMR_W, H = OMR_H) {
    const c = mkCanvas(W, H);
    const g = c.getContext('2d'), im = g.createImageData(W, H);
    for (let i = 0, j = 0; i < N.length; i++, j += 4) { im.data[j] = im.data[j + 1] = im.data[j + 2] = N[i]; im.data[j + 3] = 255; }
    g.putImageData(im, 0, 0); return c;
  }

  // what each reader state means (the names the rest of the product uses)
  const STATUS = { answered: 'READ', uncertain: 'AMBIGUOUS', blank: 'BLANK', multiple: 'MULTIPLE_MARKS' };
  return { _t: { textUp, matraVotes, gray, warp, flatten, rotateImg, readCode, codeBits, crc8, glareRows, CODE }, W, H, layout, renderSheet, process, quickCheck, captureGate, toCanvas, scaleCanvas, examCode, examFp, FAIL, STATUS, homog, applyH, detectLayout };
})();
if (typeof module !== 'undefined') module.exports = OMR;
