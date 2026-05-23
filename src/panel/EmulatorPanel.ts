import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { EmulatorClient, FrameInfo } from '../grpc/EmulatorClient';
import { AndroidSession, SessionState } from '../session/AndroidSession';

export class EmulatorPanel {
  static readonly viewType = 'tabbedEmulator.panel';

  static create(
    context: vscode.ExtensionContext,
    title: string,
    session: AndroidSession,
    grpcPort: number,
    streamMaxDim: number
  ): EmulatorPanel {
    const panel = vscode.window.createWebviewPanel(
      EmulatorPanel.viewType,
      title,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'webview')]
      }
    );
    return new EmulatorPanel(panel, context, session, grpcPort, streamMaxDim);
  }

  private readonly disposables: vscode.Disposable[] = [];
  private client?: EmulatorClient;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    private readonly session: AndroidSession,
    private readonly grpcPort: number,
    private readonly streamMaxDim: number
  ) {
    this.panel.webview.html = this.renderHtml(context);

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((msg) => this.onWebviewMessage(msg))
    );

    const onState = (state: SessionState) => {
      this.panel.webview.postMessage({ type: 'state', state });
      if (state.kind === 'running' && !this.client) {
        this.startStream();
      }
    };
    const onLog = (line: string) => {
      this.panel.webview.postMessage({ type: 'log', line });
    };
    session.on('state', onState);
    session.on('log', onLog);
    this.disposables.push({
      dispose: () => {
        session.off('state', onState);
        session.off('log', onLog);
      }
    });

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    onState(session.state);
  }

  private startStream(): void {
    const client = new EmulatorClient('127.0.0.1', this.grpcPort);
    this.client = client;
    client.on('log', (line: string) => {
      this.panel.webview.postMessage({ type: 'log', line: `[grpc] ${line}` });
    });
    client.on('frame', (frame: FrameInfo) => {
      this.panel.webview.postMessage({
        type: 'frame',
        format: frame.format,
        width: frame.width,
        height: frame.height,
        seq: frame.seq,
        base64: frame.bytes.toString('base64'),
        size: frame.bytes.length
      });
    });
    client.on('closed', (err?: Error) => {
      this.panel.webview.postMessage({
        type: 'log',
        line: `[grpc] stream closed${err ? `: ${err.message}` : ''}`
      });
    });
    try {
      client.start('PNG', this.streamMaxDim);
      void client.getDeviceSize().then((size) => {
        if (size) {
          this.panel.webview.postMessage({
            type: 'device',
            width: size.width,
            height: size.height
          });
        }
      });
    } catch (err) {
      this.panel.webview.postMessage({
        type: 'log',
        line: `[grpc] start failed: ${(err as Error).message}`
      });
      client.stop();
      this.client = undefined;
    }
  }

  private onWebviewMessage(msg: unknown): void {
    if (typeof msg !== 'object' || msg === null) return;
    const m = msg as {
      type?: string;
      x?: number;
      y?: number;
      id?: number;
      pressure?: number;
      eventType?: 'keydown' | 'keyup' | 'keypress';
      key?: string;
      text?: string;
    };
    switch (m.type) {
      case 'ready':
        this.panel.webview.postMessage({ type: 'state', state: this.session.state });
        break;
      case 'touch':
        if (
          typeof m.x === 'number' &&
          typeof m.y === 'number' &&
          typeof m.id === 'number' &&
          typeof m.pressure === 'number'
        ) {
          this.client?.sendTouch(m.x, m.y, m.id, m.pressure);
        }
        break;
      case 'key':
        if (m.eventType && (typeof m.key === 'string' || typeof m.text === 'string')) {
          this.client?.sendKey(m.eventType, m.key ?? '', m.text);
        }
        break;
    }
  }

  private renderHtml(context: vscode.ExtensionContext): string {
    const webviewDir = vscode.Uri.joinPath(context.extensionUri, 'webview');
    const html = fs.readFileSync(
      path.join(webviewDir.fsPath, 'index.html'),
      'utf8'
    );
    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(webviewDir, 'main.js')
    );
    const styleUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(webviewDir, 'style.css')
    );
    const nonce = randomNonce();
    return html
      .replaceAll('${cspSource}', this.panel.webview.cspSource)
      .replaceAll('${nonce}', nonce)
      .replaceAll('${scriptUri}', scriptUri.toString())
      .replaceAll('${styleUri}', styleUri.toString());
  }

  dispose(): void {
    this.client?.stop();
    this.client = undefined;
    void this.session.stop();
    while (this.disposables.length) this.disposables.pop()?.dispose();
    this.panel.dispose();
  }
}

function randomNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}
