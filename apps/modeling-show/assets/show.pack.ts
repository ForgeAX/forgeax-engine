import { showPack } from './show/pack.ts';
import { SHOW_PACKAGE_ID } from './show/show.ts';

/** Case C-111: the Show of the C-107 limb and the C-106 panels. */
export default showPack({
  packageId: SHOW_PACKAGE_ID,
  program: 'c-111',
  ui: '01900000-0000-7000-8000-0000c0111001',
  plugins: './show/plugins.ts',
});
