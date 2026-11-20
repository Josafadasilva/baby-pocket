// pitch.js — detector de afinação (YIN simplificado), 55–1200 Hz.
export function detectPitch(buf, sr) {
  const n = buf.length, half = n >> 1;
  let rms = 0; for (let i = 0; i < n; i++) rms += buf[i] * buf[i];
  if (Math.sqrt(rms / n) < 0.008) return null;
  const minLag = Math.floor(sr / 1200), maxLag = Math.min(Math.floor(sr / 55), half - 1);
  const d = new Float32Array(maxLag + 2), cm = new Float32Array(maxLag + 2);
  for (let t = 1; t <= maxLag + 1; t++) { let s = 0; for (let i = 0; i < half; i++) { const x = buf[i] - buf[i + t]; s += x * x; } d[t] = s; }
  cm[0] = 1; let run = 0;
  for (let t = 1; t <= maxLag + 1; t++) { run += d[t]; cm[t] = run ? (d[t] * t) / run : 1; }
  for (let t = minLag; t <= maxLag; t++) {
    if (cm[t] < 0.15) {
      while (t + 1 <= maxLag && cm[t + 1] < cm[t]) t++;
      const a = cm[t - 1], b = cm[t], c = cm[t + 1], den = a - 2 * b + c;
      const shift = den ? Math.max(-1, Math.min(1, (a - c) / (2 * den))) : 0;
      return sr / (t + shift);
    }
  }
  return null;
}
