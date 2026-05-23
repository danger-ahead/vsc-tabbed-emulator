# Tabbed Emulator

A VS Code extension that runs Android emulators and iOS Simulators inside a VS Code tab — no separate window needed. Touch and keyboard input are forwarded directly to the device.

### Data flow — Android

1. **Boot** — `AndroidSession` spawns the emulator process headlessly (`-no-window`) with gRPC enabled on a configurable port (default `8554`). It polls `adb` every 1.5 s until `sys.boot_completed=1`.

2. **Streaming** — Once booted, `EmulatorClient` calls `streamScreenshot` on the emulator's gRPC server. The emulator pushes PNG-encoded frames continuously. Each frame is base64-encoded in the extension host and sent to the webview via `postMessage`.

3. **Rendering** — The webview sets the PNG as the `src` of an `<img>` element. No canvas — the browser handles decoding.

4. **Input** — Pointer events on the `<img>` are translated from CSS pixels to device coordinates and sent back to the extension host as `touch` messages. The extension host calls `sendTouch` on the gRPC client. Keyboard events (after the user taps once) are forwarded the same way via `sendKey`.

### Data flow — iOS

1. **Boot** — `IosSession` runs `baguette boot --udid <UDID>` then waits on `xcrun simctl bootstatus`. If the simulator is already booted, the existing one is reused.

2. **Shared server** — `BaguetteServer` is a ref-counted singleton that spawns one `baguette serve --port 8421` process for the whole extension. iOS tabs share it; it shuts down when the last tab closes.

3. **Streaming** — `BaguetteStreamer` opens a WebSocket to `ws://127.0.0.1:8421/simulators/<udid>/stream?format=mjpeg&version=v2`, sends `set_fps` / `set_scale`, and receives one JPEG per binary WebSocket frame. Frames go to the webview as `data:image/jpeg;base64,...`.

4. **Input** — The same WebSocket carries `{type:'touch1-down/move/up', x, y, width, height}` for pointers and `{type:'key', code, modifiers}` / `{type:'type', text}` for keyboard. `KeyboardEvent.code` (e.g. `KeyA`) is passed through unchanged.

## Prerequisites

- **Node.js** 18+
- **VS Code** 1.85+
- **For Android**: Android SDK with
  - `emulator` binary (`$ANDROID_HOME/emulator/emulator`)
  - `adb` binary (`$ANDROID_HOME/platform-tools/adb`)
  - At least one AVD created in Android Studio
- **For iOS** (macOS only):
  - **Apple Silicon** Mac (arm64) — baguette is not built for Intel
  - **Xcode 26.3+** with iOS Simulator runtime installed
  - **baguette v0.1.73** — tested/pinned version. Install via the [tddworks tap](https://github.com/tddworks/baguette):
    ```bash
    brew install tddworks/tap/baguette
    baguette --version   # expect 0.1.73
    ```
    The extension will surface a warning on startup if a different version is detected (pre-1.0 baguette ships breaking changes; the `stream` CLI was broken in some intermediate builds and the WS wire schema is not yet stable).
  - At least one iOS Simulator created in Xcode (Window → Devices and Simulators → Simulators)

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
Tabbed Emulator: Open iOS Simulator
```

Pick a device from the list — it boots headlessly and a new tab opens with the live screen. Note that iOS Simulator state (apps, signed-in accounts, etc.) persists between sessions, unlike Android's `-no-snapshot` boot.

### 4. View logs

Open the **Output** panel and select **Tabbed Emulator** from the dropdown to see emulator stdout/stderr and gRPC events.

---

## Extension Settings

| Setting                             | Default | Description                                                                                                         |
| ----------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------- |
| `tabbedEmulator.androidSdkPath`     | `""`    | Path to Android SDK root. Falls back to `$ANDROID_HOME` / `$ANDROID_SDK_ROOT` / `~/Library/Android/sdk`.            |
| `tabbedEmulator.grpcPort`           | `8554`  | gRPC port passed to the emulator. Increment if running multiple emulators.                                          |
| `tabbedEmulator.streamMaxDimension` | `900`   | Max pixel dimension per side for streamed frames. Lower values increase frame rate. `0` = native device resolution. |
| `tabbedEmulator.baguettePath`       | `""`    | Path to the `baguette` binary. Falls back to `$PATH` and `/opt/homebrew/bin/baguette`.                              |
| `tabbedEmulator.baguetteServePort`  | `8421`  | Base port for the shared `baguette serve` process. Increments by up to +10 if the port is busy.                     |

## Commands

| Command                                  | Description                               |
| ---------------------------------------- | ----------------------------------------- |
| `Tabbed Emulator: Open Android Emulator` | Pick an AVD and open it in a new tab      |
| `Tabbed Emulator: Open iOS Simulator`    | Pick a simulator and open it in a new tab |
| `Tabbed Emulator: Stop All Sessions`     | Kill all running emulator processes       |

## Packaging (VSIX)

To install permanently without the Extension Development Host:

```bash
npm install -g @vscode/vsce
vsce package
code --install-extension tabbed-emulator-0.0.1.vsix
```
