import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';
export default defineConfig({ ...baseTsupConfig, platform: 'node', entry: ['src/index.ts'] });
