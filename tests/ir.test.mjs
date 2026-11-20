// Compara o conversor de IR com o código de referência extraído do CubeControl (MIT).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import * as IR from "../ir.js";
const require = createRequire(import.meta.url);
let n = 0; const ok = (m) => { n++; console.log("ok  - " + m); };

function makeWav({ rate = 48000, channels = 1, bits = 16, float = false, frames = 700 }) {
  const bytesPer = bits / 8, dataSize = frames * channels * bytesPer, b = new Uint8Array(44 + dataSize), v = new DataView(b.buffer);
  const w = (o, s) => [...s].forEach((c, i) => (b[o + i] = c.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + dataSize, true); w(8, "WAVE"); w(12, "fmt "); v.setUint32(16, 16, true);
  v.setUint16(20, float ? 3 : 1, true); v.setUint16(22, channels, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * channels * bytesPer, true); v.setUint16(32, channels * bytesPer, true); v.setUint16(34, bits, true);
  w(36, "data"); v.setUint32(40, dataSize, true);
  let p = 44;
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) {
    const x = Math.sin(i * 0.05 + c) * Math.exp(-i / 200) * 0.9;
    if (float) { v.setFloat32(p, x, true); p += 4; }
    else if (bits === 16) { v.setInt16(p, Math.round(x * 32767), true); p += 2; }
    else if (bits === 24) { const q = Math.round(x * 8388607); b[p] = q & 255; b[p + 1] = (q >> 8) & 255; b[p + 2] = (q >> 16) & 255; p += 3; }
    else { v.setInt32(p, Math.round(x * 2147483647), true); p += 4; }
  }
  return b;
}

const refPath = process.env.IR_REF || "/tmp/claude-0/ir_ref.js";
const ref = existsSync(refPath) ? require(refPath) : null;
for (const cfg of [{ bits: 16 }, { bits: 24, channels: 2 }, { bits: 32 }, { bits: 32, float: true, rate: 44100 }, { bits: 16, rate: 96000, frames: 3000 }, { bits: 16, frames: 100 }]) {
  const wav = makeWav(cfg);
  const mine = IR.wavToSector(wav).sector;
  assert.equal(mine.length, 4096);
  if (ref) {
    const parsed = ref.zi(wav), s = ref.Hi(parsed.samples, parsed.sampleRate);
    const theirs = ref.Ki({ samples: s, volume: 0.5, presence: "upload" });
    assert.deepEqual([...mine], [...theirs]);
  }
  ok(`WAV ${JSON.stringify(cfg)} → setor idêntico ao do CubeControl${ref ? "" : " (referência ausente: só tamanho)"}`);
}
assert.throws(() => IR.parseWav(new Uint8Array(10)));
assert.throws(() => IR.parseWav(Uint8Array.from({ length: 100 }, () => 1)));
ok("arquivos inválidos são recusados");
const s = IR.wavToSector(makeWav({})).sector;
assert.equal(s[0] | s[1] | s[2] | s[3], 0); ok("flag de upload = 0 e endereço do slot 7 = 0x70000");
assert.equal(IR.UPLOAD_ADDRESS, 0x70000);
console.log(`\n${n} testes passaram`);
