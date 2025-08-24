import { parse as parseSPS } from 'h264-sps-parser';
import { parse as parsePPS } from 'h264-pps-parser';
import fs from 'fs';




/* async function main() {

    const annexB = fs.readFileSync('test.264');
    const view   = new Uint8Array(annexB);

    let avcC;
    try {
        avcC = convertAnnexBtoAvcC(view);
    } catch (err) {
        console.error('Conversion failed:', err);
        process.exit(1);
    }


    console.log('avcC size:', avcC.byteLength, 'bytes');
    console.log('avcC hex:',
        Buffer.from(avcC).toString('hex').slice(0, 64) + '…'
    );

}

await main() */

/**
 * Extracts all NAL units (without start codes) from an Annex-B buffer.
 * @param {Uint8Array} data 
 * @returns {Uint8Array[]} array of raw NAL units
 */
function extractAnnexBNalUnits(data) {
  const units = [];
  let i = 0;

  while (i < data.length) {
    // find next start code (0x000001 or 0x00000001)
    let offset = -1;
    if (i + 3 < data.length &&
        data[i] === 0 && data[i+1] === 0 &&
        data[i+2] === 1) {
      offset = i + 3;
    } else if (i + 4 < data.length &&
               data[i] === 0 && data[i+1] === 0 &&
               data[i+2] === 0 && data[i+3] === 1) {
      offset = i + 4;
    }
    if (offset < 0) { i++; continue; }

    // find the end of this NAL by looking for the next start code
    let next = data.length;
    for (let j = offset; j + 3 < data.length; j++) {
      if ((data[j] === 0 && data[j+1] === 0 && data[j+2] === 1) ||
          (j + 4 < data.length &&
           data[j] === 0 && data[j+1] === 0 &&
           data[j+2] === 0 && data[j+3] === 1)) {
        next = j;
        break;
      }
    }

    // slice out the NAL (we want it *without* its start code)
    units.push(data.subarray(offset, next));
    i = next;
  }

  return units;
}

/**
 * Convert a Matroska-style Annex-B CodecPrivate (Uint8Array)
 * into a proper ISO-BMFF AVCDecoderConfigurationRecord (avcC).
 *
 * @param {Uint8Array} annexB 
 * @returns {ArrayBuffer}
 */
export function convertAnnexBtoAvcC(annexB) {
    const nalUs = extractAnnexBNalUnits(annexB);
    const spsUnits = nalUs.filter(u => (u[0] & 0x1f) === 7);
    const ppsUnits = nalUs.filter(u => (u[0] & 0x1f) === 8);

    if (!spsUnits.length) throw new Error('No SPS NAL found in CodecPrivate');
    if (!ppsUnits.length) throw new Error('No PPS NAL found in CodecPrivate');

    // parse out profile_idc / constraint flags / level_idc
    const spsInfo = parseSPS(spsUnits[0]);
    const profile_idc            = spsInfo.profile_idc;
    const profile_compatibility =
        (spsInfo.constraint_set0_flag ? 0x80 : 0) |
        (spsInfo.constraint_set1_flag ? 0x40 : 0) |
        (spsInfo.constraint_set2_flag ? 0x20 : 0) |
        (spsInfo.constraint_set3_flag ? 0x10 : 0) |
        (spsInfo.constraint_set4_flag ? 0x08 : 0) |
        (spsInfo.constraint_set5_flag ? 0x04 : 0); 

    const level_idc              = spsInfo.level_idc;

    const lengthSizeMinusOne = 3;       // we’ll use 4-byte NAL lengths
    const numOfSPS           = spsUnits.length;
    const numOfPPS           = ppsUnits.length;

    // calculate total avcC size
    let size = 6; // 1 configVersion + 3 profile bytes + 1 lengthSize + 1 numOfSPS
    size += numOfSPS * 2 + spsUnits.reduce((sum, u) => sum + u.byteLength, 0);
    size += 1; // numOfPPS
    size += numOfPPS * 2 + ppsUnits.reduce((sum, u) => sum + u.byteLength, 0);

    const buffer = new ArrayBuffer(size);
    const view   = new DataView(buffer);
    let off = 0;

    // ----- write avcC header -----
    view.setUint8(off++, 1);                     // configurationVersion
    view.setUint8(off++, profile_idc);           // AVCProfileIndication
    view.setUint8(off++, profile_compatibility); // profile_compatibility
    view.setUint8(off++, level_idc);             // AVCLevelIndication
    view.setUint8(off++, 0xFC | lengthSizeMinusOne);
                                                // 6 bits reserved (all 1) + 2 bits lengthSizeMinusOne
    view.setUint8(off++, 0xE0 | numOfSPS);       // 3 bits reserved + 5 bits numOfSPS

    // ----- SPS records -----
    for (const u of spsUnits) {
    view.setUint16(off, u.byteLength);         // sequenceParameterSetLength
    off += 2;
    new Uint8Array(buffer, off, u.byteLength).set(u);
    off += u.byteLength;
    }

    // ----- PPS records -----
    view.setUint8(off++, numOfPPS);
    for (const u of ppsUnits) {
    view.setUint16(off, u.byteLength);         // pictureParameterSetLength
    off += 2;
    new Uint8Array(buffer, off, u.byteLength).set(u);
    off += u.byteLength;
    }

    return {
      buffer: buffer,
      profile: profile_idc,
      compatibility: profile_compatibility,
      level: level_idc
    };;
}