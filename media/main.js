// main.js — JPG/PNG/WebP renderer + KTX2 (BC1-BC7) loader using WebGPU
// Layout: permanent left sidebar (320px) + canvas on right (no overlay).

import {
  initLibKTX,
  transcodeFullKTX2,
  checkFormatRequirements,
  getFormatName,
  vkFormatToWebGPU
} from './transcoder.js'; // This works because of the importmap in extension.ts

// Make functions available globally for backward compatibility
window.initLibKTX = initLibKTX;
window.transcodeFullKTX2 = transcodeFullKTX2;
window.checkFormatRequirements = checkFormatRequirements;
window.getFormatName = getFormatName;
window.vkFormatToWebGPU = vkFormatToWebGPU;

// Minimal logger (uses #log in sidebar)
const log = (msg) => {
  const el = document.getElementById('log');
  if (el) {
    el.style.display = 'block';
    el.textContent = String(msg);
  }
};

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

// ---------- Upload helpers ----------
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
  const wBlocks = Math.max(1, Math.ceil(width  / blockWidth));
  const hBlocks = Math.max(1, Math.ceil(height / blockHeight));
  const rowBytes = wBlocks * bytesPerBlock;

  const aligned = Math.ceil(rowBytes / 256) * 256;
  if (aligned === rowBytes) {
    return { data: src, bytesPerRow: rowBytes, rowsPerImage: hBlocks };
  }

  const dst = new Uint8Array(aligned * hBlocks);
  for (let y = 0; y < hBlocks; y++) {
    const s0 = y * rowBytes, d0 = y * aligned;
    dst.set(src.subarray(s0, s0 + rowBytes), d0);
  }
  return { data: dst, bytesPerRow: aligned, rowsPerImage: hBlocks };
}

async function waitForKTXParser() {
  let tries = 0;
  while (typeof window.parseKTX2 !== 'function') {
    if (tries++ > 500) throw new Error('KTX2 parser not loaded');
    await new Promise(r => setTimeout(r, 10));
  }
}

