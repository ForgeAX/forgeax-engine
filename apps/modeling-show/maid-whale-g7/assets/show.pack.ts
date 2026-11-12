import { showPack } from '../../assets/show/pack.ts';
import { BUILD_LABEL } from './build-label.ts';

/** F2 G7 face figure with its cooked materials (interactive page subject f2-g7). */
export default showPack({
  packageId: '01900000-0000-7000-8000-0000000c1800',
  program: 'maid-whale-g7',
  ui: '01900000-0000-7000-8000-0000000c1801',
  plugins: './plugins.ts',
  build: './build.ts',
  label: BUILD_LABEL,
});
