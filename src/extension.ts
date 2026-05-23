import * as vscode from 'vscode';
import { listAvds, resolveAndroidSdkPath } from './discovery/android';
import { EmulatorPanel } from './panel/EmulatorPanel';
import { AndroidSession } from './session/AndroidSession';

const activePanels = new Set<EmulatorPanel>();
let output: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Tabbed Emulator');
  context.subscriptions.push(output);

  context.subscriptions.push(
    vscode.commands.registerCommand('tabbedEmulator.openAndroid', () =>
      openAndroid(context)
    ),
    vscode.commands.registerCommand('tabbedEmulator.stopAll', () => stopAll())
  );
}

export function deactivate(): void {
  stopAll();
}

async function openAndroid(context: vscode.ExtensionContext): Promise<void> {
  let sdkPath: string;
  try {
    sdkPath = resolveAndroidSdkPath();
  } catch (err) {
    vscode.window.showErrorMessage((err as Error).message);
    return;
  }

  let avds: string[];
  try {
    avds = await listAvds(sdkPath);
  } catch (err) {
    vscode.window.showErrorMessage(
      `Failed to list AVDs: ${(err as Error).message}`
    );
    return;
  }

  if (avds.length === 0) {
    vscode.window.showWarningMessage(
      'No Android Virtual Devices found. Create one in Android Studio first.'
    );
    return;
  }

  const picked = await vscode.window.showQuickPick(avds, {
    placeHolder: 'Select an Android Virtual Device'
  });
  if (!picked) return;

  const config = vscode.workspace.getConfiguration('tabbedEmulator');
  const grpcPort = config.get<number>('grpcPort', 8554);
  const streamMaxDim = config.get<number>('streamMaxDimension', 900);

  const session = new AndroidSession({
    sdkPath,
    avdName: picked,
    grpcPort
  });
  session.on('log', (line: string) => output.appendLine(`[${picked}] ${line}`));
  session.on('state', (state) =>
    output.appendLine(`[${picked}] state: ${JSON.stringify(state)}`)
  );

  const panel = EmulatorPanel.create(
    context,
    `Emulator: ${picked}`,
    session,
    grpcPort,
    streamMaxDim
  );
  activePanels.add(panel);

  try {
    session.start();
  } catch (err) {
    vscode.window.showErrorMessage(
      `Failed to start emulator: ${(err as Error).message}`
    );
    panel.dispose();
    activePanels.delete(panel);
  }
}

function stopAll(): void {
  for (const panel of activePanels) panel.dispose();
  activePanels.clear();
}
