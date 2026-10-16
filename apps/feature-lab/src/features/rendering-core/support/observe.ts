import type { App } from '@forgeax/engine/app';
import type { FrameReceiptObservation, Renderer } from '@forgeax/engine/render';
import { nextReceipt } from './receipt';

type FrameObservationDomain = Parameters<NonNullable<Renderer['requestObservation']>>[0][number];

export type ObserveOutcome =
  | { readonly ok: true; readonly receiptFrame: number; readonly value: FrameReceiptObservation }
  | { readonly ok: false; readonly error: string };

export async function observeNextFrame(
  app: App,
  domains: readonly FrameObservationDomain[],
): Promise<ObserveOutcome> {
  const armed = app.renderer.requestObservation?.(domains);
  if (armed === undefined) return { ok: false, error: 'requestObservation unavailable' };
  if (!armed.ok) return { ok: false, error: armed.error.code };
  const receipt = await nextReceipt(app);
  const completed = await receipt.completed;
  if (!completed.ok) return { ok: false, error: completed.error.code };
  const observed = await app.renderer.observe(receipt, { include: domains });
  if (!observed.ok) return { ok: false, error: observed.error.code };
  return { ok: true, receiptFrame: receipt.frameId, value: observed.value };
}
