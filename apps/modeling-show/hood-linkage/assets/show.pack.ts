import { showPack } from '../../assets/show/pack.ts';
import { BUILD_LABEL } from './build-label.ts';

/** Case C-116 (B14 hood four-bar) on the Show turntable (interactive page subject c-116). */
export default showPack({
  packageId: '01900000-0000-7000-8000-0000000c1800',
  program: 'c-116',
  ui: '01900000-0000-7000-8000-0000000c1801',
  plugins: './plugins.ts',
  label: BUILD_LABEL,
});
