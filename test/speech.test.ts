import { describe, expect, it } from "vitest";
import { toWav } from "#speech/speech.ts";

describe("Ari's voice", () => {
  it("writes speech as a 24 kHz, mono, 16-bit WAV, clipping what's too loud", () => {
    const wav = toWav(Float32Array.from([0, 0.5, 1.5, -1]), 24_000);
    const view = new DataView(wav.buffer);

    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
    expect([
      view.getUint16(20, true),
      view.getUint16(22, true),
      view.getUint32(24, true),
      view.getUint16(34, true),
    ]).toEqual([1, 1, 24_000, 16]);
    expect(view.getUint32(40, true)).toBe(8);
    expect([0, 1, 2, 3].map((index) => view.getInt16(44 + index * 2, true))).toEqual([0, 16_384, 32_767, -32_767]);
  });
});
