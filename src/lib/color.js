// Color management with Little CMS (lcms-wasm): soft proofing, RGB→CMYK conversion, color matching.
import {
  instantiate, TYPE_RGBA_8, TYPE_RGB_8, TYPE_CMYK_8, INTENT_PERCEPTUAL, INTENT_RELATIVE_COLORIMETRIC,
  INTENT_SATURATION, cmsFLAGS_BLACKPOINTCOMPENSATION, cmsInfoDescription,
} from 'lcms-wasm';

// Lab as 32-bit floats (this LittleCMS build reads/writes Float32, not Float64).
const TYPE_Lab_FLT = (1 << 22) | (10 << 16) | (3 << 3) | 4;

export const INTENTS = [
  { id: INTENT_PERCEPTUAL, name: 'Perceptual (photos)' },
  { id: INTENT_RELATIVE_COLORIMETRIC, name: 'Relative colorimetric (logos, spot colors)' },
  { id: INTENT_SATURATION, name: 'Saturation (bright graphics)' },
];

let lcmsP = null;
export function getLcms() {
  if (!lcmsP) {
    lcmsP = (async () => {
      const wasmBinary = await window.inksign.color.wasm();
      return instantiate({ wasmBinary: wasmBinary instanceof ArrayBuffer ? wasmBinary : wasmBinary.buffer.slice(wasmBinary.byteOffset, wasmBinary.byteOffset + wasmBinary.byteLength) });
    })();
  }
  return lcmsP;
}

const cache = new Map();
async function openProfile(id) {
  const lcms = await getLcms();
  if (id === 'srgb') {
    if (!cache.has(id)) cache.set(id, lcms.cmsCreate_sRGBProfile());
    return cache.get(id);
  }
  if (id === 'lab') {
    if (!cache.has(id)) cache.set(id, lcms.cmsCreateLab4Profile(null));
    return cache.get(id);
  }
  if (!cache.has(id)) {
    const bytes = await window.inksign.color.profileBytes(id);
    const u8 = new Uint8Array(bytes);
    const h = lcms.cmsOpenProfileFromMem(u8, u8.byteLength);
    if (!h) throw new Error('That ICC profile could not be read.');
    cache.set(id, h);
  }
  return cache.get(id);
}

export async function profileInfo(bytes) {
  const lcms = await getLcms();
  const u8 = new Uint8Array(bytes);
  const h = lcms.cmsOpenProfileFromMem(u8, u8.byteLength);
  if (!h) throw new Error('Not an ICC profile.');
  return { name: lcms.cmsGetProfileInfoASCII(h, cmsInfoDescription, 'en', 'US'), space: lcms.cmsGetColorSpaceASCII(h).trim() };
}

const tcache = new Map();
async function transform(key, make) {
  if (!tcache.has(key)) {
    const t = await make();
    if (!t) throw new Error('This profile can\'t be used for that conversion — it may be an input-only ("read") profile. Use the printer\'s output profile.');
    tcache.set(key, t);
  }
  return tcache.get(key);
}

// RGBA pixels (from a canvas) → CMYK bytes for the printer, composited on white.
export async function rgbaToCmyk(rgba, profileId, intent = INTENT_PERCEPTUAL) {
  const lcms = await getLcms();
  const t = await transform(`rgb>cmyk:${profileId}:${intent}`, async () =>
    lcms.cmsCreateTransform(await openProfile('srgb'), TYPE_RGB_8, await openProfile(profileId), TYPE_CMYK_8, intent, cmsFLAGS_BLACKPOINTCOMPENSATION));
  const n = rgba.length / 4, rgb = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = rgba[i * 4 + 3] / 255;
    rgb[i * 3] = Math.round(rgba[i * 4] * a + 255 * (1 - a));
    rgb[i * 3 + 1] = Math.round(rgba[i * 4 + 1] * a + 255 * (1 - a));
    rgb[i * 3 + 2] = Math.round(rgba[i * 4 + 2] * a + 255 * (1 - a));
  }
  return lcms.cmsDoTransform(t, rgb, n);
}

// What the picture will look like printed (RGB → printer → RGB), plus where colors can't be reached.
export async function softProof(rgba, profileId, intent = INTENT_PERCEPTUAL, gamutDeltaE = 6) {
  const lcms = await getLcms();
  const n = rgba.length / 4;
  const toPrinter = await transform(`rgba>cmyk:${profileId}:${intent}`, async () =>
    lcms.cmsCreateTransform(await openProfile('srgb'), TYPE_RGBA_8, await openProfile(profileId), TYPE_CMYK_8, intent, cmsFLAGS_BLACKPOINTCOMPENSATION));
  const back = await transform(`cmyk>rgb:${profileId}`, async () =>
    lcms.cmsCreateTransform(await openProfile(profileId), TYPE_CMYK_8, await openProfile('srgb'), TYPE_RGB_8, INTENT_RELATIVE_COLORIMETRIC, 0));
  const toLabRgb = await transform('rgb>lab', async () =>
    lcms.cmsCreateTransform(await openProfile('srgb'), TYPE_RGB_8, await openProfile('lab'), TYPE_Lab_FLT, INTENT_RELATIVE_COLORIMETRIC, 0));
  // (lcms-wasm sizes the output by the input's extra alpha channel, so trim to 4 bytes per pixel)
  const cmyk = lcms.cmsDoTransform(toPrinter, rgba, n).subarray(0, n * 4);
  const proofRgb = lcms.cmsDoTransform(back, cmyk, n).subarray(0, n * 3);
  const srcRgb = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) { srcRgb[i * 3] = rgba[i * 4]; srcRgb[i * 3 + 1] = rgba[i * 4 + 1]; srcRgb[i * 3 + 2] = rgba[i * 4 + 2]; }
  const labA = lcms.cmsDoTransform(toLabRgb, srcRgb, n), labB = lcms.cmsDoTransform(toLabRgb, proofRgb, n);
  const out = new Uint8ClampedArray(n * 4), gamut = new Uint8Array(n);
  let outCount = 0, opaque = 0;
  for (let i = 0; i < n; i++) {
    out[i * 4] = proofRgb[i * 3]; out[i * 4 + 1] = proofRgb[i * 3 + 1]; out[i * 4 + 2] = proofRgb[i * 3 + 2]; out[i * 4 + 3] = rgba[i * 4 + 3];
    if (rgba[i * 4 + 3] < 128) continue;
    opaque++;
    const d = Math.hypot(labA[i * 3] - labB[i * 3], labA[i * 3 + 1] - labB[i * 3 + 1], labA[i * 3 + 2] - labB[i * 3 + 2]);
    if (d > gamutDeltaE) { gamut[i] = 1; outCount++; }
  }
  return { rgba: out, gamut, outOfGamutPct: opaque ? (100 * outCount) / opaque : 0 };
}

