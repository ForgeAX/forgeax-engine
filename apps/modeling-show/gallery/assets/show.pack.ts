import { showPack } from '../../assets/show/pack.ts';
import { BUILD_LABEL } from './build-label.ts';

/** Gallery of single-Pack cases (`assets/show/gallery.ts`), one turntable beat per case. */
export default showPack({
  packageId: '01900000-0000-7000-8000-0000000c1800',
  program: 'gallery',
  ui: '01900000-0000-7000-8000-0000000c1801',
  plugins: './plugins.ts',
  label: BUILD_LABEL,
});
