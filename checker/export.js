/* ============================================================
   Share results: one data model, three renderers (CSV, Excel, PDF).
   Plain script shared by the page and the Node tests (tests/export.mjs), like omr.js.

     const m = Export.build({ exam, papers, now })   // exam: { name, subject, numQ, numOpts, marks, negEnabled, neg, key: ['A', …] }
                                                      // papers: [{ roll, name, scanned, score, total, pct, correct, wrong,
                                                      //            blank, two, unclear, status, answers: [{ a, k, ok, mk, why }] }]
     Export.csv(m)              -> string
     await Export.xlsx(m)       -> Uint8Array   (an .xlsx written directly: freeze panes, filter, A4 print set-up)
     Export.pdf(jsPDF, m)       -> ArrayBuffer  (A4: landscape summary table, portrait page per paper)

   Column names and their order are the same in all three. Answers read: a letter, "-" not answered, "A/B" two marks,
   "?" an unclear mark.
   ============================================================ */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.Export = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- formatting ---------- */
  const pad = n => String(n).padStart(2, '0');
  const num = n => String(+(+n).toFixed(2));            // 17, 17.5, 17.25 (never 17.000000001)
  const pct = n => (+n).toFixed(1);                     // 85.5
  const stamp = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const day = ms => stamp(ms).slice(0, 10);
  const cmpRoll = (a, b) => (a.roll ? 0 : 1) - (b.roll ? 0 : 1) || a.roll.localeCompare(b.roll, undefined, { numeric: true }) || a.name.localeCompare(b.name);

  /* ---------- the model ---------- */
  function build({ exam, papers, now = Date.now() }) {
    const rows = papers.map(p => ({ ...p, roll: p.roll || '', name: p.name || '' })).sort(cmpRoll);
    const pcts = rows.map(r => r.pct), n = rows.length;
    const neg = exam.negEnabled && +exam.neg ? `-${num(exam.neg)} per wrong answer` : 'None';
    const total = rows[0]?.total ?? exam.numQ * exam.marks;
    return {
      title: exam.name || 'Exam', now,
      exam: { ...exam, total, negText: neg },
      // the summary table: the same columns in the CSV, the Excel "Results" sheet and the PDF
      cols: [
        { k: 'roll', h: 'Roll', t: 's' }, { k: 'name', h: 'Name', t: 's' },
        { k: 'score', h: `Marks (of ${num(total)})`, t: 'n' }, { k: 'pct', h: 'Percentage (%)', t: 'p' },
        { k: 'correct', h: 'Correct', t: 'i' }, { k: 'wrong', h: 'Wrong', t: 'i' },
        { k: 'blank', h: 'Not answered', t: 'i' }, { k: 'two', h: 'Two marks', t: 'i' }, { k: 'unclear', h: 'Unclear mark', t: 'i' },
        { k: 'status', h: 'Status', t: 's' }, { k: 'scanned', h: 'Scanned', t: 'd' },
      ],
      rows,
      qHeads: Array.from({ length: exam.numQ }, (_, i) => 'Q' + (i + 1)),
      key: exam.key,
      stats: { papers: n, average: n ? pcts.reduce((s, x) => s + x, 0) / n : 0, highest: n ? Math.max(...pcts) : 0, lowest: n ? Math.min(...pcts) : 0 },
    };
  }
  const ansText = a => a.a || '-';
  const cellText = (c, r) => c.t === 'p' ? pct(r[c.k]) : c.t === 'n' || c.t === 'i' ? num(r[c.k]) : c.t === 'd' ? stamp(r[c.k]) : String(r[c.k] ?? '');
  const examFacts = m => {
    const e = m.exam, s = m.stats;
    return [
      ['Exam', m.title], ['Subject', e.subject || ''], ['Questions', e.numQ], ['Options per question', e.numOpts], ['Marks per question', +num(e.marks)],
      ['Negative marking', e.negText], ['Total marks', +num(e.total)], ['Papers marked', s.papers],
      ['Average', pct(s.average) + '%'], ['Highest', pct(s.highest) + '%'], ['Lowest', pct(s.lowest) + '%'], ['Exported', stamp(m.now)],
    ].filter(f => f[1] !== '');
  };

  /* ---------- CSV: one table, UTF-8 with BOM, CRLF, RFC 4180 quoting ---------- */
  function csv(m) {
    // text a spreadsheet could run as a formula is defused with a leading apostrophe
    const q = v => { let s = String(v ?? ''); if (/^[=+@\t\r]|^-(?!$)(?![\d.]+$)/.test(s)) s = "'" + s; return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const head = [...m.cols.map(c => c.h), ...m.qHeads];
    const key = ['', 'Answer key', ...m.cols.slice(2).map(() => ''), ...m.key];
    const lines = [head, key, ...m.rows.map(r => [...m.cols.map(c => cellText(c, r)), ...r.answers.map(ansText)])];
    return '﻿' + lines.map(l => l.map(q).join(',')).join('\r\n') + '\r\n';
  }

  /* ---------- Excel: .xlsx written directly (a zip of small XML files) ---------- */
  const xe = s => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const colName = i => { let s = '', x = i + 1; while (x > 0) { const r = (x - 1) % 26; s = String.fromCharCode(65 + r) + s; x = Math.floor((x - 1) / 26); } return s; };
  // cell styles (index into cellXfs below)
  const ST = { text: 1, textC: 2, head: 3, int: 4, general: 5, pct: 6, date: 7, key: 8, label: 9, value: 10 };
  const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="0.0"/><numFmt numFmtId="165" formatCode="yyyy\\-mm\\-dd\\ hh:mm"/></numFmts>
<fonts count="3"><font><sz val="10"/><name val="Arial"/></font><font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Arial"/></font><font><b/><sz val="10"/><name val="Arial"/></font></fonts>
<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF2F4B9B"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEDF1FB"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFD5DBEA"/></left><right style="thin"><color rgb="FFD5DBEA"/></right><top style="thin"><color rgb="FFD5DBEA"/></top><bottom style="thin"><color rgb="FFD5DBEA"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="11">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="1" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
<dxfs count="2"><dxf><font><color rgb="FF14724A"/></font><fill><patternFill><bgColor rgb="FFE7F6EC"/></patternFill></fill></dxf><dxf><font><b/><color rgb="FFB3261E"/></font><fill><patternFill><bgColor rgb="FFFDECEA"/></patternFill></fill></dxf></dxfs>
</styleSheet>`;

  // a worksheet from rows of [value, style] pairs
  function sheetXml({ rows, widths, heights = {}, freeze, filter, cf, landscape = true, fitW = 1, title, selected }) {
    const body = rows.map((cells, r) => {
      const ht = heights[r] ? ` ht="${heights[r]}" customHeight="1"` : '';
      return `<row r="${r + 1}"${ht}>${cells.map((c, i) => {
        const [v, s] = c, ref = colName(i) + (r + 1);
        if (v === '' || v == null) return `<c r="${ref}" s="${s}"/>`;
        if (typeof v === 'number') return `<c r="${ref}" s="${s}"><v>${v}</v></c>`;
        return `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${xe(v)}</t></is></c>`;
      }).join('')}</row>`;
    }).join('');
    const lastCol = colName(Math.max(...rows.map(r => r.length)) - 1), last = `${lastCol}${rows.length}`;
    const pane = freeze ? `<pane${freeze.x ? ` xSplit="${freeze.x}"` : ''}${freeze.y ? ` ySplit="${freeze.y}"` : ''} topLeftCell="${colName(freeze.x)}${freeze.y + 1}" activePane="${freeze.x && freeze.y ? 'bottomRight' : freeze.y ? 'bottomLeft' : 'topRight'}" state="frozen"/>` : '';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:${last}"/>
<sheetViews><sheetView workbookViewId="0"${selected ? ' tabSelected="1"' : ''}>${pane}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>
<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>
<sheetData>${body}</sheetData>${filter ? `<autoFilter ref="${filter}"/>` : ''}${cf || ''}
<printOptions horizontalCentered="1"/><pageMargins left="0.4" right="0.4" top="0.7" bottom="0.7" header="0.3" footer="0.3"/>
<pageSetup paperSize="9" orientation="${landscape ? 'landscape' : 'portrait'}" fitToWidth="${fitW}" fitToHeight="0"/>
<headerFooter><oddHeader>&amp;L${xe(title.replace(/&/g, '&&'))}&amp;R&amp;D</oddHeader><oddFooter>&amp;CPage &amp;P of &amp;N</oddFooter></headerFooter></worksheet>`;
  }

  const widthOf = (vals, min, max) => Math.max(min, Math.min(max, Math.max(0, ...vals.map(v => String(v).length)) + 3));

  async function xlsx(m) {
    const n = m.rows.length, nq = m.qHeads.length;
    // ---- Results: the summary table
    const wRes = m.cols.map((c, i) => c.k === 'name' ? widthOf([c.h, ...m.rows.map(r => r.name)], 18, 40) : c.k === 'roll' ? widthOf([c.h, ...m.rows.map(r => r.roll)], 10, 20)
      : c.k === 'status' ? 18 : c.k === 'scanned' ? 18 : c.k === 'score' ? 14 : c.k === 'pct' ? 14 : 12);
    const styleOf = { s: ST.text, n: ST.general, p: ST.pct, i: ST.int, d: ST.date };
    const resRows = [m.cols.map(c => [c.h, ST.head]), ...m.rows.map(r => m.cols.map(c => {
      const v = r[c.k];
      if (c.t === 'd') return [(v - new Date(v).getTimezoneOffset() * 60000) / 864e5 + 25569, ST.date];   // a real date-time, shown as local time
      if (c.t === 'p') return [Math.round(v * 10) / 10, ST.pct];
      if (c.t === 'n' || c.t === 'i') return [Math.round(v * 100) / 100, styleOf[c.t]];
      return [String(v ?? ''), c.k === 'status' ? ST.textC : ST.text];
    }))];
    const nameW = wRes[1], resHeights = { 0: 32 };
    m.rows.forEach((r, i) => { const lines = Math.ceil(Math.max(1, r.name.length) / (nameW - 2)); if (lines > 1) resHeights[i + 1] = 14 * lines + 2; });
    const res = sheetXml({ rows: resRows, widths: wRes, heights: resHeights, freeze: { x: 2, y: 1 }, filter: `A1:${colName(m.cols.length - 1)}${n + 1}`, title: m.title, selected: true, fitW: 1 });

    // ---- Answers: the key on top (stays in view), then every paper; right and wrong answers are coloured against the key
    const aRows = [
      [['', ST.key], ['Answer key', ST.key], ...m.key.map(k => [k, ST.key])],
      [['Roll', ST.head], ['Name', ST.head], ...m.qHeads.map(h => [h, ST.head])],
      ...m.rows.map(r => [[r.roll, ST.text], [r.name, ST.text], ...r.answers.map(a => [ansText(a), ST.textC])]),
    ];
    const lastC = colName(nq + 1), cfRange = `C3:${lastC}${n + 2}`;
    const cf = n ? `<conditionalFormatting sqref="${cfRange}"><cfRule type="expression" dxfId="0" priority="1"><formula>C3=C$1</formula></cfRule><cfRule type="expression" dxfId="1" priority="2"><formula>C3&lt;&gt;C$1</formula></cfRule></conditionalFormatting>` : '';
    const wAns = [wRes[0], wRes[1], ...m.qHeads.map(() => 6)], aHeights = { 0: 20, 1: 22 };
    const ans = sheetXml({ rows: aRows, widths: wAns, heights: aHeights, freeze: { x: 2, y: 2 }, filter: `A2:${lastC}${n + 2}`, cf, title: m.title, fitW: Math.max(1, Math.ceil(nq / 40)) });

    // ---- Exam: the facts about the exam and the class
    const facts = examFacts(m);
    const exam = sheetXml({ rows: facts.map(([k, v]) => [[k, ST.label], [typeof v === 'number' ? v : String(v), ST.value]]), widths: [26, 46], title: m.title, landscape: false });

    const files = {
      '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${[1, 2, 3].map(i => `<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
      '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="0"/></bookViews><sheets><sheet name="Results" sheetId="1" r:id="rId1"/><sheet name="Answers" sheetId="2" r:id="rId2"/><sheet name="Exam" sheetId="3" r:id="rId3"/></sheets><definedNames>`
        + `<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">Results!$A$1:$${colName(m.cols.length - 1)}$${n + 1}</definedName><definedName name="_xlnm._FilterDatabase" localSheetId="1" hidden="1">Answers!$A$2:$${lastC}$${n + 2}</definedName>`
        + `<definedName name="_xlnm.Print_Area" localSheetId="0">Results!$A$1:$${colName(m.cols.length - 1)}$${n + 1}</definedName><definedName name="_xlnm.Print_Area" localSheetId="1">Answers!$A$1:$${lastC}$${n + 2}</definedName><definedName name="_xlnm.Print_Area" localSheetId="2">Exam!$A$1:$B$${facts.length}</definedName>`
        + `<definedName name="_xlnm.Print_Titles" localSheetId="0">Results!$1:$1</definedName><definedName name="_xlnm.Print_Titles" localSheetId="1">Answers!$A:$B,Answers!$1:$2</definedName></definedNames></workbook>`,
      'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${[1, 2, 3].map(i => `<Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i}.xml"/>`).join('')}<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
      'xl/styles.xml': STYLES, 'xl/worksheets/sheet1.xml': res, 'xl/worksheets/sheet2.xml': ans, 'xl/worksheets/sheet3.xml': exam,
    };
    return zip(files);
  }

  /* ---------- a small zip writer (deflate where the browser can, otherwise stored) ---------- */
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  async function deflateRaw(bytes) {
    if (typeof CompressionStream === 'undefined') return null;
    try { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer()); } catch { return null; }
  }
  async function zip(files) {
    const enc = new TextEncoder(), parts = [], central = []; let offset = 0;
    const d = new Date(), dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    for (const [name, text] of Object.entries(files)) {
      const raw = enc.encode(text), nm = enc.encode(name), z = await deflateRaw(raw), data = z && z.length < raw.length ? z : raw, method = data === raw ? 0 : 8, crc = crc32(raw);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, method, true); lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, raw.length, true); lh.setUint16(26, nm.length, true);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, method, true); ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true);
      ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, raw.length, true); ch.setUint16(28, nm.length, true); ch.setUint32(42, offset, true);
      parts.push(new Uint8Array(lh.buffer), nm, data); central.push(new Uint8Array(ch.buffer), nm);
      offset += 30 + nm.length + data.length;
    }
    const cdSize = central.reduce((s, x) => s + x.length, 0), end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, Object.keys(files).length, true); end.setUint16(10, Object.keys(files).length, true); end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    const all = [...parts, ...central, new Uint8Array(end.buffer)], out = new Uint8Array(offset + cdSize + 22); let p = 0;
    for (const x of all) { out.set(x, p); p += x.length; }
    return out;
  }

  /* ---------- PDF: A4, text that wraps, a repeating table header, "Page X of Y" ---------- */
  const MM = 25.4 / 72;                                   // 1 pt in mm
  const INK = [11, 18, 34], MUTED = [90, 100, 120], HEAD_BG = [237, 241, 251], HEAD_INK = [74, 84, 112], LINE = [222, 228, 240], GOOD = [20, 146, 74], BAD = [200, 45, 52], WARN = [194, 106, 0], BAD_BG = [253, 236, 234], ZEBRA = [248, 250, 254];
  const SCALE = 4;                                        // canvas pixels per point for text drawn as a picture
  const canvasFont = (pt, bold) => `${bold ? '700 ' : ''}${pt * SCALE}px "Noto Sans Bengali","Kohinoor Bangla","Bangla Sangam MN","Nirmala UI",system-ui,sans-serif`;
  const mkCanvas = (w, h) => typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: w, height: h }) : new OffscreenCanvas(w, h);

  function pdf(jsPDF, m) {
    const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape', compress: true }), dims = [[297, 210]], cache = new Map();
    let measureCtx = null;
    // jsPDF's built-in fonts only know Latin-1; anything else (Bengali names, say) is drawn as a picture of the text
    const latin = s => !/[^\u0000-ÿ]/.test(s);
    const width = (s, pt, bold) => {
      if (latin(s)) { doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(pt); return doc.getTextWidth(s); }
      measureCtx = measureCtx || mkCanvas(8, 8).getContext('2d'); measureCtx.font = canvasFont(pt, bold);
      return measureCtx.measureText(s).width / SCALE * MM;
    };
    const wrap = (s, pt, bold, maxW) => {
      const out = [];
      for (const para of String(s).split(/\r?\n/)) {
        let line = '';
        for (const word of para.split(/\s+/).filter(Boolean)) {
          const t = line ? line + ' ' + word : word;
          if (width(t, pt, bold) <= maxW) { line = t; continue; }
          if (line) out.push(line);
          line = '';
          let w = word;
          while (width(w, pt, bold) > maxW && w.length > 1) { let k = w.length - 1; while (k > 1 && width(w.slice(0, k), pt, bold) > maxW) k--; out.push(w.slice(0, k)); w = w.slice(k); }
          line = w;
        }
        out.push(line);
      }
      return out.length ? out : [''];
    };
    // draw one line of text with its baseline at y
    const text = (s, x, y, { pt = 9, bold = false, color = INK, align = 'left' } = {}) => {
      s = String(s); if (!s) return;
      const w = width(s, pt, bold), x0 = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
      if (latin(s)) { doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(pt); doc.setTextColor(...color); doc.text(s, x0, y); return; }
      const key = `${s}|${pt}|${bold}|${color}`; let img = cache.get(key);
      if (!img) {
        const c = mkCanvas(Math.ceil(w / MM * SCALE) + 4, Math.ceil(pt * SCALE * 1.5)), g = c.getContext('2d');
        g.font = canvasFont(pt, bold); g.fillStyle = `rgb(${color})`; g.textBaseline = 'alphabetic'; g.fillText(s, 2, pt * SCALE * 1.1);
        img = { url: c.toDataURL('image/png'), w: c.width / SCALE * MM, h: c.height / SCALE * MM, id: 't' + cache.size }; cache.set(key, img);
      }
      doc.addImage(img.url, 'PNG', x0 - 2 / SCALE * MM, y - pt * 1.1 * MM, img.w, img.h, img.id, 'FAST');
    };
    const newPage = (o) => { doc.addPage('a4', o); dims.push(o === 'landscape' ? [297, 210] : [210, 297]); };
    const fill = (c, x, y, w, h) => { doc.setFillColor(...c); doc.rect(x, y, w, h, 'F'); };
    const hline = (y, x1, x2, c = LINE) => { doc.setDrawColor(...c); doc.setLineWidth(0.2); doc.line(x1, y, x2, y); };

    /* --- summary: landscape --- */
    const L = 12, T = 14, B = 16, [PW, PH] = [297, 210], CW = PW - 2 * L, PAD = 1.8, PT = 9, LH = 4;
    const fixed = { roll: 24, score: 24, pct: 24, correct: 18, wrong: 16, blank: 22, two: 20, unclear: 22, status: 30, scanned: 30 };
    const cw = m.cols.map(c => fixed[c.k] || 0); cw[1] = CW - cw.reduce((s, x) => s + x, 0);
    const xs = cw.map((_, i) => L + cw.slice(0, i).reduce((s, x) => s + x, 0));
    const alignOf = c => ['n', 'p', 'i'].includes(c.t) || c.t === 'd' || c.k === 'status' ? 'center' : 'left';
    const cellX = (i, a) => a === 'center' ? xs[i] + cw[i] / 2 : xs[i] + PAD;

    let y = T;
    const titleLines = wrap(m.title + ' - Results', 16, true, CW);
    titleLines.forEach(t => { text(t, L, y + 5, { pt: 16, bold: true }); y += 7; });
    const s = m.stats, e = m.exam;
    const meta = [e.subject, `${e.numQ} questions`, `${num(e.marks)} mark${+e.marks === 1 ? '' : 's'} each`, `Negative marking: ${e.negText}`].filter(Boolean).join('  ·  ');
    const meta2 = `${s.papers} paper${s.papers === 1 ? '' : 's'}  ·  Average ${pct(s.average)}%  ·  Highest ${pct(s.highest)}%  ·  Lowest ${pct(s.lowest)}%  ·  Exported ${day(m.now)}`;
    y += 0.5; wrap(meta, 9.5, false, CW).forEach(t => { text(t, L, y + 3, { pt: 9.5, color: MUTED }); y += 4.6; });
    text(meta2, L, y + 3, { pt: 9.5, color: MUTED }); y += 8;

    const header = () => {
      const lines = m.cols.map((c, i) => wrap(c.h, 8.5, true, cw[i] - 2 * PAD)), h = Math.max(...lines.map(l => l.length)) * 3.8 + 3.4;
      fill(HEAD_BG, L, y, CW, h);
      lines.forEach((ls, i) => { const a = alignOf(m.cols[i]); ls.forEach((t, k) => text(t, cellX(i, a), y + 4.6 + k * 3.8, { pt: 8.5, bold: true, color: HEAD_INK, align: a })); });
      y += h;
    };
    header();
    m.rows.forEach((r, ri) => {
      const cells = m.cols.map((c, i) => wrap(cellText(c, r) || '-', PT, false, cw[i] - 2 * PAD)), h = Math.max(...cells.map(l => l.length)) * LH + 2.8;
      if (y + h > PH - B) { newPage('landscape'); y = T; header(); }
      if (ri % 2) fill(ZEBRA, L, y, CW, h);
      cells.forEach((ls, i) => {
        const c = m.cols[i], a = alignOf(c), warn = c.k === 'status' && r.status !== 'Marked';
        ls.forEach((t, k) => text(t, cellX(i, a), y + 4.2 + k * LH, { pt: PT, bold: c.k === 'score' || c.k === 'pct', color: warn ? WARN : c.k === 'wrong' && r.wrong ? BAD : INK, align: a }));
      });
      hline(y + h, L, L + CW); y += h;
    });
    y += 3;
    text(`Wrong includes questions that were not answered, had two marks or an unclear mark.`, L, y + 3, { pt: 8, color: MUTED }); y += 8;

    // the answer key, ten questions to a line
    const keyRows = Math.ceil(m.key.length / 10), keyH = 8 + keyRows * 5;
    if (y + keyH > PH - B) { newPage('landscape'); y = T; }
    text('Answer key', L, y + 3.5, { pt: 10.5, bold: true }); y += 6;
    for (let r = 0; r < keyRows; r++) {
      const from = r * 10, to = Math.min(m.key.length, from + 10);
      text(`Q${from + 1}-${to}`, L, y + 3.6, { pt: 9, bold: true, color: HEAD_INK });
      m.key.slice(from, to).forEach((k, j) => text(k, L + 24 + j * 10, y + 3.6, { pt: 9.5, bold: true }));
      y += 5;
    }

    /* --- one portrait page per paper --- */
    const PL = 15, PWd = 210 - 2 * PL, PB = 18;
    m.rows.forEach(r => {
      newPage('portrait'); let y = 16;
      const who = r.name || (r.roll ? 'Roll ' + r.roll : 'Unnamed paper');
      wrap(who, 15, true, PWd).slice(0, 2).forEach(t => { text(t, PL, y + 5, { pt: 15, bold: true }); y += 7; });
      text([r.roll && r.name ? 'Roll ' + r.roll : '', m.title, 'Scanned ' + stamp(r.scanned)].filter(Boolean).join('  ·  '), PL, y + 3.5, { pt: 9, color: MUTED }); y += 9;
      // result strip: marks, percentage, correct, wrong
      const boxes = [[num(r.score) + ' / ' + num(r.total), 'Marks'], [pct(r.pct) + '%', 'Percentage'], [String(r.correct), 'Correct'], [String(r.wrong), 'Wrong']], bw = (PWd - 9) / 4;
      boxes.forEach(([v, lab], i) => { const x = PL + i * (bw + 3); fill(HEAD_BG, x, y, bw, 17); text(v, x + bw / 2, y + 8.5, { pt: 14, bold: true, color: i === 3 && r.wrong ? BAD : i === 2 ? GOOD : INK, align: 'center' }); text(lab, x + bw / 2, y + 14, { pt: 8, color: HEAD_INK, align: 'center' }); });
      y += 21;
      const why = [r.blank && `${r.blank} not answered`, r.two && `${r.two} with two marks`, r.unclear && `${r.unclear} unclear`].filter(Boolean).join('  ·  ');
      if (why) { text('Wrong includes: ' + why, PL, y + 3, { pt: 8.5, color: WARN }); y += 6; }
      if (r.status !== 'Marked') { text('Roll number or name is missing for this paper.', PL, y + 3, { pt: 8.5, color: WARN }); y += 6; }
      y += 2;
      // questions, in as many side-by-side blocks as the page needs
      const nq = r.answers.length, avail = 297 - PB - y - 8, blocks = nq <= 20 ? 1 : nq <= 50 ? 2 : nq <= 75 ? 3 : 4;
      let per = Math.ceil(nq / blocks), rh = Math.min(5.6, avail / (per + 1)), fs = rh < 4.6 ? 7 : 8.5;
      const gap = 6, bW = (PWd - gap * (blocks - 1)) / blocks, withResult = blocks <= 2;
      const cl = withResult ? [11, 12, 14, 22, bW - 59] : [9, 9, 10, bW - 28];   // Q · Key · Answer · [Result] · Marks
      const heads = withResult ? ['Q', 'Key', 'Answer', 'Result', 'Marks'] : ['Q', 'Key', 'Ans', 'Marks'];
      for (let b = 0; b < blocks; b++) {
        const x0 = PL + b * (bW + gap), cx = cl.map((_, i) => x0 + cl.slice(0, i).reduce((a, v) => a + v, 0));
        fill(HEAD_BG, x0, y, bW, rh + 0.6); heads.forEach((h, i) => text(h, cx[i] + cl[i] / 2, y + rh * 0.72, { pt: fs, bold: true, color: HEAD_INK, align: 'center' }));
        r.answers.slice(b * per, b * per + per).forEach((a, k) => {
          const yy = y + rh + 0.6 + k * rh, res = a.ok ? 'Correct' : a.why || 'Wrong', mk = (a.mk > 0 ? '+' : '') + num(a.mk);
          if (!a.ok) fill(BAD_BG, x0, yy, bW, rh);
          hline(yy + rh, x0, x0 + bW);
          const vals = withResult ? [String(b * per + k + 1), a.k || '-', ansText(a), res, mk] : [String(b * per + k + 1), a.k || '-', ansText(a), mk];
          vals.forEach((v, i) => text(v, cx[i] + cl[i] / 2, yy + rh * 0.72, { pt: fs, color: i === (withResult ? 3 : 2) ? (a.ok ? GOOD : BAD) : INK, bold: i === 2, align: 'center' }));
        });
      }
      y += rh + 0.6 + per * rh + 3;
      text('Answer: a letter, - not answered, A/B two marks, ? unclear mark.  Red rows are counted wrong.', PL, y + 3, { pt: 8, color: MUTED });
    });

    /* --- footer on every page: exam name, page number --- */
    const total = doc.getNumberOfPages();
    for (let i = 1; i <= total; i++) {
      doc.setPage(i); const [w, h] = dims[i - 1], mx = w === 297 ? L : PL;
      hline(h - 11, mx, w - mx);
      const t = wrap(m.title + ' · Results', 8, false, (w - 2 * mx) * 0.7)[0];
      text(t, mx, h - 7, { pt: 8, color: MUTED }); text(`Page ${i} of ${total}`, w - mx, h - 7, { pt: 8, color: MUTED, align: 'right' });
    }
    return doc.output('arraybuffer');
  }

  return { build, csv, xlsx, pdf, cellText, ansText, examFacts, num, pct, stamp };
});