// ---------- build permanent left sidebar layout ----------
(function ensureLayout() {
  const canvas = document.getElementById('gfx');
  if (!canvas) {
    throw new Error('Canvas with id="gfx" not found in document.');
  }

  // If we already wrapped, do nothing
  if (document.getElementById('app-wrapper')) return;

  // Clean up any stray text nodes or elements in body (except canvas)
  const body = document.body;
  Array.from(body.childNodes).forEach(node => {
    if (node !== canvas && node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
      node.remove();
    }
  });

  // Create wrapper
  const wrapper = document.createElement('div');
  wrapper.id = 'app-wrapper';
  wrapper.style.display = 'flex';
  wrapper.style.flexDirection = 'row';
  wrapper.style.width = '100vw';
  wrapper.style.height = '100vh';
  wrapper.style.margin = '0';
  wrapper.style.padding = '0';
  wrapper.style.boxSizing = 'border-box';
  // Move body children into wrapper: we'll place sidebar and canvas specifically
  // Insert wrapper before canvas
  canvas.parentNode.insertBefore(wrapper, canvas);

  // Create sidebar
  const sidebar = document.createElement('div');
  sidebar.id = 'sidebar';
  sidebar.style.width = '320px';
  sidebar.style.minWidth = '240px';
  sidebar.style.maxWidth = '420px';
  sidebar.style.background = '#0b0b0b';
  sidebar.style.color = '#ddd';
  sidebar.style.overflow = 'auto';
  sidebar.style.padding = '12px';
  sidebar.style.boxSizing = 'border-box';
  sidebar.style.font = '13px monospace';
  sidebar.style.borderRight = '1px solid rgba(255,255,255,0.04)';
  sidebar.style.zIndex = 1000;

  // Create content in sidebar (keeps same controls but now permanent)
  sidebar.innerHTML = `
    <h3 style="margin:0 0 8px 0; font-weight:600; font-family:monospace;">KTX2 HDR Preview</h3>
    
    <div id="log" style="width:100%; padding:6px 8px; background:#111; color:#ddd; font:12px monospace; border-radius:6px; box-sizing:border-box; margin-bottom:12px; max-height:120px; overflow-y:auto; display:none;"></div>
    
    <div style="margin-bottom:8px;">
      <label style="display:block; font-size:12px;">Exposure (EV)</label>
      <input id="ev" type="range" min="-10" max="10" step="0.1" value="0" style="width:100%" />
      <div style="display:flex; justify-content:space-between; font-size:12px; margin-top:4px;">
        <div id="evv">0</div>
        <div id="stat" style="opacity:0.9"></div>
      </div>
    </div>

    <div style="margin-top:8px; margin-bottom:8px;">
      <label style="display:block; font-size:12px;">Open file</label>
      <input id="file" type="file" accept="image/png, image/jpeg, image/webp, .ktx2" style="width:100%" />
    </div>

    <div style="margin-top:8px; margin-bottom:8px;">
      <label style="display:block; font-size:12px; margin-bottom:4px;">Texture filtering</label>
      <select id="filterMode" style="width:100%; padding:4px; background:#222; color:#ddd; border:1px solid #444; border-radius:4px; font:12px monospace;">
        <option value="trilinear">Trilinear (smooth, mip blend)</option>
        <option value="bilinear">Bilinear (smooth, sharp mips)</option>
        <option value="nearest">Nearest (sharp/pixelated)</option>
        <option value="anisotropic">Anisotropic (high quality)</option>
      </select>
    </div>

    <div id="mip-controls" style="margin-top:8px; display:none;">
      <label style="font-size:12px; display:block; margin-bottom:6px;">Mipmap preview</label>
      <div style="display:flex; align-items:center; gap:8px;">
        <input id="mipSlider" type="range" min="0" max="0" value="0" step="1" style="flex:1" />
        <div id="mipLabel" style="width:28px; text-align:center;">0</div>
      </div>
      <div style="margin-top:6px; display:flex; align-items:center; gap:8px; font-size:12px;">
        <input id="mipOnly" type="checkbox" /> <label for="mipOnly">Show only selected mip</label>
      </div>
    </div>

    <div style="margin-top:8px;">
      <label style="font-size:12px; display:block; margin-bottom:6px;">Channel mix</label>
      <div style="display:grid; gap:6px;">
        <div style="display:flex; align-items:center; gap:8px;">
          <label style="color:#f88; width:12px; font:11px monospace;">R</label>
          <input id="channelR" type="range" min="0" max="2" step="0.01" value="1" style="flex:1" />
          <span id="channelRVal" style="width:32px; text-align:right; font:11px monospace;">1.00</span>
        </div>
        <div style="display:flex; align-items:center; gap:8px;">
          <label style="color:#8f8; width:12px; font:11px monospace;">G</label>
          <input id="channelG" type="range" min="0" max="2" step="0.01" value="1" style="flex:1" />
          <span id="channelGVal" style="width:32px; text-align:right; font:11px monospace;">1.00</span>
        </div>
        <div style="display:flex; align-items:center; gap:8px;">
          <label style="color:#88f; width:12px; font:11px monospace;">B</label>
          <input id="channelB" type="range" min="0" max="2" step="0.01" value="1" style="flex:1" />
          <span id="channelBVal" style="width:32px; text-align:right; font:11px monospace;">1.00</span>
        </div>
        <div style="display:flex; align-items:center; gap:8px;">
          <label style="color:#ddd; width:12px; font:11px monospace;">A</label>
          <input id="channelA" type="range" min="0" max="2" step="0.01" value="0" style="flex:1" />
          <span id="channelAVal" style="width:32px; text-align:right; font:11px monospace;">0.00</span>
        </div>
        <button id="channelReset" style="padding:4px 8px; background:#333; color:#ddd; border:1px solid #555; border-radius:4px; cursor:pointer; font:11px monospace; margin-top:4px;">Reset channels</button>
      </div>
    </div>

    <div id="meta" style="margin-top:12px; white-space:pre-wrap; font-size:12px; opacity:0.9;"></div>

    <div id="texInfo" style="margin-top:12px; padding:8px; background:#0d0d0d; border-radius:4px; font-size:11px; display:none;">
      <div style="font-weight:bold; margin-bottom:6px; color:#aaa;">Texture Info</div>
      <div id="texInfoContent" style="line-height:1.5;"></div>
    </div>

    <hr style="margin:12px 0 12px 0; border:0; height:1px; background:rgba(255,255,255,0.04);" />

    <div style="font-size:12px; color:#999;">
      <div>Tips:</div>
      <ul style="padding-left:18px; margin-top:6px;">
        <li>Use Mip slider to inspect individual mip levels.</li>
        <li>Check "Show only selected mip" to view it with exact texel-size sampling.</li>
      </ul>
    </div>

    <hr style="margin:12px 0 12px 0; border:0; height:1px; background:rgba(255,255,255,0.04);" />

    <div style="margin-top:8px;">
      <label style="font-size:12px; display:block; margin-bottom:4px;">Log</label>
      <div id="appLog" style="width:100%; padding:6px 8px; background:#0a0a0a; color:#aaa; font:11px monospace; border-radius:4px; box-sizing:border-box; max-height:150px; overflow-y:auto; border:1px solid #333; display:none;"></div>
    </div>
  `;

  // Put sidebar and canvas into wrapper
  wrapper.appendChild(sidebar);

  // Move the canvas into the right side container (flex grow)
  const canvasContainer = document.createElement('div');
  canvasContainer.id = 'canvas-container';
  canvasContainer.style.flex = '1 1 auto';
  canvasContainer.style.display = 'flex';
  canvasContainer.style.alignItems = 'stretch';
  canvasContainer.style.justifyContent = 'stretch';
  canvasContainer.style.overflow = 'hidden';
  canvasContainer.appendChild(canvas);
  wrapper.appendChild(canvasContainer);

  // Style canvas to fill container
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
  canvas.style.objectFit = 'contain';

  // Ensure body has no stray content showing
  document.body.style.margin = '0';
  document.body.style.padding = '0';
  document.body.style.overflow = 'hidden';
  document.body.style.background = '#000';
})();

