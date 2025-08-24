/**
 * Convert Annex-B HEVC extradata (VPS/SPS/PPS NALUs) into an ISO-BMFF
 * HEVCDecoderConfigurationRecord (hvcC). Drop the resulting ArrayBuffer
 * directly into mp4boxFile.addTrack({ header: buffer, … }).
 */
import fs from 'fs';


 /**
  * Simple big-endian bit-reader
  */
 class BitReader {
   constructor(buffer) {
     this.data = buffer;
     this.bytePos = 0;
     this.bitPos  = 0;
   }
   readBits(count) {
     let val = 0;
     while (count--) {
       const byte = this.data[this.bytePos];
       const bit  = (byte >> (7 - this.bitPos)) & 1;
       val = (val << 1) | bit;
       if (++this.bitPos === 8) {
         this.bitPos = 0;
         this.bytePos++;
       }
     }
     return val;
   }
}

function removeEmulationPreventionBytes(data) {
  const out = [];
  for (let i = 0; i < data.length; ++i) {
    // whenever you see 0x00 0x00 0x03, drop the 0x03
    if (i + 2 < data.length
     && data[i]   === 0x00
     && data[i+1] === 0x00
     && data[i+2] === 0x03) {
      out.push(0x00, 0x00);
      i += 2;
    } else {
      out.push(data[i]);
    }
  }
  return new Uint8Array(out);
}


 /**
  * Extract all NAL units (without start codes) from Annex-B data
  */
 function extractAnnexBNalUnits(data) {
   const units = [];
   let i = 0;
   while (i < data.length) {
     let offset = -1;
     if (i + 3 < data.length &&
         data[i] === 0 && data[i+1] === 0 && data[i+2] === 1) {
       offset = i + 3;
     } else if (i + 4 < data.length &&
                data[i] === 0 && data[i+1] === 0 &&
                data[i+2] === 0 && data[i+3] === 1) {
       offset = i + 4;
     }
     if (offset < 0) { i++; continue; }

     // find next start code
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

     units.push(data.subarray(offset, next));
     i = next;
   }
   return units;
 }

 /**
  * Parse the first VPS NALU to extract the general_* fields.
  * @param {Uint8Array} vpsNAL
  */
