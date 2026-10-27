// A controlled Debug Adapter Protocol adapter for tests (SDD-016 Task 01). It speaks DAP on
// standard input/output and misbehaves on purpose depending on its mode argument:
//
//   normal               answers everything, sends `initialized` after `initialize`
//   stop-on-entry        sends `stopped` (reason entry) after configurationDone
//   launch-after-config  answers `launch` only after `configurationDone` (like debugpy)
//   refuse-launch        answers `launch` with success: false
//   crash-on-launch      exits with code 3 when `launch` arrives (after writing to stderr)
//   hang-initialize      never answers `initialize`
//   garbage              writes an invalid header after `initialize`
//   split                writes every message one byte at a time, two messages per write
//   ignore-disconnect    answers `disconnect` but keeps running
//   spawn-child          starts a sleeping child and records its pid in the file named by
//                        the third argument
//   reverse-request      sends a `runInTerminal` request and reports the answer in an event
//   terminate-soon       sends `terminated` shortly after running
//   same-chunk           writes the `initialize` response and `initialized` in one write
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const mode = process.argv[2] ?? 'normal';
const pidFile = process.argv[3];
let seq = 1;
let buffer = Buffer.alloc(0);
let pendingLaunch = null;
let child = null;

function frame(message) {
  const body = Buffer.from(JSON.stringify({ ...message, seq: seq++ }), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}

let queued = [];
function send(message) {
  const bytes = frame(message);
  if (mode !== 'split') {
    process.stdout.write(bytes);
    return;
  }
  queued.push(bytes);
  if (queued.length < 2) return;
  const all = Buffer.concat(queued);
  queued = [];
  for (const byte of all) process.stdout.write(Buffer.from([byte]));
}

function flush() {
  if (queued.length === 0) return;
  for (const byte of Buffer.concat(queued)) process.stdout.write(Buffer.from([byte]));
  queued = [];
}

const respond = (request, body = {}, success = true, message = undefined) =>
  send({
    type: 'response',
    request_seq: request.seq,
    command: request.command,
    success,
    ...(message ? { message } : {}),
    body,
  });
const event = (name, body = {}) => send({ type: 'event', event: name, body });

function handle(message) {
  if (message.type === 'response') {
    event('reverseAnswer', { success: message.success, command: message.command });
    flush();
    return;
  }
  const request = message;
  switch (request.command) {
    case 'initialize':
      if (mode === 'hang-initialize') return;
      if (mode === 'same-chunk') {
        process.stdout.write(
          Buffer.concat([
            frame({
              type: 'response',
              request_seq: request.seq,
              command: request.command,
              success: true,
              body: { supportsConfigurationDoneRequest: true },
            }),
            frame({ type: 'event', event: 'initialized', body: {} }),
          ]),
        );
        break;
      }
      respond(request, { supportsConfigurationDoneRequest: true, supportsTerminateRequest: true });
      if (mode === 'garbage') {
        process.stdout.write('Content-Length: nope\r\n\r\n{}');
        return;
      }
      event('initialized');
      break;
    case 'launch':
    case 'attach':
      if (mode === 'crash-on-launch') {
        process.stderr.write('adapter: cannot find the runtime\n');
        process.exit(3);
      }
      if (mode === 'refuse-launch') {
        respond(request, {}, false, 'Program not found: missing.js');
        break;
      }
      if (mode === 'spawn-child') {
        child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        writeFileSync(pidFile, String(child.pid));
      }
      event('output', { category: 'console', output: `launching ${request.arguments.program}\n` });
      event('process', { name: request.arguments.program, startMethod: request.command });
      if (mode === 'launch-after-config') pendingLaunch = request;
      else respond(request);
      break;
    case 'configurationDone':
      respond(request);
      if (pendingLaunch !== null) {
        respond(pendingLaunch);
        pendingLaunch = null;
      }
      if (mode === 'stop-on-entry') event('stopped', { reason: 'entry', threadId: 1 });
      if (mode === 'reverse-request') {
        send({
          type: 'request',
          command: 'runInTerminal',
          arguments: { args: ['rm', '-rf', '/'] },
        });
      }
      if (mode === 'terminate-soon') setTimeout(() => event('terminated'), 50);
      break;
    case 'continue':
      respond(request, { allThreadsContinued: true });
      event('continued', { threadId: 1, allThreadsContinued: true });
      break;
    case 'echo':
      // Answers later requests first, to test correlation.
      setTimeout(
        () => respond(request, { value: request.arguments.value }),
        request.arguments.delay,
      );
      break;
    case 'disconnect':
      respond(request);
      flush();
      if (mode !== 'ignore-disconnect') {
        child?.kill();
        setTimeout(() => process.exit(0), 10);
      }
      break;
    default:
      respond(request, {}, false, `Unknown command ${request.command}`);
  }
  flush();
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) return;
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + length) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString('utf8'));
    buffer = buffer.subarray(end + 4 + length);
    handle(message);
  }
});
// ignore-disconnect also ignores SIGTERM, so stopping must escalate to SIGKILL.
if (mode === 'ignore-disconnect') process.on('SIGTERM', () => undefined);
setInterval(() => {}, 1000);
