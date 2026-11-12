import { showPack } from '../../assets/show/pack.ts';
import { BUILD_LABEL } from './build-label.ts';

/** F1 (C-100, mech-gt) showcase: the finished car, the transformation and the robot form. */
export default showPack({
  packageId: '01900000-0000-7000-8000-0000000c1800',
  program: 'mech-gt',
  ui: '01900000-0000-7000-8000-0000000c1801',
  plugins: './plugins.ts',
  build: './build.ts',
  label: BUILD_LABEL,
});
