import { EventEmitter } from 'events';

export type SessionState =
  | { kind: 'starting' }
  | { kind: 'running'; serial: string }
  | { kind: 'stopped'; reason?: string }
  | { kind: 'error'; message: string };

export interface IEmulatorSession extends EventEmitter {
  readonly state: SessionState;
  start(): void;
  stop(): Promise<void>;
}

export type FrameFormat = 'PNG' | 'JPEG' | 'RGB888' | 'RGBA8888';

export interface FrameInfo {
  bytes: Buffer;
  format: FrameFormat;
  width: number;
  height: number;
  display: number;
  seq: number;
}

export type KeyEventType = 'keydown' | 'keyup' | 'keypress';

export interface KeyEvent {
  eventType: KeyEventType;
  /** Browser's `KeyboardEvent.key` (e.g. "a", "Enter"). Used by the Android backend. */
  key?: string;
  /** Browser's `KeyboardEvent.code` (e.g. "KeyA", "Enter"). Used by the iOS/baguette backend. */
  code?: string;
  /** Active modifiers — subset of `shift` / `control` / `option` / `command`. */
  modifiers?: string[];
  /** Composed text (paste / IME). When set, backends should prefer it over a synthetic keypress. */
  text?: string;
}

export interface IEmulatorStreamer extends EventEmitter {
  start(maxDim?: number): void;
  getDeviceSize(): Promise<{ width: number; height: number } | undefined>;
  sendTouch(x: number, y: number, identifier: number, pressure: number): void;
  sendKey(event: KeyEvent): void;
  stop(): void;
}
