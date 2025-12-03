// File for parsing KTX2 files
// | Identifier | Header | Level Index | DFD | KVD | SGD | Mip Level Array |

function getNonce() {
  const script = document.currentScript || document.querySelector('script[nonce]');
  return script ? script.nonce : '';
}


// App logger (appends to scrollable log with severity colors)
const logApp = (...args) => {
  const el = document.getElementById('appLog');
  // Known log levels
  const knownLevels = ["info", "success", "error", "warn"];

  let msgParts = [];
  let level = "info"; // default

  // Case 1: second argument is a level → keep old behavior
  if (args.length >= 2 && typeof args[1] === "string" && knownLevels.includes(args[1])) {
    msgParts = [args[0]];
    level = args[1];
  }
  // Case 2: treat all args as message parts
  else {
    msgParts = args;
  }

  // Convert objects → pretty JSON
  const msg = msgParts
    .map(a => (typeof a === "object" ? JSON.stringify(a, null, 2) : String(a)))
    .join(" ");

  if (el) {
    el.style.display = 'block';
    const entry = document.createElement('div');
    entry.style.marginBottom = '4px';
    entry.style.paddingBottom = '4px';
    entry.style.borderBottom = '1px solid #222';

    // Color based on log level
    const colors = {
      error: '#ff6666',
      warn: '#ffaa44',
      success: '#66ff66',
      info: '#aaa'
    };
    entry.style.color = colors[level] || colors.info;
    
    const timestamp = new Date().toLocaleTimeString();
    entry.textContent = `[${timestamp}] ${msg}`;

    el.appendChild(entry);
    // Auto-scroll to bottom
    el.scrollTop = el.scrollHeight;
  }
  
  // Also log to console
  if (level === 'error') console.error(msg);
  else if (level === 'warn') console.warn(msg);
  else console.log(msg);
};


// Supercompression scheme constants
const SUPERCOMPRESSION_NONE = 0;
const SUPERCOMPRESSION_BASIS_LZ = 1;
const SUPERCOMPRESSION_ZSTD = 2;
const SUPERCOMPRESSION_ZLIB = 3;

// Load fzstd library for Zstandard decompression
let fzstdLoaded = false;
let fzstdDecompress = null;

async function loadFzstd() {
  if (fzstdLoaded) return;
  
  // Load fzstd from CDN
  const script = document.createElement('script');
  script.src = 'https://cdn.jsdelivr.net/npm/fzstd@0.1.1/umd/index.js';
  
  await new Promise((resolve, reject) => {
    script.onload = resolve;
    script.onerror = () => reject(new Error('Failed to load fzstd library'));
    document.head.appendChild(script);
  });
  
  if (typeof fzstd !== 'undefined') {
    fzstdDecompress = fzstd.decompress;
    fzstdLoaded = true;
  } else {
    throw new Error('fzstd library not available after loading');
  }
}

// -----------------------------------------------------------------------------
// Basis Universal Transcoder Loader — FIXED
// -----------------------------------------------------------------------------
let basisModulePromise = null;
let BasisModule = null;

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = url;
    
    const nonce = getNonce();
    if (nonce) {
      el.setAttribute('nonce', nonce);
    }

    el.onload = resolve;
    el.onerror = () => reject(new Error(`Script load error for ${url}`));
    document.head.appendChild(el);
  });
}

