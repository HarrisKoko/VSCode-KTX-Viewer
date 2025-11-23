// main.js — ES Module version
import {
  initLibKTX,
  transcodeFullKTX2 as importedTranscoder, // Renamed to avoid conflict if we keep inline
  checkFormatRequirements,
  getFormatName,
  vkFormatToWebGPU
} from './transcoder.js'; 

// Make functions available globally for backward compatibility
window.initLibKTX = initLibKTX;
window.checkFormatRequirements = checkFormatRequirements;
window.getFormatName = getFormatName;
window.vkFormatToWebGPU = vkFormatToWebGPU;

// Minimal logger to the on-screen <div id="log">
const log = (msg) => {
  const el = document.getElementById('log');
  if (el) el.textContent = String(msg);
};

// Upload helpers
function padRows(src, width, height, bytesPerPixel = 4) {
  const rowStride = width * bytesPerPixel;
  const aligned = Math.ceil(rowStride / 256) * 256;
  if (aligned === rowStride) return { data: src, bytesPerRow: rowStride };
  const dst = new Uint8Array(aligned * height);
  for (let y = 0; y < height; y++) {
    const s0 = y * rowStride, d0 = y * aligned;
    dst.set(src.subarray(s0, s0 + rowStride), d0);
  }
  return { data: dst, bytesPerRow: aligned };
}

function padBlockRowsBC(src, width, height, bytesPerBlock, blockWidth = 4, blockHeight = 4) {
  const wBlocks = Math.max(1, Math.ceil(width / blockWidth));
  const hBlocks = Math.max(1, Math.ceil(height / blockHeight));
  const rowBytesTight = wBlocks * bytesPerBlock;
  const bytesPerRowAligned = Math.ceil(rowBytesTight / 256) * 256;

  if (bytesPerRowAligned === rowBytesTight) {
    return { data: src, bytesPerRow: bytesPerRowAligned, rowsPerImage: hBlocks };
  }

  const dst = new Uint8Array(bytesPerRowAligned * hBlocks);
  for (let y = 0; y < hBlocks; y++) {
    const srcOffset = y * rowBytesTight;
    const dstOffset = y * bytesPerRowAligned;
    const copyLength = Math.min(rowBytesTight, src.byteLength - srcOffset);
    if (copyLength > 0) {
        dst.set(src.subarray(srcOffset, srcOffset + copyLength), dstOffset);
    }
  }
  return { data: dst, bytesPerRow: bytesPerRowAligned, rowsPerImage: hBlocks };
}

// Wait until read.js is loaded
async function waitForKTXParser() {
  let tries = 0;
  while (typeof window.parseKTX2 !== 'function') {
    if (tries++ > 500) throw new Error('KTX2 parser not loaded');
    await new Promise(r => setTimeout(r, 10));
  }
}

