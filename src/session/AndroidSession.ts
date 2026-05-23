import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { adbBinary, emulatorBinary } from '../discovery/android';
import { HardwareButton, IEmulatorSession, SessionState } from './types';

export { SessionState } from './types';

// Android KeyEvent codes — https://developer.android.com/reference/android/view/KeyEvent
const ANDROID_KEYCODE: Record<HardwareButton, number> = {
  home: 3,    // KEYCODE_HOME
  recent: 187 // KEYCODE_APP_SWITCH
};

export interface AndroidSessionOptions {
  sdkPath: string;
  avdName: string;
  grpcPort: number;
  consolePort?: number;
}

export class AndroidSession extends EventEmitter implements IEmulatorSession {
  private proc?: ChildProcess;
  private bootPoller?: NodeJS.Timeout;
  private _state: SessionState = { kind: 'stopped' };

  constructor(private readonly opts: AndroidSessionOptions) {
    super();
  }

  get state(): SessionState {
    return this._state;
  }

  get serial(): string {
    return `emulator-${this.opts.consolePort ?? 5554}`;
  }

  start(): void {
    if (this.proc) {
      throw new Error('session already started');
    }
    this.setState({ kind: 'starting' });

    const args = [
      '-avd',
      this.opts.avdName,
      '-grpc',
      String(this.opts.grpcPort),
      '-no-window',
      '-no-snapshot',
      '-no-boot-anim',
      '-gpu',
      'swiftshader_indirect'
    ];
    if (this.opts.consolePort) {
      args.push('-port', String(this.opts.consolePort));
    }

    this.log(`spawning emulator ${args.join(' ')}`);
    this.proc = spawn(emulatorBinary(this.opts.sdkPath), args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    this.proc.stdout?.on('data', (chunk) => this.log(chunk.toString().trimEnd()));
    this.proc.stderr?.on('data', (chunk) => this.log(chunk.toString().trimEnd()));

    this.proc.on('error', (err) => {
      this.setState({ kind: 'error', message: err.message });
    });
    this.proc.on('close', (code) => {
      this.clearBootPoller();
      if (this._state.kind !== 'error') {
        this.setState({ kind: 'stopped', reason: `emulator exited ${code}` });
      }
      this.proc = undefined;
    });

    this.pollBoot();
  }

  async stop(): Promise<void> {
    this.clearBootPoller();
    const adb = adbBinary(this.opts.sdkPath);
    if (this._state.kind === 'running') {
      await new Promise<void>((resolve) => {
        const p = spawn(adb, ['-s', this.serial, 'emu', 'kill']);
        p.on('close', () => resolve());
        p.on('error', () => resolve());
      });
    }
    if (this.proc && !this.proc.killed) {
      this.proc.kill('SIGTERM');
    }
  }

  async pressHardwareButton(button: HardwareButton): Promise<void> {
    if (this._state.kind !== 'running') return;
    const code = ANDROID_KEYCODE[button];
    const adb = adbBinary(this.opts.sdkPath);
    await new Promise<void>((resolve) => {
      const p = spawn(adb, ['-s', this.serial, 'shell', 'input', 'keyevent', String(code)]);
      let stderr = '';
      p.stderr?.on('data', (c) => (stderr += c));
      p.on('close', (exit) => {
        if (exit !== 0) this.log(`adb keyevent ${button} exit=${exit} ${stderr.trim()}`);
        resolve();
      });
      p.on('error', (err) => {
        this.log(`adb keyevent ${button} error: ${err.message}`);
        resolve();
      });
    });
  }

  private pollBoot(): void {
    const adb = adbBinary(this.opts.sdkPath);
    const tick = () => {
      const p = spawn(adb, [
        '-s',
        this.serial,
        'shell',
        'getprop',
        'sys.boot_completed'
      ]);
      let out = '';
      p.stdout.on('data', (c) => (out += c));
      p.on('close', () => {
        if (out.trim() === '1' && this._state.kind === 'starting') {
          this.setState({ kind: 'running', serial: this.serial });
        }
      });
      p.on('error', () => {
        /* ignore until device shows up */
      });
    };
    this.bootPoller = setInterval(tick, 1500);
  }

  private clearBootPoller(): void {
    if (this.bootPoller) {
      clearInterval(this.bootPoller);
      this.bootPoller = undefined;
    }
  }

  private setState(next: SessionState): void {
    this._state = next;
    this.emit('state', next);
  }

  private log(line: string): void {
    if (line) this.emit('log', line);
  }
}
