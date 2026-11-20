// midi.js — ligação com o pedal via Web MIDI (Chrome no Android, cabo USB-OTG) + pedal de demonstração.
import * as P from "./protocol.js";
import * as IR from "./ir.js";
import { BLE_MIDI_SERVICE, BLE_MIDI_CHAR, packBle, BleUnpacker } from "./blemidi.js";

const TIMEOUT_MS = 1500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Pedal falso em memória: responde como o real, para testar a interface sem hardware. */
export class DemoPedal {
  constructor() {
    this.name = "SINCO-CubeBaby (demo)";
    this.bank = Uint8Array.from([
      5, 3, 3, 6, 5, 99, 5, 7, 8, 8, 1, 1, 1, 0, 0, 0,
      2, 0, 9, 4, 20, 110, 12, 40, 8, 3, 1, 1, 0, 0, 0, 0,
      7, 5, 12, 2, 60, 100, 20, 80, 3, 6, 1, 0, 1, 0, 0, 0,
    ]);
    this.live = this.bank.slice();
    this.rom = new Uint8Array(0x72000).fill(0xff);       // memória 0 (flash dos IRs)
    this.rom.fill(0, IR.UPLOAD_ADDRESS, IR.UPLOAD_ADDRESS + IR.SECTOR_BYTES);
    this.rom.set(Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0x3f, 1, 2, 3), IR.UPLOAD_ADDRESS); // IR "antigo"
    this.irLive = new Uint8Array(68);
    this.failWriteAfter = null;                          // teste: falha na N-ésima escrita de ROM
    this.romWrites = 0;
    this.listener = null;
  }
  onMessage(fn) { this.listener = fn; }
  async send(bytes) {
    let m;
    try { m = P.decodeMessage(bytes); } catch { return; }
    await sleep(15);
    const reply = (u8) => this.listener && this.listener(u8);
    if (m.kind === "identity-request") reply(P.encodeIdentityResponse(this.name));
    else if (m.kind === "erase-request" && m.memory === 0) {
      const base = m.address - (m.address % IR.SECTOR_BYTES);
      this.rom.fill(0xff, base, base + IR.SECTOR_BYTES);
      reply(P.encodeAck(true));
    } else if (m.kind === "read-request" && m.memory === 0) {
      reply(P.encodeReadResponse(0, m.address, this.rom.slice(m.address, m.address + m.length)));
    } else if (m.kind === "read-request" && m.memory === 4) {
      reply(P.encodeReadResponse(4, m.address, this.irLive.slice(0, m.length)));
    } else if (m.kind === "write-request" && m.memory === 0) {
      this.romWrites++;
      if (this.failWriteAfter !== null && this.romWrites > this.failWriteAfter) { this.failWriteAfter = null; reply(P.encodeAck(false)); return; } // perde esta escrita (falha única)
      this.rom.set(m.data, m.address);
      reply(P.encodeAck(true));
    } else if (m.kind === "read-request") {
      const src = m.address >= P.LIVE_BASE ? this.live : this.bank;
      const start = m.address >= P.LIVE_BASE ? m.address - P.LIVE_BASE : m.address;
      reply(P.encodeReadResponse(m.memory, m.address, src.slice(start, start + m.length)));
    } else if (m.kind === "write-request") {
      if (m.address >= P.LIVE_BASE) {
        this.live.set(m.data, m.address - P.LIVE_BASE);
        const off = m.address - P.LIVE_BASE;
        if (off % 16 === 9 && m.data[0] >= 1) { // trocou de cabinet: recarrega o IR "ao vivo"
          const a = IR.IR_BASE + (m.data[0] - 1) * IR.SECTOR_BYTES;
          this.irLive = this.rom.slice(a + 4, a + 72);
        }
      }
      else this.bank.set(m.data, m.address);
      reply(P.encodeAck(false)); // o pedal real costuma responder "não aceito" a escritas live
    }
  }
}