// ---------- Main bootstrap (WebGPU + loaders + preview) ----------
(async () => {
  try {
    if (!('gpu' in navigator)) { 
      logApp('WebGPU not available in this browser.', 'error'); 
      throw new Error('WebGPU not available');
    }

    const canvas  = document.getElementById('gfx');
    const context = canvas.getContext('webgpu');
    if (!context) { 
      logApp('Failed to get WebGPU context.', 'error'); 
      throw new Error('Failed to get WebGPU context');
    }

    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) { 
      logApp('No GPU adapter found.', 'error'); 
      throw new Error('No GPU adapter');
    }

    // --- Log supported compressed texture formats ---
    const supportedFeatures = [];

    if (adapter.features.has("texture-compression-bc"))
      supportedFeatures.push("texture-compression-bc");

    if (adapter.features.has("texture-compression-etc2"))
      supportedFeatures.push("texture-compression-etc2");

    if (adapter.features.has("texture-compression-astc"))
      supportedFeatures.push("texture-compression-astc");
    // ------------------------------------------------

    const bcSupported = adapter.features.has('texture-compression-bc');
    const device = await adapter.requestDevice({
      requiredFeatures: supportedFeatures// bcSupported ? ['texture-compression-bc'] : []
    });
    if (adapter.features.has("texture-compression-etc2")) {
      logApp("ETC2 texture compression is supported natively.", 'success');
    }
    if (device.features.has("texture-compression-etc2")) {
      logApp("ETC2 texture compression is supported natively on device.", 'success');
    }
    device.addEventListener("uncapturederror", (event) => {
      console.error("WEBGPU ERROR:", event.error);
    });

  

    device.addEventListener?.('uncapturederror', (e) => {
      console.error('WebGPU uncaptured error:', e.error || e);
      logApp('WebGPU: ' + (e.error?.message || e.message || 'unknown error'), 'error');
    });

    logApp('WebGPU initialized successfully', 'success');

    const format = navigator.gpu.getPreferredCanvasFormat();

    // UI refs (now inside sidebar)
    const evInput = document.getElementById('ev');
    const evVal   = document.getElementById('evv');
    const fileInp = document.getElementById('file');
    const stat    = document.getElementById('stat');
    const meta    = document.getElementById('meta');
    const filterMode = document.getElementById('filterMode');

    const mipControls = document.getElementById('mip-controls');
    const mipSlider   = document.getElementById('mipSlider');
    const mipLabel    = document.getElementById('mipLabel');
    const mipOnlyBox  = document.getElementById('mipOnly');

    const texInfo = document.getElementById('texInfo');
    const texInfoContent = document.getElementById('texInfoContent');

    const channelR = document.getElementById('channelR');
    const channelG = document.getElementById('channelG');
    const channelB = document.getElementById('channelB');
    const channelA = document.getElementById('channelA');
    const channelRVal = document.getElementById('channelRVal');
    const channelGVal = document.getElementById('channelGVal');
    const channelBVal = document.getElementById('channelBVal');
    const channelAVal = document.getElementById('channelAVal');
    const channelReset = document.getElementById('channelReset');

    // Get channel multipliers
    function getChannelMultipliers() {
      return {
        r: parseFloat(channelR.value),
        g: parseFloat(channelG.value),
        b: parseFloat(channelB.value),
        a: parseFloat(channelA.value)
      };
    }

    // Format bytes for display
    function formatBytes(bytes) {
      if (bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
    }

    // Calculate GPU memory for a texture
    function calculateGPUMemory(width, height, format, mipLevels) {
      // Bytes per pixel for different formats
      const formatSizes = {
        'rgba8unorm': 4,
        'bc1-rgba-unorm': 0.5,  // 4 bits per pixel
        'bc2-rgba-unorm': 1,    // 8 bits per pixel
        'bc3-rgba-unorm': 1,    // 8 bits per pixel
        'bc4-r-unorm': 0.5,     // 4 bits per pixel
        'bc5-rg-unorm': 1,      // 8 bits per pixel
        'bc6h-rgb-ufloat': 1,   // 8 bits per pixel
        'bc7-rgba-unorm': 1     // 8 bits per pixel
      };

      const bytesPerPixel = formatSizes[format] || 4;
      let totalBytes = 0;

      // Calculate for each mip level
      for (let i = 0; i < mipLevels; i++) {
        const mipWidth = Math.max(1, width >> i);
        const mipHeight = Math.max(1, height >> i);
        totalBytes += mipWidth * mipHeight * bytesPerPixel;
      }

      return totalBytes;
    }

    // Update texture info panel
    function updateTextureInfo(fileSize, width, height, format, mipLevels, fileName, metadata = null) {
      const gpuMemory = calculateGPUMemory(width, height, format, mipLevels);
      const aspectRatio = (width / height).toFixed(3);
      
      let html = `<div style="color:#8cf;">Dimensions:</div>`;
      html += `<div style="margin-left:8px; margin-bottom:4px;">${width} × ${height} (${aspectRatio}:1)</div>`;
      
      html += `<div style="color:#8cf;">Format:</div>`;
      html += `<div style="margin-left:8px; margin-bottom:4px;">${format}</div>`;
      
      html += `<div style="color:#8cf;">Mip Levels:</div>`;
      html += `<div style="margin-left:8px; margin-bottom:4px;">${mipLevels}</div>`;
      
      html += `<div style="color:#8cf;">File Size:</div>`;
      html += `<div style="margin-left:8px; margin-bottom:4px;">${formatBytes(fileSize)}</div>`;
      
      html += `<div style="color:#8cf;">GPU Memory:</div>`;
      html += `<div style="margin-left:8px; margin-bottom:4px;">${formatBytes(gpuMemory)}</div>`;
      
      const compressionRatio = fileSize > 0 ? (gpuMemory / fileSize).toFixed(2) : 'N/A';
      html += `<div style="color:#8cf;">Compression:</div>`;
      html += `<div style="margin-left:8px; margin-bottom:4px;">${compressionRatio}x (GPU/File)</div>`;
      
      // Add metadata if provided (for KTX2 files)
      if (metadata) {
        if (metadata.supercompression) {
          html += `<div style="color:#8cf;">Supercompression:</div>`;
          html += `<div style="margin-left:8px; margin-bottom:4px;">${metadata.supercompression}</div>`;
        }
        if (metadata.kvd) {
          html += `<div style="color:#8cf;">KVD:</div>`;
          html += `<div style="margin-left:8px; margin-bottom:4px;">${metadata.kvd}</div>`;
        }
        if (metadata.dfd) {
          html += `<div style="color:#8cf;">DFD:</div>`;
          html += `<div style="margin-left:8px;">${metadata.dfd}</div>`;
        }
      }
      
      texInfoContent.innerHTML = html;
      texInfo.style.display = 'block';
    }

    // Swapchain configuration using canvas container size
    let lastW = 0, lastH = 0;
    function configureIfNeeded() {
      // Use canvas.clientWidth/Height to respect layout
      const dpr = 1;
      const w = Math.max(1, Math.floor(canvas.clientWidth  * dpr));
      const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      if (w !== lastW || h !== lastH) {
        canvas.width  = w;
        canvas.height = h;
        context.configure({ device, format, alphaMode: 'opaque' });
        lastW = w; lastH = h;
      }
    }
    new ResizeObserver(configureIfNeeded).observe(document.getElementById('canvas-container'));
    configureIfNeeded();

    // Uniform buffer for parameters
    const uniformBuf = device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    let exposureEV = 0;
    function updateUniforms() {
      const mul = Math.pow(2, exposureEV);
      const ch = getChannelMultipliers();
      const arr = new Float32Array([exposureEV, mul, lastW, lastH, ch.r, ch.g, ch.b, ch.a]);
      device.queue.writeBuffer(uniformBuf, 0, arr.buffer);
    }

    evInput.oninput = () => {
      exposureEV = parseFloat(evInput.value);
      evVal.textContent = evInput.value;
    };

    // Texture sampler (recreated when filter mode changes)
    function createSampler(mode) {
      if (mode === 'nearest') {
        return device.createSampler({ 
          magFilter: 'nearest', 
          minFilter: 'nearest',
          mipmapFilter: 'nearest'
        });
      } else if (mode === 'bilinear') {
        return device.createSampler({ 
          magFilter: 'linear', 
          minFilter: 'linear',
          mipmapFilter: 'nearest'  // Sharp mip transitions
        });
      } else if (mode === 'anisotropic') {
        return device.createSampler({ 
          magFilter: 'linear', 
          minFilter: 'linear',
          mipmapFilter: 'linear',
          maxAnisotropy: 16  // High quality anisotropic filtering
        });
      } else {  // trilinear (default)
        return device.createSampler({ 
          magFilter: 'linear', 
          minFilter: 'linear',
          mipmapFilter: 'linear'
        });
      }
    }
    let sampler = createSampler('trilinear');

    filterMode.onchange = () => {
      sampler = createSampler(filterMode.value);
      if (texPipeline) texBindGroup = makeTexBindGroup();
    };

    // Channel slider inputs
    channelR.oninput = () => { channelRVal.textContent = parseFloat(channelR.value).toFixed(2); };
    channelG.oninput = () => { channelGVal.textContent = parseFloat(channelG.value).toFixed(2); };
    channelB.oninput = () => { channelBVal.textContent = parseFloat(channelB.value).toFixed(2); };
    channelA.oninput = () => { channelAVal.textContent = parseFloat(channelA.value).toFixed(2); };

    // Reset button
    channelReset.onclick = () => {
      channelR.value = 1;
      channelG.value = 1;
      channelB.value = 1;
      channelA.value = 0;
      channelRVal.textContent = '1.00';
      channelGVal.textContent = '1.00';
      channelBVal.textContent = '1.00';
      channelAVal.textContent = '0.00';
    };

    // Initial placeholder texture
    function checkerRGBA8() {
      return new Uint8Array([
        255,255,255,255,   32,32,32,255,
         32,32,32,255,   255,255,255,255
      ]);
    }

    let srcTex = device.createTexture({
      size: { width: 2, height: 2, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING
           | GPUTextureUsage.COPY_DST
           | GPUTextureUsage.RENDER_ATTACHMENT
    });
    {
      const raw = checkerRGBA8();
      const { data, bytesPerRow } = padRows(raw, 2, 2);
      device.queue.writeTexture({ texture: srcTex }, data, { bytesPerRow }, { width: 2, height: 2 });
    }
    let srcView = srcTex.createView();

async function transcodeFullKTX2(fileBuffer) {
const m = await initLibKTX();

  let texture = null;
  try {
    // 1. LOAD TEXTURE
    try {
      const data = new Uint8Array(fileBuffer);
      texture = new m.ktxTexture2(data);
    } catch (e) {
      throw new Error(`Failed to create ktxTexture2: ${e.message}`);
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

    // Mip state
    let currentMip = 0;
    let mipCount = 1;
    mipSlider.oninput = () => {
      currentMip = Math.floor(parseFloat(mipSlider.value));
      mipLabel.textContent = currentMip;
      applySelectedMip();
    };
    mipOnlyBox.onchange = () => {
      applySelectedMip();
    };

    // ---------- Loaders ----------
    async function createMipImages(imageBitmap) {
      const w = imageBitmap.width, h = imageBitmap.height;
      const mips = [];
      const can = (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(1,1) : document.createElement('canvas');
      const ctx = can.getContext('2d');
      let pw = w, ph = h;
      while (true) {
        can.width = pw; can.height = ph;
        ctx.clearRect(0,0,pw,ph);
        ctx.drawImage(imageBitmap, 0, 0, pw, ph);
        const imgData = ctx.getImageData(0, 0, pw, ph);
        mips.push({ width: pw, height: ph, data: new Uint8Array(imgData.data.buffer) });
        if (pw === 1 && ph === 1) break;
        pw = Math.max(1, Math.floor(pw / 2));
        ph = Math.max(1, Math.floor(ph / 2));
      }
      return mips;
    }

    async function loadImageToTexture(file) {
      logApp(`Loading ${file.name}...`, 'info');
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });

      const levels = Math.floor(Math.log2(Math.max(1, Math.max(bmp.width, bmp.height)))) + 1;
      srcTex?.destroy?.();
      srcTex = device.createTexture({
        size: { width: bmp.width, height: bmp.height, depthOrArrayLayers: 1 },
        format: 'rgba8unorm',
        mipLevelCount: levels,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
      });

      device.queue.copyExternalImageToTexture(
        { source: bmp },
        { texture: srcTex },
        { width: bmp.width, height: bmp.height }
      );

      const mipImages = await createMipImages(bmp);
      for (let i = 0; i < mipImages.length; i++) {
        const m = mipImages[i];
        const { data, bytesPerRow } = padRows(m.data, m.width, m.height, 4);
        device.queue.writeTexture(
          { texture: srcTex, mipLevel: i },
          data,
          { bytesPerRow },
          { width: m.width, height: m.height, depthOrArrayLayers: 1 }
        );
      }

      srcView = srcTex.createView();
      mipCount = levels;
      currentMip = 0;
      mipSlider.min = 0;
      mipSlider.max = Math.max(0, mipCount - 1);
      mipSlider.value = 0;
      mipLabel.textContent = '0';
      mipControls.style.display = mipCount > 1 ? 'block' : 'none';

      bmp.close?.();
      stat.textContent = `Loaded ${file.name} (${srcTex.size?.width || '??'}×${srcTex.size?.height || '??'})`;
      meta.textContent = '';
      if (texPipeline) texBindGroup = makeTexBindGroup();
      
      // Update texture info panel
      updateTextureInfo(file.size, bmp.width, bmp.height, 'rgba8unorm', levels, file.name);
      
      logApp(`Successfully loaded ${file.name} (${bmp.width}×${bmp.height}, ${levels} mips)`, 'success');
    }

    async function loadKTX2_ToTexture(file) {
      if (!bcSupported) {
        logApp('BC compressed textures not supported on this device.', 'error');
        throw new Error('BC compressed textures not supported on this device.');
      }
      
      logApp(`Loading KTX2 ${file.name}...`, 'info');
      await waitForKTXParser();

      const buf = await file.arrayBuffer();
      const { header, levels, dfd, kvd } = await window.parseKTX2(buf);

      const is2D = header.pixelDepth === 0 && header.faceCount === 1;
      if (!is2D) {
        logApp('Only 2D, 1-face KTX2 supported in this demo.', 'error');
        throw new Error('Only 2D, 1-face KTX2 supported in this demo.');
      }

      const isBasisFormat = header.supercompressionScheme === 1;
      if (header.supercompressionScheme !== 0 && !isBasisFormat) {
        throw new Error('Supercompressed KTX2 (ZSTD/ZLIB) not supported. Only Basis Universal supported.');
      }

      // CHECK: What format is this?
      const formatInfo = window.checkFormatRequirements(header.vkFormat);// window.vkFormatToWebGPU(header.vkFormat);
      const isETC2 =
        header.vkFormat === 152 ||    // VK_FORMAT_ETC2_R8G8B8A8_UNORM_BLOCK
        header.vkFormat === 153 ||    // VK_FORMAT_ETC2_R8G8B8A8_SRGB_BLOCK
        header.vkFormat === 147 ||    // ETC2 formats RGB
        header.vkFormat === 148 ||
        header.vkFormat === 149;

      // if (!formatInfo && !isETC2 && !(isBasisFormat && header.vkFormat === 0)) {
      //   logApp(`Unsupported vkFormat ${header.vkFormat}. Supported: BC1-BC7, ETC2, BasisUniversal.`, 'error');
      //   throw new Error(`Unsupported vkFormat ${header.vkFormat}.`);
      // }
      let wgpuFormat, blockWidth, blockHeight, bytesPerBlock;
      // let { wgpuFormat, blockWidth, blockHeight, bytesPerBlock } = formatInfo;
      const formatName = window.getFormatName ? window.getFormatName(header.vkFormat) : `vkFormat ${header.vkFormat}`;
      // let wgpuFormat, blockWidth, blockHeight, bytesPerBlock;
      let transcodedLevels = null;

      const nativeSupported = adapter.features.has("texture-compression-etc2");
      // logApp("native ETC2 support:", nativeSupported);
      const needsTranscode =
        (isBasisFormat && header.vkFormat === 0) ||     // ETC1S, UASTC
        (isETC2 && !nativeSupported);                   // ETC2 unsupported → transcode

      if (isETC2 && nativeSupported) {
        wgpuFormat = "etc2-rgba8unorm";   // or srgb variant
        blockWidth = 4;
        blockHeight = 4;
        bytesPerBlock = 16;               // ETC2 is 64 bits per block = 8 bytes (RGB) or 16 bytes (RGBA)
        
        // ETC2_RGBA8 = 16 bytes per block
        if (header.vkFormat === 152 || header.vkFormat === 153) {
          bytesPerBlock = 16; // ETC2 RGBA8
        } else {
          bytesPerBlock = 8;  // ETC2 RGB formats
        }

        // mips: no transcoding, use raw level data
        transcodedLevels = null;

        logApp("ETC2 native path:", { wgpuFormat, bytesPerBlock });
      }

      // Special case: Basis Universal formats use VK_FORMAT_UNDEFINED (0)
      else if (needsTranscode) {
        let basisFormatName = 'Basis Universal';
  if (dfd && dfd.length > 0) {
    if (dfd[0].colorModel === 163) basisFormatName = 'ETC1S';
    else if (dfd[0].colorModel === 166 || dfd[0].colorModel === 152) basisFormatName = 'UASTC';
  }

  stat.textContent = `Loading ${file.name}... initializing transcoder for ${basisFormatName}`;
  meta.textContent = 'Initializing Basis Universal...';

  try {
    // Prefer your existing convenience wrapper if present (initLibKTX)
    if (window.initLibKTX && typeof window.initLibKTX === 'function') {
      await window.initLibKTX(); // preserves earlier behavior
    }
    // Then transcode
    transcodedLevels = await transcodeBasisKTX2(buf, header, levels, dfd, device);

    // If transcode returned numeric 'format' codes (Basis targets), map to WebGPU format strings:
    // We'll prefer BC7 if target was BC7, etc. You may already have vkFormatToWebGPU or similar.
    // For simplicity, set wgpuFormat to bc7 if device supports BC, otherwise use rgba8unorm.
    if (device.features.has('texture-compression-bc')) {
      wgpuFormat = 'bc7-rgba-unorm';
      blockWidth = 4; blockHeight = 4; bytesPerBlock = 16;
    } else {
      // fallback: upload RGBA8 uncompressed
      wgpuFormat = 'rgba8unorm';
      blockWidth = 1; blockHeight = 1; bytesPerBlock = 4;
      // Note: if using rgba8unorm ensure you use padRows() NOT padBlockRowsBC()
    }

    stat.textContent = `Transcoding ${transcodedLevels.length} levels...`;
    console.log("Transcoding success:", transcodedLevels);
  

          
        } catch (e) {
          console.error(e);
          logApp('Transcoding failed: ' + e.message);
          stat.textContent = 'Error: ' + e.message;
          throw e;
        }
      }

      // PATH 1: NATIVE BC FORMAT - use existing code as-is
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

      let mipCount = transcodedLevels ? transcodedLevels.length : levels.length;

      // Create GPU texture
      // srcTex?.destroy?.();
      srcTex = device.createTexture({
        size: { width: header.pixelWidth, height: header.pixelHeight, depthOrArrayLayers: 1 },
        format: wgpuFormat,
        mipLevelCount: mipCount,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
      });

      

      // Upload mip levels
      for (let i = 0; i < mipCount; i++) {
        const lvl = transcodedLevels ? transcodedLevels[i] : levels[i];
        const raw = transcodedLevels 
          ? transcodedLevels[i].data 
          : window.getLevelData(buf, lvl); // not new Uint8Array(buf, lvl.byteOffset, lvl.byteLength); ?
        const { data, bytesPerRow, rowsPerImage } =
          padBlockRowsBC(raw, lvl.width, lvl.height, bytesPerBlock, blockWidth, blockHeight);
        const uploadWidth = Math.ceil(lvl.width / blockWidth) * blockWidth;
        const uploadHeight = Math.ceil(lvl.height / blockHeight) * blockHeight;
        device.queue.writeTexture(
          { texture: srcTex, mipLevel: i },
          data,
          { bytesPerRow, rowsPerImage },
          { width: uploadWidth, height: uploadHeight, depthOrArrayLayers: 1 }
        );
      }

      mipCount = levels.length || 1;
      currentMip = 0;
      mipSlider.min = 0;
      mipSlider.max = Math.max(0, mipCount - 1);
      mipSlider.value = 0;
      mipLabel.textContent = '0';
      mipControls.style.display = mipCount > 1 ? 'block' : 'none';

      srcView = srcTex.createView();
      if (texPipeline) texBindGroup = makeTexBindGroup();

      // Build metadata object for texture info panel
      const compressionName = window.getSupercompressionName ? 
        window.getSupercompressionName(header.supercompressionScheme) : 
        (header.supercompressionScheme === 0 ? 'None' : `Scheme ${header.supercompressionScheme}`);
      
      const metadata = {
        supercompression: compressionName
      };
      
      if (kvd && Object.keys(kvd).length > 0) {
        let kvdStr = Object.keys(kvd).join(', ');
        if (kvd.KTXorientation) kvdStr += ` (orientation: ${kvd.KTXorientation})`;
        metadata.kvd = kvdStr;
      }
      
      if (dfd) {
        metadata.dfd = `colorModel=${dfd.colorModel}, transfer=${dfd.transferFunction}`;
      }
      
      stat.textContent = `Loaded ${file.name} (${header.pixelWidth}×${header.pixelHeight}, ${mipCount} mip${mipCount>1?'s':''})`;
      meta.textContent = '';  // Clear old meta display
      
      // Update texture info panel with metadata
      updateTextureInfo(file.size, header.pixelWidth, header.pixelHeight, formatName, mipCount, file.name, metadata);
      
      logApp(`Successfully loaded KTX2 ${file.name} (${header.pixelWidth}×${header.pixelHeight}, ${formatName}, ${mipCount} mips)`, 'success');
    }

    fileInp.addEventListener('change', async () => {
      const f = fileInp.files?.[0];
      if (!f) return;
      try {
        if (f.name.toLowerCase().endsWith('.ktx2')) {
          await loadKTX2_ToTexture(f);
        } else {
          await loadImageToTexture(f);
        }
      } catch (e) {
        console.error(e);
        logApp('Failed to load ' + f.name + ': ' + (e.message || e), 'error');
        stat.textContent = 'Error: ' + (e.message || e);
      }
    });

    // ---------- Shader load & pipeline ----------
    const shaderResponse = await fetch(window.shaderUri);
    const shaderCode = await shaderResponse.text();

    async function compileModule(code, label) {
      const mod = device.createShaderModule({ code, label });
      const info = await mod.getCompilationInfo();
      if (info.messages?.length) {
        console.group(`WGSL ${label} diagnostics`);
        for (const m of info.messages) {
          const logMsg = `${m.type} (${m.lineNum}:${m.linePos}): ${m.message}`;
          console[m.type === 'error' ? 'error' : (m.type === 'warning' ? 'warn' : 'log')](logMsg);
          if (m.type === 'error') {
            logApp(`Shader ${label}: ${logMsg}`, 'error');
          }
        }
        console.groupEnd();
      }
      return mod;
    }

    const shaderModule = await compileModule(shaderCode, 'shaders');
    logApp('Shaders compiled', 'success');

    let texPipeline = null;
    let solidPipeline = null;

    try {
      texPipeline = await device.createRenderPipelineAsync({
        layout: 'auto',
        vertex:   { module: shaderModule, entryPoint: 'vs_textured' },
        fragment: { module: shaderModule, entryPoint: 'fs_textured', targets: [{ format }] },
        primitive:{ topology: 'triangle-list' }
      });
      logApp('Textured pipeline created', 'success');
    } catch (e) {
      console.error('Textured pipeline creation failed:', e);
      logApp('Textured pipeline failed: ' + (e.message || e), 'error');
    }

    try {
      solidPipeline = await device.createRenderPipelineAsync({
        layout: 'auto',
        vertex:   { module: shaderModule, entryPoint: 'vs_solid' },
        fragment: { module: shaderModule, entryPoint: 'fs_solid', targets: [{ format }] },
        primitive:{ topology: 'triangle-list' }
      });
      logApp('Solid pipeline created', 'success');
    } catch (e) {
      console.error('Solid pipeline creation failed:', e);
      logApp('Solid pipeline failed: ' + (e.message || e), 'error');
      throw new Error('Pipeline creation failed');
    }

    function makeTexBindGroup() {
      const bgl0 = texPipeline.getBindGroupLayout(0);
      return device.createBindGroup({
        layout: bgl0,
        entries: [
          { binding: 0, resource: { buffer: uniformBuf } },
          { binding: 1, resource: sampler },
          { binding: 2, resource: srcView }
        ]
      });
    }
    let texBindGroup = texPipeline ? makeTexBindGroup() : null;

    function applySelectedMip() {
      if (srcTex && mipCount > 0 && mipOnlyBox.checked) {
        srcView = srcTex.createView({ baseMipLevel: currentMip, mipLevelCount: 1 });
      } else {
        srcView = srcTex.createView();
      }
      if (texPipeline) texBindGroup = makeTexBindGroup();
    }

    // ---------- Frame loop ----------
    function frame() {
      configureIfNeeded();
      updateUniforms();

      const swap = context.getCurrentTexture();
      const rtv = swap.createView();

      const encoder = device.createCommandEncoder();

      // Clear pass
      {
        const pass = encoder.beginRenderPass({
          colorAttachments: [{
            view: rtv,
            clearValue: { r: 0.07, g: 0.07, b: 0.08, a: 1 },
            loadOp: 'clear',
            storeOp: 'store'
          }]
        });
        pass.end();
      }

      // Draw pass
      {
        const pass = encoder.beginRenderPass({
          colorAttachments: [{ view: rtv, loadOp: 'load', storeOp: 'store' }]
        });

        if (texPipeline && texBindGroup) {
          pass.setPipeline(texPipeline);
          pass.setBindGroup(0, texBindGroup);
          pass.draw(3);
        } else {
          pass.setPipeline(solidPipeline);
          pass.draw(3);
        }
        pass.end();
      }

      device.queue.submit([encoder.finish()]);
      requestAnimationFrame(frame);
    }
    frame();

    // Adapter info log
    try {
      const info = await adapter.requestAdapterInfo?.();
      if (info) logApp(`GPU: ${info.vendor} ${info.architecture} ${info.description}`, 'info');
    } catch {
      // Silent fail
    }

    // Debug access
    window._ktx2_demo = { device, adapter, srcTex, srcView, applySelectedMip };

  } catch (e) {
    console.error(e);
    logApp(String(e.message || e), 'error');
  }
})();
