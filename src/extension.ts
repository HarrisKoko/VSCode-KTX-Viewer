import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('ktx2hdr.openWebgpuDemo', () => {
      const panel = vscode.window.createWebviewPanel(
        'webgpuDemo',
        'WebGPU Demo',
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          retainContextWhenHidden: true
        }
      );

      const scriptUri = panel.webview.asWebviewUri(
        vscode.Uri.joinPath(context.extensionUri, 'media', 'main.js')
      );

      const nonce = getNonce();
      panel.webview.html = /* html */`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta
            http-equiv="Content-Security-Policy"
            content="default-src 'none'; style-src 'unsafe-inline' ${panel.webview.cspSource}; img-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}';"
          />
          <meta name="viewport" content="width=device-width,initial-scale=1" />
          <title>WebGPU Triangle</title>
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
          <script nonce="${nonce}" src="${scriptUri}"></script>
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
