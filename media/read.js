// File for parsing KTX2 files
// | Identifier | Header | Level Index | DFD | KVD | SGD | Mip Level Array |

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

async function parseKTX2(arrayBuffer) {
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
  } else if (header.supercompressionScheme === SUPERCOMPRESSION_BASIS_LZ) {
    throw new Error('BasisLZ supercompression not yet supported. Use Zstd or uncompressed KTX2.');
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
