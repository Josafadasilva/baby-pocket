// blemidi.js — transporte BLE-MIDI (SysEx) para Web Bluetooth. Funções puras, testáveis no Node.
export const BLE_MIDI_SERVICE = "03b80e5a-ede8-4b33-a751-6ce34ec4c700";
export const BLE_MIDI_CHAR = "7772e5db-3868-4112-a1a9-f2669d106bf3";

/** Divide uma mensagem SysEx (F0..F7) em pacotes BLE-MIDI de até `size` bytes. */
export function packBle(sysex, size = 20, now = Date.now()) {
  if (sysex[0] !== 0xf0 || sysex[sysex.length - 1] !== 0xf7) throw new Error("SysEx sem F0/F7");
  const ts = now & 0x1fff;
  const header = 0x80 | ((ts >> 7) & 0x3f);
  const low = 0x80 | (ts & 0x7f);
  const stream = [...sysex.slice(0, -1), low, 0xf7]; // o timestamp vem antes do F7
  const packets = [];
  let i = 0;
  while (i < stream.length) {
    const first = packets.length === 0;
    const room = size - (first ? 2 : 1);
    const chunk = stream.slice(i, i + room); i += room;
    packets.push(Uint8Array.from(first ? [header, low, ...chunk] : [header, ...chunk]));
  }
  return packets;
}

/** Remonta SysEx a partir de pacotes recebidos. Guarda estado entre chamadas. */
export class BleUnpacker {
  constructor() { this.buf = null; }
  push(packet) {
    const out = [];
    for (let i = 1; i < packet.length; i++) { // [0] é o cabeçalho
      const b = packet[i];
      if (b === 0xf0) this.buf = [0xf0];
      else if (b === 0xf7) { if (this.buf) { this.buf.push(0xf7); out.push(Uint8Array.from(this.buf)); } this.buf = null; }
      else if (b & 0x80) continue; // timestamp ou mensagem que não é SysEx
      else if (this.buf) this.buf.push(b);
    }
    return out;
  }
}
