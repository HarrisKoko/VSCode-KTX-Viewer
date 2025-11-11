// main.js — JPG/PNG/WebP renderer + KTX2 (BC7) loader using WebGPU

(async function () {
  // Minimal logger to the on-screen <div id="log">
  const log = (msg) => {
    const el = document.getElementById('log');
    if (el) el.textContent = String(msg);
  };

  // ---------- Upload helpers ----------

  // For UNCOMPRESSED uploads (e.g., RGBA8), WebGPU requires bytesPerRow to be 256-byte aligned.
  // This repacks a tightly-packed pixel buffer (width*BPP per row) into a buffer whose rows are padded up to 256B.
  function padRows(src, width, height, bytesPerPixel = 4) {
    const rowStride = width * bytesPerPixel;               // bytes in a *tight* row
    const aligned = Math.ceil(rowStride / 256) * 256;      // next multiple of 256
    if (aligned === rowStride) return { data: src, bytesPerRow: rowStride }; // no padding needed

    const dst = new Uint8Array(aligned * height);
    for (let y = 0; y < height; y++) {
      const s0 = y * rowStride, d0 = y * aligned;
      dst.set(src.subarray(s0, s0 + rowStride), d0);       // copy row into padded row
    }
    return { data: dst, bytesPerRow: aligned };
  }

  // For COMPRESSED uploads (BC formats), alignment applies to *block rows* not pixel rows.
  // BC7 uses 4x4 blocks, 16 bytes per block. We must pad each block-row up to 256B.
  function padBlockRowsBC(src, width, height, bytesPerBlock, blockWidth = 4, blockHeight = 4) {
    const wBlocks = Math.max(1, Math.ceil(width  / blockWidth));   // number of 4x4 blocks horizontally
    const hBlocks = Math.max(1, Math.ceil(height / blockHeight));  // number of 4x4 blocks vertically
    const rowBytes = wBlocks * bytesPerBlock;                       // raw bytes in one block-row

    const aligned = Math.ceil(rowBytes / 256) * 256;                // next multiple of 256
    if (aligned === rowBytes) {
      // Already aligned; no repack needed.
      return { data: src, bytesPerRow: rowBytes, rowsPerImage: hBlocks };
    }

    const dst = new Uint8Array(aligned * hBlocks);
    for (let y = 0; y < hBlocks; y++) {
      const s0 = y * rowBytes, d0 = y * aligned;
      dst.set(src.subarray(s0, s0 + rowBytes), d0);
    }
    return { data: dst, bytesPerRow: aligned, rowsPerImage: hBlocks };
  }

  // Wait until read.js is loaded (defines window.parseKTX2)
  async function waitForKTXParser() {
    let tries = 0;
    while (typeof window.parseKTX2 !== 'function') {
      if (tries++ > 500) throw new Error('KTX2 parser not loaded'); // ~5s timeout
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
    // Ask for a high-performance adapter and enable BC compression if supported.
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) { log('No GPU adapter.'); return; }

    const bcSupported = adapter.features.has('texture-compression-bc');
    const device = await adapter.requestDevice({
      requiredFeatures: bcSupported ? ['texture-compression-bc'] : []
    });

    // Helpful runtime error info
    device.addEventListener?.('uncapturederror', (e) => {
      console.error('WebGPU uncaptured error:', e.error || e);
      log('WebGPU error: ' + (e.error?.message || e.message || 'unknown'));
    });

    const format = navigator.gpu.getPreferredCanvasFormat();

    // ---------- Simple UI ----------
    // Slider for exposure and a file input. Shows a BC7 support badge.
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
      <div style="margin-top:6px; opacity:.9;">BC7: ${bcSupported ? 'available' : 'not supported'}</div>
    `;
    document.body.appendChild(ui);

    const evInput = document.getElementById('ev');
    const evVal   = document.getElementById('evv');
    const fileInp = document.getElementById('file');
    const stat    = document.getElementById('stat');

    let exposureEV = 0;
    evInput.oninput = () => {
      exposureEV = parseFloat(evInput.value);
      evVal.textContent = evInput.value;
    };

    // ---------- Swapchain configure ----------
    // Keep DPR=1 for stability inside VS Code webview/Electron.
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
    // 16-byte aligned struct, but easiest is to allocate 256B to be safe.
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
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

    // Bootstrap a tiny 2x2 RGBA8 checker so the pipeline has something to bind.
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

    // Uncompressed images (JPEG/PNG/WebP) via createImageBitmap + copyExternalImageToTexture.
    async function loadImageToTexture(file) {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });

      // Destroy previous texture and create a new RGBA8 one.
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
      if (texPipeline) texBindGroup = makeTexBindGroup();
    }

    // KTX2 (BC7) — no transcoding; we upload compressed blocks directly.
    async function loadKTX2_BC7_ToTexture(file) {
      if (!bcSupported) throw new Error('BC compressed textures not supported on this device.');
      await waitForKTXParser();

      const buf = await file.arrayBuffer();
      const { header, levels } = await window.parseKTX2(buf); // calls parsektx2 from read.js

      // Minimal constraints for this demo
      const is2D = header.pixelDepth === 0 && header.faceCount === 1;
      if (!is2D) throw new Error('Only 2D, 1-face KTX2 supported in this demo.');
      if (header.supercompressionScheme !== 0) throw new Error('Supercompressed KTX2 not supported.');

      // Vulkan enum values for BC7
      const VK_FORMAT_BC7_UNORM_BLOCK = 145;
      const VK_FORMAT_BC7_SRGB_BLOCK  = 146;

      // Map vkFormat -> WebGPU format
      let wgpuFormat = null;
      if (header.vkFormat === VK_FORMAT_BC7_UNORM_BLOCK) wgpuFormat = 'bc7-rgba-unorm';
      else if (header.vkFormat === VK_FORMAT_BC7_SRGB_BLOCK) wgpuFormat = 'bc7-rgba-unorm-srgb';
      else throw new Error(`Unsupported vkFormat ${header.vkFormat}; need BC7.`);

      // Top mip only for now (you can loop over levels to upload a ll mips later)
      const lvl = levels[0];
      const bytesPerBlock = 16; // BC7 block = 16 bytes
      const raw = new Uint8Array(buf, lvl.byteOffset, lvl.byteLength);

      // Compressed textures cannot have RENDER_ATTACHMENT usage.
      srcTex?.destroy?.();
      srcTex = device.createTexture({
        size: { width: lvl.width, height: lvl.height, depthOrArrayLayers: 1 },
        format: wgpuFormat,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
      });
      srcView = srcTex.createView();

      // Repack each *block row* to 256B alignment if needed.
      const { data, bytesPerRow, rowsPerImage } =
        padBlockRowsBC(raw, lvl.width, lvl.height, bytesPerBlock, 4, 4);

      // Upload compressed blocks straight into the texture.
      device.queue.writeTexture(
        { texture: srcTex },
        data,
        { bytesPerRow, rowsPerImage },
        { width: lvl.width, height: lvl.height, depthOrArrayLayers: 1 }
      );

      stat.textContent = `Loaded ${file.name} (KTX2 BC7, ${lvl.width}×${lvl.height}, ${wgpuFormat})`;
      if (texPipeline) texBindGroup = makeTexBindGroup();
    }

    // Pick the right loader by file extension.
    fileInp.addEventListener('change', async () => {
      const f = fileInp.files?.[0];
      if (!f) return;
      try {
        if (f.name.toLowerCase().endsWith('.ktx2')) {
          await loadKTX2_BC7_ToTexture(f);
        } else {
          await loadImageToTexture(f);
        }
      } catch (e) {
        console.error(e);
        log('Load failed: ' + e);
      }
    });

    // ---------- Shaders ----------
    // Draw a full-screen triangle sampled from our texture, with exposure + ACES tonemap.
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
        o.uv = vec2f(0.5 * (p.x + 1.0), 0.5 * (1.0 - p.y));
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

    // Simple solid-color fallback if the textured pipeline fails.
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

    // Create modules & log diagnostics (super useful for WGSL).
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

    // Render pipelines: textured (preferred) and solid (fallback).
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

    // Bind group for the textured path (U/Sampler/Texture)
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

    // ----------- Nice-to-have adapter info -----------
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
