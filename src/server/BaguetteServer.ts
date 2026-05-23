import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import * as net from 'net';

/** Grace period before the shared `baguette serve` process is torn down after
 * the last panel closes. Lets rapid close→reopen cycles reuse the running
 * server instead of racing a SIGTERM against a fresh spawn on the same port. */
const SHUTDOWN_GRACE_MS = 5000;

export class BaguetteServer extends EventEmitter {
  private static instance?: BaguetteServer;

  static instance_(baguettePath: string, basePort: number, log: (line: string) => void): BaguetteServer {
    if (!BaguetteServer.instance) {
      BaguetteServer.instance = new BaguetteServer(baguettePath, basePort, log);
    }
    return BaguetteServer.instance;
  }

  private proc?: ChildProcess;
  private refCount = 0;
  private startPromise?: Promise<number>;
  private actualPort = 0;
  private shutdownTimer?: NodeJS.Timeout;
  private shutdownPromise?: Promise<void>;

  private constructor(
    private readonly baguettePath: string,
    private readonly basePort: number,
    private readonly log: (line: string) => void
  ) {
    super();
  }

  /** Start (if needed) and return the port the server is listening on. */
  async acquire(): Promise<number> {
    if (this.shutdownTimer) {
      clearTimeout(this.shutdownTimer);
      this.shutdownTimer = undefined;
    }
    if (this.shutdownPromise) {
      await this.shutdownPromise;
    }
    this.refCount += 1;
    if (this.proc && this.actualPort > 0) return this.actualPort;
    if (!this.startPromise) {
      this.startPromise = this.startInternal();
    }
    return this.startPromise;
  }

  release(): void {
    this.refCount = Math.max(0, this.refCount - 1);
    if (this.refCount > 0) return;
    if (this.shutdownTimer) return;
    this.shutdownTimer = setTimeout(() => {
      this.shutdownTimer = undefined;
      if (this.refCount === 0) this.shutdown();
    }, SHUTDOWN_GRACE_MS);
    this.shutdownTimer.unref();
  }

  private async startInternal(): Promise<number> {
    const port = await pickFreePort(this.basePort, 10);
    this.log(`spawning baguette serve --host 127.0.0.1 --port ${port}`);
    const proc = spawn(this.baguettePath, ['serve', '--host', '127.0.0.1', '--port', String(port)], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    this.proc = proc;

    let resolved = false;
    return new Promise<number>((resolve, reject) => {
      let probing = false;
      const onReadyChunk = (chunk: Buffer) => {
        const line = chunk.toString();
        this.log(`[serve] ${line.trimEnd()}`);
        if (resolved || probing) return;
        if (!line.includes('listening on')) return;
        // baguette logs "[baguette] listening on http://..." *before* the
        // underlying Hummingbird server has actually bound the TCP socket.
        // Confirm by polling the port until a TCP connect succeeds, so
        // downstream WebSocket clients don't race the bind.
        probing = true;
        void waitForTcp('127.0.0.1', port, 3000).then((ok) => {
          if (resolved) return;
          if (!ok) {
            resolved = true;
            reject(new Error(`port ${port} did not accept connections within 3s`));
            return;
          }
          resolved = true;
          this.actualPort = port;
          resolve(port);
        });
      };
      proc.stdout?.on('data', onReadyChunk);
      proc.stderr?.on('data', onReadyChunk);
      proc.on('error', (err) => {
        // Only clear state if this is still the active proc — a stale close
        // event from a previous instance must not clobber a newer one.
        if (this.proc === proc) {
          this.proc = undefined;
          this.actualPort = 0;
          this.startPromise = undefined;
        }
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });
      proc.on('close', (code) => {
        this.log(`[serve] exited ${code}`);
        if (this.proc === proc) {
          this.proc = undefined;
          this.actualPort = 0;
          this.startPromise = undefined;
        }
        if (!resolved) {
          resolved = true;
          reject(new Error(`baguette serve exited before ready (code ${code})`));
        }
      });
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(new Error('baguette serve did not become ready within 10s'));
        }
      }, 10_000);
    });
  }

  private shutdown(): void {
    const proc = this.proc;
    this.proc = undefined;
    this.actualPort = 0;
    this.startPromise = undefined;
    if (!proc) {
      this.shutdownPromise = undefined;
      return;
    }
    this.shutdownPromise = new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
        this.shutdownPromise = undefined;
      };
      proc.once('close', finish);
      proc.once('exit', finish);
      if (!proc.killed) proc.kill('SIGTERM');
      const force = setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, 500);
      force.unref();
      // Hard fallback if the process never reports close (rare).
      const giveUp = setTimeout(finish, 3000);
      giveUp.unref();
    });
  }
}

async function pickFreePort(start: number, tries: number): Promise<number> {
  for (let i = 0; i < tries; i++) {
    const port = start + i;
    if (await isPortFree(port)) return port;
  }
  throw new Error(`no free port in range ${start}..${start + tries - 1}`);
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

/** Poll a TCP port until a connection succeeds, or timeout. */
async function waitForTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await tryConnect(host, port, 250);
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

function tryConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    setTimeout(() => finish(false), timeoutMs);
  });
}
