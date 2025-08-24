export function annexBtoLengthPrefixed(src, nalLen) {
  const chunks = [];
  let total = 0;
  let i = 0;

  while (i < src.byteLength) {
    // find start code
    let sc = i;
    for (; sc + 3 < src.byteLength; sc++) {
      if (src[sc] === 0x00 && src[sc+1] === 0x00 &&
         (src[sc+2] === 0x01 || (src[sc+2] === 0x00 && src[sc+3] === 0x01))) break;
    }
    // no more start codes
    if (sc + 3 >= src.byteLength) break;

    const nalStart = (src[sc+2] === 0x01) ? sc + 3 : sc + 4;

    // find next start code → end of this NAL
    let next = nalStart;
    for (; next + 3 < src.byteLength; next++) {
      if (src[next] === 0x00 && src[next+1] === 0x00 &&
         (src[next+2] === 0x01 || (src[next+2] === 0x00 && src[next+3] === 0x01))) break;
    }
    if (next + 3 >= src.byteLength) next = src.byteLength;

    const nalSize = next - nalStart;

    // write length prefix
    const hdr = new ArrayBuffer(nalLen);
    const dv  = new DataView(hdr);
    if (nalLen === 4) dv.setUint32(0, nalSize);
    else if (nalLen === 2) dv.setUint16(0, nalSize);
    else dv.setUint8(0, nalSize);

    chunks.push(new Uint8Array(hdr));
    chunks.push(src.subarray(nalStart, next));
    total += nalLen + nalSize;

    i = next;
  }

  // concat
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}
