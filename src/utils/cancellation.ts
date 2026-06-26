/**
 * Lightweight cooperative cancellation for long-running operations (pull, push,
 * site creation, …). Operations don't need to thread a token through every
 * service signature — they already call `onProgress` at each checkpoint, so we
 * make the wrapped progress callback throw {@link OperationCancelledError} once
 * cancellation is requested. The next checkpoint then unwinds the await chain.
 *
 * For phases that stream progress frequently (download/extract/upload), this
 * gives near-immediate cancellation; an optional {@link OperationToken.signal}
 * is also exposed so in-flight fetch/child processes can be aborted directly.
 */

export class OperationCancelledError extends Error {
  readonly cancelled = true;
  constructor(message = 'Операция отменена пользователем.') {
    super(message);
    this.name = 'OperationCancelledError';
  }
}

/** True for our own cancellation error or an AbortError caused by it. */
export function isCancelledError(err: unknown): boolean {
  if (err instanceof OperationCancelledError) return true;
  const name = (err as { name?: string } | null | undefined)?.name;
  const cancelled = (err as { cancelled?: boolean } | null | undefined)?.cancelled;
  return cancelled === true || name === 'OperationCancelledError';
}

export interface OperationToken {
  readonly id: string;
  readonly isCancelled: boolean;
  /** Aborts when the operation is cancelled — wire into fetch/child processes. */
  readonly signal: AbortSignal;
  /** Throws {@link OperationCancelledError} if cancellation was requested. */
  throwIfCancelled(): void;
}

/**
 * Registry of in-flight cancellable operations, owned by the panel. The webview
 * cancel button posts `cancelOperation` with the operation id; the panel calls
 * {@link cancel}. Each handler wraps its work in {@link begin} … `dispose()`.
 */
export class OperationRegistry {
  private readonly ops = new Map<string, AbortController>();

  begin(): { token: OperationToken; dispose: () => void } {
    const id = `op-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const controller = new AbortController();
    this.ops.set(id, controller);
    const token: OperationToken = {
      id,
      get isCancelled() {
        return controller.signal.aborted;
      },
      get signal() {
        return controller.signal;
      },
      throwIfCancelled() {
        if (controller.signal.aborted) throw new OperationCancelledError();
      },
    };
    return { token, dispose: () => this.ops.delete(id) };
  }

  /** Cancel a specific operation by id, or all in-flight operations when omitted. */
  cancel(id?: string): void {
    if (id) {
      this.ops.get(id)?.abort();
      return;
    }
    for (const controller of this.ops.values()) controller.abort();
  }
}
