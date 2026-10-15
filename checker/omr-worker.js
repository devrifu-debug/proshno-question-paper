/* Bubblemark sheet reader running off the main thread, so the screen and camera preview never freeze.
   Messages in:  { id, op: 'read' | 'layout' | 'check', input: File | Blob | ImageBitmap, exam, cfg, images }
   Messages out: { id, stage, progress }  while working, then  { id, ok: true, result }  or  { id, ok: false, error } */
importScripts('omr.js');

const toDataUrl = async (canvas, q) => {
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: q });
  return new FileReaderSync().readAsDataURL(blob);
};
const jpeg = (src, maxDim, q) => toDataUrl(OMR.scaleCanvas(src, maxDim), q);

async function open(input, maxDim = 2000) {
  const bmp = input instanceof ImageBitmap ? input : await createImageBitmap(input, { imageOrientation: 'from-image' });
  const c = OMR.scaleCanvas(bmp, maxDim); bmp.close?.(); return c;
}

const ops = {
  // read one sheet; `images` says which pictures to hand back ({ thumb: [maxDim, q], orig: [...], proc: [...] })
  async read({ id, input, exam, cfg, images = {} }, stage) {
    const t0 = performance.now();
    let src; try { src = await open(input); } catch { return { ok: false, code: 'decode', title: OMR.FAIL.decode[0], reason: OMR.FAIL.decode[1] }; }
    const t1 = performance.now();
    const imgs = {};
    if (images.thumb) { imgs.thumb = await jpeg(src, ...images.thumb); self.postMessage({ id, thumb: imgs.thumb }); }   // show it in the queue straight away
    const res = await OMR.process(src, exam, cfg, stage);
    const t2 = performance.now();
    if (res.debug?.bitmap) { const c = new OffscreenCanvas(res.debug.bitmap.width, res.debug.bitmap.height); c.getContext('2d').drawImage(res.debug.bitmap, 0, 0); res.debug = await toDataUrl(c, 0.75); }
    if (res.ok) {
      if (images.orig) { imgs.orig = await jpeg(src, ...images.orig); if (images.origFallback && imgs.orig.length > 400000) imgs.orig = await jpeg(src, ...images.origFallback); }
      if (images.proc) imgs.proc = await jpeg(OMR.toCanvas(res.N, res.w, res.h), ...images.proc);
      delete res.N;   // the page only needs the pictures, not the raw pixels
      res.meta.timing = { open: Math.round(t1 - t0), read: Math.round(t2 - t1), images: Math.round(performance.now() - t2), where: 'worker' };
    }
    return { ...res, imgs };
  },
  async layout({ input, cfg }) { return OMR.detectLayout(await open(input), cfg); },
  // live camera: is there a steady, sharp sheet in this frame?
  async check({ input, cfg }) { const r = OMR.quickCheck(input, cfg); input.close?.(); return r; },
};

self.onmessage = async ({ data }) => {
  const { id, op } = data;
  try {
    const result = await ops[op](data, (stage, progress) => self.postMessage({ id, stage, progress }));
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};
