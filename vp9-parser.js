// vp9-helper.js --------------------------------------------------------------
/**
 * Build a VPCodecConfigurationRecord (vpcC) from Matroska CodecPrivate
 * and return it together with a proper `vp09.…` codec string.
 */
export function mkvVP9ToVpcc(privateData) {
  if (!privateData || privateData.byteLength < 7) {
    throw new Error('Invalid VP9 CodecPrivate');
  }

  const u = privateData;                 // shorthand
  const profile           = u[0];
  const level             = u[1];
  const bitDepth          = u[2];        // 8 / 10 / 12
  const chromaSubsampling = u[3] & 0x07; // keep only 3 lsb
  const fullRangeFlag     = (u[3] >> 7) & 0x01;

  const colourPrimaries        = u[4];
  const transferCharacteristics = u[5];
  const matrixCoefficients      = u[6];

  /* ---------- build raw vpcC payload (version 1 + record) ---------- */
  const buf  = new ArrayBuffer(10);
  const view = new DataView(buf);
  let off = 0;
  view.setUint8(off++, 1);                 // version
  view.setUint8(off++, profile);
  view.setUint8(off++, level);
  view.setUint8(off++, (bitDepth << 4)
                         | (chromaSubsampling << 1)
                         | fullRangeFlag);
  view.setUint8(off++, colourPrimaries);
  view.setUint8(off++, transferCharacteristics);
  view.setUint8(off++, matrixCoefficients);
  view.setUint16(off, 0);                  // codecInitDataSize = 0

  /* ---------- RFC 6386 “vp09.” codec string (mandatory fields) ---------- */
  // <profile>.<level>.<bitDepth>.<chromaSub>.0 : full range flag always 0|1
  const profileStr   = profile.toString().padStart(2, '0');
  const levelStr     = level.toString().padStart(2, '0');
  const bitDepthStr  = bitDepth.toString().padStart(2, '0');
  const chromaStr    = chromaSubsampling.toString();
  const fullRangeStr = fullRangeFlag.toString();

  return {
    codec: `vp09.${profileStr}.${levelStr}.${bitDepthStr}.0${chromaStr}.0${fullRangeStr}`,
    description: buf
  };
}