async function loadBasisModule() {
  if (basisModulePromise) return basisModulePromise;

  basisModulePromise = new Promise(async (resolve, reject) => {
    try {
      const scriptUrl = window.BASIS_JS || "media/basisu/basis_transcoder.js";
      
      // 1. Shim module.exports to capture the library
      const backupModule = window.module;
      const backupExports = window.exports;
      window.module = { exports: {} };
      window.exports = window.module.exports;

      await loadScript(scriptUrl);

      let LoadedFunc = window.module.exports;
      if (typeof LoadedFunc !== 'function') {
         if (LoadedFunc && typeof LoadedFunc.MSC_TRANSCODER === 'function') {
             LoadedFunc = LoadedFunc.MSC_TRANSCODER;
         } else {
             LoadedFunc = window.MSC_TRANSCODER || window.BasisModule || window.Module;
         }
      }

      window.module = backupModule;
      window.exports = backupExports;

      if (typeof LoadedFunc !== "function") {
        return reject(new Error("Could not find BasisModule export"));
      }
      
      BasisModule = LoadedFunc;

      // 2. Load WASM
      const wasmUrl = window.BASIS_WASM || "media/basisu/basis_transcoder.wasm";
      const wasmBinary = await fetch(wasmUrl).then(r => {
        if (!r.ok) throw new Error(`Failed to load WASM: ${r.status}`);
        return r.arrayBuffer();
      });

      // 3. Initialize Module
      BasisModule({
        wasmBinary
      }).then(mod => {
        BasisModule = mod;

        try {
          if (mod.initializeBasis) {
            mod.initializeBasis();
            console.log("✓ Basis Universal initialized");
          } else {
            console.warn("mod.initializeBasis() missing - this might cause transcoder failure.");
          }
        } catch (e) {
          console.error("Failed to initializeBasis:", e);
        }

        resolve(mod);
      }).catch(reject);

    } catch (err) {
      reject(err);
    }
  });

  return basisModulePromise;
}


// -----------------------------------------------------------------------------
// Helper for Basis files
// -----------------------------------------------------------------------------
function makeBasisFile(u8) {
  return new BasisModule.BasisFile(u8);
}

// Choose GPU target (fixed)
function getBasisTargetFormatForGPU(device) {
  // --- FIX START: Update Standard IDs ---
  // Standard Basis Universal enum values:
  // 0=ETC1, 1=ETC2, 2=BC1, 3=BC3, 4=BC4, 5=BC5, 6=BC7, 13=RGBA32
  const TF_BC7_RGBA = 2;  // CHANGED FROM 3 TO 6
  const TF_RGBA32 = 13;
  // --------------------------------------

  // Try to find explicit exports, otherwise fallback to our corrected constants
  const valBC7 = (BasisModule.cTFBC7_RGBA !== undefined) ? BasisModule.cTFBC7_RGBA 
               : (BasisModule.TranscodeTarget?.BC7_RGBA || TF_BC7_RGBA);

  const valRGBA32 = (BasisModule.cTFRGBA32 !== undefined) ? BasisModule.cTFRGBA32 
                  : (BasisModule.TranscodeTarget?.RGBA32 || TF_RGBA32);

  // Debug log to confirm we are using ID 6 now
  console.log(`[read.js] Format IDs available - BC7: ${valBC7}, RGBA32: ${valRGBA32}`);

  if (device.features.has("texture-compression-bc")) {
    console.log(`[read.js] Requesting Format: BC7 (ID: ${valBC7})`);
    return valBC7; 
  }

  console.log(`[read.js] Requesting Format: RGBA32 (ID: ${valRGBA32})`);
  return valRGBA32;
}


