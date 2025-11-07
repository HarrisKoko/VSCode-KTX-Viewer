(async function () {
  const log = (msg) => { const el = document.getElementById('log'); if (el) el.textContent = String(msg); };

  try {
    if (!('gpu' in navigator)) { log('WebGPU not available.'); return; }

    const canvas  = document.getElementById('gfx');
    const context = canvas.getContext('webgpu');
    if (!context) { log('Failed to get WebGPU context.'); return; }

    // ---------------- Adapter / Device ----------------
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) { log('No GPU adapter.'); return; }
    const device = await adapter.requestDevice();

    device.addEventListener?.('uncapturederror', (e) => {
      console.error('WebGPU uncaptured error:', e.error || e);
      log('WebGPU error: ' + (e.error?.message || e.message || 'unknown'));
    });

    const format = navigator.gpu.getPreferredCanvasFormat();

    // ---------------- UI ----------------
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
        <input id="file" type="file" accept="image/png, image/jpeg, image/webp">
      </div>
      <div id="stat" style="margin-top:6px; opacity:.9;"></div>
    `;
    document.body.appendChild(ui);
    const evInput = document.getElementById('ev');
    const evVal   = document.getElementById('evv');
    const fileInp = document.getElementById('file');
    const stat    = document.getElementById('stat');

    let exposureEV = 0;
    evInput.oninput = () => { exposureEV = parseFloat(evInput.value); evVal.textContent = evInput.value; };

    // ---------------- Canvas sizing & configure ----------------
    let lastW = 0, lastH = 0;
    function configureIfNeeded() {
      const dpr = 1; // keep stable in Electron
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

    // ---------------- Uniforms (pad to 256B) ----------------
    const uniformBuf = device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    function updateUniforms() {
      const arr = new Float32Array([exposureEV, Math.pow(2, exposureEV), lastW, lastH]);
      device.queue.writeBuffer(uniformBuf, 0, arr.buffer);
    }

    // ---------------- Texture + Sampler ----------------
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

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
    device.queue.writeTexture(
      { texture: srcTex },
      checkerRGBA8(),
      { bytesPerRow: 2*4 },
      { width: 2, height: 2 }
    );
    let srcView = srcTex.createView();

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
      stat.textContent = `Loaded ${file.name} (${srcTex.width || bmp.width}×${srcTex.height || bmp.height})`;
      if (texPipeline) texBindGroup = makeTexBindGroup();
    }
    fileInp.addEventListener('change', async () => {
      const f = fileInp.files?.[0];
      if (f) { try { await loadImageToTexture(f); } catch (e) { console.error(e); log('Load failed: ' + e); } }
    });

    // ---------------- Shaders ----------------
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
        o.uv  = 0.5 * (p + vec2f(1.0, 1.0));
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

    // ---------------- Frame loop ----------------
    function frame() {
      configureIfNeeded();
      const swap = context.getCurrentTexture();
      const rtv = swap.createView();

      updateUniforms();

      const encoder = device.createCommandEncoder();

      // Clear
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

      // Draw
      {
        const pass = encoder.beginRenderPass({
          colorAttachments: [{
            view: rtv,
            loadOp: 'load',
            storeOp: 'store'
          }]
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

    // adapter info
    try {
      const info = await adapter.requestAdapterInfo?.();
      if (info) log(`WebGPU OK — ${info.vendor} ${info.architecture} ${info.description}`);
      else log('WebGPU OK');
    } catch { log('WebGPU OK'); }
  } catch (e) {
    console.error(e);
    log(String(e));
  }
})();