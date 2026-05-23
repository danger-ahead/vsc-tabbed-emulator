import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { EventEmitter } from 'events';
import * as path from 'path';
import { FrameInfo, IEmulatorStreamer, KeyEvent } from '../session/types';

export { FrameInfo } from '../session/types';

interface ImageFormatProto {
  format: 'PNG' | 'RGB888' | 'RGBA8888';
  width?: number;
  height?: number;
  display?: number;
}

interface ImageProto {
  format?: ImageFormatProto & { width?: number; height?: number };
  width?: number;
  height?: number;
  image: Buffer;
  seq?: number;
}

interface TouchProto {
  x: number;
  y: number;
  identifier: number;
  pressure: number;
}

interface TouchEventProto {
  touches: TouchProto[];
  display?: number;
}

interface KeyboardEventProto {
  codeType?: 'Usb' | 'Evdev' | 'XKB' | 'Win' | 'Mac';
  eventType: 'keydown' | 'keyup' | 'keypress';
  keyCode?: number;
  key?: string;
  text?: string;
}

interface DisplayConfigProto {
  width: number;
  height: number;
  dpi: number;
  display: number;
}

interface DisplayConfigurationsProto {
  displays: DisplayConfigProto[];
  userConfigurable?: number;
  maxDisplays?: number;
}

interface EmulatorControllerClient extends grpc.Client {
  streamScreenshot(request: ImageFormatProto): grpc.ClientReadableStream<ImageProto>;
  sendTouch(
    request: TouchEventProto,
    callback: (err: grpc.ServiceError | null) => void
  ): grpc.ClientUnaryCall;
  sendKey(
    request: KeyboardEventProto,
    callback: (err: grpc.ServiceError | null) => void
  ): grpc.ClientUnaryCall;
  getDisplayConfigurations(
    request: object,
    callback: (err: grpc.ServiceError | null, response: DisplayConfigurationsProto) => void
  ): grpc.ClientUnaryCall;
}

let cachedCtor: grpc.ServiceClientConstructor | undefined;

function loadEmulatorController(): grpc.ServiceClientConstructor {
  if (cachedCtor) return cachedCtor;
  const protoDir = path.join(__dirname, 'proto');
  const def = protoLoader.loadSync(
    path.join(protoDir, 'emulator_controller.proto'),
    {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
      includeDirs: [protoDir]
    }
  );
  const pkg = grpc.loadPackageDefinition(def) as any;
  cachedCtor = pkg.android.emulation.control
    .EmulatorController as grpc.ServiceClientConstructor;
  return cachedCtor;
}

export class EmulatorClient extends EventEmitter implements IEmulatorStreamer {
  private client?: EmulatorControllerClient;
  private screenshotStream?: grpc.ClientReadableStream<ImageProto>;
  private closed = false;

  constructor(private readonly host: string, private readonly port: number) {
    super();
  }

  start(maxDim = 0): void {
    const format: 'PNG' = 'PNG';
    const Ctor = loadEmulatorController();
    const target = `${this.host}:${this.port}`;
    this.client = new Ctor(
      target,
      grpc.credentials.createInsecure(),
      { 'grpc.max_receive_message_length': 64 * 1024 * 1024 }
    ) as unknown as EmulatorControllerClient;

    const request: ImageFormatProto = { format, display: 0 };
    if (maxDim > 0) {
      request.width = maxDim;
      request.height = maxDim;
    }

    this.screenshotStream = this.client.streamScreenshot(request);
    this.emit('log', `streamScreenshot started format=${format}`);

    this.screenshotStream.on('data', (img: ImageProto) => {
      if (this.closed) return;
      const width = img.format?.width ?? img.width ?? 0;
      const height = img.format?.height ?? img.height ?? 0;
      this.emit('frame', {
        bytes: img.image,
        format,
        width,
        height,
        display: 0,
        seq: Number(img.seq ?? 0)
      } satisfies FrameInfo);
    });

    this.screenshotStream.on('error', (err) => {
      if (this.closed) return;
      this.emit('log', `screenshot stream error: ${err.message}`);
      this.emit('closed', err);
    });

    this.screenshotStream.on('end', () => {
      if (!this.closed) this.emit('closed');
    });
  }

  async getDeviceSize(): Promise<{ width: number; height: number } | undefined> {
    if (!this.client) return undefined;
    return new Promise((resolve) => {
      this.client!.getDisplayConfigurations({}, (err, res) => {
        if (err || !res?.displays?.length) {
          this.emit('log', `getDisplayConfigurations failed: ${err?.message ?? 'no displays'}`);
          resolve(undefined);
          return;
        }
        const primary = res.displays.find((d) => d.display === 0) ?? res.displays[0];
        resolve({ width: primary.width, height: primary.height });
      });
    });
  }

  sendKey(event: KeyEvent): void {
    if (!this.client || this.closed) return;
    const req: KeyboardEventProto = { eventType: event.eventType };
    if (event.text !== undefined) req.text = event.text;
    else if (event.key !== undefined) req.key = event.key;
    else return;
    this.client.sendKey(req, (err) => {
      if (err) this.emit('log', `sendKey error: ${err.message}`);
    });
  }

  sendTouch(x: number, y: number, identifier: number, pressure: number): void {
    if (!this.client || this.closed) return;
    this.client.sendTouch(
      { touches: [{ x, y, identifier, pressure }], display: 0 },
      (err) => {
        if (err) this.emit('log', `sendTouch error: ${err.message}`);
      }
    );
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.screenshotStream?.cancel();
    } catch {
      /* ignore */
    }
    try {
      this.client?.close();
    } catch {
      /* ignore */
    }
  }
}
