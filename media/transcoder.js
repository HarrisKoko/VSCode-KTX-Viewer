// transcoder.js - LibKTX ES Module for KTX2 transcoding



let ktxModule = null;



/**

 * Initialize libktx WebAssembly module

 */

async function initLibKTX() {

  if (ktxModule) return ktxModule;

 

  console.log('initLibKTX: checking window.LIBKTX ->', typeof window.LIBKTX);



  if (typeof window.LIBKTX === 'undefined') {

    console.error('LIBKTX is undefined! Waiting for module to import...');

    // Wait for LIBKTX to be available (set by HTML module script)

    let attempts = 0;

    await new Promise((resolve, reject) => {

      const checkInterval = setInterval(() => {

        if (window.LIBKTX) {

          clearInterval(checkInterval);

          resolve();

        }

        if (++attempts > 300) { // 30 seconds

          clearInterval(checkInterval);

          reject(new Error('LIBKTX never became available'));

        }

      }, 100);

    });

  }



  try {

    console.log('Initializing LIBKTX module...');

    const mod = await window.LIBKTX({

      locateFile: (path) => {

        if (path.endsWith('.wasm')) {

          console.log('libktx.locateFile -> LIBKTX_WASM:', window.LIBKTX_WASM);

          return window.LIBKTX_WASM;

        }

        return path;

      }

    });

    console.log('✓ libktx module initialized');

    ktxModule = mod;

    return mod;

  } catch (err) {

    console.error('libktx init failed:', err);

    throw err;

  }

}



/**

 * Transcode entire KTX2 file (handles Basis Universal supercompression)

 * Returns array of mip levels with transcoded BC7 data

 */

async function transcodeFullKTX2(fileBuffer) {

  const m = await initLibKTX();



  let texture = null;

  try {

    // 1. LOAD TEXTURE

    try {

      const data = new Uint8Array(fileBuffer);

      texture = new m.ktxTexture(data);

    } catch (e) {

      throw new Error(`Failed to create ktxTexture: ${e.message}`);

    }

   

    // 2. CHECK TRANSCODING NEEDS

    let shouldTranscode = false;

    if (texture.needsTranscoding && typeof texture.needsTranscoding === 'function') {

      shouldTranscode = texture.needsTranscoding();

    } else if (texture.vkFormat === 0) {

      shouldTranscode = true;

    }



    // 3. TRANSCODE

    if (shouldTranscode) {

      // Target format: BC7_M5_RGBA

      let targetFormat = (

        m.TranscodeTarget?.BC7_RGBA?.value ??

        m.TranscodeTarget?.BC7_RGBA ??

        0x93  // safe fallback

      );



      if (m.TranscodeTarget && m.TranscodeTarget.BC7_M5_RGBA !== undefined) {

        targetFormat = m.TranscodeTarget.BC7_M5_RGBA.value || m.TranscodeTarget.BC7_M5_RGBA;

      }

     

      const flags = 0;



      if (typeof texture.transcodeBasis !== 'function') {

        throw new Error("texture.transcodeBasis function is missing");

      }



      if (!texture.transcodeBasis(targetFormat, flags)) {

        throw new Error("libktx transcoding failed (transcodeBasis returned false)");

      }

    }



    // 4. GET TEXTURE DATA

    const heap = m.HEAPU8;

    const ptr = texture._data;

    const size = texture._dataSize;



    if (!ptr || !size) {

      console.error("Texture object:", texture);

      throw new Error("libktx: Could not determine data pointer or size.");

    }



    const texData = heap.subarray(ptr, ptr + size);



    // 5. GENERATE MIP MAPS

    const mips = [];

    for (let i = 0; i < texture.numLevels; i++) {

      const offset = texture.getImageOffset(i, 0, 0);

      const mipSize = texture.getImageSize(i, 0, 0);

     

      // IMPORTANT: slice() copies the data because texture.delete() will free WASM memory

      const mipData = texData.slice(offset, offset + mipSize);



      mips.push({

        data: mipData,

        width: texture.baseWidth >> i,

        height: texture.baseHeight >> i

      });

    }



    return mips;



  } catch(e) {

    console.error("KTX2 Processing Error:", e);

    throw e;

  } finally {

    if (texture && texture.delete) texture.delete();

  }

}



// --- HELPER FUNCTIONS ---



const NATIVE_BC_FORMATS = {

  131: 'bc1-rgba-unorm',

  132: 'bc1-rgba-unorm-srgb',

  135: 'bc2-rgba-unorm',

  136: 'bc2-rgba-unorm-srgb',

  137: 'bc3-rgba-unorm',

  138: 'bc3-rgba-unorm-srgb',

  139: 'bc4-r-unorm',

  140: 'bc4-r-snorm',

  141: 'bc5-rg-unorm',

  142: 'bc5-rg-snorm',

  143: 'bc6h-rgb-ufloat',

  144: 'bc6h-rgb-float',

  145: 'bc7-rgba-unorm',

  146: 'bc7-rgba-unorm-srgb',

};



function checkFormatRequirements(vkFormat) {

  if (NATIVE_BC_FORMATS[vkFormat]) {

    return {

      needsProcessing: false,

      format: NATIVE_BC_FORMATS[vkFormat],

      vkFormat: vkFormat

    };

  }

  return null;

}



function getFormatName(vkFormat) {

  const names = {

    0: 'VK_FORMAT_UNDEFINED (Basis Universal)',

    131: 'BC1 (DXT1) UNORM',

    132: 'BC1 (DXT1) SRGB',

    135: 'BC2 (DXT3) UNORM',

    136: 'BC2 (DXT3) SRGB',

    137: 'BC3 (DXT5) UNORM',

    138: 'BC3 (DXT5) SRGB',

    139: 'BC4 (RGTC1) UNORM',

    140: 'BC4 (RGTC1) SNORM',

    141: 'BC5 (RGTC2) UNORM',

    142: 'BC5 (RGTC2) SNORM',

    143: 'BC6H UFLOAT',

    144: 'BC6H FLOAT',

    145: 'BC7 UNORM',

    146: 'BC7 SRGB',

  };

  return names[vkFormat] || `VK Format ${vkFormat}`;

}



function vkFormatToWebGPU(vkFormat) {

  const format = NATIVE_BC_FORMATS[vkFormat];

  if (!format) return null;

  return {

    format,

    blockWidth: 4,

    blockHeight: 4,

    bytesPerBlock: 16

  };

}



// --- EXPORTS (for ES module) ---

export {

  initLibKTX,

  transcodeFullKTX2,

  checkFormatRequirements,

  getFormatName,

  vkFormatToWebGPU,

  NATIVE_BC_FORMATS

};



// --- ALSO ATTACH TO WINDOW (for backward compatibility) ---

window.initLibKTX = initLibKTX;

window.transcodeFullKTX2 = transcodeFullKTX2;

window.checkFormatRequirements = checkFormatRequirements;

window.getFormatName = getFormatName;

window.vkFormatToWebGPU = vkFormatToWebGPU;