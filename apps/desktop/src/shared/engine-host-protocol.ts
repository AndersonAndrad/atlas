import type {
  EngineEventMessage,
  EngineRequestMessage,
  EngineResponseMessage,
} from '@atlas/engine';
import type { SerializedError } from '@atlas/shared';

/** Messages from the Electron main process to the Engine host utility process. */
/** A hosting token decrypted by the main process; null removes it (SDD-024 Task 04). */
export interface HostingCredentialMessage {
  type: 'hosting-credential';
  accountId: string;
  token: string | null;
}

export type MainToHostMessage =
  | { type: 'start'; dataDir: string; appVersion: string }
  | HostingCredentialMessage
  | EngineRequestMessage
  | { type: 'shutdown' };

/** Messages from the Engine host utility process to the Electron main process. */
export type HostToMainMessage =
  | { type: 'ready' }
  | { type: 'start-failed'; error: SerializedError }
  | EngineResponseMessage
  | EngineEventMessage
  | { type: 'stopped' };
