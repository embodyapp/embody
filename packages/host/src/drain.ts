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