function parseVPS(vpsNAL) {
    // skip the 2-byte NAL header in HEVC:
    //   forbidden_zero_bit(1) + nal_unit_type(6) + nuh_layer_id(6) + nuh_temporal_id_plus1(3)
    const rawRbsp = vpsNAL.subarray(2);
    const rbsp    = removeEmulationPreventionBytes(rawRbsp);
    const br      = new BitReader(rbsp);

    br.readBits(4); // vps_video_parameter_set_id
    br.readBits(2); // vps_base_layer_internal_flag + vps_base_layer_available_flag
    br.readBits(6); // vps_max_layers_minus1
    const max_sub_layers_minus1 = br.readBits(3);
    br.readBits(1); // vps_temporal_id_nesting_flag
    br.readBits(16); // vps_reserved_0xffff_16bits

    // --- Start of profile_tier_level structure ---
    // All general_* fields must be read first, in this order.

    const general_profile_space = br.readBits(2);
    const general_tier_flag = br.readBits(1);
    const general_profile_idc = br.readBits(5);
    const general_profile_compatibility_flags = br.readBits(32);

    // Read the 48-bit constraint flags
    const flagHigh = br.readBits(16);
    const flagLow = br.readBits(32);
    const general_constraint_indicator_flags = (BigInt(flagHigh) << 32n) | BigInt(flagLow);

    const general_level_idc = br.readBits(8);

    // --- Sub-layer information follows the general profile info ---

    const sub_layer_profile_present_flag = [];
    const sub_layer_level_present_flag = [];
    for (let i = 0; i < max_sub_layers_minus1; i++) {
        sub_layer_profile_present_flag[i] = br.readBits(1);
        sub_layer_level_present_flag[i] = br.readBits(1);
    }

    if (max_sub_layers_minus1 > 0) {
        for (let i = max_sub_layers_minus1; i < 8; i++) {
        br.readBits(2); // reserved_zero_2bits
        }
    }

    // Parse sub-layer profile/level info if present
    for (let i = 0; i < max_sub_layers_minus1; i++) {
        if (sub_layer_profile_present_flag[i]) {
        // sub_layer_profile_space[i], sub_layer_tier_flag[i], sub_layer_profile_idc[i]
        br.readBits(2 + 1 + 5); 
        // sub_layer_profile_compatibility_flag[i]
        br.readBits(32);
        // sub_layer_constraint_indicator_flags[i]
        br.readBits(48);
        // sub_layer_level_idc[i]
        br.readBits(8);
        }
        if (sub_layer_level_present_flag[i]) {
        // Not needed for hvcC, but must be skipped
        // In HEVC spec, this is actually outside the profile_present_flag block
        }
    }

    return {
        general_profile_space,
        general_tier_flag,
        general_profile_idc,
        general_profile_compatibility_flags,
        general_constraint_indicator_flags,
        general_level_idc
    };
}

 /**
  * Build the hvcC record.
  * @param {Uint8Array} annexB 
  * @returns {ArrayBuffer}
  */
 export function convertAnnexBtoHevcC(annexB) {
    const nalUs   = extractAnnexBNalUnits(annexB);
    const vps     = nalUs.filter(u => ((u[0] >> 1) & 0x3F) === 32);
    const sps     = nalUs.filter(u => ((u[0] >> 1) & 0x3F) === 33);
    const pps     = nalUs.filter(u => ((u[0] >> 1) & 0x3F) === 34);

    if (!vps.length) throw new Error('No VPS NAL found in CodecPrivate');
    if (!sps.length) throw new Error('No SPS NAL found in CodecPrivate');
    if (!pps.length) throw new Error('No PPS NAL found in CodecPrivate');

    // pull the general_* fields from VPS
    const info = parseVPS(vps[0]);

    // static defaults for fields we won’t vary:
    const min_spatial_segmentation_idc = 0;
    const parallelismType             = 0;
    const chroma_format_idc           = 1;   // 4:2:0
    const bitDepthLumaMinus8          = 0;   // 8-bit
    const bitDepthChromaMinus8        = 0;   // 8-bit
    const avgFrameRate                = 0;
    const constantFrameRate           = 0;
    const numTemporalLayers           = 0;
    const temporalIdNested            = 0;
    const lengthSizeMinusOne          = 3;   // 4-byte NAL lengths

    // build all arrays (VPS, SPS, PPS)
    const arrays = [
      { type: 32, units: vps },
      { type: 33, units: sps },
      { type: 34, units: pps }
    ].filter(a => a.units.length);

    // compute total size
    let size = 23; 
    // 1+1+4+6+1+2+1+1+1+1+1+2+1+1  = 23 bytes header up to numOfArrays
    for (const { type, units } of arrays) {
      size += 1; // array_completeness + reserved + NAL_unit_type
      size += 2; // numNalus
      for (const u of units) {
        size += 2 + u.byteLength; // nalUnitLength + data
      }
    }

    const buf  = new ArrayBuffer(size);
    const view = new DataView(buf);
    let off = 0;

    // configurationVersion
    view.setUint8(off++, 1);

    // profile/tier/level
    view.setUint8(off++,
      (info.general_profile_space  << 6) |
      ((info.general_tier_flag ? 1:0) << 5) |
      (info.general_profile_idc & 0x1F)
    );
    view.setUint32(off, info.general_profile_compatibility_flags);
    off += 4;
    // constraint flags (48 bits)
    const ci = info.general_constraint_indicator_flags;
    view.setUint16(off, Number(ci >> 32n));
    off += 2;
    view.setUint32(off, Number(ci & 0xFFFFFFFFn));
    off += 4;
    // level
    view.setUint8(off++, info.general_level_idc);

    // reserved(4) + min_spatial_segmentation_idc(12)
    view.setUint16(off, (0xF << 12) | min_spatial_segmentation_idc);
    off += 2;

    // reserved(6) + parallelismType(2)
    view.setUint8(off++, (0x3F << 2) | parallelismType);

    // reserved(6) + chroma_format_idc(2)
    view.setUint8(off++, (0x3F << 2) | chroma_format_idc);

    // reserved(5) + bitDepthLumaMinus8(3)
    view.setUint8(off++, (0x1F << 3) | bitDepthLumaMinus8);

    // reserved(5) + bitDepthChromaMinus8(3)
    view.setUint8(off++, (0x1F << 3) | bitDepthChromaMinus8);

    // avgFrameRate
    view.setUint16(off, avgFrameRate);
    off += 2;

    // constantFrameRate(2) + numTemporalLayers(3) + temporalIdNested(1) + lengthSizeMinusOne(2)
    view.setUint8(off++, (constantFrameRate<<6)|(numTemporalLayers<<3)|(temporalIdNested<<2)|lengthSizeMinusOne);

    // numOfArrays
    view.setUint8(off++, arrays.length);

    // write each array
    for (const { type, units } of arrays) {
      // array_completeness=1 + reserved=0 + NAL_unit_type
      view.setUint8(off++, (1<<7) | (type & 0x3F));
      view.setUint16(off, units.length);
      off += 2;
      for (const u of units) {
        view.setUint16(off, u.byteLength);
        off += 2;
        new Uint8Array(buf, off, u.byteLength).set(u);
        off += u.byteLength;
      }
    }

    return {
        buffer: buf,
        ...info

    };
}


/* async function main() {
  // 1. Load the raw Annex-B file
  const annexB = fs.readFileSync('test.265');
  const data   = new Uint8Array(annexB);

  // 2. Convert to hvcC
  let hvcC;
  try {
    hvcC = convertAnnexBtoHevcC(data);
  } catch (err) {
    console.error('Conversion failed:', err);
    process.exit(1);
  }

  // 3. Inspect the result
  console.log('hvcC length:', hvcC.byteLength, 'bytes');
  console.log('hvcC hex (first 32 bytes):',
    Buffer.from(hvcC).toString('hex').slice(0, 64) + '…'
  );
}

main(); */