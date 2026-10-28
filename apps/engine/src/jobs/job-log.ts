import type { JobOutputPage } from '@atlas/contracts';
import type { JobRecord } from '@atlas/jobs';
import type { LogBuffer, PreflightLogStore } from '@atlas/preflight';

/**
 * One page of a job attempt's output: from its live buffer while it runs, then from the
 * log file saved when it finished. Shared by the executors that keep their own log.
 */
export async function readJobOutput(
  input: {
    job: JobRecord;
    attempt: number;
    after: number;
    limit: number;
  },
  buffer: LogBuffer | undefined,
  logs: PreflightLogStore,
): Promise<JobOutputPage> {
  const { job, attempt, after, limit } = input;
  if (buffer !== undefined) {
    const lines = buffer.read(after, limit);
    const next = lines.at(-1)?.seq ?? Math.max(after, buffer.firstSeq - 1);
    return {
      lines,
      next,
      complete: buffer.complete && next >= buffer.count - 1,
      truncatedBefore: after + 1 < buffer.firstSeq,
    };
  }
  const log = await logs.read(job.id, attempt);
  if (log === null) {
    // The current attempt may not have started its process yet: more output may come.
    const starting = job.status === 'RUNNING' && attempt === job.retryCount + 1;
    return { lines: [], next: after, complete: !starting, truncatedBefore: false };
  }
  const start = Math.max(0, after + 1 - log.firstSeq);
  const lines = log.lines.slice(start, start + limit);
  return {
    lines,
    next: lines.at(-1)?.seq ?? Math.max(after, log.firstSeq - 1),
    complete: start + lines.length >= log.lines.length,
    truncatedBefore: after + 1 < log.firstSeq,
  };
}
