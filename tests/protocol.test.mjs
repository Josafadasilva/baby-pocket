import assert from "node:assert/strict";
import * as P from "../protocol.js";

const hex = (h) => Uint8Array.from(h.match(/.{2}/g).map((b) => parseInt(b, 16)));
const toHex = (u) => [...u].map((b) => b.toString(16).padStart(2, "0")).join("");
let n = 0; const ok = (name, fn) => { fn(); n++; console.log("ok  -", name); };

ok("identity request == captura do CubeSuite", () => {
  assert.equal(toHex(P.encodeIdentityRequest()), "f0003245000000407ff7");
});
ok("read 48 bytes do banco == captura", () => {
  assert.equal(toHex(P.encodeMemoryRead(5, 0, 48)), "f000320d410000400200000000000600004a01f7");
});
ok("identity response do pedal real", () => {
  const m = P.decodeMessage(hex("f00032455801004029491c0d7a5465503a624a090a262c1e10204000011260040a152c5c40114307f7"));
  assert.equal(m.kind, "identity-response");
  assert.equal(m.name, "SINCO-CubeBaby");
  assert.equal(m.checksumOk, true);
});
ok("resposta de leitura do banco (48 bytes) com checksum válido", () => {
  const m = P.decodeMessage(hex("f000320d4103004002000000000006000005060c305060580207102008102000000000141840404120733040420021400001000000600040010a32115a20014202010204000000000ef7"));
  assert.equal(m.kind, "read-response");
  assert.equal(m.memory, 5); assert.equal(m.address, 0); assert.equal(m.data.length, 48);
  assert.equal(m.checksumOk, true);
  const s = P.slotToObject(m.data, 0);
  for (const p of P.PARAMS) assert.ok(s[p.id] <= p.max || p.id === "irSection", `${p.id}=${s[p.id]} > ${p.max}`);
  console.log("      slot A:", JSON.stringify(s));
});
ok("ida e volta: escrita live de 1 byte", () => {
  const msg = P.encodeMemoryWrite(5, P.liveAddress(1, 7), Uint8Array.of(42));
  const m = P.decodeMessage(msg);
  assert.equal(m.kind, "write-request");
  assert.equal(m.address, 0x80000017); assert.deepEqual([...m.data], [42]); assert.equal(m.checksumOk, true);
});
ok("ida e volta 7 bits em dados aleatórios", () => {
  for (let i = 0; i < 200; i++) {
    const a = Uint8Array.from({ length: 1 + (i % 60) }, () => Math.floor(Math.random() * 256));
    assert.deepEqual(P.decodeSevenBit(P.encodeSevenBit(a)), a);
  }
});
ok("ack recusado (estilo escrita live)", () => {
  const m = P.decodeMessage(P.encodeAck(false));
  assert.equal(m.kind, "ack"); assert.equal(m.accepted, false);
});
console.log(`\n${n} testes passaram`);
