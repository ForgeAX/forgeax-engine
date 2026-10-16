import { describe, expect, it } from 'vitest';
import {
  GPU_PASS_TIMING_ADMISSION_SAMPLING,
  validateGpuPassTimingAdmission,
  type GpuPassTimingAdmissionArtifact,
} from '../admission.js';

const SOURCE_HEAD = '0123456789abcdef0123456789abcdef01234567';
const BUILD_ID = '89abcdef0123456789abcdef0123456789abcdef';

function samples(offset: number): { beginTicks: string[]; endTicks: string[] } {
  const beginTicks = Array.from({ length: GPU_PASS_TIMING_ADMISSION_SAMPLING.framesPerWindow }, (_, index) =>
    String(offset + index * 100),
  );
  return {
    beginTicks,
    endTicks: beginTicks.map((value) => String(Number(value) + 10)),
  };
}

function validAdmission(): GpuPassTimingAdmissionArtifact {
  const passNames = ['meter', 'lut'] as const;
  return {
    schemaVersion: '1.0',
    source: { sourceHead: SOURCE_HEAD, buildId: BUILD_ID },
    runner: { name: 'gpu-pass-timing', version: '1.0.0', os: 'darwin-arm64', browser: 'dawn-node' },
    backend: {
      kind: 'webgpu',
      adapter: 'Apple M3 Pro',
      driver: 'Metal  Apple M3 Pro',
      physicalGpu: true,
      timestampQuery: true,
      timestampPeriodNanoseconds: 2,
    },
    fixture: {
      id: 'auto-exposure-lut-fixture',
      asset: 'canonical-kit:hdr-room',
      camera: 'camera:d65',
      light: 'light:d65-key',
      input: 'input:fixed-sequence-v1',
    },
    frame: { generation: 'device-3/graph-17', firstFrame: 120, lastFrame: 179 },
    sampling: { ...GPU_PASS_TIMING_ADMISSION_SAMPLING },
    passes: passNames.map((passName, index) => ({
      passName,
      passIdentity: `standard-output/${passName}`,
      windows: [
        {
          width: 1920,
          height: 1080,
          measurementSource: 'gpu-timestamp',
          captureGeneration: 'device-3/graph-17',
          firstFrame: 120,
          lastFrame: 179,
          ...samples(index * 1_000_000),
        },
        {
          width: 3840,
          height: 2160,
          measurementSource: 'gpu-timestamp',
          captureGeneration: 'device-3/graph-17',
          firstFrame: 120,
          lastFrame: 179,
          ...samples((index + 4) * 1_000_000),
        },
      ],
    })),
  };
}

function expectRejected(mutator: (artifact: GpuPassTimingAdmissionArtifact) => void): void {
  const artifact = validAdmission();
  mutator(artifact);
  const result = validateGpuPassTimingAdmission(artifact);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toMatchObject({
    code: expect.any(String),
    expected: expect.any(String),
    hint: expect.any(String),
  });
}

function expectRejectedWith(
  mutator: (artifact: GpuPassTimingAdmissionArtifact) => void,
  code: string,
  path: string,
): void {
  const artifact = validAdmission();
  mutator(artifact);
  const result = validateGpuPassTimingAdmission(artifact);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe(code);
  expect(result.error.path).toBe(path);
}

