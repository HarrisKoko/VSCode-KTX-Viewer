// main.js — JPG/PNG/WebP renderer + KTX2 (BC1-BC7) loader using WebGPU
// WITH PROPER MIPMAP SUPPORT AND BLOCK ALIGNMENT

(async function () {
  // Minimal logger to the on-screen <div id="log">
  const log = (msg) => {
    const el = document.getElementById('log');
    if (el) el.textContent = String(msg);
  };

  // ---------- Upload helpers ----------

  // For UNCOMPRESSED uploads (e.g., RGBA8), WebGPU requires bytesPerRow to be 256-byte aligned.
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

  // For COMPRESSED uploads (BC formats), alignment applies to *block rows* not pixel rows.
  // FIXED: Handle small mip levels correctly by treating them as at least 1 block
  function padBlockRowsBC(src, width, height, bytesPerBlock, blockWidth = 4, blockHeight = 4) {
    // For compressed formats, even a 1x1 pixel mip is treated as a full 4x4 block
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

  // Wait until read.js is loaded
  async function waitForKTXParser() {
    let tries = 0;
    while (typeof window.parseKTX2 !== 'function') {
      if (tries++ > 500) throw new Error('KTX2 parser not loaded');
      await new Promise(r => setTimeout(r, 10));
    }
  }

  try {
    // ---------- WebGPU availability ----------
    if (!('gpu' in navigator)) { log('WebGPU not available.'); return; }

    const canvas  = document.getElementById('gfx');
    const context = canvas.getContext('webgpu');
    if (!context) { log('Failed to get WebGPU context.'); return; }

    // ---------- Adapter / Device ----------
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) { log('No GPU adapter.'); return; }

    const bcSupported = adapter.features.has('texture-compression-bc');
    const device = await adapter.requestDevice({
      requiredFeatures: bcSupported ? ['texture-compression-bc'] : []
    });

    device.addEventListener?.('uncapturederror', (e) => {
      console.error('WebGPU uncaptured error:', e.error || e);
      log('WebGPU error: ' + (e.error?.message || e.message || 'unknown'));
    });

    const format = navigator.gpu.getPreferredCanvasFormat();

    // ---------- Simple UI ----------
    const ui = document.createElement('div');
    ui.style.position = 'absolute';
    ui.style.right = '12px';
    ui.style.top = '12px';
    ui.style.background = '#0008';
    ui.style.padding = '8px 10px';
    ui.style.color = '#ddd';
    ui.style.font = '12px monospace';
    ui.style.borderRadius = '6px';
    ui.innerHTML = `
      <div style="margin-bottom:6px;">
        <label>exposureEV:</label>
        <input id="ev" type="range" min="-10" max="10" step="0.1" value="0">
        <span id="evv">0</span>
      </div>
      <div>
        <input id="file" type="file" accept="image/png, image/jpeg, image/webp, .ktx2">
      </div>
      <div id="stat" style="margin-top:6px; opacity:.9;"></div>
      <div id="meta" style="margin-top:6px; opacity:.7; font-size:10px;"></div>
      <div style="margin-top:6px; opacity:.9;">BC Compression: ${bcSupported ? '✓ available' : '✗ not supported'}</div>
    `;
    document.body.appendChild(ui);

    const evInput = document.getElementById('ev');
    const evVal   = document.getElementById('evv');
    const fileInp = document.getElementById('file');
    const stat    = document.getElementById('stat');
    const meta    = document.getElementById('meta');

    let exposureEV = 0;
    evInput.oninput = () => {
      exposureEV = parseFloat(evInput.value);
      evVal.textContent = evInput.value;
    };

    // ---------- Swapchain configure ----------
    let lastW = 0, lastH = 0;
    function configureIfNeeded() {
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
    new ResizeObserver(configureIfNeeded).observe(canvas);
    configureIfNeeded();

    // ---------- Uniforms ----------
    const uniformBuf = device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    function updateUniforms() {
      const mul = Math.pow(2, exposureEV);
      const arr = new Float32Array([exposureEV, mul, lastW, lastH]);
      device.queue.writeBuffer(uniformBuf, 0, arr.buffer);
    }

    // ---------- Texture state ----------
    // FIXED: Added mipmapFilter for proper mipmap sampling
    const sampler = device.createSampler({ 
      magFilter: 'linear', 
      minFilter: 'linear',
      mipmapFilter: 'linear'  // Enable trilinear filtering
    });

    // Bootstrap a tiny 2x2 RGBA8 checker
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
      const w = 2, h = 2;
      const raw = checkerRGBA8();
      const { data, bytesPerRow } = padRows(raw, w, h);
      device.queue.writeTexture({ texture: srcTex }, data, { bytesPerRow }, { width: w, height: h });
    }
    let srcView = srcTex.createView();

    // ---------- Loaders ----------

    // Uncompressed images (JPEG/PNG/WebP)
    async function loadImageToTexture(file) {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });

      srcTex.destroy();
      srcTex = device.createTexture({
        size: { width: bmp.width, height: bmp.height, depthOrArrayLayers: 1 },
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING
             | GPUTextureUsage.COPY_DST
             | GPUTextureUsage.RENDER_ATTACHMENT
      });

      device.queue.copyExternalImageToTexture(
        { source: bmp },
        { texture: srcTex },
        { width: bmp.width, height: bmp.height }
      );

      srcView = srcTex.createView();
      bmp.close?.();

      stat.textContent = `Loaded ${file.name} (${bmp.width}×${bmp.height})`;
      meta.textContent = '';
      if (texPipeline) texBindGroup = makeTexBindGroup();
    }

    // KTX2 (BC1-BC7) — upload compressed blocks directly
    // FIXED: Now uploads ALL mip levels with proper block alignment
    async function loadKTX2_ToTexture(file) {
      if (!bcSupported) throw new Error('BC compressed textures not supported on this device.');
      await waitForKTXParser();

      const buf = await file.arrayBuffer();
      const { header, levels, dfd, kvd } = await window.parseKTX2(buf);

      // Validation
      const is2D = header.pixelDepth === 0 && header.faceCount === 1;
      if (!is2D) throw new Error('Only 2D, 1-face KTX2 supported in this demo.');
      if (header.supercompressionScheme !== 0) throw new Error('Supercompressed KTX2 not supported.');

      // Use helper to get WebGPU format info
      const formatInfo = window.vkFormatToWebGPU(header.vkFormat);
      if (!formatInfo) {
        throw new Error(`Unsupported vkFormat ${header.vkFormat}. Supported: BC1-BC7.`);
      }

      const { format: wgpuFormat, blockWidth, blockHeight, bytesPerBlock } = formatInfo;
      const formatName = window.getFormatName(header.vkFormat);

      // FIXED: Create texture with proper mipLevelCount
      srcTex?.destroy?.();
      srcTex = device.createTexture({
        size: { width: header.pixelWidth, height: header.pixelHeight, depthOrArrayLayers: 1 },
        format: wgpuFormat,
        mipLevelCount: levels.length,  // CRITICAL: Specify number of mip levels
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
      });
      srcView = srcTex.createView();

      // FIXED: Upload ALL mip levels with proper block alignment
      for (let i = 0; i < levels.length; i++) {
        const lvl = levels[i];
        const raw = new Uint8Array(buf, lvl.byteOffset, lvl.byteLength);

        // Pad block rows to 256B alignment
        const { data, bytesPerRow, rowsPerImage } =
          padBlockRowsBC(raw, lvl.width, lvl.height, bytesPerBlock, blockWidth, blockHeight);

        // CRITICAL: For compressed formats, extent must be multiples of block size
        // Round UP to nearest block multiple (5x5 becomes 8x8, 1x1 becomes 4x4, etc)
        const uploadWidth = Math.ceil(lvl.width / blockWidth) * blockWidth;
        const uploadHeight = Math.ceil(lvl.height / blockHeight) * blockHeight;

        // Upload compressed data to specific mip level
        device.queue.writeTexture(
          { 
            texture: srcTex,
            mipLevel: i
          },
          data,
          { bytesPerRow, rowsPerImage },
          { width: uploadWidth, height: uploadHeight, depthOrArrayLayers: 1 }
        );
      }

      // FIXED: Show mip level count in status
      const lvl0 = levels[0];
      stat.textContent = `Loaded ${file.name} (${lvl0.width}×${lvl0.height}, ${levels.length} mip${levels.length > 1 ? 's' : ''})`;
      
      // Show metadata
      let metaStr = `Format: ${formatName} (${wgpuFormat})`;
      if (kvd && Object.keys(kvd).length > 0) {
        metaStr += `\nKVD: ${Object.keys(kvd).join(', ')}`;
        if (kvd.KTXorientation) metaStr += `\nOrientation: ${kvd.KTXorientation}`;
      }
      if (dfd) {
        metaStr += `\nDFD: colorModel=${dfd.colorModel}, transfer=${dfd.transferFunction}`;
      }
      meta.textContent = metaStr;

      if (texPipeline) texBindGroup = makeTexBindGroup();
    }

    // Pick the right loader
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
        log('Load failed: ' + e.message);
        stat.textContent = 'Error: ' + e.message;
      }
    });

    // ---------- Shaders ----------
    const texturedWGSL = /* wgsl */`
      struct Params {
        exposureEV: f32,
        exposureMul: f32,
        width: f32,
        height: f32
      }
      @group(0) @binding(0) var<uniform> U : Params;
      @group(0) @binding(1) var samp : sampler;
      @group(0) @binding(2) var tex0 : texture_2d<f32>;

      struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f }

      @vertex fn vs_main(@builtin(vertex_index) vid: u32) -> VSOut {
        var pos = array<vec2f,3>(
          vec2f(-1.0, -3.0),
          vec2f( 3.0,  1.0),
          vec2f(-1.0,  1.0)
        );
        let p = pos[vid];
        var o: VSOut;
        o.pos = vec4f(p, 0.0, 1.0);
        // Fix UV flipping for KTX2 (bottom-left origin)
        let uv_raw = 0.5 * (p + vec2f(1.0, 1.0));
        o.uv = vec2f(uv_raw.x, 1.0 - uv_raw.y);
        return o;
      }

      fn aces_tonemap(x: vec3f) -> vec3f {
        let a=2.51; let b=0.03; let c=2.43; let d=0.59; let e=0.14;
        return clamp((x*(a*x + b)) / (x*(c*x + d) + e), vec3f(0.0), vec3f(1.0));
      }

      @fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
        let c = textureSample(tex0, samp, uv).rgb;
        let exposed = c * U.exposureMul;
        let ldr = aces_tonemap(exposed);
        return vec4f(ldr, 1.0);
      }
    `;

    const solidWGSL = /* wgsl */`
      struct VSOut { @builtin(position) pos: vec4f }
      @vertex fn vs_main(@builtin(vertex_index) vid: u32) -> VSOut {
        var pos = array<vec2f,3>(
          vec2f(-1.0, -3.0),
          vec2f( 3.0,  1.0),
          vec2f(-1.0,  1.0)
        );
        var o: VSOut;
        o.pos = vec4f(pos[vid], 0.0, 1.0);
        return o;
      }
      @fragment fn fs_main() -> @location(0) vec4f {
        return vec4f(0.2, 0.6, 1.0, 1.0);
      }
    `;

    async function compileModule(code, label) {
      const mod = device.createShaderModule({ code, label });
      const info = await mod.getCompilationInfo();
      if (info.messages?.length) {
        console.group(`WGSL ${label} diagnostics`);
        for (const m of info.messages) {
          console[m.type === 'error' ? 'error' : (m.type === 'warning' ? 'warn' : 'log')](
            `${m.type} (${m.lineNum}:${m.linePos}): ${m.message}`
          );
        }
        console.groupEnd();
      }
      return mod;
    }

    const texturedVS = await compileModule(texturedWGSL, 'textured');
    const solidVS    = await compileModule(solidWGSL,    'solid');

    let texPipeline = null;
    let solidPipeline = null;

    try {
      texPipeline = await device.createRenderPipelineAsync({
        layout: 'auto',
        vertex:   { module: texturedVS, entryPoint: 'vs_main' },
        fragment: { module: texturedVS, entryPoint: 'fs_main', targets: [{ format }] },
        primitive:{ topology: 'triangle-list' }
      });
    } catch (e) {
      console.error('Textured pipeline creation failed:', e);
      log('Textured pipeline failed (see console). Falling back to solid.');
    }

    try {
      solidPipeline = await device.createRenderPipelineAsync({
        layout: 'auto',
        vertex:   { module: solidVS, entryPoint: 'vs_main' },
        fragment: { module: solidVS, entryPoint: 'fs_main', targets: [{ format }] },
        primitive:{ topology: 'triangle-list' }
      });
    } catch (e) {
      console.error('Solid pipeline creation failed:', e);
      log('Solid pipeline failed (see console).');
      return;
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

    // ---------- Frame loop ----------
    function frame() {
      configureIfNeeded();
      const swap = context.getCurrentTexture();
      const rtv = swap.createView();

      updateUniforms();

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

    // ----------- Adapter info -----------
    try {
      const info = await adapter.requestAdapterInfo?.();
      if (info) log(`WebGPU OK — ${info.vendor} ${info.architecture} ${info.description}`);
      else log('WebGPU OK');
    } catch {
      log('WebGPU OK');
    }
  } catch (e) {
    console.error(e);
    log(String(e));
  }
})();