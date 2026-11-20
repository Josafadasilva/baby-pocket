// midi.js — ligação com o pedal via Web MIDI (Chrome no Android, cabo USB-OTG) + pedal de demonstração.
import * as P from "./protocol.js";

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
    this.listener = null;
  }
  onMessage(fn) { this.listener = fn; }
  async send(bytes) {
    let m;
    try { m = P.decodeMessage(bytes); } catch { return; }
    await sleep(15);
    const reply = (u8) => this.listener && this.listener(u8);
    if (m.kind === "identity-request") reply(P.encodeIdentityResponse(this.name));
    else if (m.kind === "read-request") {
      const src = m.address >= P.LIVE_BASE ? this.live : this.bank;
      const start = m.address >= P.LIVE_BASE ? m.address - P.LIVE_BASE : m.address;
      reply(P.encodeReadResponse(m.memory, m.address, src.slice(start, start + m.length)));
    } else if (m.kind === "write-request") {
      if (m.address >= P.LIVE_BASE) this.live.set(m.data, m.address - P.LIVE_BASE);
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

  async connectUsb() {
    if (!CubeLink.supported()) throw new Error("Este navegador não tem Web MIDI. Use o Chrome no Android.");
    this.access = await navigator.requestMIDIAccess({ sysex: true });
    this.access.onstatechange = () => this.#refresh();
    await this.#refresh(true);
    if (!this.input || !this.output) {
      throw new Error("Pedal não encontrado. Ligue o cabo USB (OTG), feche o CubeSuite e tente de novo.");
    }
  }

  #pick(ports) {
    const list = [...ports.values()];
    return (
      list.find((p) => /cube[\s-]*baby/i.test(p.name || "")) ||
      list.find((p) => /m-?vave|cuvave|sinco/i.test(`${p.manufacturer} ${p.name}`)) ||
      // o driver genérico do Windows chama a porta de "USB-Midi"; a identidade é conferida depois
      (list.length === 1 && /usb[\s-]*midi/i.test(list[0].name || "") ? list[0] : null)
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
    this.input = this.output = this.demo = null;
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
