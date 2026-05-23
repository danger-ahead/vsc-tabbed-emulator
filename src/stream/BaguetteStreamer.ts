import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { FrameInfo, IEmulatorStreamer, KeyEvent } from '../session/types';
import { BaguetteServer } from '../server/BaguetteServer';

export interface BaguetteStreamerOptions {
  server: BaguetteServer;
  udid: string;
}

const MODIFIER_KEYS = new Set([
  'ShiftLeft', 'ShiftRight',
  'ControlLeft', 'ControlRight',
  'AltLeft', 'AltRight',
  'MetaLeft', 'MetaRight'
]);

export class BaguetteStreamer extends EventEmitter implements IEmulatorStreamer {
  private ws?: WebSocket;
  private closed = false;
  private deviceSize?: { width: number; height: number };
  private seq = 0;
  private deviceSizeResolvers: Array<(size: { width: number; height: number } | undefined) => void> = [];
  private pendingMoveDrop = false;

  constructor(private readonly opts: BaguetteStreamerOptions) {
    super();
  }

  start(maxDim = 0): void {
    void this.startAsync(maxDim).catch((err: Error) => {
      this.emit('log', `start failed: ${err.message}`);
      this.emit('closed', err);
    });
  }

  private async startAsync(maxDim: number): Promise<void> {
    const port = await this.opts.server.acquire();
    const url = `ws://127.0.0.1:${port}/simulators/${encodeURIComponent(this.opts.udid)}/stream?format=mjpeg&version=v2`;
    this.emit('log', `ws connecting: ${url}`);

    const ws = new WebSocket(url);
    ws.binaryType = 'nodebuffer';
    this.ws = ws;

    ws.on('open', () => {
      this.emit('log', 'ws open');
      this.send({ type: 'set_fps', fps: 30 });
      if (maxDim > 0) {
        // baguette's scale is an integer downscale divisor. We don't know
        // the device's native dimensions yet, so pick a divisor by guessing
        // ~2x for typical retina until the first frame lands.
        this.send({ type: 'set_scale', scale: 2 });
      }
    });

    ws.on('message', (data, isBinary) => {
      if (this.closed) return;
      if (isBinary && Buffer.isBuffer(data)) {
        const buf = data;
        if (!this.deviceSize) {
          const size = parseJpegSize(buf);
          if (size) {
            this.deviceSize = size;
            this.emit('device', size);
            for (const r of this.deviceSizeResolvers) r(size);
            this.deviceSizeResolvers = [];
          }
        }
        this.seq += 1;
        const frame: FrameInfo = {
          bytes: buf,
          format: 'JPEG',
          width: this.deviceSize?.width ?? 0,
          height: this.deviceSize?.height ?? 0,
          display: 0,
          seq: this.seq
        };
        this.emit('frame', frame);
      } else {
        const text = data.toString();
        this.emit('log', `ws text: ${text.slice(0, 200)}`);
      }
    });

    ws.on('close', (code, reason) => {
      const reasonStr = reason?.toString();
      this.emit('log', `ws closed code=${code}${reasonStr ? ` reason=${reasonStr}` : ''}`);
      this.cleanup();
      this.emit('closed');
    });

    ws.on('error', (err: Error) => {
      this.emit('log', `ws error: ${err.message}`);
    });
  }

  async getDeviceSize(): Promise<{ width: number; height: number } | undefined> {
    if (this.deviceSize) return this.deviceSize;
    if (this.closed) return undefined;
    return new Promise((resolve) => {
      this.deviceSizeResolvers.push(resolve);
      setTimeout(() => resolve(undefined), 5000);
    });
  }

  sendTouch(x: number, y: number, _id: number, pressure: number): void {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const size = this.deviceSize;
    if (!size) return;
    const phase = pressure > 0 ? (this.activeDown ? 'move' : 'down') : 'up';
    if (phase === 'down') this.activeDown = true;
    if (phase === 'up') this.activeDown = false;

    // Coalesce moves when the socket is backed up: drop intermediate
    // points so we don't queue stale positions on a slow simulator.
    if (phase === 'move' && this.ws.bufferedAmount > 64 * 1024) {
      if (this.pendingMoveDrop) return;
      this.pendingMoveDrop = true;
      setImmediate(() => (this.pendingMoveDrop = false));
      return;
    }

    this.send({
      type: `touch1-${phase}`,
      x: Math.round(x),
      y: Math.round(y),
      width: size.width,
      height: size.height
    });
  }
  private activeDown = false;

  sendKey(event: KeyEvent): void {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // baguette's `key` envelope is a press-and-release; only fire on keydown.
    if (event.eventType !== 'keydown') return;
    if (event.text) {
      this.send({ type: 'type', text: event.text });
      return;
    }
    const code = event.code;
    if (!code || MODIFIER_KEYS.has(code)) return;
    const envelope: Record<string, unknown> = { type: 'key', code };
    if (event.modifiers && event.modifiers.length > 0) envelope.modifiers = event.modifiers;
    this.send(envelope);
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws?.close(1000);
    } catch {
      // ignore
    }
    this.cleanup();
  }

  private cleanup(): void {
    if (this.ws) {
      try { this.ws.removeAllListeners(); } catch { /* ignore */ }
      this.ws = undefined;
    }
    if (this.deviceSizeResolvers.length) {
      for (const r of this.deviceSizeResolvers) r(undefined);
      this.deviceSizeResolvers = [];
    }
    try { this.opts.server.release(); } catch { /* ignore */ }
  }

  private send(payload: object): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(payload));
    } catch (err) {
      this.emit('log', `ws send failed: ${(err as Error).message}`);
    }
  }
}

/** Parse a JPEG's first SOF (Start Of Frame) marker for width/height. */
function parseJpegSize(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return undefined;
  let i = 2;
  while (i < buf.length - 8) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buf[i + 1];
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    // SOF0..SOF15 = 0xC0..0xCF, excluding DHT(0xC4), JPG(0xC8), DAC(0xCC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = buf.readUInt16BE(i + 5);
      const width = buf.readUInt16BE(i + 7);
      return { width, height };
    }
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const segLen = buf.readUInt16BE(i + 2);
    i += 2 + segLen;
  }
  return undefined;
}
