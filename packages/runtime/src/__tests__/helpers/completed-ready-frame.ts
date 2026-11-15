import type { FrameReceipt } from '@forgeax/engine-render';

/** Preparation receipts do not count as pictures; redraw the same static source. */
export async function completedReadyFrame(
  draw: () => FrameReceipt,
  deadline: number,
): Promise<FrameReceipt> {
  const withinDeadline = async <T>(completion: Promise<T>): Promise<T> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Completed ready frame deadline expired');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        completion,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Completed ready frame deadline expired')),
            remaining,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  let previous: FrameReceipt | undefined;
  for (;;) {
    if (Date.now() >= deadline) throw new Error('Completed ready frame deadline expired');
    const receipt = draw();
    if (previous !== undefined && receipt.frameId === previous.frameId)
      throw new Error('Preparation retry did not submit a new frame receipt');
    const completed = await withinDeadline(receipt.completed);
    if (!completed.ok) throw completed.error;
    if (receipt.presentation === 'ready') return receipt;
    if (receipt.preparationCompleted === undefined)
      throw new Error(`Pending receipt ${receipt.frameId} omitted its preparation completion`);
    const prepared = await withinDeadline(receipt.preparationCompleted);
    if (!prepared.ok) throw prepared.error;
    previous = receipt;
  }
}