describe('GPU pass timing admission contract', () => {
  it('accepts raw fused-meter windows and computes nearest-rank p95 for 1080p and 4K', () => {
    const result = validateGpuPassTimingAdmission(validAdmission());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.passes.map((pass) => pass.passName)).toEqual([
      'meter',
      'lut',
    ]);
    expect(result.value.passes[0]?.windows.map((window) => window.p95Nanoseconds)).toEqual([
      20,
      20,
    ]);
  });

  it('preserves a 64-character build content digest during admission', () => {
    const artifact = validAdmission();
    artifact.source.buildId = 'a'.repeat(64);
    const result = validateGpuPassTimingAdmission(artifact);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.source.buildId).toHaveLength(64);
  });

  it('converts raw ticks by the finite positive timestamp period and uses exact nearest-rank p95', () => {
    const artifact = validAdmission();
    const window = artifact.passes[0]!.windows[0]!;
    for (let index = Math.ceil(window.endTicks.length * 0.95) - 1; index < window.endTicks.length; index += 1) {
      window.endTicks[index] = String(Number(window.beginTicks[index]) + 20);
    }
    const result = validateGpuPassTimingAdmission(artifact);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.passes[0]!.windows[0]!.p95Nanoseconds).toBe(40);
  });

  it('rejects TAA blur, wall-time/FPS, missing stages, reused samples, and incomplete windows', () => {
    expectRejected((artifact) => {
      artifact.passes[0]!.passIdentity = 'taa-motion-blur';
    });
    expectRejected((artifact) => {
      artifact.passes[0]!.windows[0]!.measurementSource = 'wall-time';
    });
    expectRejected((artifact) => {
      artifact.passes = artifact.passes.filter((pass) => pass.passName !== 'lut');
    });
    expectRejected((artifact) => {
      artifact.passes[1]!.windows[0] = {
        ...artifact.passes[0]!.windows[0]!,
        width: 1920,
        height: 1080,
      };
    });
    expectRejected((artifact) => {
      artifact.passes[1]!.windows[1] = {
        ...artifact.passes[0]!.windows[0]!,
        width: 3840,
        height: 2160,
      };
    });
    expectRejected((artifact) => {
      artifact.passes[0]!.windows[1]!.beginTicks = artifact.passes[0]!.windows[1]!.beginTicks.slice(0, 59);
    });
    expectRejected((artifact) => {
      artifact.passes[1]!.windows[0]!.firstFrame = 121;
    });
    expectRejected((artifact) => {
      artifact.passes[0]!.windows[0]!.measurementSource = 'fps';
    });
    expectRejected((artifact) => {
      artifact.passes[0]!.windows[1]!.width = 1920;
      artifact.passes[0]!.windows[1]!.height = 1080;
    });
  });

  it('rejects missing timestamp capability and non-physical backends', () => {
    expectRejected((artifact) => {
      artifact.backend.timestampQuery = false;
    });
    expectRejected((artifact) => {
      artifact.backend.physicalGpu = false;
    });
    expectRejected((artifact) => {
      artifact.backend.kind = 'rhi-null';
    });
    for (const token of ['SwiftShader', 'lavapipe', 'RhiNull', 'AppleParavirtualGPU']) {
      expectRejected((artifact) => {
        artifact.backend.adapter = token;
      });
    }
    expectRejected((artifact) => {
      artifact.backend.timestampPeriodNanoseconds = 0;
    });
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expectRejected((artifact) => {
        artifact.backend.timestampPeriodNanoseconds = value;
      });
    }
  });

  it('rejects incomplete source, build, runner, adapter, fixture, or frame identity', () => {
    for (const path of [
      ['source', 'sourceHead'],
      ['source', 'buildId'],
      ['runner', 'name'],
      ['runner', 'version'],
      ['runner', 'os'],
      ['runner', 'browser'],
      ['backend', 'adapter'],
      ['backend', 'driver'],
      ['fixture', 'id'],
      ['fixture', 'asset'],
      ['fixture', 'camera'],
      ['fixture', 'light'],
      ['fixture', 'input'],
      ['frame', 'generation'],
    ] as const) {
      expectRejected((artifact) => {
        (artifact[path[0]] as Record<string, unknown>)[path[1]] = '';
      });
    }
  });

  it('binds every resolution window to the top-level frame owner', () => {
    expectRejected((artifact) => {
      artifact.frame.generation = 'device-4/graph-2';
    });
    expectRejected((artifact) => {
      artifact.passes[1]!.windows[1]!.captureGeneration = 'device-4/graph-2';
    });
  });

  it('asserts concrete failures for falsifiers and every provenance boundary', () => {
    expectRejectedWith(
      (artifact) => {
        artifact.passes[1]!.windows[0]!.firstFrame = 121;
      },
      'admission-identity-invalid',
      '/passes/1/windows/0/firstFrame',
    );
    expectRejectedWith(
      (artifact) => {
        artifact.passes[1]!.windows[0]!.lastFrame = 418;
      },
      'admission-identity-invalid',
      '/passes/1/windows/0/firstFrame',
    );
    expectRejectedWith(
      (artifact) => {
        artifact.frame.generation = 'device-4/graph-2';
      },
      'admission-identity-invalid',
      '/passes/0/windows/0/captureGeneration',
    );
    expectRejectedWith(
      (artifact) => {
        artifact.passes[1]!.windows[1]!.captureGeneration = 'device-4/graph-2';
      },
      'admission-identity-invalid',
      '/passes/1/windows/1/captureGeneration',
    );
    expectRejectedWith(
      (artifact) => {
        artifact.backend.adapter = 'AppleParavirtualGPU';
      },
      'admission-capability-invalid',
      '/backend',
    );
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expectRejectedWith(
        (artifact) => {
          artifact.backend.timestampPeriodNanoseconds = value;
        },
        'admission-capability-invalid',
        '/backend/timestampPeriodNanoseconds',
      );
    }
    expectRejectedWith(
      (artifact) => {
        artifact.passes[0]!.windows[0]!.measurementSource = 'fps';
      },
      'admission-window-invalid',
      '/passes/0/windows/0/measurementSource',
    );
    expectRejectedWith(
      (artifact) => {
        artifact.passes[0]!.windows[1]!.width = 1920;
        artifact.passes[0]!.windows[1]!.height = 1080;
      },
      'admission-window-invalid',
      '/passes/0/windows',
    );
    for (const token of ['SwiftShader', 'lavapipe', 'RhiNull', 'AppleParavirtualGPU']) {
      expectRejectedWith(
        (artifact) => {
          artifact.backend.adapter = token;
        },
        'admission-capability-invalid',
        '/backend',
      );
    }
    for (const [section, field] of [
      ['runner', 'version'],
      ['backend', 'driver'],
      ['fixture', 'id'],
      ['fixture', 'asset'],
      ['fixture', 'camera'],
      ['fixture', 'light'],
      ['fixture', 'input'],
    ] as const) {
      expectRejectedWith(
        (artifact) => {
          (artifact[section] as Record<string, unknown>)[field] = '';
        },
        'admission-identity-invalid',
        `/${section}/${field}`,
      );
    }
    expectRejectedWith(
      (artifact) => {
        artifact.passes[0]!.windows[0]!.captureGeneration = '';
      },
      'admission-identity-invalid',
      '/passes/0/windows/0/captureGeneration',
    );
    expectRejectedWith(
      (artifact) => {
        artifact.passes[0]!.windows[0]!.firstFrame = 0;
      },
      'admission-identity-invalid',
      '/passes/0/windows/0/firstFrame',
    );
    expectRejectedWith(
      (artifact) => {
        artifact.passes[0]!.windows[0]!.lastFrame = 0;
      },
      'admission-identity-invalid',
      '/passes/0/windows/0/firstFrame',
    );
  });
});
