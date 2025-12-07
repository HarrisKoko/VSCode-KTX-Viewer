// main.js — JPG/PNG/WebP renderer + KTX2 (BC1-BC7) loader using WebGPU

const NATIVE_BC_FORMATS = {
  131: 'bc1-rgba-unorm', 132: 'bc1-rgba-unorm-srgb',
  137: 'bc3-rgba-unorm', 138: 'bc3-rgba-unorm-srgb',
  145: 'bc7-rgba-unorm', 146: 'bc7-rgba-unorm-srgb',
};

function getFormatName(vkFormat) {
  return NATIVE_BC_FORMATS[vkFormat] || `VK Format ${vkFormat}`;
}

function vkFormatToWebGPU(vkFormat) {
  const format = NATIVE_BC_FORMATS[vkFormat];
  if (!format) return null;
  return { format, blockWidth: 4, blockHeight: 4, bytesPerBlock: 16 };
}

const log = (msg) => {
  const el = document.getElementById('log');
  if (el) { el.style.display = 'block'; el.textContent = String(msg); }
};

const logApp = (msg, level = 'info') => {
  const el = document.getElementById('appLog');
  if (el) {
    el.style.display = 'block';
    const entry = document.createElement('div');
    entry.style.marginBottom = '4px'; entry.style.paddingBottom = '4px'; entry.style.borderBottom = '1px solid #222';
    const colors = { error: '#ff6666', warn: '#ffaa44', success: '#66ff66', info: '#aaa' };
    entry.style.color = colors[level] || colors.info;
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${String(msg)}`;
    el.appendChild(entry);
    el.scrollTop = el.scrollHeight;
  }
  //if (level === 'error') console.error(msg); else if (level === 'warn') console.warn(msg); //else console.log(msg);
};

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

async function waitForKTXParser() {
  let tries = 0;
  while (typeof window.parseKTX2 !== 'function') {
    if (tries++ > 500) throw new Error('KTX2 parser not loaded');
    await new Promise(r => setTimeout(r, 10));
  }
}

// Layout setup
(function ensureLayout() {
  const canvas = document.getElementById('gfx');
  if (!canvas || document.getElementById('app-wrapper')) return;
  const wrapper = document.createElement('div');
  wrapper.id = 'app-wrapper';
  Object.assign(wrapper.style, { display:'flex', flexDirection:'row', width:'100vw', height:'100vh', margin:0, padding:0 });
  canvas.parentNode.insertBefore(wrapper, canvas);

  const sidebar = document.createElement('div');
  sidebar.id = 'sidebar';
  Object.assign(sidebar.style, { width:'320px', minWidth:'240px', background:'#0b0b0b', color:'#ddd', overflow:'auto', padding:'12px', borderRight:'1px solid rgba(255,255,255,0.04)', zIndex:1000 });
  
  if (window.sidebarTemplate) sidebar.innerHTML = window.sidebarTemplate;
  else sidebar.innerHTML = '<h3>KTX2 HDR Preview</h3>';
  
  wrapper.appendChild(sidebar);
  
  const canvasContainer = document.createElement('div');
  canvasContainer.id = 'canvas-container';
  Object.assign(canvasContainer.style, { flex:'1 1 auto', display:'flex', overflow:'hidden' });
  canvasContainer.appendChild(canvas);
  wrapper.appendChild(canvasContainer);
  
  canvas.style.width = '100%'; canvas.style.height = '100%'; canvas.style.objectFit = 'contain';
  document.body.style.margin = '0'; document.body.style.background = '#000';
})();

// Main WebGPU setup
(async () => {
  try {
    if (!('gpu' in navigator)) { logApp('WebGPU not available', 'error'); throw new Error('WebGPU not available'); }
    const canvas = document.getElementById('gfx');
    const context = canvas.getContext('webgpu');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    
    // Features
    const supportedFeatures = [];
    if (adapter.features.has("texture-compression-bc")) supportedFeatures.push("texture-compression-bc");
    if (adapter.features.has("texture-compression-etc2")) supportedFeatures.push("texture-compression-etc2");
    
    const device = await adapter.requestDevice({ requiredFeatures: supportedFeatures });
    logApp(`WebGPU initialized. BC: ${adapter.features.has("texture-compression-bc")}, ETC2: ${adapter.features.has("texture-compression-etc2")}`, 'success');

    const format = navigator.gpu.getPreferredCanvasFormat();
    
    const texInfo = document.getElementById('texInfo');
    const texInfoContent = document.getElementById('texInfoContent');
    const mipSlider = document.getElementById('mipSlider');
    const mipLabel = document.getElementById('mipLabel');
    const mipControls = document.getElementById('mip-controls');
    const fileInp = document.getElementById('file');
    const stat = document.getElementById('stat');
    const meta = document.getElementById('meta');

    // Simplified helper
    function getChannelMultipliers() {
      const getVal = (id) => parseFloat(document.getElementById(id)?.value || (id==='channelA'?0:1));
      return {r:getVal('channelR'), g:getVal('channelG'), b:getVal('channelB'), a:getVal('channelA')};
    }
    
    function updateTextureInfo(size, w, h, fmt, mips, name, extra) {
       if(texInfoContent) texInfoContent.innerHTML = `
         <div style="margin-bottom:4px"><b>${w}x${h}</b></div>
         <div style="margin-bottom:4px;color:#8cf">${fmt}</div>
         <div style="margin-bottom:4px">Mips: ${mips}</div>
         <div style="color:#888">${name}</div>
       `;
       if(texInfo) texInfo.style.display = 'block';
    }

    // Uniform Buffer
    let lastW=0, lastH=0;
    const uniformBuf = device.createBuffer({ size:256, usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST });
    function updateUniforms() {
       const ev = parseFloat(document.getElementById('ev')?.value||0);
       const ch = getChannelMultipliers();
       const arr = new Float32Array([ev, Math.pow(2,ev), lastW, lastH, ch.r, ch.g, ch.b, ch.a]);
       device.queue.writeBuffer(uniformBuf, 0, arr.buffer);
    }
    document.getElementById('ev')?.addEventListener('input', (e)=>{ document.getElementById('evv').textContent=e.target.value; });
    
    let sampler = device.createSampler({ magFilter:'linear', minFilter:'linear' });

    let srcTex, srcView, texPipeline, texBindGroup;
    let mipCount = 1, currentMip = 0;

    // --- KTX2 LOADER ---
    async function loadKTX2_ToTexture(file) {
    logApp(`Loading KTX2 ${file.name}...`, "info");
    await waitForKTXParser();

    const buf = await file.arrayBuffer();
    const { header, levels } = await window.parseKTX2(buf, device);

    const is2D = header.pixelDepth === 0 && header.faceCount === 1;
    if (!is2D) throw new Error("Only 2D, 1-face KTX2 supported.");

    let wgpuFormat = null;
    let blockWidth = 1, blockHeight = 1, bytesPerBlock = 0;
    let isPixel = false;   // uncompressed flag
    let isBlock = false;   // block-compressed flag
    let formatInfo = null; // ← FIX: define formatInfo properly

    // ======================================================================================
    // 1. --- SUPERCOMPRESSED BASIS/UASTC PATH ----------------------------------------------
    // ======================================================================================
    const isTranscoded = levels[0]?.isDecompressed;

    if (isTranscoded) {
        const tf = levels[0].transcodedFormat;
        logApp(`Using pre-transcoded Basis data (format ID: ${tf})`, "info");

        switch (tf) {
            case 6:  // BC7
                wgpuFormat = "bc7-rgba-unorm";
                blockWidth = 4; blockHeight = 4; bytesPerBlock = 16;
                isBlock = true;
                break;

            case 1:  // BC3
                wgpuFormat = "bc3-rgba-unorm";
                blockWidth = 4; blockHeight = 4; bytesPerBlock = 16;
                isBlock = true;
                break;

            case 0:  // BC1
                wgpuFormat = "bc1-rgba-unorm";
                blockWidth = 4; blockHeight = 4; bytesPerBlock = 8;
                isBlock = true;
                break;

            case 13: // RGBA32 → treat as RGBA8
            default:
                wgpuFormat = "rgba8unorm";
                isPixel = true;
                formatInfo = {
                    bytesPerPixel: 4,
                    sourceChannels: 4,
                    sourceBytesPerPixel: 4
                };
                break;
        }
    }

    // ======================================================================================
    // 2. --- NATIVE ETC2 PATH --------------------------------------------------------------
    // ======================================================================================
    else if ((header.vkFormat >= 147 && header.vkFormat <= 153) &&
              adapter.features.has("texture-compression-etc2")) {

        logApp("Using native ETC2", "info");

        const isRGBA = (header.vkFormat === 152 || header.vkFormat === 153);

        wgpuFormat = isRGBA ? "etc2-rgba8unorm" : "etc2-rgb8unorm";
        blockWidth = 4;
        blockHeight = 4;
        bytesPerBlock = isRGBA ? 16 : 8;
        isBlock = true;
    }

    // ======================================================================================
    // 3. --- USE vkFormatToWebGPU FOR UNCOMPRESSED + BC FORMATS ----------------------------
    // ======================================================================================
    else {
        formatInfo = window.vkFormatToWebGPU(header.vkFormat);
        if (!formatInfo) throw new Error(`Unsupported vkFormat ${header.vkFormat}`);

        wgpuFormat   = formatInfo.format;
        blockWidth   = formatInfo.blockWidth  || 1;
        blockHeight  = formatInfo.blockHeight || 1;
        bytesPerBlock = formatInfo.bytesPerBlock || 0;

        isPixel = !!formatInfo.bytesPerPixel;
        isBlock = !!formatInfo.blockWidth;
    }

    // ======================================================================================
    // 4. --- CREATE TEXTURE ----------------------------------------------------------------
    // ======================================================================================
    srcTex?.destroy?.();
    srcTex = device.createTexture({
        size: { width: header.pixelWidth, height: header.pixelHeight, depthOrArrayLayers: 1 },
        format: wgpuFormat,
        mipLevelCount: levels.length,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });

    srcView = srcTex.createView();
    if (texPipeline) texBindGroup = makeTexBindGroup();

    // ======================================================================================
    // 5. --- MIP UPLOAD LOOP ---------------------------------------------------------------
    // ======================================================================================
    for (let i = 0; i < levels.length; i++) {
        const lvl = levels[i];
        let raw = lvl.isDecompressed ? lvl.decompressedData : window.getLevelData(buf, lvl);

        // ----------------------------------------------------------------------
        // UNCOMPRESSED PATH (RGB8, RGBA8, 16F, 32F, etc.)
        // ----------------------------------------------------------------------
        if (isPixel) {

            // RGB8 → RGBA8 expand
            if (formatInfo.sourceChannels === 3) {
                const pixelCount = lvl.width * lvl.height;
                const rgba = new Uint8Array(pixelCount * 4);
                for (let p = 0; p < pixelCount; p++) {
                    rgba[p*4+0] = raw[p*3+0];
                    rgba[p*4+1] = raw[p*3+1];
                    rgba[p*4+2] = raw[p*3+2];
                    rgba[p*4+3] = 255;
                }
                raw = rgba;
            }

            // RGBA32F → RGBA16F conversion if required
            if (formatInfo.sourceBytesPerPixel === 16 &&
                formatInfo.bytesPerPixel === 8) {
                raw = convertRGBA32FtoRGBA16F(raw, lvl.width, lvl.height);
            }

            // Row alignment to 256 bytes
            const { data, bytesPerRow } = padRows(
                raw,
                lvl.width,
                lvl.height,
                formatInfo.bytesPerPixel
            );

            device.queue.writeTexture(
                { texture: srcTex, mipLevel: i },
                data,
                { bytesPerRow },
                { width: lvl.width, height: lvl.height, depthOrArrayLayers: 1 }
            );

            continue;
        }

        // ----------------------------------------------------------------------
        // BLOCK-COMPRESSED PATH (BC / ETC2 / transcoded Basis)
        // ----------------------------------------------------------------------
        if (isBlock) {
            const wBlocks = Math.ceil(lvl.width / blockWidth);
            const hBlocks = Math.ceil(lvl.height / blockHeight);
            const bytesPerRow = wBlocks * bytesPerBlock;

            device.queue.writeTexture(
                { texture: srcTex, mipLevel: i },
                raw,
                { bytesPerRow, rowsPerImage: hBlocks },
                { width: lvl.width, height: lvl.height, depthOrArrayLayers: 1 }
            );

            continue;
        }
    }

    // ======================================================================================
    // 6. --- UI UPDATE ---------------------------------------------------------------------
    // ======================================================================================
    mipCount = levels.length;
    currentMip = 0;

    updateTextureInfo(
        file.size,
        header.pixelWidth,
        header.pixelHeight,
        wgpuFormat,
        mipCount,
        file.name,
        {}
    );

    logApp(`Loaded ${file.name} (${wgpuFormat})`, "success");

    if (mipControls) {
        mipSlider.max = Math.max(0, mipCount - 1);
        mipSlider.value = 0;
        mipLabel.textContent = "0";
        mipControls.style.display = mipCount > 1 ? "block" : "none";
    }
}



    fileInp?.addEventListener('change', async () => {
       if(!fileInp.files[0]) return;
       try { await loadKTX2_ToTexture(fileInp.files[0]); }
       catch(e) { logApp(e.message, 'error'); }
    });

    // Pipeline
    const shaderResponse = await fetch(window.shaderUri);
    const shaderCode = await shaderResponse.text();
    const shaderModule = device.createShaderModule({ code: shaderCode });
    
    texPipeline = await device.createRenderPipelineAsync({
        layout: 'auto',
        vertex: { module: shaderModule, entryPoint: 'vs_textured' },
        fragment: { module: shaderModule, entryPoint: 'fs_textured', targets: [{ format }] },
        primitive: { topology: 'triangle-list' }
    });
    
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
    
    function frame() {
       const w = canvas.clientWidth, h = canvas.clientHeight;
       if(w!==lastW || h!==lastH) {
          canvas.width=w; canvas.height=h;
          context.configure({ device, format, alphaMode:'opaque' });
          lastW=w; lastH=h;
       }
       updateUniforms();
       
       const encoder = device.createCommandEncoder();
       const pass = encoder.beginRenderPass({
          colorAttachments: [{ view: context.getCurrentTexture().createView(), clearValue:{r:0.1,g:0.1,b:0.1,a:1}, loadOp:'clear', storeOp:'store' }]
       });
       
       if(texPipeline && texBindGroup) {
          pass.setPipeline(texPipeline);
          pass.setBindGroup(0, texBindGroup);
          pass.draw(3);
       }
       pass.end();
       device.queue.submit([encoder.finish()]);
       requestAnimationFrame(frame);
    }
    frame();

  } catch(e) { /*console.error(e); logApp(e.message, 'error'); */}
})();