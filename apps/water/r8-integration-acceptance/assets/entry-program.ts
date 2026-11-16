import { waterEntryCrownRimModule } from './entry-surfaces';
import drops from './vfx/iron-ball-entry.vfx.wgsl?raw';
import motion from './vfx/iron-ball-entry-motion.wgsl?raw';
import crown from './vfx/iron-ball-entry-surface.vfx.wgsl?raw';
import tongue from './vfx/iron-ball-entry-tongue.vfx.wgsl?raw';

const imports = {
  'water_entry::motion': motion,
  'water_entry::geometry': waterEntryCrownRimModule(),
};

export const waterEntryModules = {
  'iron-ball-entry.vfx.wgsl': { entry: drops, imports },
  'iron-ball-entry-surface.vfx.wgsl': { entry: crown, imports },
  'iron-ball-entry-tongue.vfx.wgsl': { entry: tongue, imports },
};
