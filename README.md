# Tabbed Emulator

A VS Code extension that runs Android emulators inside a VS Code tab — no separate emulator window needed. Touch and keyboard input are forwarded directly to the device.

### Data flow

1. **Boot** — `AndroidSession` spawns the emulator process headlessly (`-no-window`) with gRPC enabled on a configurable port (default `8554`). It polls `adb` every 1.5 s until `sys.boot_completed=1`.

2. **Streaming** — Once booted, `EmulatorClient` calls `streamScreenshot` on the emulator's gRPC server. The emulator pushes PNG-encoded frames continuously. Each frame is base64-encoded in the extension host and sent to the webview via `postMessage`.

3. **Rendering** — The webview sets the PNG as the `src` of an `<img>` element. No canvas — the browser handles decoding.

4. **Input** — Pointer events on the `<img>` are translated from CSS pixels to device coordinates and sent back to the extension host as `touch` messages. The extension host calls `sendTouch` on the gRPC client. Keyboard events (after the user taps once) are forwarded the same way via `sendKey`.

## Prerequisites

- **Node.js** 18+
- **VS Code** 1.85+
- **Android SDK** with:
  - `emulator` binary (`$ANDROID_HOME/emulator/emulator`)
  - `adb` binary (`$ANDROID_HOME/platform-tools/adb`)
  - At least one AVD created in Android Studio

## Local Development

### 1. Install dependencies

```bash
npm install
```

### 2. Build

```bash
npm run build
```

Or watch for changes:

```bash
npm run watch
```

The build uses [esbuild](esbuild.js) and outputs a single bundle to `out/extension.js`. The proto files are copied to `out/proto/` as part of the build.

### 3. Run in the Extension Development Host

Press **F5** in VS Code (or use **Run > Start Debugging**).

This launches a second VS Code window with the extension loaded. Open the Command Palette (`Cmd+Shift+P`) and run:

```
Tabbed Emulator: Open Android Emulator
```

Select an AVD from the list — the emulator starts headlessly and a new tab opens with the live screen.

### 4. View logs

Open the **Output** panel and select **Tabbed Emulator** from the dropdown to see emulator stdout/stderr and gRPC events.

---

## Extension Settings

| Setting                             | Default | Description                                                                                                         |
| ----------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------- |
| `tabbedEmulator.androidSdkPath`     | `""`    | Path to Android SDK root. Falls back to `$ANDROID_HOME` / `$ANDROID_SDK_ROOT` / `~/Library/Android/sdk`.            |
| `tabbedEmulator.grpcPort`           | `8554`  | gRPC port passed to the emulator. Increment if running multiple emulators.                                          |
| `tabbedEmulator.streamMaxDimension` | `900`   | Max pixel dimension per side for streamed frames. Lower values increase frame rate. `0` = native device resolution. |

## Commands

| Command                                  | Description                          |
| ---------------------------------------- | ------------------------------------ |
| `Tabbed Emulator: Open Android Emulator` | Pick an AVD and open it in a new tab |
| `Tabbed Emulator: Stop All Sessions`     | Kill all running emulator processes  |

## Packaging (VSIX)

To install permanently without the Extension Development Host:

```bash
npm install -g @vscode/vsce
vsce package
code --install-extension tabbed-emulator-0.0.1.vsix
```
