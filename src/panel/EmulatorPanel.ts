import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { FrameInfo, HardwareButton, IEmulatorSession, IEmulatorStreamer, KeyEvent, SessionState } from '../session/types';

export interface StreamerFactory {
  (): IEmulatorStreamer;
}

export class EmulatorPanel {
  static readonly viewType = 'tabbedEmulator.panel';

  static create(
    context: vscode.ExtensionContext,
    title: string,
    session: IEmulatorSession,
    streamerFactory: StreamerFactory,
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
    return new EmulatorPanel(panel, context, session, streamerFactory, streamMaxDim);
  }

  private readonly disposables: vscode.Disposable[] = [];
  private client?: IEmulatorStreamer;
  /** Promise that resolves when the underlying session has fully shut down.
   *  Set the first time `dispose()` is called, so callers (e.g. extension
   *  deactivate) can await the real OS-level shutdown. */
  private stopPromise?: Promise<void>;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    private readonly session: IEmulatorSession,
    private readonly streamerFactory: StreamerFactory,
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
    const client = this.streamerFactory();
    this.client = client;
    client.on('log', (line: string) => {
      this.panel.webview.postMessage({ type: 'log', line: `[stream] ${line}` });
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
    client.on('device', (size: { width: number; height: number }) => {
      this.panel.webview.postMessage({
        type: 'device',
        width: size.width,
        height: size.height
      });
    });
    client.on('closed', (err?: Error) => {
      this.panel.webview.postMessage({
        type: 'log',
        line: `[stream] closed${err ? `: ${err.message}` : ''}`
      });
    });
    try {
      client.start(this.streamMaxDim);
      void client.getDeviceSize().then((size: { width: number; height: number } | undefined) => {
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
        line: `[stream] start failed: ${(err as Error).message}`
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
      code?: string;
      modifiers?: string[];
      text?: string;
      button?: HardwareButton;
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
        if (m.eventType) {
          const ev: KeyEvent = { eventType: m.eventType };
          if (m.key !== undefined) ev.key = m.key;
          if (m.code !== undefined) ev.code = m.code;
          if (m.modifiers !== undefined) ev.modifiers = m.modifiers;
          if (m.text !== undefined) ev.text = m.text;
          this.client?.sendKey(ev);
        }
        break;
      case 'button':
        if (m.button === 'home' || m.button === 'recent') {
          void this.session.pressHardwareButton(m.button);
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
    if (!this.stopPromise) {
      // Swallow rejections so callers can await without try/catch.
      this.stopPromise = this.session.stop().catch(() => {});
    }
    while (this.disposables.length) this.disposables.pop()?.dispose();
    this.panel.dispose();
  }

  /** Resolves once `session.stop()` (started by `dispose()`) has finished.
   *  Use this when you need to know the underlying emulator/simulator
   *  process has actually been signalled — e.g. during extension shutdown. */
  stopped(): Promise<void> {
    return this.stopPromise ?? Promise.resolve();
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
