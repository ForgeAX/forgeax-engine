import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';
export default defineConfig({ ...baseTsupConfig, entry: ['src/index.ts', 'src/importer/index.ts', 'src/authoring/index.ts', 'src/preview/index.ts', 'src/localization/index.ts'], external: ['@forgeax/engine-types'] });
