// create-bc6h-test.js
// Creates a minimal BC6H KTX2 test file with HDR gradient
// Run with: node create-bc6h-test.js

const fs = require('fs');

// Simplified BC6H block encoder - creates solid color blocks
function encodeBC6HBlock(r, g, b) {
  const block = new Uint8Array(16);
  
  // Use Mode 11 (0b00011) - 10-bit endpoints, no partition
  // Quantize HDR values to 10 bits (scale by 64 for reasonable range)
  const r10 = Math.min(1023, Math.max(0, Math.floor(r * 64))) & 0x3FF;
  const g10 = Math.min(1023, Math.max(0, Math.floor(g * 64))) & 0x3FF;
  const b10 = Math.min(1023, Math.max(0, Math.floor(b * 64))) & 0x3FF;
  
  // Pack into 128 bits using BigInt
  let bits = BigInt(0b00011); // mode 11
  bits |= BigInt(r10) << 5n;
  bits |= BigInt(g10) << 15n;
  bits |= BigInt(b10) << 25n;
  bits |= BigInt(r10) << 35n;  // endpoint 1 = endpoint 0
  bits |= BigInt(g10) << 45n;
  bits |= BigInt(b10) << 55n;
  // Indices stay 0 (all pixels use interpolation index 0)
  
  // Write as little-endian
  for (let i = 0; i < 16; i++) {
    block[i] = Number((bits >> BigInt(i * 8)) & 0xFFn);
  }
  
  return block;
}

function createBC6H_KTX2(width, height, filename) {
  const wBlocks = Math.ceil(width / 4);
  const hBlocks = Math.ceil(height / 4);
  const blockDataSize = wBlocks * hBlocks * 16;
  
  // Generate HDR gradient
  const blockData = new Uint8Array(blockDataSize);
  
  for (let by = 0; by < hBlocks; by++) {
    for (let bx = 0; bx < wBlocks; bx++) {
      const u = bx / (wBlocks - 1 || 1);
      const v = by / (hBlocks - 1 || 1);
      
      // HDR values 0 to 10
      const r = u * 10.0;
      const g = v * 10.0;
      const b = (1 - u) * 5.0;
      
      const block = encodeBC6HBlock(r, g, b);
      blockData.set(block, (by * wBlocks + bx) * 16);
    }
  }
  
  // Build KTX2 file
  const parts = [];
  
  // 1. Identifier (12 bytes)
  const identifier = Buffer.from([0xAB, 0x4B, 0x54, 0x58, 0x20, 0x32, 0x30, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A]);
  parts.push(identifier);
  
  // 2. Header (68 bytes)
  const header = Buffer.alloc(68);
  let off = 0;
  header.writeUInt32LE(143, off); off += 4;   // vkFormat = BC6H_UFLOAT_BLOCK
  header.writeUInt32LE(1, off); off += 4;     // typeSize
  header.writeUInt32LE(width, off); off += 4; // pixelWidth
  header.writeUInt32LE(height, off); off += 4;// pixelHeight
  header.writeUInt32LE(0, off); off += 4;     // pixelDepth
  header.writeUInt32LE(0, off); off += 4;     // layerCount
  header.writeUInt32LE(1, off); off += 4;     // faceCount
  header.writeUInt32LE(1, off); off += 4;     // levelCount
  header.writeUInt32LE(0, off); off += 4;     // supercompressionScheme
  
  // Index section in header
  const dfdByteLength = 28;
  const levelIndexSize = 24;
  const dfdByteOffset = 12 + 68 + levelIndexSize;
  const kvdByteOffset = dfdByteOffset + dfdByteLength;
  const kvdByteLength = 0;
  
  header.writeUInt32LE(dfdByteOffset, off); off += 4;
  header.writeUInt32LE(dfdByteLength, off); off += 4;
  header.writeUInt32LE(kvdByteOffset, off); off += 4;
  header.writeUInt32LE(kvdByteLength, off); off += 4;
  header.writeBigUInt64LE(0n, off); off += 8; // sgdByteOffset
  header.writeBigUInt64LE(0n, off); off += 8; // sgdByteLength
  parts.push(header);
  
  // 3. Level Index (24 bytes)
  const levelIndex = Buffer.alloc(24);
  const dataOffset = kvdByteOffset + kvdByteLength;
  // Align to 4 bytes minimum
  const alignedDataOffset = Math.ceil(dataOffset / 4) * 4;
  
  levelIndex.writeBigUInt64LE(BigInt(alignedDataOffset), 0);
  levelIndex.writeBigUInt64LE(BigInt(blockDataSize), 8);
  levelIndex.writeBigUInt64LE(BigInt(blockDataSize), 16);
  parts.push(levelIndex);
  
  // 4. DFD (Data Format Descriptor)
  const dfd = Buffer.alloc(dfdByteLength);
  dfd.writeUInt32LE(dfdByteLength, 0);  // totalSize
  dfd.writeUInt16LE(0, 4);   // vendorId
  dfd.writeUInt16LE(0, 6);   // descriptorType
  dfd.writeUInt16LE(2, 8);   // versionNumber
  dfd.writeUInt16LE(24, 10); // descriptorBlockSize
  dfd.writeUInt8(128, 12);   // colorModel (BC6H = 128)
  dfd.writeUInt8(1, 13);     // colorPrimaries (BT709)
  dfd.writeUInt8(2, 14);     // transferFunction (linear)
  dfd.writeUInt8(0, 15);     // flags
  dfd.writeUInt8(3, 16);     // texelBlockDimension[0] = 4-1
  dfd.writeUInt8(3, 17);     // texelBlockDimension[1] = 4-1
  dfd.writeUInt8(0, 18);     // texelBlockDimension[2]
  dfd.writeUInt8(0, 19);     // texelBlockDimension[3]
  dfd.writeUInt8(16, 20);    // bytesPlane[0]
  parts.push(dfd);
  
  // 5. Padding to align data
  const currentSize = 12 + 68 + 24 + dfdByteLength;
  const paddingSize = alignedDataOffset - currentSize;
  if (paddingSize > 0) {
    parts.push(Buffer.alloc(paddingSize));
  }
  
  // 6. Mip level data
  parts.push(Buffer.from(blockData));
  
  // Write file
  const fileBuffer = Buffer.concat(parts);
  fs.writeFileSync(filename, fileBuffer);
  
  console.log(`Created ${filename}`);
  console.log(`  Size: ${width}x${height} (${fileBuffer.length} bytes)`);
  console.log(`  Format: BC6H_UFLOAT_BLOCK (vkFormat 143)`);
  console.log(`  HDR range: R[0-10], G[0-10], B[0-5]`);
  console.log(`  Use exposure -3 to -4 to see full gradient`);
}

createBC6H_KTX2(64, 64, 'bc6h_test.ktx2');