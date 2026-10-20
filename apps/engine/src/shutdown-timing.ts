import { DEFAULT_TERMINAL_TIMING } from '@atlas/terminal';
import { preCommitStopTimeoutMs } from './adapters/shell-pre-commit-runner.js';

/**
 * How long Engine shutdown waits for Git operations: longer than a cancelled
 * pre-commit step can take to be stopped (SIGTERM, the kill grace period, SIGKILL),
 * so steps are force-killed before the Engine stops waiting; commits and pushes
 * that cannot be interrupted get the same bounded time.
 */
export const GIT_SHUTDOWN_TIMEOUT_MS = preCommitStopTimeoutMs() + 1_000;

/**
 * Time terminal processes need to stop with the default timing: SIGHUP, then
 * SIGKILL after the kill timeout, plus a margin for the exit to be reported.
 */
export const TERMINAL_SHUTDOWN_TIMEOUT_MS = DEFAULT_TERMINAL_TIMING.killTimeoutMs + 1_000;

/**
 * Longest time a graceful Engine shutdown is expected to take: Git operations
 * are awaited first, then terminals are stopped. Hosts that kill the Engine when
 * it does not stop must wait clearly longer than this.
 */
export const ENGINE_SHUTDOWN_TIMEOUT_MS = GIT_SHUTDOWN_TIMEOUT_MS + TERMINAL_SHUTDOWN_TIMEOUT_MS;
