// transcoder.js - Basis Universal transcoder only

let basisTranscoder = null;
let basisReady = false;

/**
 * Initialize Basis Universal transcoder for ETC1S/UASTC only
 * Uses local file loaded from extension directory
 */
async function initBasisTranscoder() {
  if (basisReady) return basisTranscoder;
  if (basisTranscoder) return basisTranscoder;
  
  try {
    console.log('Initializing Basis Universal transcoder...');
    console.log('window.BASIS available:', !!window.BASIS);
    
    // Check if BASIS module exists and try to initialize it
    if (!window.BASIS) {
      throw new Error('BASIS module not found - basis_transcoder.js may not have loaded');
    }

    console.log('BASIS module found. Calling initialization...');
    
    // Initialize the module - BASIS() is an async factory function
    if (typeof window.BASIS === 'function') {
      console.log('BASIS is a function, calling it to initialize...');
      basisTranscoder = await window.BASIS();
      console.log('✓ Basis Universal initialized');
    } else if (window.BASIS.isReady?.()) {
      console.log('BASIS is already initialized');
      basisTranscoder = window.BASIS;
    } else {
      console.log('Waiting for BASIS to be ready...');
      let attempts = 0;
      const maxAttempts = 300; // 30 seconds at 100ms intervals
      
      await new Promise((resolve, reject) => {
        const checkReady = setInterval(() => {
          attempts++;
          console.log(`Attempt ${attempts}: BASIS.isReady() = ${window.BASIS?.isReady?.()}`);
          
          if (window.BASIS?.isReady?.()) {
            clearInterval(checkReady);
            basisTranscoder = window.BASIS;
            console.log('✓ Basis Universal ready');
            resolve();
          }
          
          if (attempts >= maxAttempts) {
            clearInterval(checkReady);
            reject(new Error('Basis initialization timeout after 30 seconds'));
          }
        }, 100);
      });
    }
    
    basisReady = true;
    console.log('✓ Basis transcoder initialized successfully');
    return basisTranscoder;
    
  } catch (e) {
    console.error('Basis transcoder initialization failed:', e);
    console.error('Error details:', e.message);
    console.error('Stack:', e.stack);
    basisReady = true; // Mark as attempted to prevent retries
    throw e; // Re-throw so caller knows transcoding failed
  }
}

/**
 * Transcode Basis Universal compressed data to BC7
 * Handles both raw Basis files and KTX2 Basis supercompressed data
 */
async function transcodeBasisToBC7(compressedData, width, height) {
  const basis = await initBasisTranscoder();
  
  if (!basis) {
    throw new Error('Basis transcoder not available');
  }
  
  try {
    console.log(`Transcoding Basis data (${width}x${height}, ${compressedData.byteLength} bytes)...`);
    
    // Create a BasisFile from the compressed data
    // This works for both raw .basis files and KTX2 Basis supercompressed data
    const basisFile = new basis.BasisFile(new Uint8Array(compressedData));
    
    if (!basisFile.startTranscoding()) {
      throw new Error('Failed to start Basis transcoding - data may be corrupted or not valid Basis format');
    }

    console.log(`BasisFile info: images=${basisFile.getNumImages()}, levels=${basisFile.getNumLevels(0)}`);

    // Get the transcoded BC7 data
    // Parameters: image_index=0 (first/only image), level_index=0 (first mip)
    const transcodedData = basisFile.getImageTranscodedData(0, 0, basis.eBASIS_BC7_M6_OPAQUE_FAST);
    
    if (!transcodedData || transcodedData.length === 0) {
      throw new Error('Transcoding returned empty data');
    }
    
    basisFile.close();
    
    console.log(`✓ Transcoded to BC7 (${transcodedData.length} bytes)`);
    return new Uint8Array(transcodedData);
  } catch (e) {
    console.error('Transcoding error details:', e);
    throw new Error(`Basis transcoding failed: ${e.message}`);
  }
}

// Native BC formats that WebGPU supports (no transcoding needed)
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

/**
 * Check if a format needs transcoding (only for non-Basis formats)
 */
function checkFormatRequirements(vkFormat) {
  // Native BC format - no transcoding needed
  if (NATIVE_BC_FORMATS[vkFormat]) {
    return {
      needsProcessing: false,
      format: NATIVE_BC_FORMATS[vkFormat],
      vkFormat: vkFormat
    };
  }

  return null;
}

/**
 * Get human-readable format name
 */
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

// Expose to global scope
window.initBasisTranscoder = initBasisTranscoder;
window.transcodeBasisToBC7 = transcodeBasisToBC7;
window.checkFormatRequirements = checkFormatRequirements;
window.getFormatName = getFormatName;
window.NATIVE_BC_FORMATS = NATIVE_BC_FORMATS;