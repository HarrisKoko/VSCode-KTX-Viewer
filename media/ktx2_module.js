import { loadKTX2Wasm } from "./wasm_loader.js";

export default async function CreateKTX2Module() {

    // --- FIX: Provide all necessary import namespaces for the WASM ---
    const imports = {
        // Emscripten MINIMAL_RUNTIME typically uses namespace "a"
        a: {
            memory: new WebAssembly.Memory({ initial: 256 }),
            abort: () => {},
            a: () => {},      // <-- NEW REQUIRED FUNCTION
            b: () => {}    // <-- NEW required import
        },

        // Extra namespaces in case Emscripten emitted mixed imports
        env: {
            abort: () => {}
        },

        wasi_snapshot_preview1: {}  // stub out WASI if needed
    };

    const instance = await loadKTX2Wasm(window.KTX2_WASM_URI, imports);
    const e = instance.exports;

    return {
        HEAPU8: new Uint8Array(e.memory.buffer),
        _malloc: e.malloc,
        _free: e.free,
        ktx2_transcoder: e.ktx2_transcoder
    };
}
