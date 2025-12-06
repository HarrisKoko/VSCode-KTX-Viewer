// main.js - Fixed Logic, Full UI

import {
  initLibKTX,
  transcodeFullKTX2,
  checkFormatRequirements,
  getFormatName,
  vkFormatToWebGPU
} from './transcoder.js';

import CreateKTX2Module from './ktx2_module.js';

let ktx2ModulePromise = null;
async function getKtx2Module() {
  if (!ktx2ModulePromise) {
    ktx2ModulePromise = CreateKTX2Module();
  }
  return ktx2ModulePromise;
}


// Global exports
window.initLibKTX = initLibKTX;
window.transcodeFullKTX2 = transcodeFullKTX2;
window.checkFormatRequirements = checkFormatRequirements;
window.getFormatName = getFormatName;
window.vkFormatToWebGPU = vkFormatToWebGPU;

/**
 * Minimal logging to #log element in test harness sidebar.
 */
function log(msg) {
  const el = document.getElementById('log');
  if (!el) return;
  el.style.display = 'block';
  el.textContent = msg;
}

/**
 * More advanced logging to #appLog in the sidebar.
 */
function logApp(message, level = 'info') {
  const logElement = document.getElementById('appLog');
  if (!logElement) {
    console[level === 'error' ? 'error' : (level === 'warn' ? 'warn' : 'log')](message);
    return;
  }

  logElement.style.display = 'block';

  const entry = document.createElement('div');
  entry.style.marginBottom = '4px';
  entry.style.paddingBottom = '4px';
  entry.style.borderBottom = '1px solid #222';

  const colorMap = {
    error: '#ff6666',
    warn: '#ffcc66',
    success: '#66ff66',
    info: '#aaaaaa'
  };
  entry.style.color = colorMap[level] || colorMap.info;

  const now = new Date();
  const timeString = now.toLocaleTimeString();
  entry.textContent = `[${timeString}] ${message}`;

  logElement.appendChild(entry);
  logElement.scrollTop = logElement.scrollHeight;

  if (level === 'error') console.error(message);
  else if (level === 'warn') console.warn(message);
  else console.log(message);
}

/**
 * Wait for parseKTX2 to be registered by read.js.
 */
async function waitForKTXParser() {
  let attempts = 0;
  while (typeof window.parseKTX2 !== 'function') {
    if (attempts++ > 300) {
      throw new Error('Timed out waiting for KTX2 parser to load.');
    }
    await new Promise(res => setTimeout(res, 50));
  }
}

/**
 * Padd row-aligned data to 256 bytes per row for WebGPU.
 */
function padRows(src, width, height, bytesPerPixel = 4) {
  const rowStride = width * bytesPerPixel;
  const alignedStride = Math.ceil(rowStride / 256) * 256;
  if (alignedStride === rowStride) {
    return { data: src, bytesPerRow: rowStride };
  }

  const dst = new Uint8Array(alignedStride * height);
  for (let y = 0; y < height; y++) {
    const srcOffset = y * rowStride;
    const dstOffset = y * alignedStride;
    dst.set(src.subarray(srcOffset, srcOffset + rowStride), dstOffset);
  }

  return { data: dst, bytesPerRow: alignedStride };
}

/**
 * For block compressed formats (BC/ETC), pad row of blocks to 256 bytes.
 */
function padBlockRowsBC(src, width, height, bytesPerBlock, blockWidth = 4, blockHeight = 4) {
  const wBlocks = Math.max(1, Math.ceil(width / blockWidth));
  const hBlocks = Math.max(1, Math.ceil(height / blockHeight));

  const rowBytes = wBlocks * bytesPerBlock;
  const alignedStride = Math.ceil(rowBytes / 256) * 256;
  const rowsPerImage = hBlocks;

  if (alignedStride === rowBytes) {
    return {
      data: src,
      bytesPerRow: rowBytes,
      rowsPerImage
    };
  }

  const dst = new Uint8Array(alignedStride * hBlocks);
  for (let y = 0; y < hBlocks; y++) {
    const srcOffset = y * rowBytes;
    const dstOffset = y * alignedStride;
    dst.set(src.subarray(srcOffset, srcOffset + rowBytes), dstOffset);
  }

  return {
    data: dst,
    bytesPerRow: alignedStride,
    rowsPerImage
  };
}