export class CubeLink extends EventTarget {
  constructor() {
    super();
    this.access = null;
    this.input = null;
    this.output = null;
    this.demo = null;
    this.ble = null;
    this.pending = null;
    this.chain = Promise.resolve();
    this.buffer = [];
    this.connected = false;
    this.deviceName = "";
  }

  static supported() { return typeof navigator !== "undefined" && "requestMIDIAccess" in navigator; }

  #emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  async connectDemo() {
    this.demo = new DemoPedal();
    this.demo.onMessage((u8) => this.#onBytes(u8));
    this.connected = true;
    this.deviceName = this.demo.name;
    this.#emit("state", { connected: true, name: this.deviceName });
  }

  static bleSupported() { return typeof navigator !== "undefined" && "bluetooth" in navigator; }

  /** Experimental: BLE-MIDI. Só funciona se o pedal expuser o serviço MIDI por Bluetooth. */
  async connectBle() {
    if (!CubeLink.bleSupported()) throw new Error("Este navegador não tem Web Bluetooth. Use o Chrome (Android ou PC).");
    const device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: [BLE_MIDI_SERVICE] });
    let characteristic;
    try {
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(BLE_MIDI_SERVICE);
      characteristic = await service.getCharacteristic(BLE_MIDI_CHAR);
    } catch {
      try { device.gatt.disconnect(); } catch { /* já desconectado */ }
      throw new Error(`“${device.name || "Dispositivo"}” não oferece MIDI por Bluetooth. Use o cabo USB.`);
    }
    const unpacker = new BleUnpacker();
    await characteristic.startNotifications();
    characteristic.addEventListener("characteristicvaluechanged", (e) => {
      const dv = e.target.value;
      for (const sysex of unpacker.push(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength))) this.#onBytes(sysex);
    });
    device.addEventListener("gattserverdisconnected", () => this.disconnect());
    this.ble = { device, characteristic };
    this.connected = true;
    this.deviceName = device.name || "Bluetooth MIDI";
    this.#emit("state", { connected: true, name: this.deviceName });
  }

  async connectUsb() {
    if (!CubeLink.supported()) throw new Error("Este navegador não tem Web MIDI. Use o Chrome no Android.");
    this.access = await navigator.requestMIDIAccess({ sysex: true });
    this.access.onstatechange = () => this.#refresh();
    await this.#refresh(true);
    if (!this.input || !this.output) {
      const seen = [...this.access.inputs.values()].map((p) => p.name).join(", ") || "nenhuma porta MIDI";
      throw new Error(`Pedal não encontrado (o Chrome viu: ${seen}). Ligue o cabo USB (OTG), feche o CubeSuite e tente de novo.`);
    }
  }

  #pick(ports) {
    const list = [...ports.values()];
    return (
      list.find((p) => /cube[\s-]*baby/i.test(p.name || "")) ||
      list.find((p) => /m-?vave|cuvave|sinco/i.test(`${p.manufacturer} ${p.name}`)) ||
      // nomes genéricos do driver do sistema (Windows: "USB-Midi"; Android: "USB2.0 Device"/Smartlink).
      // A identidade do aparelho é conferida depois da conexão.
      list.find((p) => /smartlink|usb[\s-]*midi|usb\s*2\.0\s*device/i.test(`${p.manufacturer} ${p.name}`)) ||
      null
    );
  }

  async #refresh(force = false) {
    const input = this.#pick(this.access.inputs);
    const output = this.#pick(this.access.outputs);
    const was = this.connected;
    if (this.input && this.input !== input) this.input.onmidimessage = null;
    this.input = input;
    this.output = output;
    if (input) input.onmidimessage = (e) => this.#onBytes(e.data);
    this.connected = Boolean(input && output);
    this.deviceName = input ? input.name : "";
    if (this.connected && (force || !was)) {
      try { await input.open(); await output.open(); } catch { /* o Chrome abre na primeira troca */ }
    }
    if (force || was !== this.connected) this.#emit("state", { connected: this.connected, name: this.deviceName });
  }

  async disconnect() {
    if (this.input) this.input.onmidimessage = null;
    if (this.ble) { try { this.ble.device.gatt.disconnect(); } catch { /* ok */ } }
    this.input = this.output = this.demo = this.ble = null;
    this.connected = false;
    this.#emit("state", { connected: false, name: "" });
  }

  #onBytes(bytes) {
    for (const b of bytes) {
      if (b === 0xf0) this.buffer = [b];
      else if (this.buffer.length) {
        this.buffer.push(b);
        if (b === 0xf7) {
          const raw = Uint8Array.from(this.buffer);
          this.buffer = [];
          let msg;
          try { msg = P.decodeMessage(raw); } catch { continue; }
          if (this.pending && this.pending.match(msg)) this.pending.resolve(msg);
        }
      }
    }
  }

  async #send(bytes) {
    if (this.demo) return this.demo.send(bytes);
    if (this.ble) {
      for (const packet of packBle(bytes)) {
        await (this.ble.characteristic.writeValueWithoutResponse?.(packet) ?? this.ble.characteristic.writeValue(packet));
        await sleep(8);
      }
      return;
    }
    if (!this.output) throw new Error("Pedal desconectado.");
    this.output.send(bytes);
  }

  /** Uma troca por vez: envia o pedido e espera a resposta que combina. */
  exchange(request, match, timeoutMs = TIMEOUT_MS) {
    const run = async () => {
      const response = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this.pending = null; reject(new Error("O pedal não respondeu a tempo.")); }, timeoutMs);
        this.pending = { match, resolve: (m) => { clearTimeout(timer); this.pending = null; resolve(m); } };
      });
      await this.#send(request);
      return response;
    };
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => {});
    return result;
  }

  async handshake() {
    await this.exchange(P.encodeIdentityRequest(), (m) => m.kind === "identity-response").catch(() => {});
    await sleep(80);
  }

  async identify() {
    const m = await this.exchange(P.encodeIdentityRequest(), (m) => m.kind === "identity-response");
    return m.name;
  }

  async readBank() {
    const m = await this.exchange(
      P.encodeMemoryRead(P.BANK_MEMORY, P.BANK_ADDRESS, P.BANK_BYTES),
      (m) => m.kind === "read-response" && m.address === P.BANK_ADDRESS && m.data.length === P.BANK_BYTES,
    );
    if (!m.checksumOk) throw new Error("Resposta do pedal com checksum inválido.");
    return m.data.slice();
  }

  /** Escreve 1 byte na RAM live (um knob). Aceita ack "recusado": é o comportamento normal do pedal. */
  async writeLive(slot, offset, value) {
    await this.handshake();
    await this.exchange(
      P.encodeMemoryWrite(P.BANK_MEMORY, P.liveAddress(slot, offset), Uint8Array.of(value)),
      (m) => m.kind === "ack",
    );
  }

  /** Empurra os 13 campos de um slot para a RAM live. */
  async pushSlotLive(bank, slot) {
    for (let off = 0; off < P.FIELD_COUNT; off++) {
      await this.exchange(
        P.encodeMemoryWrite(P.BANK_MEMORY, P.liveAddress(slot, off), Uint8Array.of(bank[slot * P.SLOT_BYTES + off])),
        (m) => m.kind === "ack",
      );
      await sleep(40);
    }
  }

  // ---------- IR (flash, memória 0). Só o setor do slot de upload (Cab 8) é gravado. ----------
  async readRom(address, length, onProgress) {
    const out = new Uint8Array(length);
    for (let o = 0; o < length; o += IR.READ_CHUNK) {
      const n = Math.min(IR.READ_CHUNK, length - o);
      const m = await this.exchange(P.encodeMemoryRead(IR.ROM_MEMORY, address + o, n),
        (r) => r.kind === "read-response" && r.address === address + o && r.data.length === n);
      if (!m.checksumOk) throw new Error("Resposta do pedal com checksum inválido.");
      out.set(m.data, o);
      onProgress?.(Math.min(1, (o + n) / length));
      await sleep(40);
    }
    return out;
  }

  /** Lê só a distância do microfone (float 0..1, 4 bytes) do IR de um Cab 1–8. Somente leitura. */
  async readCabDistance(cab) {
    if (!Number.isInteger(cab) || cab < 1 || cab > 8) throw new Error("Cab inválido.");
    const b = await this.readRom(IR.IR_BASE + (cab - 1) * IR.SECTOR_BYTES + 4, 4);
    const d = new DataView(b.buffer).getFloat32(0, true);
    if (!Number.isFinite(d)) throw new Error(`O Cab ${cab} não tem uma distância válida.`);
    return Math.min(1, Math.max(0, d));
  }

  /** Apaga o setor, grava em blocos de 128 bytes e confere lendo de volta. */
  async flashSector(sector, onProgress) {
    if (sector.length !== IR.SECTOR_BYTES) throw new Error("O setor de IR precisa ter 4096 bytes.");
    const address = IR.UPLOAD_ADDRESS; // endereço fixo: este app nunca grava em outro slot
    await this.exchange(P.encodeMemoryErase(IR.ROM_MEMORY, address), (m) => m.kind === "ack", 4000);
    await sleep(250);
    for (let o = 0; o < sector.length; o += IR.WRITE_CHUNK) {
      await this.exchange(P.encodeMemoryWrite(IR.ROM_MEMORY, address + o, sector.subarray(o, o + IR.WRITE_CHUNK)), (m) => m.kind === "ack", 3000);
      onProgress?.(Math.min(1, (o + IR.WRITE_CHUNK) / sector.length));
      await sleep(40);
    }
    await sleep(250);
    const after = await this.readRom(address, sector.length);
    return { verified: after.every((b, i) => b === sector[i]), after };
  }

  /** Seleciona o Cab 8 ao vivo (passa por outro valor antes, para o IR recarregar). */
  async selectUploadCabinet(slot) {
    await this.writeLive(slot, P.PARAM.cabinet.offset, 1); await sleep(350);
    await this.writeLive(slot, P.PARAM.cabinet.offset, 8); await sleep(350);
  }

  async liveIrMatch(sector) {
    const m = await this.exchange(P.encodeMemoryRead(4, 1896, 68), (r) => r.kind === "read-response" && r.address === 1896 && r.data.length === 68);
    const expected = sector.subarray(4, 72);
    let same = 0; for (let i = 0; i < 68; i++) if (m.data[i] === expected[i]) same++;
    return same;
  }

  /** Grava o banco inteiro (48 bytes) e confere lendo de volta. */
  async writeBank(bank) {
    if (bank.length !== P.BANK_BYTES) throw new Error("O banco precisa ter 48 bytes.");
    await this.exchange(P.encodeMemoryWrite(P.BANK_MEMORY, P.BANK_ADDRESS, bank), (m) => m.kind === "ack");
    await sleep(250);
    let after = await this.readBank();
    let verified = after.every((b, i) => b === bank[i]);
    if (!verified) {
      await sleep(250);
      after = await this.readBank();
      verified = after.every((b, i) => b === bank[i]);
    }
    return { verified, after };
  }
}

/** Fila de knobs: junta movimentos rápidos e manda só o último valor de cada campo. */
export class LiveWriter {
  constructor(link, onError) {
    this.link = link;
    this.onError = onError;
    this.dirty = new Map();
    this.running = false;
  }
  set(slot, offset, value) {
    this.dirty.set(`${slot}:${offset}`, [slot, offset, value]);
    this.#run();
  }
  async #run() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.dirty.size) {
        const [key, [slot, offset, value]] = this.dirty.entries().next().value;
        this.dirty.delete(key);
        await this.link.writeLive(slot, offset, value);
      }
    } catch (e) {
      this.dirty.clear();
      this.onError(e);
    } finally {
      this.running = false;
    }
  }
}
