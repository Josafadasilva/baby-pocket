import assert from "node:assert/strict";
import { detectPitch } from "../pitch.js";
const SR = 48000, N = 4096;
const make = (f, harm) => Float32Array.from({ length: N }, (_, i) => harm.reduce((s, [mult, amp]) => s + amp * Math.sin(2 * Math.PI * f * mult * i / SR), 0) * 0.3);
const cases = [["E2 82.41", 82.41], ["A2 110", 110], ["D3 146.83", 146.83], ["G3 196", 196], ["B3 246.94", 246.94], ["E4 329.63", 329.63], ["A4 440", 440]];
for (const [name, f] of cases) {
  for (const [label, harm] of [["senoide", [[1, 1]]], ["corda (2º harmônico forte)", [[1, 0.6], [2, 1], [3, 0.5]]]]) {
    const got = detectPitch(make(f, harm), SR);
    const cents = 1200 * Math.log2(got / f);
    assert.ok(got && Math.abs(cents) < 4, `${name} ${label}: detectou ${got} (${cents?.toFixed(1)} cents)`);
    console.log(`ok  - ${name} ${label}: ${got.toFixed(2)} Hz (${cents.toFixed(2)} cents)`);
  }
}
assert.equal(detectPitch(new Float32Array(N), SR), null);
const noise = Float32Array.from({ length: N }, () => (Math.random() - 0.5) * 0.001);
assert.equal(detectPitch(noise, SR), null);
console.log("ok  - silêncio e ruído fraco não geram nota");