async function parseKTX2(arrayBuffer, device) {
  const dv = new DataView(arrayBuffer);

  // Identifier (12 bytes) - validates that this is truly ktx2 file
  const identifier = new Uint8Array(arrayBuffer, 0, 12);
  const KTX2_IDENTIFIER = new Uint8Array([0xAB,0x4B,0x54,0x58,0x20,0x32,0x30,0xBB,0x0D,0x0A,0x1A,0x0A]);
  for (let i = 0; i < 12; i++) {
    if (identifier[i] !== KTX2_IDENTIFIER[i]) throw new Error('Invalid KTX2 identifier');
  }

  if (arrayBuffer.byteLength < 12 + 68) {
    throw new Error('KTX2 too small to contain header.');
  }

  // Header (68 bytes) - Describes global properties of the texture (dimensions, format, data locations, etc.)
  let offset = 12; // After identifier which is 12 bytes
  const header = {
    vkFormat: dv.getUint32(offset, true), offset: (offset += 4), // Vulkan format enum (texture type)
    typeSize: dv.getUint32(offset, true), offset: (offset += 4), // Size of a single texel block in bytes
    pixelWidth: dv.getUint32(offset, true), offset: (offset += 4), // Width of the texture in pixels
    pixelHeight: dv.getUint32(offset, true), offset: (offset += 4), // Height of the texture in pixels
    pixelDepth: dv.getUint32(offset, true), offset: (offset += 4), // Depth of the texture in pixels (1 for 2D textures)
    layerCount: dv.getUint32(offset, true), offset: (offset += 4), /// Number of array layers
    faceCount: dv.getUint32(offset, true), offset: (offset += 4), // Number of faces (6 for cubemaps)
    levelCount: dv.getUint32(offset, true), offset: (offset += 4), // Number of mip levels
    supercompressionScheme: dv.getUint32(offset, true), offset: (offset += 4), // Supercompression scheme used (0 = none)
  };

  // Indexing of data blocks
  const index = {
    dfdByteOffset: dv.getUint32(offset, true), offset: (offset += 4), // Data Format Descriptor
    dfdByteLength: dv.getUint32(offset, true), offset: (offset += 4), // Length of DFD block
    kvdByteOffset: dv.getUint32(offset, true), offset: (offset += 4), // Key/Value Data
    kvdByteLength: dv.getUint32(offset, true), offset: (offset += 4), // Length of KVD block
    sgdByteOffset: Number(dv.getBigUint64(offset, true)), offset: (offset += 8), // Supercompression Global Data
    sgdByteLength: Number(dv.getBigUint64(offset, true)), offset: (offset += 8), // Length of SGD block
  };

  // Level Index - array of mip levels
  const levelCount = Math.max(1, header.levelCount || 1);
  const levels = [];
  for (let i = 0; i < levelCount; i++) {
    const byteOffset = Number(dv.getBigUint64(offset, true)); offset += 8;
    const byteLength = Number(dv.getBigUint64(offset, true)); offset += 8;
    const uncompressedByteLength = Number(dv.getBigUint64(offset, true)); offset += 8;
    levels.push({
      byteOffset, byteLength, uncompressedByteLength,
      width: Math.max(1, header.pixelWidth  >> i),
      height: Math.max(1, header.pixelHeight >> i),
    });
  }

  // Parse DFD if present
  let dfd = null;
  if (index.dfdByteLength > 0) {
    dfd = parseDFD(dv, index.dfdByteOffset, index.dfdByteLength);
  }

  // Parse KVD if present
  let kvd = null;
  if (index.kvdByteLength > 0) {
    kvd = parseKVD(dv, index.kvdByteOffset, index.kvdByteLength);
  }

  // Handle supercompression - decompress level data if needed
  if (header.supercompressionScheme === SUPERCOMPRESSION_ZSTD) {
    await loadFzstd();
    
    // Decompress each mip level
    for (let i = 0; i < levels.length; i++) {
      const level = levels[i];
      const compressedData = new Uint8Array(arrayBuffer, level.byteOffset, level.byteLength);
      
      try {
        const decompressedData = fzstdDecompress(compressedData);
        
        // Store decompressed data - we need to keep it accessible
        level.decompressedData = decompressedData;
        level.isDecompressed = true;
        
        // Verify size matches expected
        if (decompressedData.length !== level.uncompressedByteLength) {
          console.warn(`Level ${i}: Decompressed size ${decompressedData.length} != expected ${level.uncompressedByteLength}`);
        }
      } catch (e) {
        throw new Error(`Failed to decompress level ${i}: ${e.message}`);
      }
    }
  } else if (header.supercompressionScheme === SUPERCOMPRESSION_BASIS_LZ) { // This means ETC1S or UASTC
    logApp("Detected BASIS-LZ texture (ETC1S or UASTC)");

    // 1. Load the transcoder
    await loadBasisModule();

    let basisFile = null;
    const fileUint8 = new Uint8Array(arrayBuffer);

    // 2. ATTEMPT 1: Check for explicit KTX2File support (common in newer builds)
    if (BasisModule.KTX2File) {
      try {
        basisFile = new BasisModule.KTX2File(fileUint8);
      } catch (e) {
        console.warn("KTX2File constructor failed", e);
      }
    }

    // 3. ATTEMPT 2: Fallback to BasisFile with the WHOLE BUFFER
    // (Some builds auto-detect KTX2 headers inside BasisFile)
    if (!basisFile) {
      basisFile = new BasisModule.BasisFile(fileUint8);
    }

    // 4. Initialize
    if (!basisFile.startTranscoding()) {
      basisFile.close();
      basisFile.delete();
      throw new Error("Transcoder failed to initialize. (Your basis_transcoder.wasm might lack KTX2 support)");
    }

    // Detect Class FIRST
    const isKTX2File = (BasisModule.KTX2File && basisFile instanceof BasisModule.KTX2File);

    let imageCount = 1;
    if (!isKTX2File) {
        // Only legacy BasisFile has getNumImages()
        if (typeof basisFile.getNumImages === 'function') {
            imageCount = basisFile.getNumImages();
        }
    }

    if (imageCount === 0) {
       basisFile.close();
       basisFile.delete();
       throw new Error("File has no images");
    }

    const format = getBasisTargetFormatForGPU(device);

    const imageIndex = 0;
    
    // Ask the transcoder how many levels IT sees
    let transcoderLevelCount = 1; 
    try {
        if (isKTX2File) {
            // FIX: KTX2File uses .getLevels() with no arguments
            transcoderLevelCount = basisFile.getLevels();
        } else {
            // FIX: BasisFile uses .getNumLevels(imageIndex)
            transcoderLevelCount = basisFile.getNumLevels(imageIndex);
        }
    } catch(e) {
        console.warn("Could not query numLevels from transcoder, defaulting to 1.", e);
    }

    // Loop only up to the minimum of what the Header says and what the Transcoder says
    const safeLevelCount = Math.min(levels.length, transcoderLevelCount);

    for (let i = 0; i < safeLevelCount; i++) {
        const levelIndex = i;
        let dst = null;
        let status = false;

        try {
            if (isKTX2File) {
                // KTX2File Path
                const layerIndex = 0;
                const faceIndex = 0;
                
                const size = isKTX2File 
                ? basisFile.getImageTranscodedSizeInBytes(imageIndex, levelIndex, 0, 0, format)
                : basisFile.getImageTranscodedSizeInBytes(imageIndex, levelIndex, format);

                // --- DEBUG LOG START ---
                const width = levels[levelIndex].width;
                const height = levels[levelIndex].height;
                const expectedBC7 = Math.ceil(width/4) * Math.ceil(height/4) * 16;
                const expectedRGBA = width * height * 4;

                console.log(`[read.js] Level ${levelIndex} (${width}x${height}):`);
                console.log(`   > Requested Format ID: ${format}`);
                console.log(`   > WASM calculated size: ${size} bytes`);
                console.log(`   > Expected if BC7:      ${expectedBC7} bytes`);
                console.log(`   > Expected if RGBA32:   ${expectedRGBA} bytes`);
                
                if (size === expectedBC7) console.log("   > MATCH: WASM outputting BC7 size");
                else if (size === expectedRGBA) console.log("   > MATCH: WASM outputting RGBA32 size");
                else console.warn("   > MISMATCH: Size matches neither standard BC7 nor RGBA32!");

                dst = new Uint8Array(size);
                
                status = basisFile.transcodeImage(
                    dst, imageIndex, levelIndex, layerIndex, faceIndex, 
                    format, 0, -1, -1
                );
            } else {
                // BasisFile Path
                const size = basisFile.getImageTranscodedSizeInBytes(
                    imageIndex, levelIndex, format
                );
                dst = new Uint8Array(size);
                
                status = basisFile.transcodeImage(
                    dst, imageIndex, levelIndex, format, 0, 0
                );
            }
        } catch (err) {
            console.warn(`Transcode warning on level ${i}:`, err);
            status = false;
        }

        if (status && dst) {
            levels[i].isDecompressed = true;
            levels[i].decompressedData = dst;
            levels[i].transcodedFormat = format;
        } else {
            console.warn(`Failed to transcode level ${i}. Stopping mip chain.`);
            break; // Stop trying deeper levels if one fails
        }
    }

    basisFile.close();
    basisFile.delete(); 
    
  } else if (header.supercompressionScheme === SUPERCOMPRESSION_ZLIB) {
    throw new Error('Zlib supercompression not yet supported. Use Zstd or uncompressed KTX2.');
  } else if (header.supercompressionScheme !== SUPERCOMPRESSION_NONE) {
    throw new Error(`Unknown supercompression scheme: ${header.supercompressionScheme}`);
  }

  return { header, index, levels, dfd, kvd };
}

