(async function () {
  const log = (msg) => { const el = document.getElementById('log'); if (el) el.textContent = String(msg); };

  if (!('gpu' in navigator)) {
    log('WebGPU not available. Check GPU/driver and VS Code version.');
    return;
  }

  const canvas = document.getElementById('gfx');
  const context = canvas.getContext('webgpu');
  if (!context) { log('Failed to get WebGPU context.'); return; }

  // Resize handling (webview resizes often)
  const resize = () => {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  };
  new ResizeObserver(resize).observe(canvas);
  resize();

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) { log('No GPU adapter.'); return; }

  const device = await adapter.requestDevice();
  const format = navigator.gpu.getPreferredCanvasFormat();

  context.configure({ device, format, alphaMode: 'opaque' });

  // Simple triangle WGSL
  const shader = device.createShaderModule({
    code: `
      @vertex
      fn vs_main(@builtin(vertex_index) vid: u32) -> @builtin(position) vec4f {
        var pos = array<vec2f,3>(
          vec2f(0.0, 0.6),
          vec2f(-0.5, -0.4),
          vec2f(0.5, -0.4)
        );
        return vec4f(pos[vid], 0.0, 1.0);
      }
      @fragment
      fn fs_main() -> @location(0) vec4f {
        // fun gradient to prove we're drawing
        return vec4f(0.2, 0.6, 1.0, 1.0);
      }
    `
  });

  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: shader, entryPoint: 'vs_main' },
    fragment: { module: shader, entryPoint: 'fs_main', targets: [{ format }] },
    primitive: { topology: 'triangle-list' }
  });

  function frame() {
    const texView = context.getCurrentTexture().createView();
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: texView,
        clearValue: { r: 0.05, g: 0.05, b: 0.06, a: 1 },
        loadOp: 'clear',
        storeOp: 'store'
      }]
    });
    pass.setPipeline(pipeline);
    pass.draw(3, 1, 0, 0);
    pass.end();
    device.queue.submit([encoder.finish()]);
    requestAnimationFrame(frame);
  }
  frame();

  // optional: show adapter info
  try {
    const info = await adapter.requestAdapterInfo?.();
    if (info) log(`WebGPU OK — ${info.vendor} ${info.architecture} ${info.description}`);
    else log('WebGPU OK');
  } catch {
    log('WebGPU OK');
  }
})();
