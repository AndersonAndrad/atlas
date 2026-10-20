/** A save waiting in or running from a {@link SaveQueue}. */
export interface QueuedSave<T> {
  /** Order of the save; compare with {@link SaveQueue.isLatest}. */
  ticket: number;
  /** Settles with the outcome of this save once every earlier save finished. */
  result: Promise<T>;
}

export interface SaveQueue {
  /** Runs `task` after every earlier task settled, whatever their outcome. */
  enqueue<T>(task: () => Promise<T>): QueuedSave<T>;
  /** True while no save was requested after the one with `ticket`. */
  isLatest(ticket: number): boolean;
}

/**
 * Saves that run one at a time, in the order they were requested. Only the latest save may
 * replace what is shown, so an older save that settles late never overwrites a newer choice.
 */
export function createSaveQueue(): SaveQueue {
  let tail: Promise<unknown> = Promise.resolve();
  let latest = 0;
  return {
    enqueue<T>(task: () => Promise<T>): QueuedSave<T> {
      const ticket = (latest += 1);
      const result = tail.then(task);
      tail = result.catch(() => undefined);
      return { ticket, result };
    },
    isLatest: (ticket) => ticket === latest,
  };
}
