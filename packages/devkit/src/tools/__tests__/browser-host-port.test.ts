import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { allocateLoopbackPort } from '../browser-host.js';

describe('Browser Host loopback port', () => {
  it('returns a bindable OS-assigned port instead of Vite default port semantics', async () => {
    const port = await allocateLoopbackPort();
    expect(port).toBeGreaterThan(0);

    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve());
    });
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  });
});
