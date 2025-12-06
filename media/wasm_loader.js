export async function loadKTX2Wasm(path, imports = {}) {
    if (!path) throw new Error("KTX2 WASM URI is undefined.");

    const response = await fetch(path);
    if (!response.ok) throw new Error(`Failed to fetch WASM file: ${response.status}`);

    const bytes = await response.arrayBuffer();
    if (bytes.byteLength === 0) throw new Error("Fetched WASM file is empty.");

    return WebAssembly.instantiate(bytes, imports);
}
