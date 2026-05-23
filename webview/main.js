const vscode = acquireVsCodeApi();
const stage = document.getElementById('stage');
const screenEl = /** @type {HTMLImageElement} */ (document.getElementById('screen'));
screenEl.addEventListener('error', () => {
  // The img element fires `error` whenever its `src` resolves to something
  // unloadable, including when no src is set (browsers resolve "" to the
  // document URL). Ignore those — only log if we actually set a data URL.
  if (screenEl.src.startsWith('data:')) {
    appendLog(`<img> load error for ${screenEl.src.slice(0, 40)}…`);
  }
});
const statusText = document.getElementById('status-text');
const logEl = document.getElementById('log');

const MAX_LOG_LINES = 200;
const logLines = [];

function appendLog(line) {
  logLines.push(line);
  while (logLines.length > MAX_LOG_LINES) logLines.shift();
  logEl.textContent = logLines.join('\n');
  logEl.scrollTop = logEl.scrollHeight;
}

let framesReceived = 0;
let lastFpsTick = performance.now();
let framesSinceTick = 0;
let frameWidth = 0;
let frameHeight = 0;
let deviceWidth = 0;
let deviceHeight = 0;

/** @param {string} base64 @param {string} format @param {number} size @param {number} width @param {number} height */
function showFrame(base64, format, size, width, height) {
  const mime = format === 'JPEG' ? 'image/jpeg' : format === 'PNG' ? 'image/png' : null;
  if (!mime) {
    appendLog(`unsupported frame format: ${format}`);
    return;
  }
  if (width > 0 && height > 0) {
    frameWidth = width;
    frameHeight = height;
  }
  if (framesReceived < 3) {
    appendLog(`frame #${framesReceived + 1} size=${size} ${width}x${height}`);
  }
  screenEl.src = `data:${mime};base64,${base64}`;

  framesReceived += 1;
  framesSinceTick += 1;
  const now = performance.now();
  if (now - lastFpsTick >= 1000) {
    const fps = (framesSinceTick * 1000) / (now - lastFpsTick);
    statusText.textContent = `Streaming · ${fps.toFixed(1)} fps`;
    stage.classList.add('has-stream');
    lastFpsTick = now;
    framesSinceTick = 0;
  } else if (framesReceived === 1) {
    stage.classList.add('has-stream');
    statusText.textContent = 'Streaming';
  }
}

window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'state':
      handleState(msg.state);
      break;
    case 'log':
      appendLog(msg.line);
      break;
    case 'frame':
      showFrame(msg.base64, msg.format, msg.size, msg.width, msg.height);
      break;
    case 'device':
      deviceWidth = msg.width;
      deviceHeight = msg.height;
      appendLog(`device size ${deviceWidth}x${deviceHeight}`);
      break;
  }
});

function handleState(state) {
  switch (state.kind) {
    case 'starting':
      statusText.textContent = 'Starting emulator…';
      break;
    case 'running':
      statusText.textContent = `Booted (${state.serial}). Waiting for frames…`;
      break;
    case 'stopped':
      statusText.textContent = `Stopped${state.reason ? `: ${state.reason}` : ''}`;
      stage.classList.remove('has-stream');
      screenEl.removeAttribute('src');
      break;
    case 'error':
      statusText.textContent = `Error: ${state.message}`;
      stage.classList.remove('has-stream');
      screenEl.removeAttribute('src');
      break;
  }
}

// ---- Input ----

const activePointers = new Map();

function clientToDeviceCoords(clientX, clientY) {
  const w = deviceWidth || frameWidth;
  const h = deviceHeight || frameHeight;
  if (w === 0 || h === 0) return null;
  const rect = screenEl.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const fx = (clientX - rect.left) / rect.width;
  const fy = (clientY - rect.top) / rect.height;
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
  return {
    x: Math.round(fx * w),
    y: Math.round(fy * h)
  };
}

function sendTouch(x, y, id, pressure) {
  vscode.postMessage({ type: 'touch', x, y, id, pressure });
}

screenEl.addEventListener('pointerdown', (e) => {
  const c = clientToDeviceCoords(e.clientX, e.clientY);
  if (!c) return;
  e.preventDefault();
  // Pull keyboard focus back into the webview so subsequent keystrokes route here
  // instead of the previously-focused VS Code editor.
  window.focus();
  screenEl.focus({ preventScroll: true });
  screenEl.setPointerCapture(e.pointerId);
  activePointers.set(e.pointerId, c);
  sendTouch(c.x, c.y, e.pointerId, 1);
});

screenEl.addEventListener('pointermove', (e) => {
  if (!activePointers.has(e.pointerId)) return;
  const c = clientToDeviceCoords(e.clientX, e.clientY);
  if (!c) return;
  activePointers.set(e.pointerId, c);
  sendTouch(c.x, c.y, e.pointerId, 1);
});

function releasePointer(e) {
  const last = activePointers.get(e.pointerId);
  if (!last) return;
  activePointers.delete(e.pointerId);
  if (screenEl.hasPointerCapture(e.pointerId)) {
    screenEl.releasePointerCapture(e.pointerId);
  }
  sendTouch(last.x, last.y, e.pointerId, 0);
}

screenEl.addEventListener('pointerup', releasePointer);
screenEl.addEventListener('pointercancel', releasePointer);
screenEl.addEventListener('pointerleave', releasePointer);

// Suppress default drag behavior on the img element.
screenEl.addEventListener('dragstart', (e) => e.preventDefault());

// ---- Keyboard ----
// Forward keystrokes once the user has tapped the screen at least once
// (acts as an implicit focus on the embedded device).
let keyboardArmed = false;
screenEl.addEventListener('pointerdown', () => { keyboardArmed = true; });

function forwardKey(eventType, e) {
  if (!keyboardArmed) return;
  // Don't fight VS Code shortcuts — let modifier combos through.
  if (e.ctrlKey || e.metaKey) return;
  const modifiers = [];
  if (e.shiftKey) modifiers.push('shift');
  if (e.altKey)   modifiers.push('option');
  vscode.postMessage({
    type: 'key',
    eventType,
    key: e.key,
    code: e.code,
    modifiers
  });
  e.preventDefault();
}

window.addEventListener('keydown', (e) => forwardKey('keydown', e));
window.addEventListener('keyup', (e) => forwardKey('keyup', e));

vscode.postMessage({ type: 'ready' });
