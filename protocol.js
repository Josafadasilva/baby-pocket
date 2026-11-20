// protocol.js — mensagens SysEx do M-VAVE CUBE Baby (USB-MIDI).
// Escrito do zero a partir do formato observado (envelope 00 59 + tipo + len24 + conteúdo + checksum,
// codificado em 7 bits). Funciona no navegador e no Node (para testes).

export const MAGIC = [0x00, 0x59];
export const MSG = { ACK: 0x00, IDENTITY: 0x11, ERASE: 0x21, WRITE: 0x22, READ: 0x23, REGISTER: 0x24 };

export const BANK_MEMORY = 5;
export const BANK_ADDRESS = 0x00000000;
export const LIVE_BASE = 0x80000000;
export const SLOT_BYTES = 16;
export const SLOT_COUNT = 3;
export const BANK_BYTES = SLOT_BYTES * SLOT_COUNT;

/** Campos de um slot (offset dentro dos 16 bytes) e teto de cada um. */
export const PARAMS = [
  { id: "type",         offset: 0,  max: 8 },
  { id: "gain",         offset: 1,  max: 7 },
  { id: "tone",         offset: 2,  max: 15 },
  { id: "reverb",       offset: 3,  max: 15 },
  { id: "feedback",     offset: 4,  max: 127 },
  { id: "volume",       offset: 5,  max: 127 },
  { id: "time",         offset: 6,  max: 31 },
  { id: "mix",          offset: 7,  max: 118 },
  { id: "modulation",   offset: 8,  max: 15 },
  { id: "cabinet",      offset: 9,  max: 8 },
  { id: "irSection",    offset: 10, max: 1 },
  { id: "delaySection", offset: 11, max: 1 },
  { id: "toneSection",  offset: 12, max: 1 },
];
export const PARAM = Object.fromEntries(PARAMS.map((p) => [p.id, p]));
export const FIELD_COUNT = PARAMS.length; // 13
/** MOD é bipolar: 0–6 chorus, 7–8 desligado, 9–15 phaser. */
export const MOD_OFF = 8;

export function clampParam(id, value) {
  const p = PARAM[id];
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(p.max, Math.round(value)));
}

// ---------- 7 bits ----------
export function encodeSevenBit(source) {
  const out = [];
  let bitCount = 0;
  let acc = 0;
  for (const byte of source) {
    acc = (acc | (byte << (bitCount & 0x1f))) >>> 0;
    bitCount += 1;
    for (;;) {
      out.push(acc & 0x7f);
      acc >>>= 7;
      if (bitCount < 7) break;
      bitCount -= 7;
    }
  }
  if (acc > 0) out.push(acc & 0x7f);
  const padded = Math.ceil((source.length * 8) / 7);
  while (out.length < padded) out.push(0);
  return Uint8Array.from(out);
}

export function decodeSevenBit(source) {
  const out = [];
  let bitCount = 0;
  let last = 0;
  for (const byte of source) {
    const mask = bitCount === 0 ? 0 : 0xffffffff >>> (32 - bitCount);
    const acc = byte & mask;
    if (bitCount > 0) out.push(((last & 0x7f) | (acc << (8 - bitCount))) & 0xff);
    last = byte >>> bitCount;
    bitCount = (bitCount + 1) % 8;
  }
  if (last > 0) out.push(last);
  return Uint8Array.from(out);
}

// ---------- envelope ----------
export function checksum(content) {
  let sum = 0;
  for (const b of content) sum = (sum + b) & 0xff;
  return ~sum & 0xff;
}

const u24 = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff];
const u32 = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
const r24 = (d, o) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16)) >>> 0;
const r32 = (d, o) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;

function envelope(type, content) {
  const clear = Uint8Array.from([...MAGIC, type, ...u24(content.length), ...content, checksum(content)]);
  return Uint8Array.from([0xf0, ...encodeSevenBit(clear), 0xf7]);
}

export const encodeIdentityRequest = () => envelope(MSG.IDENTITY, []);

export function encodeMemoryRead(memory, address, length) {
  return envelope(MSG.READ, [memory, ...u32(address), ...u24(length)]);
}

export function encodeMemoryErase(memory, address) {
  return envelope(MSG.ERASE, [memory, ...u32(address)]);
}

export function encodeMemoryWrite(memory, address, data) {
  if (data.length < 1) throw new Error("dados vazios");
  return envelope(MSG.WRITE, [memory, ...u32(address), ...u24(data.length), ...data]);
}

/** Respostas (usadas só pelo modo demonstração). */
export const encodeAck = (accepted) => envelope(MSG.ACK, [accepted ? 1 : 0]);
export function encodeReadResponse(memory, address, data) {
  return envelope(MSG.READ, [memory, ...u32(address), ...u24(data.length), ...data]);
}
export function encodeIdentityResponse(name) {
  const text = [...name].map((c) => c.charCodeAt(0));
  return envelope(MSG.IDENTITY, [...text, 0x00, 1, 19, 20, 21, 22, 23, 24, 25]);
}

export function decodeMessage(sysex) {
  if (sysex[0] !== 0xf0 || sysex[sysex.length - 1] !== 0xf7) throw new Error("SysEx sem F0/F7");
  const clear = decodeSevenBit(sysex.slice(1, -1));
  if (clear.length < 7) throw new Error("payload curto");
  if (clear[0] !== MAGIC[0] || clear[1] !== MAGIC[1]) throw new Error("magic inválido");
  const type = clear[2];
  const len = r24(clear, 3);
  if (clear.length !== 7 + len) throw new Error("tamanho não confere");
  const content = clear.slice(6, 6 + len);
  const checksumOk = clear[6 + len] === checksum(content);

  const base = { type, content, checksumOk };
  if (type === MSG.IDENTITY) {
    if (content.length === 0) return { ...base, kind: "identity-request" };
    let n = content.findIndex((b) => b < 0x20 || b > 0x7e);
    if (n === -1) n = Math.min(16, content.length);
    const name = String.fromCharCode(...content.slice(0, n)).trimEnd();
    return { ...base, kind: "identity-response", name };
  }
  if (type === MSG.ACK && content.length === 1) {
    return { ...base, kind: "ack", accepted: content[0] > 0, raw: content[0] };
  }
  if ((type === MSG.READ || type === MSG.WRITE) && content.length >= 8) {
    const memory = content[0];
    const address = r32(content, 1);
    const length = r24(content, 5);
    const data = content.slice(8);
    if (type === MSG.READ) {
      return data.length === 0
        ? { ...base, kind: "read-request", memory, address, length }
        : { ...base, kind: "read-response", memory, address, length, data };
    }
    return { ...base, kind: "write-request", memory, address, length, data };
  }
  if (type === MSG.ERASE && content.length === 5) return { ...base, kind: "erase-request", memory: content[0], address: r32(content, 1) };
  return { ...base, kind: "unknown" };
}

// ---------- banco / slots ----------
export const liveAddress = (slot, offset) => LIVE_BASE + slot * SLOT_BYTES + offset;

export function slotToObject(bank, slot) {
  const o = {};
  for (const p of PARAMS) o[p.id] = bank[slot * SLOT_BYTES + p.offset];
  return o;
}
export function setSlotValue(bank, slot, id, value) {
  bank[slot * SLOT_BYTES + PARAM[id].offset] = clampParam(id, value);
}
export const SLOT_NAMES = ["A", "B", "C"];