/**
 * Convert KTX2 metadata into human-readable text for the UI.
 */
function updateTextureInfo(fileSize, width, height, formatName, mips, fileName, metadata) {
  const texInfo = document.getElementById('texInfo');
  const texInfoContent = document.getElementById('texInfoContent');
  if (!texInfo || !texInfoContent) return;

  let html = '';
  html += `<div><strong>File:</strong> ${fileName}</div>`;
  html += `<div><strong>File size:</strong> ${(fileSize / 1024).toFixed(2)} KB</div>`;
  html += `<div><strong>Dimensions:</strong> ${width}×${height}</div>`;
  html += `<div><strong>Mip levels:</strong> ${mips}</div>`;
  html += `<div><strong>Format:</strong> ${formatName}</div>`;

  if (metadata) {
    const sc = metadata.supercompression || 'None';
    html += `<div><strong>Supercompression:</strong> ${sc}</div>`;
    if (metadata.basisFormatName) {
      html += `<div><strong>Basis Variant:</strong> ${metadata.basisFormatName}</div>`;
    }
    if (metadata.dfd) {
      html += `<div style="margin-top:4px;"><strong>DFD:</strong></div>`;
      html += `<div style="margin-left:8px;">${metadata.dfd}</div>`;
    }
  }

  texInfoContent.innerHTML = html;
  texInfo.style.display = 'block';
}

/**
 * Setup the page layout on startup.
 */
(function ensureLayout() {
  const canvas = document.getElementById('gfx');
  if (!canvas) {
    throw new Error('Canvas with id="gfx" not found.');
  }

  const existingWrapper = document.getElementById('app-wrapper');
  if (existingWrapper) {
    const container = document.getElementById('canvas-container');
    if (container && !canvas.parentNode?.isSameNode(container)) {
      container.appendChild(canvas);
    }
    return;
  }

  const body = document.body;
  Array.from(body.childNodes).forEach(node => {
    if (node !== canvas && node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
      node.remove();
    }
  });

  const wrapper = document.createElement('div');
  wrapper.id = 'app-wrapper';
  wrapper.style.display = 'flex';
  wrapper.style.flexDirection = 'row';
  wrapper.style.width = '100vw';
  wrapper.style.height = '100vh';
  wrapper.style.margin = '0';
  wrapper.style.padding = '0';
  wrapper.style.boxSizing = 'border-box';
  canvas.parentNode.insertBefore(wrapper, canvas);

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

  if (window.sidebarTemplate) {
    sidebar.innerHTML = window.sidebarTemplate;
  } else {
    console.error('Sidebar template not found.');
    sidebar.innerHTML = '<h3>KTX2 Viewer</h3>';
  }

  const canvasContainer = document.createElement('div');
  canvasContainer.id = 'canvas-container';
  canvasContainer.style.flex = '1 1 auto';
  canvasContainer.style.display = 'flex';
  canvasContainer.style.alignItems = 'stretch';
  canvasContainer.style.justifyContent = 'stretch';
  canvasContainer.style.overflow = 'hidden';
  canvasContainer.appendChild(canvas);

  wrapper.appendChild(sidebar);
  wrapper.appendChild(canvasContainer);

  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.objectFit = 'contain';

  document.body.style.margin = '0';
  document.body.style.padding = '0';
  document.body.style.overflow = 'hidden';
  document.body.style.background = '#000';
})();

/**
 * Main async entrypoint: WebGPU init + event hooks + render loop.
 */
