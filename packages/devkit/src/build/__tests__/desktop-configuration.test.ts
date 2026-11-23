import { resolveEngineStartup } from '@forgeax/engine-app/configuration';
import { expect, test } from 'vitest';
import {
  desktopDeviceFacts,
  preflightDesktopStartup,
  validateDesktopStartup,
} from '../desktop-configuration.js';

test('checks the destination profile and leaves the shared browser profile usable', () => {
  const definition = {
    deviceProfiles: [
      {
        id: 'WebWorkers',
        match: { runtime: 'browser' },
        priority: 10,
        settings: { execution: { workers: { render: true } } },
      },
      {
        id: 'WindowsLegacyGraphics',
        match: { platform: 'windows', runtime: 'native' },
        priority: 10,
        settings: { rendering: { renderBackend: 'webgl2' } },
      },
    ],
  };
  const browser = resolveEngineStartup(definition, { platform: 'windows', runtime: 'browser' });
  expect(browser.unwrap().settings.execution?.workers?.render).toBe(true);
  expect(preflightDesktopStartup(definition, 'darwin').ok).toBe(true);
  const result = preflightDesktopStartup(definition, 'win32');
  expect(result).toMatchObject({
    ok: false,
    error: {
      code: 'configuration-domain-unavailable',
      detail: { path: 'rendering.renderBackend' },
    },
  });
});

test('uses the same admission at build and launch', () => {
  const definition = { settings: { execution: { taskWorkers: 2 } } };
  const atBuild = preflightDesktopStartup(definition, 'linux');
  const atLaunch = validateDesktopStartup(
    resolveEngineStartup(definition, desktopDeviceFacts('linux')).unwrap(),
  );
  expect(atBuild).toMatchObject({
    ok: false,
    error: { code: 'configuration-domain-unavailable', detail: { path: 'execution.taskWorkers' } },
  });
  expect(atBuild).toEqual(atLaunch);
  expect(
    preflightDesktopStartup({ settings: { execution: { workers: { render: true } } } }, 'darwin'),
  ).toMatchObject({
    ok: false,
    error: { code: 'configuration-domain-unavailable', detail: { path: 'execution.workers' } },
  });
  expect(
    preflightDesktopStartup(
      {
        settings: {
          execution: { workers: { render: false } },
          rendering: { renderBackend: 'auto' },
        },
      },
      'linux',
    ).ok,
  ).toBe(true);
});
