
async function parseKTX2(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  const identifier = new Uint8Array(arrayBuffer, 0, 12);
  const KTX2_IDENTIFIER = new Uint8Array([
    0xAB, 0x4B, 0x54, 0x58, 0x20, 0x32, 0x30, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A
  ]);
  for (let i = 0; i < 12; i++) {
    if (identifier[i] !== KTX2_IDENTIFIER[i])
      throw new Error('Invalid KTX2 identifier');
  }

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

  const index = {
    dfdByteOffset: dv.getUint32(offset, true), offset: offset += 4,
    dfdByteLength: dv.getUint32(offset, true), offset: offset += 4,
    kvdByteOffset: dv.getUint32(offset, true), offset: offset += 4,
    kvdByteLength: dv.getUint32(offset, true), offset: offset += 4,
    sgdByteOffset: Number(dv.getBigUint64(offset, true)), offset: offset += 8,
    sgdByteLength: Number(dv.getBigUint64(offset, true)), offset: offset += 8,
  };

  const levels = [];
  for (let i = 0; i < Math.max(1, header.levelCount); i++) {
    const byteOffset = Number(dv.getBigUint64(offset, true)); offset += 8;
    const byteLength = Number(dv.getBigUint64(offset, true)); offset += 8;
    const uncompressedByteLength = Number(dv.getBigUint64(offset, true)); offset += 8;
    levels.push({ byteOffset, byteLength, uncompressedByteLength });
  }

  return { header, index, levels };
}
