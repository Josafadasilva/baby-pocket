import assert from "node:assert/strict";
import * as P from "../protocol.js";
import { packBle, BleUnpacker } from "../blemidi.js";
let n = 0; const ok = (m) => { n++; console.log("ok  - " + m); };
for (const [name, msg] of [
  ["leitura de banco", P.encodeMemoryRead(5, 0, 48)],
  ["escrita longa (48 bytes)", P.encodeMemoryWrite(5, 0, Uint8Array.from({ length: 48 }, (_, i) => i))],
  ["identidade", P.encodeIdentityRequest()],
]) {
  for (const size of [20, 23, 185]) {
    const packets = packBle(msg, size, 1234);
    assert.ok(packets.every((p) => p.length <= size && p[0] & 0x80));
    const u = new BleUnpacker(); const got = packets.flatMap((p) => u.push(p));
    assert.equal(got.length, 1); assert.deepEqual([...got[0]], [...msg]);
  }
  ok(`${name}: ida e volta em pacotes de 20/23/185`);
}
console.log(`\n${n} testes passaram`);
