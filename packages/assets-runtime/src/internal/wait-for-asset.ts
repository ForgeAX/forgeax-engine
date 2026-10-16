import { type AssetLoadError, err, type Result } from '@forgeax/engine-types';

/** Cancel one wait without cancelling the owner's shared operation. */
export function waitForAsset<T>(
  request: Promise<Result<T, AssetLoadError>>,
  signal: AbortSignal,
  guid: string,
): Promise<Result<T, AssetLoadError>> {
  if (signal.aborted) return Promise.resolve(err(assetLoadCancelled(guid)));
  return new Promise((resolve, reject) => {
    const abort = () => resolve(err(assetLoadCancelled(guid)));
    signal.addEventListener('abort', abort, { once: true });
    request.then(
      (result) => {
        signal.removeEventListener('abort', abort);
        resolve(result);
      },
      (cause: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(cause);
      },
    );
  });
}

export function assetLoadCancelled(guid: string): AssetLoadError {
  return {
    code: 'asset-load-cancelled',
    expected: 'the request AbortSignal to remain live until the load completes',
    hint: 'retry with a live AbortSignal when the request is still needed',
    detail: { guid },
  };
}
