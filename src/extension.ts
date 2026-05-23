import * as vscode from 'vscode';
import { listAvds, resolveAndroidSdkPath } from './discovery/android';
import { listSimulators, preflight, resolveBaguettePath } from './discovery/ios';
import { EmulatorClient } from './grpc/EmulatorClient';
import { EmulatorPanel } from './panel/EmulatorPanel';
import { BaguetteServer } from './server/BaguetteServer';
import { AndroidSession } from './session/AndroidSession';
import { IosSession } from './session/IosSession';
import { BaguetteStreamer } from './stream/BaguetteStreamer';

const activePanels = new Set<EmulatorPanel>();
let output: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Tabbed Emulator');
  context.subscriptions.push(output);

  context.subscriptions.push(
    vscode.commands.registerCommand('tabbedEmulator.openAndroid', () =>
      openAndroid(context)
    ),
    vscode.commands.registerCommand('tabbedEmulator.openIos', () =>
      openIos(context)
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
    () => new EmulatorClient('127.0.0.1', grpcPort),
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

async function openIos(context: vscode.ExtensionContext): Promise<void> {
  try {
    preflight();
  } catch (err) {
    vscode.window.showErrorMessage((err as Error).message);
    return;
  }

  let baguettePath: string;
  try {
    baguettePath = resolveBaguettePath();
  } catch (err) {
    vscode.window.showErrorMessage((err as Error).message);
    return;
  }

  let sims;
  try {
    sims = await listSimulators(baguettePath);
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to list iOS simulators: ${(err as Error).message}`);
    return;
  }
  if (sims.length === 0) {
    vscode.window.showWarningMessage(
      'No iOS Simulators found. Create one in Xcode > Settings > Platforms.'
    );
    return;
  }

  const items = sims.map((sim) => ({
    label: sim.name,
    description: sim.runtime,
    detail: `${sim.state} · ${sim.udid}`,
    sim
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select an iOS Simulator',
    matchOnDescription: true,
    matchOnDetail: true
  });
  if (!picked) return;

  const config = vscode.workspace.getConfiguration('tabbedEmulator');
  const baguetteServePort = config.get<number>('baguetteServePort', 8421);
  const streamMaxDim = config.get<number>('streamMaxDimension', 900);

  const tag = `${picked.sim.name} (${picked.sim.udid.slice(0, 8)})`;
  const server = BaguetteServer.instance_(baguettePath, baguetteServePort, (line) =>
    output.appendLine(`[serve] ${line}`)
  );

  const session = new IosSession({
    baguettePath,
    udid: picked.sim.udid,
    name: picked.sim.name
  });
  session.on('log', (line: string) => output.appendLine(`[${tag}] ${line}`));
  session.on('state', (state) =>
    output.appendLine(`[${tag}] state: ${JSON.stringify(state)}`)
  );

  const panel = EmulatorPanel.create(
    context,
    `Simulator: ${picked.sim.name}`,
    session,
    () => new BaguetteStreamer({ server, udid: picked.sim.udid }),
    streamMaxDim
  );
  activePanels.add(panel);

  try {
    session.start();
  } catch (err) {
    vscode.window.showErrorMessage(
      `Failed to start simulator: ${(err as Error).message}`
    );
    panel.dispose();
    activePanels.delete(panel);
  }
}

function stopAll(): void {
  for (const panel of activePanels) panel.dispose();
  activePanels.clear();
}