(async function main() {
  try {
    if (!('gpu' in navigator)) {
      logApp('WebGPU not available. Use Chrome/Edge/Firefox with WebGPU enabled.', 'error');
      return;
    }

    const canvas = document.getElementById('gfx');
    const context = canvas.getContext('webgpu');
    if (!context) {
      throw new Error('Failed to get WebGPU context from canvas.');
    }

    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: 'high-performance'
    });
    if (!adapter) {
      throw new Error('No GPU adapter found. WebGPU may not be enabled.');
    }

    const bcSupported = adapter.features.has('texture-compression-bc');
    const etc2Supported = adapter.features.has('texture-compression-etc2');

    logApp(`BC support: ${bcSupported}, ETC2 support: ${etc2Supported}`, 'info');

    const requiredFeatures = [];
    if (bcSupported) requiredFeatures.push('texture-compression-bc');
    if (etc2Supported) requiredFeatures.push('texture-compression-etc2');

    const device = await adapter.requestDevice({
      requiredFeatures
    });

    device.addEventListener?.('uncapturederror', (event) => {
      logApp(`WebGPU uncaptured error: ${event.error?.message || event.message}`, 'error');
    });

    const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
    logApp(`Canvas format: ${canvasFormat}`, 'info');

    const evInput   = document.getElementById('ev');
    const evLabel   = document.getElementById('evv');
    const fileInput = document.getElementById('file');
    const stat      = document.getElementById('stat');
    const meta      = document.getElementById('meta');
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

    let srcTex = device.createTexture({
      size: { width: 2, height: 2, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });
    let srcView = srcTex.createView();

    {
      const checker = new Uint8Array([
        255,255,255,255,  32,32,32,255,
        32,32,32,255,   255,255,255,255
      ]);
      const { data, bytesPerRow } = padRows(checker, 2, 2, 4);
      device.queue.writeTexture(
        { texture: srcTex },
        data,
        { bytesPerRow },
        { width: 2, height: 2, depthOrArrayLayers: 1 }
      );
    }

    let mipCount = 1;
    let currentMip = 0;

    mipSlider.oninput = () => {
      currentMip = parseInt(mipSlider.value, 10);
      mipLabel.textContent = String(currentMip);
      applySelectedMip();
    };

    mipOnlyBox.onchange = applySelectedMip;

    function getChannelMultipliers() {
      return {
        r: parseFloat(channelR.value),
        g: parseFloat(channelG.value),
        b: parseFloat(channelB.value),
        a: parseFloat(channelA.value)
      };
    }

    channelR.oninput = () => {
      channelRVal.textContent = parseFloat(channelR.value).toFixed(2);
    };
    channelG.oninput = () => {
      channelGVal.textContent = parseFloat(channelG.value).toFixed(2);
    };
    channelB.oninput = () => {
      channelBVal.textContent = parseFloat(channelB.value).toFixed(2);
    };
    channelA.oninput = () => {
      channelAVal.textContent = parseFloat(channelA.value).toFixed(2);
    };

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

    let exposureEV = 0.0;
    evInput.oninput = () => {
      exposureEV = parseFloat(evInput.value);
      evLabel.textContent = evInput.value;
    };

    const uniformBuffer = device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    let sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear'
    });

    filterMode.onchange = () => {
      const v = filterMode.value;
      if (v === 'point') {
        sampler = device.createSampler({
          magFilter: 'nearest',
          minFilter: 'nearest',
          mipmapFilter: 'nearest'
        });
      } else if (v === 'linear') {
        sampler = device.createSampler({
          magFilter: 'linear',
          minFilter: 'linear',
          mipmapFilter: 'linear'
        });
      } else {
        sampler = device.createSampler({
          magFilter: 'linear',
          minFilter: 'linear',
          mipmapFilter: 'nearest'
        });
      }
      texBindGroup = makeTexBindGroup();
    };

    function updateUniforms() {
      const exposureMul = Math.pow(2.0, exposureEV);
      const channels = getChannelMultipliers();
      const data = new Float32Array([
        exposureEV, exposureMul, canvas.width, canvas.height,
        channels.r, channels.g, channels.b, channels.a
      ]);
      device.queue.writeBuffer(uniformBuffer, 0, data.buffer);
    }

    async function createMipImages(imageBitmap) {
      const w = imageBitmap.width;
      const h = imageBitmap.height;
      const mips = [];

      const offscreen = typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(1, 1)
        : document.createElement('canvas');

      const ctx = offscreen.getContext('2d');

      let mipW = w;
      let mipH = h;

      while (true) {
        offscreen.width = mipW;
        offscreen.height = mipH;
        ctx.clearRect(0, 0, mipW, mipH);
        ctx.drawImage(imageBitmap, 0, 0, mipW, mipH);

        const imageData = ctx.getImageData(0, 0, mipW, mipH);
        const raw = new Uint8Array(imageData.data.buffer);
        mips.push({ width: mipW, height: mipH, data: raw });

        if (mipW === 1 && mipH === 1) break;

        mipW = Math.max(1, mipW >> 1);
        mipH = Math.max(1, mipH >> 1);
      }

      return mips;
    }

    async function loadImageToTexture(file) {
      logApp(`Loading ${file.name} as standard image...`, 'info');

      const bitmap = await createImageBitmap(file, {
        imageOrientation: 'from-image'
      });

      const maxDim = Math.max(bitmap.width, bitmap.height);
      const levels = Math.floor(Math.log2(Math.max(1, maxDim))) + 1;

      srcTex?.destroy?.();
      srcTex = device.createTexture({
        size: {
          width: bitmap.width,
          height: bitmap.height,
          depthOrArrayLayers: 1
        },
        format: 'rgba8unorm',
        mipLevelCount: levels,
        usage: GPUTextureUsage.TEXTURE_BINDING |
               GPUTextureUsage.COPY_DST |
               GPUTextureUsage.RENDER_ATTACHMENT
      });
      srcView = srcTex.createView();

      const mipImages = await createMipImages(bitmap);
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

      mipCount    = levels;
      currentMip  = 0;
      mipSlider.min = 0;
      mipSlider.max = Math.max(0, mipCount - 1);
      mipSlider.value = 0;
      mipLabel.textContent = '0';
      mipControls.style.display = (mipCount > 1) ? 'block' : 'none';

      srcView = srcTex.createView();
      texBindGroup = makeTexBindGroup();

      updateTextureInfo(file.size, bitmap.width, bitmap.height, 'rgba8unorm', levels, file.name);
      logApp(`Successfully loaded ${file.name} (${bitmap.width}×${bitmap.height}, ${levels} mips)`, 'success');
    }

    async function loadKTX2_ToTexture(file) {
      logApp(`Loading KTX2 ${file.name}...`, 'info');
      await waitForKTXParser();

      const buf = await file.arrayBuffer();
      const u8 = new Uint8Array(buf);

      // Parse KTX2 container to get header + level metadata
      const { header, levels, dfd, kvd } = await window.parseKTX2(buf, device);

      const is2D = header.pixelDepth === 0 && header.faceCount === 1;
      if (!is2D) {
        logApp('Only 2D, 1-face KTX2 supported in this viewer.', 'error');
        throw new Error('Only 2D, 1-face KTX2 supported.');
      }

      const superName = window.getSupercompressionName
        ? window.getSupercompressionName(header.supercompressionScheme)
        : (header.supercompressionScheme === 0 ? 'None' : `Scheme ${header.supercompressionScheme}`);

      const isBasisLZ = header.supercompressionScheme === 1; // BASIS_LZ (ETC1S/UASTC)
      let wgpuFormat      = null;
      let blockWidth      = 0;
      let blockHeight     = 0;
      let bytesPerBlock   = 0;
      let decodedMips     = null;
      let mipCount        = 0;

      // -----------------------------------------------------------------------------------
      // PATH 1: BASIS-LZ (ETC1S/UASTC) → Use our WASM ktx2_transcoder to decode to RGBA8
      // -----------------------------------------------------------------------------------
      if (isBasisLZ) {
        logApp(`Supercompression: ${superName} (BasisLZ) → decoding via WASM ktx2_transcoder`, 'info');

        const wasm = await getKtx2Module();
        if (!wasm) {
          throw new Error('Failed to initialize WASM KTX2 module');
        }

        // Allocate KTX2 file in WASM heap
        const filePtr = wasm._malloc(u8.length);
        if (!filePtr) {
          throw new Error('WASM malloc for KTX2 buffer failed');
        }
        wasm.HEAPU8.set(u8, filePtr);

        const transcoder = new wasm.ktx2_transcoder();
        try {
          const okInit = transcoder.init(filePtr, u8.length >>> 0);
          if (!okInit) {
            throw new Error('ktx2_transcoder.init() failed – is this a valid KTX2 Basis file?');
          }

          if (!transcoder.start_transcoding()) {
            throw new Error('ktx2_transcoder.start_transcoding() failed');
          }

          const width   = transcoder.get_width();
          const height  = transcoder.get_height();
          const levelsCount = transcoder.get_levels();
          const layers  = Math.max(1, transcoder.get_layers());
          const faces   = Math.max(1, transcoder.get_faces());

          if (layers !== 1 || faces !== 1) {
            throw new Error(`Only 2D, 1-layer, 1-face Basis KTX2 supported (got layers=${layers}, faces=${faces})`);
          }

          // NOTE: This constant comes from basist::transcoder_texture_format::cTFRGBA32.
          // If your build uses different enum values, adjust this to match.
          const TF_RGBA32 = 13;

          decodedMips = [];
          for (let levelIndex = 0; levelIndex < levelsCount; levelIndex++) {
            const info = transcoder.get_image_level_info(levelIndex, 0, 0);
            if (!info) break;

            const mipW = Math.max(1, info.orig_width);
            const mipH = Math.max(1, info.orig_height);
            const pixels = mipW * mipH;
            const outBytes = pixels * 4;

            const outPtr = wasm._malloc(outBytes);
            if (!outPtr) {
              logApp(`WASM malloc failed for level ${levelIndex}`, 'error');
              break;
            }

            const ok = transcoder.transcode_image_level(
              levelIndex,
              0, // layer
              0, // face
              outPtr,
              pixels,    // output size in pixels (RGBA32)
              TF_RGBA32, // see note above
              0          // decode_flags
            );

            if (!ok) {
              wasm._free(outPtr);
              logApp(`transcode_image_level() failed at level ${levelIndex}`, 'error');
              break;
            }

            const view = new Uint8Array(wasm.HEAPU8.buffer, outPtr, outBytes);
            const copy = new Uint8Array(outBytes);
            copy.set(view);
            wasm._free(outPtr);

            decodedMips.push({ width: mipW, height: mipH, data: copy });
          }

          mipCount = decodedMips.length;
          if (mipCount === 0) {
            throw new Error('WASM decoder did not produce any mip levels');
          }

          // For now, upload as uncompressed RGBA8 to WebGPU.
          wgpuFormat = 'rgba8unorm';
          blockWidth = blockHeight = bytesPerBlock = 0;

          logApp(`WASM KTX2 decoder produced ${mipCount} mip levels (${width}×${height})`, 'success');
        } finally {
          transcoder.delete();
          wasm._free(filePtr);
        }
      }
      // -----------------------------------------------------------------------------------
      // PATH 2: No supercompression → rely on vkFormat mapping (BC/ETC etc.)
      // -----------------------------------------------------------------------------------
      else {
        const formatInfo = window.vkFormatToWebGPU
          ? window.vkFormatToWebGPU(header.vkFormat)
          : window.checkFormatRequirements?.(header.vkFormat);

        if (!formatInfo) {
          logApp(`Unsupported vkFormat ${header.vkFormat} for non-supercompressed KTX2.`, 'error');
          throw new Error(`Unsupported vkFormat ${header.vkFormat}.`);
        }

        wgpuFormat    = formatInfo.format;
        blockWidth    = formatInfo.blockWidth;
        blockHeight   = formatInfo.blockHeight;
        bytesPerBlock = formatInfo.bytesPerBlock;

        const isBlockCompressed = !!blockWidth;
        if (isBlockCompressed && !bcSupported) {
          logApp('BC-compressed KTX2, but GPU does not support BC formats.', 'error');
          throw new Error('BC formats not supported on this device.');
        }

        mipCount = levels.length;

        logApp(`No supercompression (${superName}). Using direct ${wgpuFormat} with ${mipCount} mips.`, 'info');
      }

      // -----------------------------------------------------------------------------------
      // CREATE GPU TEXTURE
      // -----------------------------------------------------------------------------------
      srcTex?.destroy?.();
      srcTex = device.createTexture({
        size: {
          width:  header.pixelWidth,
          height: header.pixelHeight,
          depthOrArrayLayers: 1
        },
        format: wgpuFormat,
        mipLevelCount: mipCount,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
      });

      srcView = srcTex.createView();
      texBindGroup = makeTexBindGroup();

      // -----------------------------------------------------------------------------------
      // UPLOAD MIP LEVELS
      // -----------------------------------------------------------------------------------
      if (decodedMips) {
        // Uncompressed RGBA8 path
        for (let i = 0; i < mipCount; i++) {
          const lvl = decodedMips[i];
          const { data, bytesPerRow } = padRows(lvl.data, lvl.width, lvl.height, 4);
          device.queue.writeTexture(
            { texture: srcTex, mipLevel: i },
            data,
            { bytesPerRow },
            { width: lvl.width, height: lvl.height, depthOrArrayLayers: 1 }
          );
        }
      } else {
        // Block-compressed (or other non-supercompressed) path
        for (let i = 0; i < mipCount; i++) {
          const lvl = levels[i];
          const raw = window.getLevelData(buf, lvl);

          if (blockWidth && blockHeight && bytesPerBlock) {
            const { data, bytesPerRow, rowsPerImage } = padBlockRowsBC(
              raw, lvl.width, lvl.height, bytesPerBlock, blockWidth, blockHeight
            );
            const uploadWidth  = Math.ceil(lvl.width  / blockWidth ) * blockWidth;
            const uploadHeight = Math.ceil(lvl.height / blockHeight) * blockHeight;

            device.queue.writeTexture(
              { texture: srcTex, mipLevel: i },
              data,
              { bytesPerRow, rowsPerImage },
              { width: uploadWidth, height: uploadHeight, depthOrArrayLayers: 1 }
            );
          } else {
            // Fallback: treat as tightly-packed RGBA8
            const { data, bytesPerRow } = padRows(raw, lvl.width, lvl.height, 4);
            device.queue.writeTexture(
              { texture: srcTex, mipLevel: i },
              data,
              { bytesPerRow },
              { width: lvl.width, height: lvl.height, depthOrArrayLayers: 1 }
            );
          }
        }
      }

      // -----------------------------------------------------------------------------------
      // UPDATE UI + STATE
      // -----------------------------------------------------------------------------------
      mipSlider.min = 0;
      mipSlider.max = Math.max(0, mipCount - 1);
      mipSlider.value = 0;
      mipLabel.textContent = '0';
      mipControls.style.display = mipCount > 1 ? 'block' : 'none';

      const metadata = { supercompression: superName };
      updateTextureInfo(file.size, header.pixelWidth, header.pixelHeight, wgpuFormat, mipCount, file.name, metadata);

      stat.textContent = `Loaded ${file.name} (${header.pixelWidth}×${header.pixelHeight}, ${mipCount} mips)`;
      meta.textContent = '';
      logApp(`Successfully loaded KTX2 ${file.name}`, 'success');
    }

    function configureIfNeeded() {
      const dpr = 1;
      const w = Math.max(1, Math.floor(canvas.clientWidth  * dpr));
      const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));

      if (w === canvas.width && h === canvas.height) return;

      canvas.width = w;
      canvas.height = h;

      context.configure({
        device,
        format: canvasFormat,
        alphaMode: 'opaque'
      });
    }

    async function compileShaderModule(code, label) {
      const module = device.createShaderModule({ code, label });
      const info = await module.getCompilationInfo();
      if (info.messages && info.messages.length > 0) {
        console.group(`WGSL ${label} diagnostics`);
        for (const m of info.messages) {
          const msg = `${m.type} @ (${m.lineNum}, ${m.linePos}): ${m.message}`;
          console[m.type === 'error' ? 'error' : (m.type === 'warning' ? 'warn' : 'log')](msg);
          if (m.type === 'error') {
            logApp(`Shader ${label} error: ${msg}`, 'error');
          }
        }
        console.groupEnd();
      }
      return module;
    }

    const shaderResponse = await fetch(window.shaderUri);
    const shaderCode = await shaderResponse.text();
    const shaderModule = await compileShaderModule(shaderCode, 'fullscreen shader');
    logApp('Shaders compiled', 'success');

    let texPipeline = null;
    let solidPipeline = null;

    texPipeline = await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_textured'
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_textured',
        targets: [{ format: canvasFormat }]
      },
      primitive: {
        topology: 'triangle-list'
      }
    });

    solidPipeline = await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_solid'
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_solid',
        targets: [{ format: canvasFormat }]
      },
      primitive: {
        topology: 'triangle-list'
      }
    });

    let texBindGroup = null;
    function makeTexBindGroup() {
      if (!texPipeline) return null;
      const layout = texPipeline.getBindGroupLayout(0);
      return device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { buffer: uniformBuffer } },
          { binding: 1, resource: sampler },
          { binding: 2, resource: srcView }
        ]
      });
    }

    function applySelectedMip() {
      if (!srcTex) return;
      srcView = mipOnlyBox.checked
        ? srcTex.createView({ baseMipLevel: currentMip, mipLevelCount: 1 })
        : srcTex.createView();
      texBindGroup = makeTexBindGroup();
    }

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;

      const lower = file.name.toLowerCase();
      stat.textContent = `Loading ${file.name}...`;
      meta.textContent = '';

      try {
        if (lower.endsWith('.ktx2')) {
          await loadKTX2_ToTexture(file);
        } else {
          await loadImageToTexture(file);
        }
      } catch (e) {
        console.error(e);
        const msg = e.message || String(e);
        stat.textContent = `Error: ${msg}`;
        logApp(`Failed to load ${file.name}: ${msg}`, 'error');
      }
    });

    texBindGroup = makeTexBindGroup();

    function frame() {
      configureIfNeeded();
      updateUniforms();

      const currentTexture = context.getCurrentTexture();
      const renderView = currentTexture.createView();

      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: renderView,
          clearValue: { r: 0.07, g: 0.07, b: 0.08, a: 1.0 },
          loadOp: 'clear',
          storeOp: 'store'
        }]
      });

      if (texPipeline && texBindGroup) {
        pass.setPipeline(texPipeline);
        pass.setBindGroup(0, texBindGroup);
        pass.draw(3, 1, 0, 0);
      } else if (solidPipeline) {
        pass.setPipeline(solidPipeline);
        pass.draw(3, 1, 0, 0);
      }

      pass.end();
      device.queue.submit([encoder.finish()]);

      requestAnimationFrame(frame);
    }

    frame();

    try {
      const info = await adapter.requestAdapterInfo?.();
      if (info) {
        logApp(`GPU: ${info.vendor} ${info.architecture} ${info.description}`, 'info');
      }
    } catch {
      // ignore
    }

    window._ktx2_demo = { device, adapter, srcTex, srcView, applySelectedMip };

  } catch (e) {
    console.error(e);
    logApp(String(e.message || e), 'error');
  }
})();