// DFD data block parser
function parseDFD(dv, baseOffset, length) {
  const view = new DataView(dv.buffer, baseOffset, length);
  let offset = 0;
  const totalSize = view.getUint32(offset, true); offset += 4;
  const vendorId = view.getUint16(offset, true); offset += 2;
  const descriptorType = view.getUint16(offset, true); offset += 2;
  const versionNumber = view.getUint16(offset, true); offset += 2;
  const descriptorBlockSize = view.getUint16(offset, true); offset += 2;

  const colorModel = view.getUint8(offset++); 
  const colorPrimaries = view.getUint8(offset++);
  const transferFunction = view.getUint8(offset++);
  const flags = view.getUint8(offset++);

  const texelBlockDimension = [
    view.getUint8(offset++), view.getUint8(offset++),
    view.getUint8(offset++), view.getUint8(offset++)
  ];

  const bytesPlane = [];
  for (let i = 0; i < 8; i++) bytesPlane.push(view.getUint8(offset++));

  return { totalSize, vendorId, descriptorType, versionNumber,
           colorModel, colorPrimaries, transferFunction, flags,
           texelBlockDimension, bytesPlane, descriptorBlockSize };
}

// KVD data block parser
function parseKVD(dv, baseOffset, length) {
  const kv = {};
  let offset = baseOffset;
  while (offset < baseOffset + length) {
    const kvByteLength = dv.getUint32(offset, true); offset += 4;
    if (kvByteLength === 0) break; // Safety check
    const bytes = new Uint8Array(dv.buffer, offset, kvByteLength);
    const str = new TextDecoder().decode(bytes);
    const nullPos = str.indexOf('\0');
    if (nullPos >= 0) {
      const key = str.slice(0, nullPos);
      const value = str.slice(nullPos + 1);
      kv[key] = value;
    }
    offset += kvByteLength;
    offset += (4 - (kvByteLength % 4)) % 4; // 4-byte align
  }
  return kv;
}

