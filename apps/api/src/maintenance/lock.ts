/**
 * Promise mutex shared by everything that runs `kyro install` / `kyro update`: both rewrite the
 * global runtime and skills, so two of them must never overlap.
 */
export class KyroLock {
  private tail: Promise<void> = Promise.resolve();

  /** Runs `fn` after every earlier holder finished (ok or not); its result or error is returned. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
