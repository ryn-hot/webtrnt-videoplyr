// av1-helper.js --------------------------------------------------------------
/**
 * Convert Matroska AV1 CodecPrivate (a Sequence-Header OBU) into an
 * AV1CodecConfigurationBox (av1C) and a `av01.…` codec string.
 */
export function mkvAV1ToAv1C(privateData) {
  if (!privateData || privateData[0] !== 0x81 /* OBU_SEQUENCE_HEADER marker */) {
    throw new Error('Invalid AV1 CodecPrivate');
  }

  /* ---------- very small OBU parser (just what we need) ---------- */
  let i = 1;                               // skip OBU header (0x81)
  // skip leb128 OBU size
  let sz = 0, shift = 0, b;
  do { b = privateData[i++]; sz |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
  const seq = new DataView(privateData.buffer, privateData.byteOffset + i);

  const seq_profile      = (seq.getUint8(0) >> 5) & 0x07;     // 3 bits
  const seq_level_idx_0  =  seq.getUint8(1) & 0x1F;           // 5 bits
  const seq_tier_0       = (seq.getUint8(1) >> 5) & 0x01;     // 1 bit
  const highBitdepth     = (seq.getUint8(2) >> 7) & 0x01;
  const twelveBit        = (seq.getUint8(2) >> 6) & 0x01;
  const monochrome       = (seq.getUint8(2) >> 5) & 0x01;
  const chromaSubX       = (seq.getUint8(2) >> 4) & 0x01;
  const chromaSubY       = (seq.getUint8(2) >> 3) & 0x01;
  const chromaSamplePos  =  seq.getUint8(2) & 0x03;

  /* ---------- build raw av1C payload ---------- */
  const obuLen = privateData.byteLength;
  const buf  = new ArrayBuffer(4 + obuLen);
  const view = new DataView(buf);
  let off = 0;

  // byte 0: 1-bit marker (1) + 7-bit version (0)
  view.setUint8(off++, 0x81);

  // byte 1: seq_profile (3) + seq_level_idx_0 (5)
  view.setUint8(off++, (seq_profile << 5) | seq_level_idx_0);

  // byte 2: seq_tier_0 (1) + highBitdepth (1) + twelveBit (1) +
  //         monochrome (1) + chromaSubX (1) + chromaSubY (1) +
  //         chromaSamplePos (2)
  view.setUint8(
    off++,
    (seq_tier_0        << 7) |
    (highBitdepth      << 6) |
    (twelveBit         << 5) |
    (monochrome        << 4) |
    (chromaSubX        << 3) |
    (chromaSubY        << 2) |
     chromaSamplePos
  );

  // byte 3: presentationDelay fields – we’ll signal “not present” (all zero)
  view.setUint8(off++, 0);

  // bytes 4..n : the *entire* Sequence-Header OBU
  new Uint8Array(buf, off).set(privateData);

  /* ---------- RFC 6386 style codec string ---------- */
  // av01.<Profile>.<Level>.<TierChar>
  const levelHex = seq_level_idx_0.toString(16).toUpperCase().padStart(2, '0');
  const tierChar = seq_tier_0 ? 'H' : 'M';  // Main / High tier
  const codecStr = `av01.${seq_profile}.${levelHex}.${tierChar}`;

  return {
    codec: codecStr,
    description: buf
  };
}