// ---- Color matching -----------------------------------------------------------
export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex).trim());
  return m ? m.slice(1).map((h) => parseInt(h, 16)) : null;
}

export async function rgbToLab(rgb) {
  const lcms = await getLcms();
  const t = await transform('rgb>lab', async () =>
    lcms.cmsCreateTransform(await openProfile('srgb'), TYPE_RGB_8, await openProfile('lab'), TYPE_Lab_FLT, INTENT_RELATIVE_COLORIMETRIC, 0));
  const r = lcms.cmsDoTransform(t, new Uint8Array(rgb), 1);
  return [r[0], r[1], r[2]];
}

// The CMYK recipe that prints a given color on a printer profile (and how close it gets).
export async function labToCmyk(lab, profileId, intent = INTENT_RELATIVE_COLORIMETRIC) {
  const lcms = await getLcms();
  const t = await transform(`lab>cmyk:${profileId}:${intent}`, async () =>
    lcms.cmsCreateTransform(await openProfile('lab'), TYPE_Lab_FLT, await openProfile(profileId), TYPE_CMYK_8, intent, cmsFLAGS_BLACKPOINTCOMPENSATION));
  const back = await transform(`cmyk>lab:${profileId}`, async () =>
    lcms.cmsCreateTransform(await openProfile(profileId), TYPE_CMYK_8, await openProfile('lab'), TYPE_Lab_FLT, INTENT_RELATIVE_COLORIMETRIC, 0));
  const c = lcms.cmsDoTransform(t, new Float32Array(lab), 1);
  const printed = lcms.cmsDoTransform(back, c, 1);
  return { cmyk: [...c].map((v) => Math.round((v / 255) * 100)), printedLab: [printed[0], printed[1], printed[2]], deltaE: deltaE2000(lab, [printed[0], printed[1], printed[2]]) };
}

// CIEDE2000 color difference (under ~2 = hard to tell apart, over ~5 = clearly different).
export function deltaE2000([L1, a1, b1], [L2, a2, b2]) {
  const rad = Math.PI / 180, deg = 180 / Math.PI;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const h = (b, a) => { if (!b && !a) return 0; const v = Math.atan2(b, a) * deg; return v < 0 ? v + 360 : v; };
  const h1p = h(b1, a1p), h2p = h(b2, a2p);
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p) { dhp = h2p - h1p; if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360; }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);
  const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p) { if (Math.abs(h1p - h2p) > 180) hbp += h1p + h2p < 360 ? 360 : -360; hbp /= 2; }
  const T = 1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos(2 * hbp * rad) + 0.32 * Math.cos((3 * hbp + 6) * rad) - 0.2 * Math.cos((4 * hbp - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2), Sc = 1 + 0.045 * Cbp, Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}

// Library colors closest to a target color, nearest first.
export async function nearestColors(lab, library) {
  const out = [];
  for (const c of library) {
    const rgb = hexToRgb(c.hex);
    if (!rgb) continue;
    out.push({ ...c, deltaE: deltaE2000(lab, await rgbToLab(rgb)) });
  }
  return out.sort((a, b) => a.deltaE - b.deltaE);
}

export { INTENT_PERCEPTUAL, INTENT_RELATIVE_COLORIMETRIC };

// Decode an image (data URL) and convert it to the printer's CMYK. Big photos are capped at ~16 MP.
export async function imageToCmyk(dataUrl, profileId, intent = INTENT_PERCEPTUAL) {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const k = Math.min(1, Math.sqrt(16e6 / (img.naturalWidth * img.naturalHeight)));
  const w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const cmyk = await rgbaToCmyk(ctx.getImageData(0, 0, w, h).data, profileId, intent);
  let bin = '';
  for (let i = 0; i < cmyk.length; i += 0x8000) bin += String.fromCharCode.apply(null, cmyk.subarray(i, i + 0x8000));
  return { w, h, base64: btoa(bin) };
}

// The profile + intent chosen for a printer on the Color page, or null.
export function printerProfile(settings, deviceId) {
  const a = settings?.colorProfiles?.[deviceId];
  if (!a || !a.profileId) return null;
  const p = (settings.iccProfiles || []).find((x) => x.id === a.profileId);
  return p ? { ...a, profile: p } : null;
}
