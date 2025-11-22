import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('ktx2hdr.openWebgpuDemo', () => {
      const panel = vscode.window.createWebviewPanel(
        'webgpuDemo',
        'WebGPU KTX2 Viewer',
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          retainContextWhenHidden: true
        }
      );

      const readUri = panel.webview.asWebviewUri(
        vscode.Uri.joinPath(context.extensionUri, 'media', 'read.js')
      );
      const ktxTranscoderUri = panel.webview.asWebviewUri(
        vscode.Uri.joinPath(context.extensionUri, 'media', 'transcoder.js')
      );
      const basisUri = panel.webview.asWebviewUri(
        vscode.Uri.joinPath(context.extensionUri, 'media', 'basisu', 'basis_transcoder.js')
      );
      const basisWasmUri = panel.webview.asWebviewUri(
        vscode.Uri.joinPath(context.extensionUri, 'media', 'basisu', 'basis_transcoder.wasm')
      );
      const scriptUri = panel.webview.asWebviewUri(
        vscode.Uri.joinPath(context.extensionUri, 'media', 'main.js')
      );
      const shaderUri = panel.webview.asWebviewUri(
        vscode.Uri.joinPath(context.extensionUri, 'media', 'shaders.wgsl')
      );

      const nonce = getNonce();
      panel.webview.html = /* html */`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <!-- ✔ Updated CSP: allow WASM execution -->
          <meta http-equiv="Content-Security-Policy"
            content="
              default-src 'none';
              img-src ${panel.webview.cspSource};
              style-src 'unsafe-inline' ${panel.webview.cspSource};
              script-src 'unsafe-eval' 'nonce-${nonce}' ${panel.webview.cspSource};
              connect-src ${panel.webview.cspSource};
              worker-src blob:;
            ">
          <meta name="viewport" content="width=device-width,initial-scale=1" />
          <title>WebGPU KTX2 Viewer</title>
          <style>
            html, body, #wrap { height: 100%; margin: 0; background: #1e1e1e; }
            #log { position:absolute; top:8px; left:8px; font:12px/1.4 monospace; color:#ccc; }
            canvas { width: 100%; height: 100%; display: block; }
          </style>
        </head>
        <body>
          <div id="wrap">
            <canvas id="gfx"></canvas>
            <div id="log">Initializing…</div>
          </div>
          <script nonce="${nonce}">
            // Inject shader URI as global variable
            window.shaderUri = '${shaderUri}';
          </script>
          <script nonce="${nonce}">
            window.BASIS_WASMPATH = "${basisWasmUri}";
            console.log("BASIS WASM path:", window.BASIS_WASMPATH);
          </script>
          
          <script nonce="${nonce}" src="${basisUri}"></script>
          <script nonce="${nonce}" src="${ktxTranscoderUri}"></script>
          <script nonce="${nonce}" src="${readUri}"></script>
          <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
        </body>
        </html>`;

    })
  );
}

export function deactivate() {}

function getNonce() {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}