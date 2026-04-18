interface RetryOptions {
  attempts: number;
  delayMs: number;
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < options.attempts; i += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i < options.attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
    }
  }

  throw lastError;
}
