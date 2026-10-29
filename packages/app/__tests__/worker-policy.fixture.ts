import { createApp } from '@forgeax/engine-app/browser';

export async function workerPolicyFixture(data?: string) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  document.body.append(canvas);
  const channel = new MessageChannel();
  const values: number[] = [];
  const sealedValues: number[] = [];
  channel.port1.onmessage = (event) => {
    if (event.data.kind === 'kernel-feedback') values.push(event.data.value);
    if (event.data.kind === 'kernel-sealed') sealedValues.push(event.data.value);
  };
  const result = await createApp(
    canvas,
    {
      silenceUnhandledErrors: true,
      execution: {
        bootstrap: new URL('./worker-policy-bootstrap.ts', import.meta.url),
        ...(data === undefined ? {} : { bootstrapData: data }),
        bootstrapPort: channel.port2,
        startupTimeoutMs: 90_000,
      },
    },
    { shaderManifestUrl: new URL('/shaders/manifest.json', location.href).href },
  );
  return {
    result,
    canvas,
    channel,
    values,
    sealedValues,
    async dispose() {
      try {
        if (result.ok) (await result.value.dispose()).unwrap();
      } finally {
        if (result.ok) result.value.canvas?.remove();
        channel.port1.close();
        canvas.remove();
      }
    },
  };
}
