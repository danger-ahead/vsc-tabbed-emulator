import { execFile, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { promisify } from 'util';
import { waitForBoot } from '../discovery/ios';
import { IEmulatorSession, SessionState } from './types';

const execFileAsync = promisify(execFile);

export interface IosSessionOptions {
  baguettePath: string;
  udid: string;
  name: string;
}

export class IosSession extends EventEmitter implements IEmulatorSession {
  private _state: SessionState = { kind: 'stopped' };
  private started = false;

  constructor(private readonly opts: IosSessionOptions) {
    super();
  }

  get state(): SessionState {
    return this._state;
  }

  start(): void {
    if (this.started) throw new Error('session already started');
    this.started = true;
    this.setState({ kind: 'starting' });

    void this.bootSequence().catch((err: Error) => {
      this.setState({ kind: 'error', message: err.message });
    });
  }

  private async bootSequence(): Promise<void> {
    this.log(`baguette boot --udid ${this.opts.udid}`);
    try {
      const { stdout, stderr } = await execFileAsync(
        this.opts.baguettePath,
        ['boot', '--udid', this.opts.udid],
        { maxBuffer: 1024 * 1024 }
      );
      const out = (stdout + stderr).trim();
      if (out) this.log(out);
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr ?? '';
      // CoreSimulator error 405 = "Unable to boot device in current state: Booted".
      // Already booted is fine — skip and continue.
      if (stderr.includes('Code=405') || /current state: Booted/.test(stderr)) {
        this.log('already booted, continuing');
      } else {
        throw new Error(stderr.trim() || (err as Error).message);
      }
    }

    this.log('waiting for simctl bootstatus...');
    await waitForBoot(this.opts.udid);
    if (this._state.kind === 'starting') {
      this.setState({ kind: 'running', serial: this.opts.udid });
    }
  }

  async stop(): Promise<void> {
    if (this._state.kind === 'stopped' || this._state.kind === 'error') return;
    this.setState({ kind: 'stopped', reason: 'shutdown requested' });
    await new Promise<void>((resolve) => {
      const p = spawn(this.opts.baguettePath, ['shutdown', '--udid', this.opts.udid]);
      p.on('close', () => resolve());
      p.on('error', () => resolve());
    });
  }

  private setState(next: SessionState): void {
    this._state = next;
    this.emit('state', next);
  }

  private log(line: string): void {
    if (line) this.emit('log', line);
  }
}
