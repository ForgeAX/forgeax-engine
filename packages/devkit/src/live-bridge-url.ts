// Page URL side of the live App bridge owner contract; the page half lives in
// packages/app/src/internal/browser-remote-bridge.ts.

/** Query parameter carrying the live owner's bridge token to the page it launched. */
export const LIVE_BRIDGE_OWNER_PARAM = 'forgeaxBridge';

export const GPU_PASS_TIMING_PARAM = 'forgeax-gpu-pass-timing';

export function ownerPageUrl(url: string, token: string, gpuPassTiming: boolean): string {
  const owner = new URL(url);
  owner.searchParams.set(LIVE_BRIDGE_OWNER_PARAM, token);
  if (gpuPassTiming) owner.searchParams.set(GPU_PASS_TIMING_PARAM, '1');
  return owner.href;
}

/** The URL other pages and reports may carry: same game, never the bridge token. */
export function publicPageUrl(url: string): string {
  const value = new URL(url);
  value.searchParams.delete(LIVE_BRIDGE_OWNER_PARAM);
  return value.href;
}
