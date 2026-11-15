/// <reference types="@webgpu/types" />

/** Float texture usages verified against the owning WebGPU device. */
export interface VerifiedFloatTextureCapabilities {
  readonly rgba16floatRenderable: boolean;
  readonly rgba32floatRenderable: boolean;
  readonly rgba16floatStorage: boolean;
  readonly rgba32floatStorage: boolean;
  readonly rgba16floatArrayRenderable?: boolean;
  readonly rgba32floatArrayRenderable?: boolean;
  readonly depth32floatSampled?: boolean;
  readonly rg16floatRenderable?: boolean;
}

const TEXTURE_BINDING = 0x04;
const STORAGE_BINDING = 0x08;
const RENDER_ATTACHMENT = 0x10;

const FLOAT_TEXTURE_PROBES = [
  {
    key: 'rgba16floatRenderable',
    format: 'rgba16float',
    usage: TEXTURE_BINDING | RENDER_ATTACHMENT,
  },
  {
    key: 'rgba32floatRenderable',
    format: 'rgba32float',
    usage: TEXTURE_BINDING | RENDER_ATTACHMENT,
  },
  {
    key: 'rgba16floatStorage',
    format: 'rgba16float',
    usage: TEXTURE_BINDING | STORAGE_BINDING,
  },
  {
    key: 'rgba32floatStorage',
    format: 'rgba32float',
    usage: TEXTURE_BINDING | STORAGE_BINDING,
  },
  {
    key: 'rgba16floatArrayRenderable',
    format: 'rgba16float',
    usage: TEXTURE_BINDING | RENDER_ATTACHMENT,
    layers: 2,
  },
  {
    key: 'rgba32floatArrayRenderable',
    format: 'rgba32float',
    usage: TEXTURE_BINDING | RENDER_ATTACHMENT,
    layers: 2,
  },
  {
    key: 'depth32floatSampled',
    format: 'depth32float',
    usage: TEXTURE_BINDING | RENDER_ATTACHMENT,
  },
  { key: 'rg16floatRenderable', format: 'rg16float', usage: TEXTURE_BINDING | RENDER_ATTACHMENT },
] as const satisfies readonly {
  readonly key: keyof VerifiedFloatTextureCapabilities;
  readonly format: GPUTextureFormat;
  readonly usage: GPUTextureUsageFlags;
  readonly layers?: number;
}[];

export const UNVERIFIED_FLOAT_TEXTURE_CAPABILITIES: VerifiedFloatTextureCapabilities =
  Object.freeze({
    rgba16floatRenderable: false,
    rgba32floatRenderable: false,
    rgba16floatStorage: false,
    rgba32floatStorage: false,
  });

/** Probe serially so each validation error scope owns exactly one descriptor. */
export async function probeFloatTextureCapabilities(
  device: Pick<GPUDevice, 'createTexture' | 'pushErrorScope' | 'popErrorScope'>,
): Promise<VerifiedFloatTextureCapabilities> {
  const verified: {
    -readonly [K in keyof VerifiedFloatTextureCapabilities]: VerifiedFloatTextureCapabilities[K];
  } = {
    ...UNVERIFIED_FLOAT_TEXTURE_CAPABILITIES,
  };

  for (const probe of FLOAT_TEXTURE_PROBES) {
    verified[probe.key] = await probeTextureUsage(
      device,
      probe.format,
      probe.usage,
      'layers' in probe ? probe.layers : 1,
    );
  }

  return Object.freeze(verified);
}

async function probeTextureUsage(
  device: Pick<GPUDevice, 'createTexture' | 'pushErrorScope' | 'popErrorScope'>,
  format: GPUTextureFormat,
  usage: GPUTextureUsageFlags,
  layers = 1,
): Promise<boolean> {
  let texture: GPUTexture | undefined;
  let scopeOpen = false;
  let created = false;
  try {
    device.pushErrorScope('validation');
    scopeOpen = true;
    try {
      texture = device.createTexture({
        label: `forgeax-caps-probe-${format}-${usage}`,
        format,
        usage,
        size: [1, 1, layers],
      });
      created = true;
    } catch {
      // Synchronous descriptor exceptions are also a negative capability result.
    }

    const pendingValidationError = device.popErrorScope();
    scopeOpen = false;
    const validationError = await pendingValidationError;
    return created && validationError === null;
  } catch {
    return false;
  } finally {
    if (scopeOpen) {
      scopeOpen = false;
      try {
        const pendingValidationError = device.popErrorScope();
        scopeOpen = false;
        await pendingValidationError;
      } catch {
        // A failed scope cannot provide positive evidence.
      }
    }
    try {
      texture?.destroy?.();
    } catch {
      // A rejected descriptor may return an invalid texture handle.
    }
  }
}
