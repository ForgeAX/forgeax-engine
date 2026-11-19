import { afterAll, it } from 'vitest';
import { observeNativeDeviceRequests } from '../../../runtime/src/__tests__/native-device-work.fixture';
import { dawnRendererFixture } from './dawn-renderer.fixture';
import { nodeFamilies, verifyNodeFamily } from './node-family.fixture';

const nativeDevices = observeNativeDeviceRequests();
afterAll(() => {
  try {
    nativeDevices.assertMaximum(1 + nodeFamilies.length);
  } finally {
    nativeDevices.restore();
  }
});

const getRenderer = dawnRendererFixture();

it.each(nodeFamilies)('renders and replays ordinary %s NodeMaterial on Dawn', {
  timeout: 120000,
}, async (kind) => {
  const renderer = await getRenderer();
  await verifyNodeFamily(renderer, kind, async () => {});
});
