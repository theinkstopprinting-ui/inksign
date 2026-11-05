// Load an image (data URL) into pixel data for tracing.
export async function analyzeImage(dataUrl, maxSide = 900) {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  let transparent = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 128) transparent++;
  return { pxW: img.naturalWidth, pxH: img.naturalHeight, w, h, data, hasAlpha: transparent > w * h * 0.01 };
}
