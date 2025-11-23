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

      const readUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'read.js'));
      const ktxTranscoderUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'transcoder.js'));
      const libktxUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'basisu', 'libktx.js'));
      const libktxWasmUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'basisu', 'libktx.wasm'));
      const mainUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'main.js'));
      const shaderUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'shaders.wgsl'));

      const nonce = getNonce();

      panel.webview.html = /* html */`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta http-equiv="Content-Security-Policy" content="
            default-src 'none';
            img-src ${panel.webview.cspSource} blob: data:;
            style-src 'unsafe-inline' ${panel.webview.cspSource};
            script-src 'unsafe-eval' 'wasm-unsafe-eval' 'nonce-${nonce}';
            connect-src ${panel.webview.cspSource};
            worker-src blob:;
          ">
          <style>
            html, body, #wrap { height: 100%; margin: 0; background: #1e1e1e; }
            #log { position:absolute; top:8px; left:8px; font:12px/1.4 monospace; color:#ccc; }
            canvas { width: 100%; height: 100%; display: block; }
          </style>
          
          <script type="importmap" nonce="${nonce}">
          {
            "imports": {
              "./transcoder.js": "${ktxTranscoderUri}"
            }
          }
          </script>
        </head>
        <body>
          <div id="wrap">
            <canvas id="gfx"></canvas>
            <div id="log">Initializing…</div>
          </div>

          <script nonce="${nonce}">
            window.shaderUri = '${shaderUri}';
            // FIXED: Variable name matches transcoder.js expectation
            window.LIBKTX_WASM = "${libktxWasmUri}"; 
          </script>

          <script nonce="${nonce}" src="${readUri}"></script>
          <script nonce="${nonce}" src="${libktxUri}"></script>

          <script nonce="${nonce}" type="module" src="${mainUri}"></script>
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