// Mip level accessor - returns decompressed data if available
function getLevelData(arrayBuffer, level) {
  if (level.isDecompressed && level.decompressedData) {
    return level.decompressedData;
  }
  return new Uint8Array(arrayBuffer, level.byteOffset, level.byteLength);
}

// Vulkan format enum to WebGPU format string + metadata
// Returns: { format: 'bc7-rgba-unorm', blockWidth: 4, blockHeight: 4, bytesPerBlock: 16 }
function vkFormatToWebGPU(vkFormat) {
  const formats = {
    // BC1 (DXT1) - 4x4 blocks, 8 bytes per block
    131: { format: 'bc1-rgba-unorm', blockWidth: 4, blockHeight: 4, bytesPerBlock: 8 },
    132: { format: 'bc1-rgba-unorm-srgb', blockWidth: 4, blockHeight: 4, bytesPerBlock: 8 },
    
    // BC2 (DXT3) - 4x4 blocks, 16 bytes per block
    135: { format: 'bc2-rgba-unorm', blockWidth: 4, blockHeight: 4, bytesPerBlock: 16 },
    136: { format: 'bc2-rgba-unorm-srgb', blockWidth: 4, blockHeight: 4, bytesPerBlock: 16 },
    
    // BC3 (DXT5) - 4x4 blocks, 16 bytes per block
    137: { format: 'bc3-rgba-unorm', blockWidth: 4, blockHeight: 4, bytesPerBlock: 16 },
    138: { format: 'bc3-rgba-unorm-srgb', blockWidth: 4, blockHeight: 4, bytesPerBlock: 16 },
    
    // BC4 (RGTC1) - 4x4 blocks, 8 bytes per block
    139: { format: 'bc4-r-unorm', blockWidth: 4, blockHeight: 4, bytesPerBlock: 8 },
    140: { format: 'bc4-r-snorm', blockWidth: 4, blockHeight: 4, bytesPerBlock: 8 },
    
    // BC5 (RGTC2) - 4x4 blocks, 16 bytes per block
    141: { format: 'bc5-rg-unorm', blockWidth: 4, blockHeight: 4, bytesPerBlock: 16 },
    142: { format: 'bc5-rg-snorm', blockWidth: 4, blockHeight: 4, bytesPerBlock: 16 },
    
    // BC6H (HDR) - 4x4 blocks, 16 bytes per block
    143: { format: 'bc6h-rgb-ufloat', blockWidth: 4, blockHeight: 4, bytesPerBlock: 16 },
    144: { format: 'bc6h-rgb-float', blockWidth: 4, blockHeight: 4, bytesPerBlock: 16 },
    
    // BC7 - 4x4 blocks, 16 bytes per block
    145: { format: 'bc7-rgba-unorm', blockWidth: 4, blockHeight: 4, bytesPerBlock: 16 },
    146: { format: 'bc7-rgba-unorm-srgb', blockWidth: 4, blockHeight: 4, bytesPerBlock: 16 },
  };
  
  return formats[vkFormat] || null;
}

