// ir.js — conversão de WAV para o setor de IR do Cube Baby (Cab 8) e constantes do procedimento.
// Formato observado no CubeControl: setor de 4096 bytes = [flag(4) | volume float32 LE (4) | 512 amostras float32 LE | zeros].
export const IR_SAMPLES = 512;
export const IR_RATE = 48000;
export const SECTOR_BYTES = 4096;
export const IR_BASE = 0x69000;           // slot 0; cada slot ocupa 0x1000
export const UPLOAD_SLOT = 7;             // único slot que este app grava (Cab 8)
export const UPLOAD_ADDRESS = IR_BASE + UPLOAD_SLOT * SECTOR_BYTES; // 0x70000
export const ROM_MEMORY = 0;
export const READ_CHUNK = 113;
export const WRITE_CHUNK = 128;
export const DEFAULT_VOLUME = 0.5;

function findChunk(view, id, start) {
  let p = start;
  while (p + 8 <= view.byteLength) {
    const name = String.fromCharCode(view.getUint8(p), view.getUint8(p + 1), view.getUint8(p + 2), view.getUint8(p + 3));
    const size = view.getUint32(p + 4, true);
    if (name === id) return { offset: p + 8, size };
    p += 8 + size + (size % 2);
  }
  throw new Error(`WAV sem bloco "${id}".`);
}

/** Lê um WAV PCM 16/24/32 bits ou float 32; mistura os canais fazendo a média. */
export function parseWav(bytes) {
  if (bytes.length < 44) throw new Error("Arquivo WAV pequeno demais.");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("Não é um arquivo WAV.");
  const fmt = findChunk(v, "fmt ", 12);
  const format = v.getUint16(fmt.offset, true), channels = v.getUint16(fmt.offset + 2, true);
  const sampleRate = v.getUint32(fmt.offset + 4, true), bits = v.getUint16(fmt.offset + 14, true);
  if (channels < 1) throw new Error("WAV sem canais.");
  const data = findChunk(v, "data", 12);
  const frame = (bits / 8) * channels;
  if (!Number.isInteger(frame) || frame <= 0) throw new Error("Formato de WAV não suportado.");
  const frames = Math.floor(Math.min(data.size, v.byteLength - data.offset) / frame);
  const out = new Float32Array(frames);
  let p = data.offset;
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      if (format === 3 && bits === 32) { sum += v.getFloat32(p, true); p += 4; }
      else if (format === 1 && bits === 16) { sum += v.getInt16(p, true) / 32768; p += 2; }
      else if (format === 1 && bits === 24) {
        let x = (v.getUint8(p + 2) << 16) | (v.getUint8(p + 1) << 8) | v.getUint8(p);
        p += 3; if (x & 0x800000) x |= -0x1000000; sum += x / 8388608;
      } else if (format === 1 && bits === 32) { sum += v.getInt32(p, true) / 2147483648; p += 4; }
      else throw new Error(`WAV não suportado (formato ${format}, ${bits} bits). Use PCM 16/24/32 bits ou float 32.`);
    }
    out[i] = sum / channels;
  }
  return { sampleRate, samples: out, channels };
}

function fit(samples, n) {
  if (samples.length === n) return samples.slice();
  const out = new Float32Array(n); out.set(samples.subarray(0, Math.min(samples.length, n))); return out;
}

/** Reamostra (interpolação linear) para 48 kHz e ajusta para 512 amostras. */
export function toIrSamples(samples, sampleRate) {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error("Taxa de amostragem inválida.");
  if (!samples.length) throw new Error("O WAV não tem amostras.");
  let s = samples;
  if (sampleRate !== IR_RATE) {
    const ratio = sampleRate / IR_RATE, n = Math.max(1, Math.round(samples.length / ratio)), r = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const pos = i * ratio, lo = Math.floor(pos), hi = Math.min(lo + 1, samples.length - 1), f = pos - lo;
      const a = samples[lo] ?? 0, b = samples[hi] ?? 0; r[i] = a + (b - a) * f;
    }
    s = r;
  }
  return fit(s, IR_SAMPLES);
}

/** Monta o setor de 4096 bytes para o slot de upload (flag 0). */
export function buildSector(samples512, volume = DEFAULT_VOLUME) {
  if (!Number.isFinite(volume)) throw new Error("Volume inválido.");
  const sector = new Uint8Array(SECTOR_BYTES);
  const v = new DataView(sector.buffer);
  v.setFloat32(4, volume, true);
  const s = fit(samples512, IR_SAMPLES);
  for (let i = 0; i < s.length; i++) v.setFloat32(8 + i * 4, s[i] ?? 0, true);
  return sector;
}

export function wavToSector(bytes, volume = DEFAULT_VOLUME) {
  const wav = parseWav(bytes);
  const samples = toIrSamples(wav.samples, wav.sampleRate);
  let peak = 0; for (const x of samples) peak = Math.max(peak, Math.abs(x));
  const seconds = wav.samples.length / wav.sampleRate;
  return { sector: buildSector(samples, volume), samples, info: { sampleRate: wav.sampleRate, channels: wav.channels, frames: wav.samples.length, seconds, truncated: seconds * IR_RATE > IR_SAMPLES, peak } };
}
