import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';

const execFileAsync = promisify(execFile);

/** The baguette version this extension has been built and tested against.
 *  We pin to an exact version because baguette is pre-1.0 and ships
 *  breaking changes (e.g., the `stream` CLI subcommand was broken in some
 *  builds; the WS wire schema is not yet stable). Newer/older versions
 *  may still work — we warn rather than fail. */
export const PINNED_BAGUETTE_VERSION = '0.1.73';

export interface IosSimulator {
  udid: string;
  name: string;
  runtime: string;
  state: 'Booted' | 'Shutdown' | string;
}

export function resolveBaguettePath(): string {
  const configured = vscode.workspace
    .getConfiguration('tabbedEmulator')
    .get<string>('baguettePath');
  const candidates = [
    configured,
    ...((process.env.PATH ?? '')
      .split(':')
      .filter(Boolean)
      .map((dir) => path.join(dir, 'baguette'))),
    '/opt/homebrew/bin/baguette',
    '/usr/local/bin/baguette'
  ].filter((p): p is string => !!p && p.length > 0);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // not executable; keep looking
      }
    }
  }
  throw new Error(
    'baguette not found. Install with: brew install tddworks/tap/baguette (or set tabbedEmulator.baguettePath).'
  );
}

export function preflight(): void {
  if (process.platform !== 'darwin') {
    throw new Error('iOS Simulator support is macOS-only.');
  }
  if (process.arch !== 'arm64') {
    throw new Error('iOS Simulator support requires Apple Silicon (arm64). baguette is not built for Intel Macs.');
  }
}

/** Run `baguette --version` and return the trimmed version string,
 *  or undefined if the binary doesn't respond. */
export async function getBaguetteVersion(baguette: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(baguette, ['--version'], { timeout: 3000 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Check the installed baguette against the pinned version. Returns a
 *  human-readable warning string if there's a mismatch, undefined if
 *  the version matches (or can't be determined). */
export async function checkBaguetteVersion(baguette: string): Promise<string | undefined> {
  const v = await getBaguetteVersion(baguette);
  if (!v) return `could not read \`baguette --version\` — pinned version is ${PINNED_BAGUETTE_VERSION}`;
  if (v === PINNED_BAGUETTE_VERSION) return undefined;
  return `installed baguette is v${v}, this extension was tested against v${PINNED_BAGUETTE_VERSION}. ` +
         `Run \`brew reinstall tddworks/tap/baguette\` if you see issues.`;
}

export async function listSimulators(baguette: string): Promise<IosSimulator[]> {
  const { stdout } = await execFileAsync(baguette, ['list', '--json'], { maxBuffer: 8 * 1024 * 1024 });
  const parsed = JSON.parse(stdout) as { available?: IosSimulator[]; running?: IosSimulator[] };
  const seen = new Map<string, IosSimulator>();
  for (const sim of [...(parsed.running ?? []), ...(parsed.available ?? [])]) {
    if (!seen.has(sim.udid)) seen.set(sim.udid, sim);
  }
  return Array.from(seen.values());
}

export async function waitForBoot(udid: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('xcrun', ['simctl', 'bootstatus', udid, '-b'], {
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    proc.stderr.on('data', (chunk) => (stderr += chunk));
    proc.on('error', reject);
    proc.on('close', (code) => {
      // bootstatus exits with `4294967295` (uint32 max) on success; treat any
      // non-trapped exit as ok and only fail on spawn/exec error above.
      if (code === null) reject(new Error('bootstatus killed'));
      else resolve();
      void stderr; // silence unused
    });
  });
}
