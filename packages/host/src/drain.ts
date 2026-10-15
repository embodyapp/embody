// Stop deadlines must not keep completed, fully drained runtimes alive.
export async function drain(active: Iterable<Promise<unknown>>, deadlineMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled([...active]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, deadlineMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Waits for every task, then rethrows the first failure. A batch never answers while one of its
 * items is still running, which on a request-billed host would continue throttled after the reply.
 */
export async function settleAll(tasks: readonly Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(tasks);
  const failure = results.find((result) => result.status === "rejected");
  if (failure !== undefined) throw failure.reason;
}
