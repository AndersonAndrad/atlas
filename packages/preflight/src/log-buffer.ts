import type { PreflightOutputLine } from '@atlas/contracts';

/** Lines kept per check; older lines are dropped (the log says so). */
export const MAX_LOG_LINES = 20_000;
/** Longer lines are cut: minified bundles and progress bars are not worth keeping whole. */
export const MAX_LINE_CHARS = 4000;
/** Characters kept per check, whatever the line count (about 4 MB of text). */
export const MAX_LOG_CHARS = 4 * 1024 * 1024;
const DROP_BATCH = 1000;

const PRIVATE_KEY_START = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----/;
const PRIVATE_KEY_END = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/;

/**
 * The output of one running check, split into redacted lines with sequence numbers.
 * Redaction is per line, so a private key spanning several lines is dropped from its
 * first line to its last. Partial lines wait for their end (or for `finish`).
 */
export class LogBuffer {
  private readonly lines: PreflightOutputLine[] = [];
  private readonly partial = { out: '', err: '' };
  private nextSeq = 0;
  private chars = 0;
  private inPrivateKey = false;
  private finished = false;

  constructor(private readonly redact: (text: string) => string) {}

  get firstSeq(): number {
    return this.lines[0]?.seq ?? this.nextSeq;
  }

  get count(): number {
    return this.nextSeq;
  }

  get truncated(): boolean {
    return this.firstSeq > 0;
  }

  get complete(): boolean {
    return this.finished;
  }

  append(stream: 'out' | 'err', chunk: string): void {
    if (this.finished) return;
    const text = this.partial[stream] + chunk;
    const parts = text.split(/\r\n|\n|\r/);
    this.partial[stream] = parts.pop() ?? '';
    // A line without an end is kept whole only up to the limit.
    if (this.partial[stream].length > MAX_LINE_CHARS) {
      this.push(stream, this.partial[stream]);
      this.partial[stream] = '';
    }
    for (const line of parts) this.push(stream, line);
  }

  /** A message from ATLAS itself, e.g. why a check was blocked. */
  note(text: string): void {
    this.push('atlas', text);
  }

  finish(): void {
    for (const stream of ['out', 'err'] as const) {
      if (this.partial[stream] !== '') this.push(stream, this.partial[stream]);
      this.partial[stream] = '';
    }
    this.finished = true;
  }

  /** Lines after `after`, at most `limit`. */
  read(after: number, limit: number): PreflightOutputLine[] {
    const start = Math.max(0, after + 1 - this.firstSeq);
    return this.lines.slice(start, start + limit);
  }

  snapshot(): { firstSeq: number; lines: PreflightOutputLine[] } {
    return { firstSeq: this.firstSeq, lines: [...this.lines] };
  }

  private push(stream: PreflightOutputLine['stream'], raw: string): void {
    let text = raw.length > MAX_LINE_CHARS ? `${raw.slice(0, MAX_LINE_CHARS)}…` : raw;
    if (this.inPrivateKey) {
      if (PRIVATE_KEY_END.test(text)) this.inPrivateKey = false;
      return;
    }
    if (PRIVATE_KEY_START.test(text)) {
      this.inPrivateKey = !PRIVATE_KEY_END.test(text);
      text = '[REDACTED PRIVATE KEY]';
    } else {
      text = this.redact(text);
    }
    this.lines.push({ seq: this.nextSeq, stream, text });
    this.nextSeq += 1;
    this.chars += text.length;
    // Dropped in batches so a chatty check does not shift the array on every line.
    if (this.lines.length >= MAX_LOG_LINES + DROP_BATCH || this.chars > MAX_LOG_CHARS) {
      let drop = Math.max(0, this.lines.length - MAX_LOG_LINES);
      let kept = this.chars;
      for (const line of this.lines.slice(0, drop)) kept -= line.text.length;
      // Down to 90 % of the limit, so the next lines do not trigger this again at once.
      while (kept > MAX_LOG_CHARS * 0.9 && drop < this.lines.length - 1) {
        kept -= this.lines[drop]!.text.length;
        drop += 1;
      }
      this.lines.splice(0, drop);
      this.chars = kept;
    }
  }
}
