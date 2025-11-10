// File for parsing KTX2 files
// | Identifier | Header | Level Index | DFD | KVD | SGD | Mip Level Array |

// Identifier (12 bytes)
// Header (17 × 4 bytes = 68 bytes)
// Level Index (levelCount × 24 bytes)
//// byeOffset, byteLength, uncompressedByteLength
//// used to locate mip levels in the binary file
async function parseKTX2(arrayBuffer) {
  // Indentifier
  const dv = new DataView(arrayBuffer);
  const identifier = new Uint8Array(arrayBuffer, 0, 12);
  const KTX2_IDENTIFIER = new Uint8Array([
    0xAB, 0x4B, 0x54, 0x58, 0x20, 0x32, 0x30, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A
  ]);
  for (let i = 0; i < 12; i++) {
    if (identifier[i] !== KTX2_IDENTIFIER[i])
      throw new Error('Invalid KTX2 identifier');
  }

  // Header
  let offset = 12;
  const header = {
    vkFormat: dv.getUint32(offset, true), offset: offset += 4,
    typeSize: dv.getUint32(offset, true), offset: offset += 4,
    pixelWidth: dv.getUint32(offset, true), offset: offset += 4,
    pixelHeight: dv.getUint32(offset, true), offset: offset += 4,
    pixelDepth: dv.getUint32(offset, true), offset: offset += 4,
    layerCount: dv.getUint32(offset, true), offset: offset += 4,
    faceCount: dv.getUint32(offset, true), offset: offset += 4,
    levelCount: dv.getUint32(offset, true), offset: offset += 4,
    supercompressionScheme: dv.getUint32(offset, true), offset: offset += 4,
  };

  // Index
  const index = {
    dfdByteOffset: dv.getUint32(offset, true), offset: offset += 4,
    dfdByteLength: dv.getUint32(offset, true), offset: offset += 4,
    kvdByteOffset: dv.getUint32(offset, true), offset: offset += 4,
    kvdByteLength: dv.getUint32(offset, true), offset: offset += 4,
    sgdByteOffset: Number(dv.getBigUint64(offset, true)), offset: offset += 8,
    sgdByteLength: Number(dv.getBigUint64(offset, true)), offset: offset += 8,
  };

  // Level Index
  const levels = [];
  for (let i = 0; i < Math.max(1, header.levelCount); i++) {
    const byteOffset = Number(dv.getBigUint64(offset, true)); offset += 8;
    const byteLength = Number(dv.getBigUint64(offset, true)); offset += 8;
    const uncompressedByteLength = Number(dv.getBigUint64(offset, true)); offset += 8;
    // TODO: make this into a class
    levels.push({ byteOffset, byteLength, uncompressedByteLength });
  }

  return { header, index, levels };
}

// Data Format Descriptor
// call const dfd = parseDFD(dv, index.dfdByteOffset, index.dfdByteLength);
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
    view.getUint8(offset++),
    view.getUint8(offset++),
    view.getUint8(offset++),
    view.getUint8(offset++)
  ];

  const bytesPlane = [];
  for (let i = 0; i < 8; i++) bytesPlane.push(view.getUint8(offset++));

  return {
    vendorId, descriptorType, versionNumber,
    colorModel, colorPrimaries, transferFunction, flags,
    texelBlockDimension, bytesPlane
  };
}

// Key/Value Data
function parseKVD(dv, baseOffset, length) {
  const kv = {};
  let offset = baseOffset;
  while (offset < baseOffset + length) {
    const kvByteLength = dv.getUint32(offset, true); offset += 4;
    const keyBytes = new Uint8Array(dv.buffer, offset, kvByteLength);
    const keyStr = new TextDecoder().decode(keyBytes);
    const nullPos = keyStr.indexOf('\0');
    const key = keyStr.slice(0, nullPos);
    const value = keyStr.slice(nullPos + 1);
    kv[key] = value;
    offset += kvByteLength;
    const padding = (4 - (kvByteLength % 4)) % 4;
    offset += padding;
  }
  return kv;
}

// Mip Level Array
// for each mip_level in levelCount
function getLevelData(arrayBuffer, level) {
  return new Uint8Array(arrayBuffer, level.byteOffset, level.byteLength);
}

