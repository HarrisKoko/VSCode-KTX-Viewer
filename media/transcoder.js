// transcoder.js - LibKTX ES Module for KTX2 transcoding

let ktxModule = null;

/**
 * Initialize libktx WebAssembly module
 */
async function initLibKTX() {
  if (ktxModule) return ktxModule;

  // Verify LIBKTX loaded
  if (typeof window.LIBKTX === 'undefined') {
    throw new Error('LIBKTX global not found. Ensure libktx.js is loaded in extension.ts.');
  }

  try {
    console.log('Initializing LIBKTX module...');
    const mod = await window.LIBKTX({
      locateFile: (path) => {
        if (path.endsWith('.wasm')) {
          // FIXED: Matches the variable set in extension.ts
          return window.LIBKTX_WASM; 
        }
        return path;
      },
      onRuntimeInitialized: () => {
        console.log('✓ libktx module initialized');
      }
    });

    ktxModule = mod;
    return mod;
  } catch (err) {
    console.error('libktx init failed:', err);
    throw err;
  }
}

/**
 * Transcode entire KTX2 file (handles Basis Universal supercompression)
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
      shouldTranscode = texture.needsTranscoding;
    } else if (texture.vkFormat === 0) {
      shouldTranscode = true;
    }

    // 3. TRANSCODE
    if (shouldTranscode) {
      let targetFormat = (
        m.TranscodeTarget?.BC7_RGBA?.value ??
        m.TranscodeTarget?.BC7_RGBA ??
        0x93 
      );

      if (m.TranscodeTarget && m.TranscodeTarget.BC7_M5_RGBA !== undefined) {
        targetFormat = m.TranscodeTarget.BC7_M5_RGBA.value || m.TranscodeTarget.BC7_M5_RGBA;
      }
      
      if (!texture.transcodeBasis(targetFormat, 0)) {
        throw new Error("libktx transcoding failed");
      }
    }

  // 4. GET TEXTURE DATA
    const mips = [];
    const numLevels = texture.numLevels || 1; // Default to 1 if property is missing

    for (let i = 0; i < numLevels; i++) {
      let mipData = null;

      // Use the API exposed in your log: getImage(level, layer, face)
      if (texture.getImage) {
          mipData = texture.getImage(i, 0, 0);
      } else {
          throw new Error("texture.getImage() is missing, but required for this libktx version.");
      }

      // If it returns a view into WASM memory, we MUST copy it
      // because texture.delete() will invalidate the memory.
      const mipCopy = new Uint8Array(mipData);

      mips.push({
        data: mipCopy,
        width: Math.max(1, texture.baseWidth >> i),
        height: Math.max(1, texture.baseHeight >> i)
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
  131: 'bc1-rgba-unorm', 132: 'bc1-rgba-unorm-srgb',
  135: 'bc2-rgba-unorm', 136: 'bc2-rgba-unorm-srgb',
  137: 'bc3-rgba-unorm', 138: 'bc3-rgba-unorm-srgb',
  139: 'bc4-r-unorm', 140: 'bc4-r-snorm',
  141: 'bc5-rg-unorm', 142: 'bc5-rg-snorm',
  143: 'bc6h-rgb-ufloat', 144: 'bc6h-rgb-float',
  145: 'bc7-rgba-unorm', 146: 'bc7-rgba-unorm-srgb',
};

function checkFormatRequirements(vkFormat) {
  if (NATIVE_BC_FORMATS[vkFormat]) {
    return { needsProcessing: false, format: NATIVE_BC_FORMATS[vkFormat], vkFormat: vkFormat };
  }
  return null;
}

function getFormatName(vkFormat) {
  return NATIVE_BC_FORMATS[vkFormat] || `VK Format ${vkFormat}`;
}

function vkFormatToWebGPU(vkFormat) {
  const format = NATIVE_BC_FORMATS[vkFormat];
  if (!format) return null;
  return { format, blockWidth: 4, blockHeight: 4, bytesPerBlock: 16 };
}

// --- EXPORTS ---
export {
  initLibKTX,
  transcodeFullKTX2,
  checkFormatRequirements,
  getFormatName,
  vkFormatToWebGPU,
  NATIVE_BC_FORMATS
};

// Attach to window for fallback compatibility
window.initLibKTX = initLibKTX;
window.transcodeFullKTX2 = transcodeFullKTX2;
window.checkFormatRequirements = checkFormatRequirements;
window.getFormatName = getFormatName;
window.vkFormatToWebGPU = vkFormatToWebGPU;