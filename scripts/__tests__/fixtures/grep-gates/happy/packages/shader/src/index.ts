// Happy-path fixture: runtime registry imports only @forgeax/engine-rhi.
import type { Rhi } from '@forgeax/engine-rhi';

export class ShaderRegistry {
  constructor(public rhi: Rhi) {}
}
