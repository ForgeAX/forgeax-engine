import { readPackWithoutNativeAny } from './pack-reader-abort.js';

Object.defineProperty(AbortSignal, 'any', { configurable: true, value: undefined });
self.onmessage = () => {
  void readPackWithoutNativeAny().then(
    (result) => self.postMessage({ result }),
    (error: unknown) => self.postMessage({ error: String(error) }),
  );
};
