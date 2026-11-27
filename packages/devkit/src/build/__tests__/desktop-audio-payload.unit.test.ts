import { expect, test } from 'vitest';
import { emitDesktopAudioPayload } from '../desktop-audio-payload.js';

test('prepares a single Windows binary and a flat runtime closure for MSI harvesting', async () => {
  const files = new Set<string>();
  await emitDesktopAudioPayload('win32', 'x64', (name) => {
    files.add(name);
  });

  expect(files.has('audio/node_modules/node-domexception/index.js')).toBe(true);
  expect(files.has('audio/node_modules/node-domexception/LICENSE')).toBe(true);
  expect([...files].filter((name) => name.endsWith('.node'))).toEqual([
    'audio/node-web-audio-api.win32-x64-msvc.node',
  ]);
  expect(
    [...files].some(
      (name) =>
        name.includes('/.history/') ||
        name.split('/').filter((part) => part === 'node_modules').length > 1,
    ),
  ).toBe(false);
});
