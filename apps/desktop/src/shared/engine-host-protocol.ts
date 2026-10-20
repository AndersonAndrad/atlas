import type {
  EngineEventMessage,
  EngineRequestMessage,
  EngineResponseMessage,
} from '@atlas/engine';
import type { SerializedError } from '@atlas/shared';

/** Messages from the Electron main process to the Engine host utility process. */
export type MainToHostMessage =
  | { type: 'start'; dataDir: string; appVersion: string }
  | EngineRequestMessage
  | { type: 'shutdown' };

/** Messages from the Engine host utility process to the Electron main process. */
export type HostToMainMessage =
  | { type: 'ready' }
  | { type: 'start-failed'; error: SerializedError }
  | EngineResponseMessage
  | EngineEventMessage
  | { type: 'stopped' };