// Get human-readable format name
function getFormatName(vkFormat) {
  const names = {
    131: 'BC1 (DXT1) UNORM', 132: 'BC1 (DXT1) SRGB',
    135: 'BC2 (DXT3) UNORM', 136: 'BC2 (DXT3) SRGB',
    137: 'BC3 (DXT5) UNORM', 138: 'BC3 (DXT5) SRGB',
    139: 'BC4 (RGTC1) UNORM', 140: 'BC4 (RGTC1) SNORM',
    141: 'BC5 (RGTC2) UNORM', 142: 'BC5 (RGTC2) SNORM',
    143: 'BC6H UFLOAT', 144: 'BC6H FLOAT',
    145: 'BC7 UNORM', 146: 'BC7 SRGB',
  };
  return names[vkFormat] || `VK Format ${vkFormat}`;
}

// Get supercompression scheme name
function getSupercompressionName(scheme) {
  const names = {
    0: 'None',
    1: 'BasisLZ',
    2: 'Zstandard',
    3: 'Zlib',
  };
  return names[scheme] || `Unknown (${scheme})`;
}

// Expose functions
window.parseKTX2 = parseKTX2;
window.vkFormatToWebGPU = vkFormatToWebGPU;
window.getFormatName = getFormatName;
window.getSupercompressionName = getSupercompressionName;
window.parseDFD = parseDFD;
window.parseKVD = parseKVD;
window.getLevelData = getLevelData;

// Export constants
window.SUPERCOMPRESSION_NONE = SUPERCOMPRESSION_NONE;
window.SUPERCOMPRESSION_BASIS_LZ = SUPERCOMPRESSION_BASIS_LZ;
window.SUPERCOMPRESSION_ZSTD = SUPERCOMPRESSION_ZSTD;
window.SUPERCOMPRESSION_ZLIB = SUPERCOMPRESSION_ZLIB;
