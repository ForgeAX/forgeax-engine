import type { CarrierCapabilities, ViewPlatform } from '@forgeax/view-plugin-display/carrier-contract';
export type ResourceBrowserPlatformOptions = { targetId?: string };
/**
 * A browser that may render the View catalog but is not an Engine-owned page.
 * It keeps asset discovery available and makes preview allocation fall back.
 */
export class ResourceBrowserPlatform implements ViewPlatform {
  declare readonly targetId: string;
  declare disposed: boolean;
  constructor({ targetId = 'view-resource-browser' } = {}) {
    if (typeof targetId !== 'string' || targetId.length === 0) {
      throw new TypeError('resource browser targetId must be a non-empty string');
    }
    this.targetId = targetId;
    this.disposed = false;
  }

  getCapabilities(): Partial<CarrierCapabilities> {
    return Object.freeze({
      ready: !this.disposed,
      supportsPage: false,
      resourceBrowser: true,
      gpuModes: [],
      maxWidth: 0,
      maxHeight: 0,
      canvasSizing: 'none',
    });
  }

  async createPage(): Promise<never> {
    throw Object.assign(new Error('the resource-browser host cannot allocate an Engine preview page'), {
      fallbackReason: 'view-resource-browser',
    });
  }

  async dispose() {
    this.disposed = true;
  }
}

export function createResourceBrowserPlatform(options?: ResourceBrowserPlatformOptions) {
  return new ResourceBrowserPlatform(options);
}
