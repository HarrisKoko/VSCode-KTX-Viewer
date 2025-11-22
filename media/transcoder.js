// transcoder.js - Format detection and Basis Universal transcoding

let basisTranscoder = null;
let basisReady = false;

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

// Formats that require transcoding to BC7
const FORMATS_REQUIRING_TRANSCODING = {
  // ASTC formats (mobile)
  148: { name: 'ASTC', targetVK: 145 },
  149: { name: 'ASTC SRGB', targetVK: 146 },
  
  // ETC formats (mobile) - multiple VK codes for variants
  147: { name: 'ETC2', targetVK: 145 },
  152: { name: 'ETC2', targetVK: 145 },
  153: { name: 'ETC2 SRGB', targetVK: 146 },
  150: { name: 'ETC2 A1', targetVK: 145 },
  151: { name: 'ETC2 A1 SRGB', targetVK: 146 },
  154: { name: 'ETC2 A8', targetVK: 145 },
  155: { name: 'ETC2 A8 SRGB', targetVK: 146 },
  156: { name: 'EAC R11', targetVK: 139 }, // BC4
  157: { name: 'EAC R11 SNORM', targetVK: 140 },
  158: { name: 'EAC RG11', targetVK: 141 }, // BC5
  159: { name: 'EAC RG11 SNORM', targetVK: 142 },
  
  // PVRTC formats (iOS)
  160: { name: 'PVRTC', targetVK: 145 },
  161: { name: 'PVRTC SRGB', targetVK: 146 },
};

/**
 * Initialize Basis Universal transcoder from CDN
 */
async function initBasisTranscoder() {
  if (basisReady) return basisTranscoder;
  
  try {
    // Load the transcoder script from THREE.js examples
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/three@r128/examples/js/libs/basis/basis_transcoder.js';
    script.async = true;
    
    // Get nonce from existing script tag if available
    const existingScript = document.querySelector('script[nonce]');
    if (existingScript?.nonce) {
      script.nonce = existingScript.nonce;
    }
    
    await new Promise((resolve, reject) => {
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });

    // Wait for BASIS module to initialize
    if (!window.BASIS) {
      throw new Error('Basis module not found');
    }

    await new Promise((resolve, reject) => {
      const checkReady = setInterval(() => {
        if (window.BASIS?.isReady?.()) {
          clearInterval(checkReady);
          basisTranscoder = window.BASIS;
          basisReady = true;
          console.log('Basis Universal transcoder ready');
          resolve();
        }
      }, 100);

      setTimeout(() => {
        clearInterval(checkReady);
        reject(new Error('Basis initialization timeout'));
      }, 10000);
    });

    return basisTranscoder;
  } catch (e) {
    console.error('Basis transcoder failed to load:', e);
    throw e;
  }
}

/**
 * Transcode compressed data from one format to BC7
 * Works with raw block data from KTX2 mip levels
 */
async function transcodeToBC7(compressedData, width, height, sourceVkFormat) {
  const basis = await initBasisTranscoder();
  
  try {
    // Create a BasisFile from the compressed data
    const basisFile = new basis.BasisFile(new Uint8Array(compressedData));
    
    if (!basisFile.startTranscoding()) {
      throw new Error('Failed to start Basis transcoding');
    }

    // Get the transcoded BC7 data
    // Parameters: image_index=0 (first/only image), level_index=0 (first mip)
    const transcodedData = basisFile.getImageTranscodedData(0, 0, basis.eBASIS_BC7_M6_OPAQUE_FAST);
    
    basisFile.close();
    
    return new Uint8Array(transcodedData);
  } catch (e) {
    throw new Error(`Transcoding failed: ${e.message}`);
  }
}

/**
 * Check if a VK format needs transcoding
 * @param {number} vkFormat - Vulkan format code
 * @returns {Object|null}
 */
function checkFormatRequirements(vkFormat) {
  // Check if it's a native BC format (no transcoding needed)
  if (NATIVE_BC_FORMATS[vkFormat]) {
    return {
      needsTranscoding: false,
      format: NATIVE_BC_FORMATS[vkFormat],
      vkFormat: vkFormat
    };
  }

  // Check if it needs transcoding
  if (FORMATS_REQUIRING_TRANSCODING[vkFormat]) {
    const info = FORMATS_REQUIRING_TRANSCODING[vkFormat];
    return {
      needsTranscoding: true,
      sourceFormat: info.name,
      sourceVK: vkFormat,
      targetVK: info.targetVK,
      targetFormat: NATIVE_BC_FORMATS[info.targetVK]
    };
  }

  // Unsupported format
  return null;
}

/**
 * Simple check: is this a native BC format?
 */
function isNativeBCFormat(vkFormat) {
  return NATIVE_BC_FORMATS[vkFormat] !== undefined;
}

/**
 * Get human-readable format name
 */
function getFormatName(vkFormat) {
  const names = {
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
    147: 'ETC2',
    148: 'ASTC',
    149: 'ASTC SRGB',
    150: 'ETC2 A1',
    151: 'ETC2 A1 SRGB',
    152: 'ETC2',
    153: 'ETC2 SRGB',
    154: 'ETC2 A8',
    155: 'ETC2 A8 SRGB',
    156: 'EAC R11',
    157: 'EAC R11 SNORM',
    158: 'EAC RG11',
    159: 'EAC RG11 SNORM',
    160: 'PVRTC',
    161: 'PVRTC SRGB',
  };
  return names[vkFormat] || `VK Format ${vkFormat}`;
}

// Expose to global scope
window.initBasisTranscoder = initBasisTranscoder;
window.transcodeToBC7 = transcodeToBC7;
window.checkFormatRequirements = checkFormatRequirements;
window.isNativeBCFormat = isNativeBCFormat;
window.getFormatName = getFormatName;