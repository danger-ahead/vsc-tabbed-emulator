import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export function resolveAndroidSdkPath(): string {
  const configured = vscode.workspace
    .getConfiguration('tabbedEmulator')
    .get<string>('androidSdkPath');
  const candidates = [
    configured,
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(process.env.HOME ?? '', 'Library/Android/sdk')
  ].filter((p): p is string => !!p && p.length > 0);

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'emulator', 'emulator'))) {
      return candidate;
    }
  }
  throw new Error(
    'Android SDK not found. Set tabbedEmulator.androidSdkPath or $ANDROID_HOME.'
  );
}

export function emulatorBinary(sdkPath: string): string {
  return path.join(sdkPath, 'emulator', 'emulator');
}

export function adbBinary(sdkPath: string): string {
  return path.join(sdkPath, 'platform-tools', 'adb');
}

export async function listAvds(sdkPath: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn(emulatorBinary(sdkPath), ['-list-avds']);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => (stdout += chunk));
    proc.stderr.on('data', (chunk) => (stderr += chunk));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`emulator -list-avds exited ${code}: ${stderr}`));
        return;
      }
      const avds = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('INFO'));
      resolve(avds);
    });
  });
}
