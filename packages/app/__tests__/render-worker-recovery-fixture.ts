/** Terminate the actual renderer realm and deliver its fatal transport signal. */
export function rendererCrashProbe(): () => void {
  const NativeWorker = globalThis.Worker;
  let renderer: Worker | undefined;
  globalThis.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      if (options?.name === 'forgeax-render') renderer = this;
    }
  };
  return () => {
    if (renderer === undefined) throw new Error('No child Renderer to terminate');
    renderer.terminate();
    renderer.dispatchEvent(
      new ErrorEvent('error', { message: 'Test terminated the Renderer realm' }),
    );
  };
}
