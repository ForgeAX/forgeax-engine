import { showPack } from '../../assets/show/pack.ts';
import { BUILD_LABEL } from './build-label.ts';

/** F2 (C-200, maid-whale) whole character (interactive page subjects f2 and f2-wip). */
export default showPack({
  packageId: '01900000-0000-7000-8000-0000000c1800',
  program: 'maid-whale',
  ui: '01900000-0000-7000-8000-0000000c1801',
  plugins: './plugins.ts',
  build: './build.ts',
  label: BUILD_LABEL,
});
