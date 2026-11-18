import { page } from 'vitest/browser';
import { createApp } from '@forgeax/engine-app/browser';
import { createHostAudioConsumer } from '@forgeax/engine-audio-webaudio';
import { expect, it } from 'vitest';

it.each([
  { engine: false, render: false, kernels: false },
  { engine: true, render: false, kernels: false },
  { engine: true, render: true, kernels: false },
])('adopts quality in the actual renderer and restores its source at $engine/$render', async (workers) => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  canvas.style.width = canvas.style.height = '128px';
  document.body.append(canvas);
  const channel = new MessageChannel();
  const audioBudget = { maxCachedBytes: 4096, maxCachedSources: 2, maxPendingPlays: 3 };
  const audioOptions: unknown[] = [];
  const result = await createApp(canvas, {
    configuration: {
      deviceProfile: 'ConfigurationDevice',
      deviceProfiles: [{ id: 'ConfigurationDevice', extends: 'Default', settings: { audio: { host: audioBudget } } }],
    },
    execution: {
      workers,
      bootstrap: new URL('./configuration-bootstrap.ts', import.meta.url),
      ...(workers.render ? { bootstrapData: 'recover', bootstrapPort: channel.port2 } : {}),
      startupTimeoutMs: 90_000,
      frameTimeoutMs: 30_000,
    },
  }, {
    shaderManifestUrl: new URL('/shaders/manifest.json', location.href).href,
    configurationHost: { readDeviceFacts: () => ({ platform: 'unknown', runtime: 'browser' }) },
    createHostAudio(options) {
      audioOptions.push(options);
      return createHostAudioConsumer(undefined, options);
    },
  });
  if (!result.ok) throw result.error;
  const app = result.value;
  const configuration = app.configuration;
  if (configuration === undefined) throw new Error('Configuration control is absent');
  expect(audioOptions).toEqual([audioBudget]);
  let completions = 0;
  const completed = (event: Event) => {
    const frame = (event as CustomEvent<{ presentation: string }>).detail;
    if (event.target === (app.canvas ?? canvas) && frame.presentation === 'ready') completions++;
  };
  document.addEventListener('forgeax:frame-completed', completed, true);
  const picture = async () => {
    const shot = await page.elementLocator(app.canvas ?? canvas).screenshot({ base64: true });
    const bytes = Uint8Array.from(atob(typeof shot === 'string' ? shot : shot.base64), (character) => character.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const decoded = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = decoded.getContext('2d');
    if (context === null) throw new Error('Pixel decoding unavailable');
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const pixels = context.getImageData(0, 0, decoded.width, decoded.height).data;
    let green = 0;
    for (let i = 0; i < pixels.length; i += 4) if ((pixels[i + 1] ?? 0) > (pixels[i] ?? 0) + 20) green++;
    expect(green).toBeGreaterThan(100);
  };
  let phase = 'initial-pictures';
  try {
    app.start().unwrap();
    await expect.poll(() => configuration.inspect().rendering.completedRevision, { timeout: 90_000 }).toBe(1);
    await expect.poll(() => completions, { timeout: 60_000 }).toBeGreaterThanOrEqual(60);
    await picture();
    const baseline = configuration.inspect().applied.effectiveGroups;
    phase = 'low-quality';
    const low = await configuration.setQuality({ base: { kind: 'preset', preset: 'low' }, groups: { textures: 'high' } });
    if (!low.ok) throw low.error;
    await expect.poll(() => configuration.inspect().rendering.completedRevision, { timeout: 60_000 }).toBe(2);
    expect(canvas.width).toBe(128);
    await picture();
    if (workers.render) {
      phase = 'render-replacement';
      const world = app.execution.report().world.identity;
      channel.port1.postMessage('terminate-render');
      await expect.poll(() => app.execution.report().render?.epoch, { timeout: 90_000 }).toBeGreaterThan(1);
      await expect.poll(() => app.canvas?.forgeaxFrameProgress?.completed?.configurationRevision, { timeout: 90_000 }).toBe(2);
      const resumed = completions;
      await expect.poll(() => completions, { timeout: 60_000 }).toBeGreaterThanOrEqual(resumed + 60);
      expect(app.execution.report().world.identity).toBe(world);
      expect(configuration.inspect().applied.revision).toBe(2);
      await picture();
    }
    phase = 'restore-defaults';
    const restored = await configuration.setQuality({ base: { kind: 'device-default' } });
    if (!restored.ok) throw restored.error;
    await expect.poll(() => configuration.inspect().rendering.completedRevision, { timeout: 60_000 }).toBe(3);
    expect(configuration.inspect().applied.effectiveGroups).toEqual(baseline);
    await picture();
    const before = configuration.inspect().applied;
    const restart = await configuration.setQuality({ base: { kind: 'preset', preset: 'low' } });
    expect(!restart.ok && restart.error.code).toBe('configuration-recreate-required');
    expect(configuration.inspect().applied).toBe(before);
  } catch (cause) {
    console.error('[configuration-browser-failure]', JSON.stringify({ phase, workers, completions, configuration: configuration.inspect(), execution: app.execution.report(), lastError: app.lastError, progress: (app.canvas ?? canvas).forgeaxFrameProgress }));
    throw cause;
  } finally {
    document.removeEventListener('forgeax:frame-completed', completed, true);
    try { (await app.dispose()).unwrap(); }
    finally { app.canvas?.remove(); canvas.remove(); channel.port1.close(); channel.port2.close(); }
  }
}, 180_000);
