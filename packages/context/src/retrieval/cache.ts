/**
 * Bounded least-recently-used cache (FR-612). Keys must include everything that
 * changes the cached value: owner, request and the stored-context revision.
 */
export class LruCache<V> {
  private readonly values = new Map<string, V>();

  constructor(private readonly capacity: number) {}

  get(key: string): V | undefined {
    const value = this.values.get(key);
    if (value === undefined) return undefined;
    // Re-inserting moves the key to the most recently used position.
    this.values.delete(key);
    this.values.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    this.values.delete(key);
    this.values.set(key, value);
    while (this.values.size > this.capacity) {
      const oldest = this.values.keys().next().value as string;
      this.values.delete(oldest);
    }
  }

  clear(): void {
    this.values.clear();
  }

  get size(): number {
    return this.values.size;
  }
}
