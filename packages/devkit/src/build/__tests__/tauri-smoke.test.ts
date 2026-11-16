import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { tauriLibrarySource } from '../tauri-source.js';

it('waits for the renderer inspection method before observing completed frames', async () => {
  const source = tauriLibrarySource.match(/const SMOKE: &str = r#"([\s\S]*?)"#;/)?.[1];
  expect(source).toBeDefined();
  let tick: (() => Promise<void>) | undefined;
  let completed = 1;
  const reports: { command: string; args: unknown }[] = [];
  const inspection: { renderer?: () => unknown } = {};
  const rect = { toJSON: () => ({ width: 1280, height: 800 }) };
  const document = {
    documentElement: { dataset: { forgeaxInput: 'closed' }, getBoundingClientRect: () => rect },
    body: { getBoundingClientRect: () => rect },
    scripts: [],
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const context = {
    __forgeaxGameInspection: inspection,
    window: {
      __TAURI__: {
        core: {
          invoke: async (command: string, args: unknown) => {
            if (command === 'plugin:window|set_title') throw new Error('permission denied');
            reports.push({ command, args });
          },
        },
      },
    },
    document,
    navigator: { userAgent: 'Tauri smoke regression' },
    location: { href: 'tauri://localhost' },
    performance: { now: () => 0, getEntriesByType: () => [] },
    isSecureContext: true,
    innerWidth: 1280,
    innerHeight: 800,
    outerWidth: 1280,
    outerHeight: 800,
    devicePixelRatio: 1,
    addEventListener: () => {},
    setInterval: (callback: () => Promise<void>) => {
      tick = callback;
      return 1;
    },
    clearInterval: () => {},
    setTimeout: () => {},
  };
  runInNewContext(source ?? '', context);
  expect(tick).toBeTypeOf('function');
  await expect(tick?.()).resolves.toBeUndefined();
  expect(reports).toEqual([]);
  inspection.renderer = () => ({ state: 'alive', execution: { frame: { completed } } });
  document.documentElement.dataset.forgeaxInput = 'open';
  await tick?.();
  expect(reports).toEqual([]);
  completed += 60;
  await tick?.();
  expect(reports).toEqual([
    {
      command: 'smoke_report',
      args: {
        report: expect.objectContaining({
          phase: 'ready',
          completed: 61,
          presented: 60,
          errors: [],
          permissionDenied: 'Error: permission denied',
        }),
      },
    },
  ]);
});
