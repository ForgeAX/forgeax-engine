import { showPack } from '../../assets/show/pack.ts';
import { BUILD_LABEL } from './build-label.ts';

/** C-410 (T1 sci-fi mech, high-to-low bake): low mesh with baked maps, the detail preview and the plain look. */
export default showPack({
  packageId: '01900000-0000-7000-8000-0000000c1800',
  program: 'scifi-mech',
  ui: '01900000-0000-7000-8000-0000000c1801',
  plugins: './plugins.ts',
  build: './build.ts',
  label: BUILD_LABEL,
});
