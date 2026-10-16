import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: {
    index: 'src/index.ts',
    frontend: 'src/frontend.ts',
    backend: 'src/backend.ts',
    protocol: 'src/protocol.ts',
    transport: 'src/transport.ts',
    platform: 'src/platform.ts',
  },
  external: ['@deepseek-ai/cordis', '@forgeax/engine-plugin'],
});