try {
  // WebGPU setup
  if (!('gpu' in navigator)) { throw new Error('WebGPU not available'); }
  const canvas = document.getElementById('gfx');
  const context = canvas.getContext('webgpu');
  if (!context) { throw new Error('Failed to get WebGPU context'); }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) { throw new Error('No GPU adapter'); }
  const bcSupported = adapter.features.has('texture-compression-bc');
  const device = await adapter.requestDevice({
    requiredFeatures: bcSupported ? ['texture-compression-bc'] : []
  });

  device.addEventListener?.('uncapturederror', (e) => {
    console.error('WebGPU uncaptured error:', e.error || e);
    // Don't show validation errors in UI to avoid spamming "Destroyed texture" logs
    if (!String(e.error || e).includes("Destroyed texture")) {
        log('WebGPU error: ' + (e.error?.message || e.message || 'unknown'));
    }
  });

  const format = navigator.gpu.getPreferredCanvasFormat();

  // Simple UI
  const ui = document.createElement('div');
  ui.style.cssText = 'position:absolute; right:12px; top:12px; background:#0008; padding:8px 10px; color:#ddd; font:12px monospace; border-radius:6px;';
  ui.innerHTML = `
    <div style="margin-bottom:6px;">
      <label>exposureEV:</label> <input id="ev" type="range" min="-10" max="10" step="0.1" value="0"> <span id="evv">0</span>
    </div>
    <div><input id="file" type="file" accept="image/png, image/jpeg, image/webp, .ktx2"></div>
    <div id="stat" style="margin-top:6px; opacity:.9;"></div>
    <div id="meta" style="margin-top:6px; opacity:.7; font-size:10px;"></div>
    <div style="margin-top:6px; opacity:.9;">BC Compression: ${bcSupported ? '✓ available' : '✗ not supported'}</div>
  `;
  document.body.appendChild(ui);

  const evInput = document.getElementById('ev');
  const evVal = document.getElementById('evv');
  const fileInp = document.getElementById('file');
  const stat = document.getElementById('stat');
  const meta = document.getElementById('meta');
  let exposureEV = 0;
  
  evInput.oninput = () => {
    exposureEV = parseFloat(evInput.value);
    evVal.textContent = evInput.value;
  };

  let lastW = 0, lastH = 0;
  function configureIfNeeded() {
    const w = Math.max(1, Math.floor(canvas.clientWidth));
    const h = Math.max(1, Math.floor(canvas.clientHeight));
    if (w !== lastW || h !== lastH) {
      canvas.width = w; canvas.height = h;
      context.configure({ device, format, alphaMode: 'opaque' });
      lastW = w; lastH = h;
    }
  }
  new ResizeObserver(configureIfNeeded).observe(canvas);
  configureIfNeeded();

  const uniformBuf = device.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  function updateUniforms() {
    const mul = Math.pow(2, exposureEV);
    const arr = new Float32Array([exposureEV, mul, lastW, lastH]);
    device.queue.writeBuffer(uniformBuf, 0, arr.buffer);
  }

  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });

  // Init default texture
  let srcTex = device.createTexture({ size: [2,2,1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  let srcView = srcTex.createView();
  
  // Create a working Transcoder function that uses getImage()
  window.transcodeFullKTX2 = async function(fileBuffer) {
    const m = await initLibKTX();
    let texture = null;
    try {
      try {
        texture = new m.ktxTexture(new Uint8Array(fileBuffer));
      } catch (e) { throw new Error(`Failed to create ktxTexture: ${e.message}`); }
      
      let shouldTranscode = false;
      if (texture.needsTranscoding) shouldTranscode = texture.needsTranscoding; // getter
      else if (texture.vkFormat === 0) shouldTranscode = true;

      if (shouldTranscode) {
        let targetFormat = 16; // BC7
        if (m.TranscodeTarget && m.TranscodeTarget.BC7_M5_RGBA) {
            targetFormat = m.TranscodeTarget.BC7_M5_RGBA.value ?? m.TranscodeTarget.BC7_M5_RGBA;
        }
        if (!texture.transcodeBasis(targetFormat, 0)) throw new Error("libktx transcoding failed");
      }

      const mips = [];
      const numLevels = texture.numLevels || 1;

      for (let i = 0; i < numLevels; i++) {
        // FIXED: Use getImage() instead of missing properties
        if (!texture.getImage) throw new Error("texture.getImage missing");
        
        const mipData = texture.getImage(i, 0, 0);
        const mipCopy = new Uint8Array(mipData); // Copy required

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
  };

  async function loadImageToTexture(file) {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    
    // Prevent rendering while swapping
    texBindGroup = null; 
    srcTex.destroy();
    
    srcTex = device.createTexture({
      size: [bmp.width, bmp.height, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
    });

    device.queue.copyExternalImageToTexture({ source: bmp }, { texture: srcTex }, { width: bmp.width, height: bmp.height });
    srcView = srcTex.createView();
    bmp.close?.();

    stat.textContent = `Loaded ${file.name} (${bmp.width}×${bmp.height})`;
    meta.textContent = '';
    if (texPipeline) texBindGroup = makeTexBindGroup();
  }
  
  async function loadKTX2_ToTexture(file) {
    if (!bcSupported) throw new Error('BC compression not supported');
    await waitForKTXParser();

    const buf = await file.arrayBuffer();
    const { header, levels, dfd, kvd } = await window.parseKTX2(buf);

    const isBasisFormat = header.supercompressionScheme === 1;
    const formatInfo = window.checkFormatRequirements(header.vkFormat);
    
    let wgpuFormat, blockWidth, blockHeight, bytesPerBlock;
    let transcodedLevels = null;

    if (isBasisFormat && header.vkFormat === 0) {
      stat.textContent = `Transcoding ${file.name}...`;
      try {
        transcodedLevels = await window.transcodeFullKTX2(buf);
        wgpuFormat = 'bc7-rgba-unorm';
        blockWidth = 4; blockHeight = 4; bytesPerBlock = 16;
        console.log("Transcoding success:", transcodedLevels);
      } catch (e) {
        log('Transcoding failed: ' + e.message);
        throw e;
      }
    } 
    else if (formatInfo && !formatInfo.needsProcessing) {
      const info = window.vkFormatToWebGPU(header.vkFormat);
      wgpuFormat = info.format;
      blockWidth = info.blockWidth;
      blockHeight = info.blockHeight;
      bytesPerBlock = info.bytesPerBlock;
      stat.textContent = `Loading ${file.name}...`;
    } 
    else {
      throw new Error(`Unsupported format: ${window.getFormatName(header.vkFormat)}`);
    }

    // Prevent rendering while swapping
    texBindGroup = null;
    srcTex?.destroy?.();
    
    srcTex = device.createTexture({
      size: { width: header.pixelWidth, height: header.pixelHeight, depthOrArrayLayers: 1 },
      format: wgpuFormat,
      mipLevelCount: levels.length,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });
    srcView = srcTex.createView();

    // Upload mips
    for (let i = 0; i < levels.length; i++) {
      // Safety check for mip count mismatch
      if (transcodedLevels && i >= transcodedLevels.length) break;

      const lvl = levels[i];
      let raw = transcodedLevels ? transcodedLevels[i].data : new Uint8Array(buf, lvl.byteOffset, lvl.byteLength);
      
      // Use transcoded dims if available (safer)
      const mipW = transcodedLevels ? transcodedLevels[i].width : lvl.width;
      const mipH = transcodedLevels ? transcodedLevels[i].height : lvl.height;

      const { data, bytesPerRow, rowsPerImage } = padBlockRowsBC(raw, mipW, mipH, bytesPerBlock, blockWidth, blockHeight);
      
      const uploadWidth = Math.ceil(mipW / blockWidth) * blockWidth;
      const uploadHeight = Math.ceil(mipH / blockHeight) * blockHeight;

      device.queue.writeTexture(
        { texture: srcTex, mipLevel: i },
        data,
        { bytesPerRow, rowsPerImage },
        { width: uploadWidth, height: uploadHeight, depthOrArrayLayers: 1 }
      );
    }

    // UI Updates
    stat.textContent = `Loaded ${file.name} [${isBasisFormat ? 'Basis->BC7' : 'Native BC'}]`;
    if (texPipeline) texBindGroup = makeTexBindGroup();
  }

  // Event Listener
  fileInp.addEventListener('change', async () => {
    const f = fileInp.files?.[0];
    if (!f) return;
    try {
      if (f.name.toLowerCase().endsWith('.ktx2')) await loadKTX2_ToTexture(f);
      else await loadImageToTexture(f);
    } catch (e) {
      console.error(e);
      log('Error: ' + e.message);
    }
  });

  // Shader & Pipeline
  const shaderResponse = await fetch(window.shaderUri);
  const shaderModule = device.createShaderModule({ code: await shaderResponse.text() });
  
  let texPipeline = null, solidPipeline = null;
  
  try {
    texPipeline = await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module: shaderModule, entryPoint: 'vs_textured' },
      fragment: { module: shaderModule, entryPoint: 'fs_textured', targets: [{ format }] },
      primitive: { topology: 'triangle-list' }
    });
  } catch(e) { console.error(e); }

  try {
    solidPipeline = await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module: shaderModule, entryPoint: 'vs_solid' },
      fragment: { module: shaderModule, entryPoint: 'fs_solid', targets: [{ format }] },
      primitive: { topology: 'triangle-list' }
    });
  } catch(e) { console.error(e); }

  function makeTexBindGroup() {
    return device.createBindGroup({
      layout: texPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniformBuf } },
        { binding: 1, resource: sampler },
        { binding: 2, resource: srcView }
      ]
    });
  }
  let texBindGroup = texPipeline ? makeTexBindGroup() : null;

  function frame() {
    configureIfNeeded();
    updateUniforms();
    const encoder = device.createCommandEncoder();
    const rtv = context.getCurrentTexture().createView();

    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: rtv, clearValue: { r:0.1, g:0.1, b:0.1, a:1 }, loadOp: 'clear', storeOp: 'store' }]
    });

    // Only draw if we have a valid bind group (prevents using destroyed texture)
    if (texPipeline && texBindGroup) {
      pass.setPipeline(texPipeline);
      pass.setBindGroup(0, texBindGroup);
      pass.draw(3);
    } else if (solidPipeline) {
      pass.setPipeline(solidPipeline);
      pass.draw(3);
    }
    pass.end();
    device.queue.submit([encoder.finish()]);
    requestAnimationFrame(frame);
  }
  frame();

} catch (e) {
  console.error(e);
  log(String(e));
}