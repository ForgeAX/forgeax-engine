import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import { packIrradianceFieldUniform } from '../../raytracing/irradiance-field';
import { IRRADIANCE_FIELD_PROBE_STRIDE } from '../../raytracing/irradiance-field-plan';
import {
  packScreenProbeFrame,
  SCREEN_PROBE_RADIANCE_BYTES,
  SCREEN_PROBE_RECORD_BYTES,
} from '../../raytracing/screen-probe-plan';
import { rayShaderTestImports } from './ray-shader-imports.fixture';

type AngularSample = { direction: number[]; radiance: number[]; measure: number };
type AngularControl = { mode: string; normal: number[]; actual: number[] };

function sampledMean(samples: readonly AngularSample[], normal: readonly number[], omitted = -1) {
  let measure = 0;
  const sum = [0, 0, 0];
  for (const [index, sample] of samples.entries()) {
    if (index === omitted) continue;
    const weight =
      sample.measure *
      Math.max(
        0,
        sample.direction.reduce((value, v, axis) => value + v * (normal[axis] ?? NaN), 0),
      );
    measure += weight;
    for (let channel = 0; channel < 3; channel++)
      sum[channel] = (sum[channel] ?? NaN) + (sample.radiance[channel] ?? NaN) * weight;
  }
  return sum.map((v) => v / measure);
}

function expectAngularControls(
  controls: readonly AngularControl[],
  unavailable: readonly number[],
  samples: readonly AngularSample[],
) {
  for (const control of controls) {
    if (control.mode === 'mixed') continue;
    const dot = control.normal.reduce((sum, v, axis) => sum + v * (unavailable[axis] ?? NaN), 0);
    expect(control.actual[3], `single missing sample cosine ${dot}`).toBe(dot < -0.02 ? 1 : -1);
    if (dot >= -0.02) continue;
    // Only known samples enter the f64 sum. The unavailable sample's exact
    // clamped cosine is zero; its unobserved RGB remains unspecified.
    const expected = sampledMean(samples, control.normal, 22);
    for (let channel = 0; channel < 3; channel++)
      expect(Math.abs((control.actual[channel] ?? NaN) - (expected[channel] ?? NaN))).toBeLessThan(
        0.002,
      );
  }
  expect(controls.find((c) => c.mode === 'mixed' && c.normal[2] === 1)?.actual[3]).toBe(-1);
}

async function verifyRefinedHorizon({
  device,
  probes,
  rays,
  rayData,
  rayWords,
  samples,
  readConvolution,
  errors,
}: {
  device: GPUDevice;
  probes: GPUBuffer;
  rays: GPUBuffer;
  rayData: Float32Array;
  rayWords: Uint32Array;
  samples: readonly AngularSample[];
  readConvolution: () => Promise<Float32Array>;
  errors: readonly string[];
}) {
  // The real producer refines a cell into four sub-rays with one shared
  // jitter. Reproduce that exact 2x2 pattern, not an impossible ray count.
  const mixedSamples = samples.map((sample, t) => {
    rayData.set([...sample.direction, 0, 0, 0, 0, 5], t * 8);
    rayWords[t * 8 + 3] = t | 512;
    return { direction: [...sample.direction], radiance: [0, 0, 0], measure: sample.measure };
  });
  const probeNormal = [0.2, 0, Math.sqrt(0.96)];
  const pair: unknown[] = [];
  for (const [s, slot] of [22, 61, 62, 63].entries()) {
    const blue = s === 0 ? 20 : s === 1 ? 200 : 0;
    const x = (12 + (s & 1) + 0.2) / 8 - 1,
      y = (4 + (s >> 1) + 0.8) / 8 - 1,
      z = 1 - Math.abs(x) - Math.abs(y);
    const raw = [
        z < 0 ? (1 - Math.abs(y)) * (x < 0 ? -1 : 1) : x,
        z < 0 ? (1 - Math.abs(x)) * (y < 0 ? -1 : 1) : y,
        z,
      ],
      length = Math.hypot(...raw);
    const direction = raw.map((v) => Math.fround(v / length));
    const l1 = direction.reduce((s, v) => s + Math.abs(v), 0);
    let u = (direction[0] ?? NaN) / l1,
      v = (direction[1] ?? NaN) / l1;
    if ((direction[2] ?? NaN) < 0)
      [u, v] = [(1 - Math.abs(v)) * (u < 0 ? -1 : 1), (1 - Math.abs(u)) * (v < 0 ? -1 : 1)];
    const cell = Math.floor((u + 1) * 4) + 8 * Math.floor((v + 1) * 4);
    expect(cell).toBe(22);
    expect(direction.reduce((s, x, a) => s + x * (probeNormal[a] ?? NaN), 0)).toBeGreaterThan(0.08);
    rayData.set([...direction, 0, 0, 0, blue, 5], slot * 8);
    rayWords[slot * 8 + 3] = 22 | (s << 6) | 256 | 512;
    mixedSamples[slot] = { direction, radiance: [0, 0, blue], measure: l1 ** 3 / 4 };
    pair.push({
      slot,
      cell,
      subray: s,
      sharedJitter: [0.2, 0.8],
      direction,
      radiance: [0, 0, blue],
      perCellSampleWeight: 0.25,
    });
  }
  device.queue.writeBuffer(probes, 16, Float32Array.from(probeNormal));
  device.queue.writeBuffer(rays, 0, rayData);
  const mixedActual = await readConvolution();
  const expected = sampledMean(mixedSamples, [0, 0, 1]);
  const observed = Array.from(mixedActual.slice(0, 4));
  const sourcePath = new URL('../../../../shader/src/ray-screen-probe.wgsl', import.meta.url);
  const refinedOut =
    process.env.FORGEAX_GI_REFINED_HORIZON_RESULT ?? 'artifacts/screen-probe/refined-horizon.json';
  mkdirSync(dirname(refinedOut), { recursive: true });
  writeFileSync(
    refinedOut,
    JSON.stringify(
      {
        scope:
          'Actual production resolve and query of one four-ray refined octahedral cell. The 2x2 sub-rays share jitter exactly as generateProbeRays; all are forward for a probe normal only 11.54 degrees from query +Z, and one crosses behind query +Z. Independent per-cell f64 quadrature clamps each actual direction before averaging. Missing cells 61..63 are wholly behind +Z. No temporal or spatial filtering, manufactured CPU output, or changed rendering threshold.',
        sourceSha256: createHash('sha256').update(readFileSync(sourcePath)).digest('hex'),
        probeNormal,
        queryNormal: [0, 0, 1],
        pair,
        expected,
        observed,
        errors,
      },
      null,
      2,
    ),
  );
  expect(errors).toEqual([]);
  expect(observed[3]).toBe(1);
  expect(expected[2]).toBeGreaterThan(0.01);
  expect(Math.abs((observed[2] ?? NaN) - (expected[2] ?? NaN))).toBeLessThan(0.002);
}

it('integrates the actual resolved sample cosines rather than angular bin centers', async () => {
  const read = (name: string) =>
    readFileSync(new URL(`../../../../shader/src/${name}.wgsl`, import.meta.url), 'utf8');
  const source = `${read('ray-screen-probe')}
@group(2) @binding(0) var<storage,read> sampleNormals: array<vec4f>;
@group(2) @binding(1) var<storage,read_write> sampleResults: array<vec4f>;
@compute @workgroup_size(1) fn verifyActualCosines(@builtin(global_invocation_id) gid: vec3u) {
 if(gid.x<arrayLength(&sampleNormals)){sampleResults[gid.x]=probeIrradianceAt(0u,sampleNormals[gid.x].xyz);}
}`;
  const compile = async (entry: string) =>
    (
      await compileShader(source, {
        id: 'screen-probe-actual-cosines',
        computeEntry: entry,
        imports: await rayShaderTestImports(),
      })
    ).unwrap();
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Actual GPU required');
  const device = await adapter.requestDevice();
  const owned: (GPUBuffer | GPUTexture)[] = [];
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  const buffer = (bytes: Uint8Array, usage = 128 | 8 | 4) => {
    const b = device.createBuffer({ size: bytes.byteLength, usage });
    owned.push(b);
    if ((usage & 1) === 0) device.queue.writeBuffer(b, 0, bytes);
    return b;
  };
  const floats = (values: readonly number[], usage?: number) =>
    buffer(new Uint8Array(Float32Array.from(values).buffer), usage);
  try {
    const frame = floats(
      Array.from(
        new Float32Array(
          packScreenProbeFrame({
            worldSource: { traversal: 'unused' },
            layout: {
              width: 8,
              height: 8,
              tilesX: 2,
              tilesY: 2,
              uniformCount: 4,
              adaptiveCapacity: 0,
              probeCount: 4,
            },
            downsample: 4,
            frameIndex: 0,
            importance: 'uniform',
            screenSteps: 0,
            thickness: 0.02,
            environment: [0, 0, 0],
            maxDistance: 100,
            shortRangeAo: 0,
            maxFrames: 8,
            sceneHistory: false,
            pixelHistory: false,
            probeHistory: false,
            worldBias: 0.25,
            cardMargin: 0.125,
            query: new Uint8Array(8),
            reprojection: undefined,
          }).buffer,
        ),
      ),
      64 | 8 | 4,
    );
    // Controlled post-resolve records use the actual Probe96 stride. This
    // fixture does not manufacture a canonical receiver/contact certificate.
    const probeData = new Float32Array((4 * SCREEN_PROBE_RECORD_BYTES) / 4);
    probeData.set([0, 0, 0, 1, 0, 0, 1, 0]);
    const probes = buffer(new Uint8Array(probeData.buffer));
    const adaptiveCount = buffer(new Uint8Array(4));
    const depth = device.createTexture({ size: [8, 8], format: 'depth32float', usage: 4 | 16 });
    owned.push(depth);
    const depthEncoder = device.createCommandEncoder();
    depthEncoder
      .beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: depth.createView(),
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
          depthClearValue: 1,
        },
      })
      .end();
    device.queue.submit([depthEncoder.finish()]);
    const rayData = new Float32Array(4 * 64 * 8);
    const rayWords = new Uint32Array(rayData.buffer);
    const samples: AngularSample[] = [];
    for (let t = 0; t < 64; t++) {
      const x = ((t % 8) + 0.1) / 4 - 1,
        y = (Math.floor(t / 8) + 0.1) / 4 - 1,
        z = 1 - Math.abs(x) - Math.abs(y);
      const dx = z < 0 ? (1 - Math.abs(y)) * (x < 0 ? -1 : 1) : x,
        dy = z < 0 ? (1 - Math.abs(x)) * (y < 0 ? -1 : 1) : y;
      const length = Math.hypot(dx, dy, z),
        d = [dx / length, dy / length, z / length];
      const rgb = [1 + 0.7 * (d[0] ?? 0), 0.8 + 0.6 * (d[1] ?? 0), 2 + 1.5 * (d[2] ?? 0)];
      rayData.set([...d, 0, ...rgb, 5], t * 8);
      rayWords[t * 8 + 3] = t | 512;
      samples.push({
        direction: Array.from(rayData.slice(t * 8, t * 8 + 3)),
        radiance: Array.from(rayData.slice(t * 8 + 4, t * 8 + 7)),
        measure: 1 / length ** 3,
      });
    }
    const rays = buffer(new Uint8Array(rayData.buffer));
    const radiance = buffer(new Uint8Array(4 * 64 * SCREEN_PROBE_RADIANCE_BYTES));
    const field = buffer(
      packIrradianceFieldUniform(
        { origin: [-1, -1, -1], spacing: 2, dimensions: [2, 2, 2], probeCount: 8, levels: 1 },
        [{ window: [0, 0, 0], min: [0, 0, 0], max: [2, 2, 2] }],
      ),
      64 | 8 | 4,
    );
    const retained = buffer(new Uint8Array(8 * IRRADIANCE_FIELD_PROBE_STRIDE * 16)),
      moments = buffer(new Uint8Array(8 * 64 * 8)),
      meta = buffer(new Uint8Array(8 * 16));
    const resolve = (await compile('resolveProbeRays')).wgsl;
    const convolution = (await compile('verifyActualCosines')).wgsl;
    const producer = device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: device.createShaderModule({ code: resolve }),
        entryPoint: 'resolveProbeRays',
      },
    });
    const producerGroups = [
      device.createBindGroup({
        layout: producer.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: frame } },
          { binding: 7, resource: { buffer: probes } },
          { binding: 9, resource: { buffer: adaptiveCount } },
          { binding: 13, resource: { buffer: rays } },
          { binding: 17, resource: { buffer: radiance } },
        ],
      }),
      device.createBindGroup({
        layout: producer.getBindGroupLayout(1),
        entries: [
          { binding: 0, resource: { buffer: field } },
          { binding: 1, resource: { buffer: retained } },
          { binding: 2, resource: { buffer: moments } },
          { binding: 3, resource: { buffer: meta } },
        ],
      }),
    ];
    const queries = [
      [0, 0, 1],
      [0, 0, -1],
      [1, 0, 0],
      [-1, 0, 0],
      [0.6, 0, 0.8],
      [-0.7, 0.1, 0.7],
      [0.438997686, 0.894667387, 0],
      [0.087, 0, 1],
    ].map((v) => {
      const length = Math.hypot(...v);
      return v.map((x) => x / length);
    });
    const input = floats(queries.flatMap((v) => [...v, 0])),
      output = buffer(new Uint8Array(queries.length * 16)),
      staging = buffer(new Uint8Array(output.size), 1 | 8);
    const consumer = device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: device.createShaderModule({ code: convolution }),
        entryPoint: 'verifyActualCosines',
      },
    });
    const consumerGroups = [
      device.createBindGroup({
        layout: consumer.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: frame } },
          { binding: 2, resource: depth.createView() },
          { binding: 7, resource: { buffer: probes } },
          { binding: 9, resource: { buffer: adaptiveCount } },
          { binding: 19, resource: { buffer: radiance } },
        ],
      }),
      device.createBindGroup({ layout: consumer.getBindGroupLayout(1), entries: [] }),
      device.createBindGroup({
        layout: consumer.getBindGroupLayout(2),
        entries: [
          { binding: 0, resource: { buffer: input } },
          { binding: 1, resource: { buffer: output } },
        ],
      }),
    ];
    async function readConvolution(): Promise<Float32Array> {
      const encoder = device.createCommandEncoder();
      for (const [pipeline, groups, count] of [
        [producer, producerGroups, 1],
        [consumer, consumerGroups, queries.length],
      ] as const) {
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        groups.forEach((g, i) => {
          pass.setBindGroup(i, g);
        });
        pass.dispatchWorkgroups(count);
        pass.end();
      }
      encoder.copyBufferToBuffer(output, 0, staging, 0, output.size);
      device.queue.submit([encoder.finish()]);
      await staging.mapAsync(1);
      const values = new Float32Array(staging.getMappedRange()).slice();
      staging.unmap();
      return values;
    }
    const actual = await readConvolution();
    const records = queries.map((normal, i) => ({
      normal,
      expected: sampledMean(samples, normal),
      actual: Array.from(actual.slice(i * 4, i * 4 + 4)),
    }));
    const out = process.env.FORGEAX_GI_COSINE_RESULT ?? 'artifacts/screen-probe/sample-cosine.json';
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(
      out,
      JSON.stringify(
        {
          scope:
            'Actual production resolve -> cosine reconstruction, compared with independent f64 quadrature over exactly the emitted sample directions. This tests the sampled estimator, not continuous-scene accuracy.',
          records,
          errors,
          adapter: { vendor: adapter.info.vendor, device: adapter.info.device },
        },
        null,
        2,
      ),
    );
    expect(errors).toEqual([]);
    for (const r of records) {
      expect(r.actual[3]).toBe(1);
      for (let c = 0; c < 3; c++)
        expect(Math.abs((r.actual[c] ?? NaN) - (r.expected[c] ?? NaN))).toBeLessThan(0.002);
    }
    // One real missing world ray from the black plane capture. Its direction
    // is behind +Z although its octahedral cell crosses the cosine horizon.
    const unavailable = [0.894667387, -0.438997686, -0.082772695];
    rayData.set(unavailable, 22 * 8);
    rayWords[22 * 8 + 3] = 22 | 512 | (4 << 12);
    const angularControls: AngularControl[] = [];
    for (const mode of ['single', 'mixed'] as const) {
      if (mode === 'mixed') {
        // Two unresolved samples share a cell: a negative average direction
        // cannot certify the positive sample. Keep that case conservative.
        const vector = [0.7, -0.4, 0.01],
          length = Math.hypot(...vector);
        rayData.set(
          vector.map((v) => v / length),
          63 * 8,
        );
        rayWords[63 * 8 + 3] = 22 | 512 | (4 << 12);
      }
      device.queue.writeBuffer(rays, 0, rayData);
      const values = await readConvolution();
      angularControls.push(
        ...queries.map((normal, i) => ({
          mode,
          normal,
          actual: Array.from(values.slice(i * 4, i * 4 + 4)),
        })),
      );
    }
    const angularOut =
      process.env.FORGEAX_GI_ANGULAR_UNCERTAINTY_RESULT ??
      'artifacts/screen-probe/angular-uncertainty.json';
    mkdirSync(dirname(angularOut), { recursive: true });
    writeFileSync(angularOut, JSON.stringify({ unavailable, angularControls, errors }, null, 2));
    expectAngularControls(angularControls, unavailable, samples);
    await verifyRefinedHorizon({
      device,
      probes,
      rays,
      rayData,
      rayWords,
      samples,
      readConvolution,
      errors,
    });

    expect(errors).toEqual([]);
  } finally {
    owned.forEach((b) => {
      b.destroy();
    });
    device.destroy();
  }
}, 30000);

function requireProofValue<T>(value: T | undefined): T {
  if (value === undefined) throw Error('Missing GPU proof value');
  return value;
}
const R = process.env.FORGEAX_GI_DISTRIBUTION_ARTIFACT_DIR ?? 'artifacts/screen-probe/residual';
const N = 65536;
const read = (n: string) =>
  readFileSync(new URL(`../../../../shader/src/${n}.wgsl`, import.meta.url), 'utf8');
const code =
  read('ray-screen-probe') +
  `
@group(2) @binding(0) var<storage,read> proofInput:array<vec4f>;
@group(2) @binding(1) var<storage,read_write> proofPackets:array<ProbeRadiance>;
@group(2) @binding(2) var<storage,read_write> proofResults:array<vec4f>;
@group(2) @binding(3) var<storage,read_write> proofOutput:array<ProbeRadiance>;
@compute @workgroup_size(1) fn proofPrepare(){
 var beams:array<DistributionBeam,4>;for(var i=0u;i<4u;i++){beams[i]=DistributionBeam(proofInput[i*2u+1u].xyz,0u,proofInput[i*2u].xyz,proofInput[i*2u].w);}
 proofPackets[0]=distributionSet(beams,1.0,5.0,0u);for(var i=0u;i<4u;i++){beams[i].radiance=vec3f(0.0);}proofPackets[1]=distributionSet(beams,1.0,5.0,0u);
 proofPackets[5]=distributionPoint(vec4f(1.0),vec3f(0,0,1),proofInput[8].x,proofInput[8].y,2u);
 proofPackets[6]=distributionSet(beams,proofInput[8].z,proofInput[8].w,3u);
}
@compute @workgroup_size(1) fn proofControls(){
 var inputs:array<ProbeRadiance,9>;var weights:array<f32,9>;inputs[0]=distributionPoint(vec4f(1.0),vec3f(0,0,1),1.0,5.0,0u);inputs[1]=distributionPoint(vec4f(0,0,0,1),vec3f(0,0,1),1.0,5.0,0u);weights[0]=.5;weights[1]=.5;
 var q=distributionQuery(distributionMerge(&inputs,&weights,2u,.375,1.0,5.0,1u,22u),vec3f(0,0,1));proofResults[65632u]=vec4f(q.weighted.xyz/q.weighted.w,q.support);
 inputs[0]=distributionPoint(vec4f(2,2,2,1),vec3f(0,0,1),1.0,5.0,0u);inputs[1]=distributionPoint(vec4f(16,16,16,1),vec3f(0,0,1),4.0,5.0,0u);weights[0]=.2;weights[1]=.8;
 q=distributionQuery(distributionMerge(&inputs,&weights,2u,.375,1.0,5.0,1u,22u),vec3f(0,0,1));proofResults[65633u]=vec4f(q.weighted.xyz/q.weighted.w,q.support);
 var beams:array<DistributionBeam,4>;for(var i=0u;i<4u;i++){beams[i]=DistributionBeam(vec3f(f32(i+1u)),0u,vec3f(0,0,1),1.0);}let gray=distributionSet(beams,1.0,5.0,0u);let sample=cvPick(gray,1.0);proofResults[65634u]=vec4f(distributionRgbDecode(sample.color),1.0);
 q=distributionQuery(distributionPoint(vec4f(0,0,0,1),vec3f(0,0,-1),-2.0,-1.0,0u),vec3f(0,0,1));proofResults[65635u]=vec4f(q.weighted.xyz,q.support);
 q=distributionQuery(distributionPoint(vec4f(0,0,0,1),vec3f(0,0,1),-2.0,-1.0,0u),vec3f(0,0,1));proofResults[65636u]=vec4f(q.weighted.xyz,q.support);
 for(var i=0u;i<4u;i++){beams[i]=DistributionBeam(proofInput[i*2u+1u].xyz,0u,proofInput[i*2u].xyz,proofInput[i*2u].w);}beams[1].availability=2u;
 proofResults[65637u]=distributionQuery(distributionSet(beams,-1.0,-1.0,0u),vec3f(0,0,1)).weighted;
 beams[1].availability=0u;beams[0].availability=2u;q=distributionQuery(distributionSet(beams,-1.0,-1.0,0u),vec3f(0,0,1));proofResults[65638u]=vec4f(q.weighted.xyz,q.support);
 proofResults[65639u]=distributionQuery(proofPackets[0],vec3f(0,0,1)).weighted;
 var reserved=inputs[0];reserved.samples[3].y=0x40000000u;q=distributionQuery(reserved,vec3f(0,0,1));proofResults[65640u]=vec4f(q.weighted.xyz,q.support);
}
@compute @workgroup_size(64) fn proofPhases(@builtin(global_invocation_id) gid:vec3u){
 let i=gid.x;if(i>=65536u){return;}var inputs:array<ProbeRadiance,9>;var weights:array<f32,9>;inputs[0]=proofPackets[0];inputs[1]=proofPackets[1];weights[0]=.37;weights[1]=.63;
 let p=distributionMerge(&inputs,&weights,2u,(f32(i)+.5)/65536.0,1.0,5.0,1u,22u);proofOutput[i]=p;proofResults[i]=distributionQuery(p,vec3f(0,0,1)).weighted;
}
@compute @workgroup_size(1) fn proofReuse(){
 var p=proofOutput[12345];proofPackets[2]=p;var inputs:array<ProbeRadiance,9>;var weights:array<f32,9>;weights[0]=1.0;
 for(var i=0u;i<256u;i++){inputs[0]=p;p=distributionMerge(&inputs,&weights,1u,.375,1.0,5.0,i,22u);}proofPackets[3]=p;
 let m=distributionMoments(p);proofPackets[4]=cvMake(m,CvSample(p.samples[2].y,p.samples[3].y&0xfffffu),cvMass(p),proofInput[8].x,proofInput[8].y,22u,3u);
}
@compute @workgroup_size(64) fn proofCodec(@builtin(global_invocation_id) gid:vec3u){
 let i=gid.x;if(i>=24u){return;}let scales=array<f32,4>(0.0,1e-20,1.0,1e20);let axes=array<vec3f,6>(vec3f(1,0,0),vec3f(-1,0,0),vec3f(0,1,0),vec3f(0,-1,0),vec3f(.6,0,.8),vec3f(-.8,.6,0));
 let s=scales[i/6u];let r=axes[i%6u]*s;let g=axes[(i+1u)%6u]*(s*.123456);let b=axes[(i+2u)%6u]*(s*.00001);let w=axes[(i+3u)%6u]*(1.0+f32(i)*.13);
 proofOutput[65536u+i]=cvMake(mat3x4f(vec4f(r.x,g.x,b.x,w.x),vec4f(r.y,g.y,b.y,w.y),vec4f(r.z,g.z,b.z,w.z)),CvSample(0u,0u),3.25,1.0,5.0,22u,0u);
 proofResults[65536u+i*4u]=vec4f(r,0.0);proofResults[65536u+i*4u+1u]=vec4f(g,0.0);proofResults[65536u+i*4u+2u]=vec4f(b,0.0);proofResults[65536u+i*4u+3u]=vec4f(w,0.0);
}
`;
function oct(x: number, y: number) {
  const z = 1 - Math.abs(x) - Math.abs(y);
  if (z < 0) {
    const a = (1 - Math.abs(y)) * Math.sign(x || 1);
    y = (1 - Math.abs(x)) * Math.sign(y || 1);
    x = a;
  }
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
}
function decodeRgb(word: number) {
  const scale = 2 ** (Math.max(word >>> 24, 1) - 127) / 128;
  return [(word >>> 16) & 255, (word >>> 8) & 255, word & 255].map((x) => x * scale);
}
function directionCode(v: number[]) {
  const sum = v.reduce((a, b) => a + Math.abs(b), 0);
  let x = requireProofValue(v[0]) / sum,
    y = requireProofValue(v[1]) / sum;
  if (requireProofValue(v[2]) < 0) {
    const u = (1 - Math.abs(y)) * Math.sign(x || 1);
    y = (1 - Math.abs(x)) * Math.sign(y || 1);
    x = u;
  }
  return Math.round((x * 0.5 + 0.5) * 1023) | (Math.round((y * 0.5 + 0.5) * 1023) << 10);
}
function directionDecode(code: number, res = 1023, shift = 10) {
  return oct(((code & res) * 2) / res - 1, (((code >>> shift) & res) * 2) / res - 1);
}
function floatWord(word: number) {
  return requireProofValue(new Float32Array(Uint32Array.of(word).buffer)[0]);
}
function dense(words: Uint32Array) {
  const amp = [
    requireProofValue(words[0]) & 65535,
    (requireProofValue(words[1]) >>> 8) & 65535,
    requireProofValue(words[2]) >>> 16,
    (requireProofValue(words[3]) >>> 24) | ((requireProofValue(words[4]) & 255) << 8),
  ].map((x) => floatWord(x << 15));
  const codes = [
    (requireProofValue(words[0]) >>> 16) | ((requireProofValue(words[1]) & 255) << 16),
    (requireProofValue(words[1]) >>> 24) | ((requireProofValue(words[2]) & 65535) << 8),
    requireProofValue(words[3]) & 0xffffff,
    requireProofValue(words[4]) >>> 8,
  ];
  return codes.map((c, i) =>
    directionDecode(c, 4095, 12).map((v) => v * requireProofValue(amp[i])),
  );
}
function rawBeams(words: Uint32Array) {
  return Array.from({ length: 4 }, (_, i) => {
    const b = requireProofValue(words[i * 2 + 1]);
    const v = [(b << 22) >> 22, (b << 12) >> 22, (b << 2) >> 22].map((x) => (x * 4) / 511);
    return {
      color: requireProofValue(words[i * 2]),
      rgb: decodeRgb(requireProofValue(words[i * 2])),
      v,
      mass: Math.hypot(...v),
      axis: directionCode(v),
    };
  });
}
function verifyScalarControls(
  controls: Float32Array,
  controlPackets: Uint32Array,
  authoredWords: Uint32Array,
  N: number,
) {
  const control = (row: number, column: number) =>
    requireProofValue(controls[(N + 96 + row) * 4 + column]);
  expect(Math.abs(control(0, 0) - 0.5)).toBeLessThan(0.002);
  expect(Math.abs(control(1, 0) - 13.2)).toBeLessThan(0.002);
  expect(control(2, 0)).toBe(4);
  expect(control(3, 0)).toBe(0);
  expect(control(3, 3)).toBe(1);
  expect(control(4, 3)).toBe(-1);
  for (let c = 0; c < 4; c++) expect(control(5, c)).toBe(control(7, c));
  expect(control(6, 3)).toBe(-1);
  expect(control(8, 3)).toBe(-1);
  for (const [packet, input] of [
    [5, 32],
    [6, 34],
  ] as const)
    for (let c = 0; c < 2; c++)
      expect(requireProofValue(controlPackets[packet * 10 + 8 + c])).toBe(
        requireProofValue(authoredWords[input + c]),
      );
}

it('preserves mixed-radiance linear statistics and a bounded nonlinear residual', {
  timeout: 120000,
}, async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw Error('Actual GPU required');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  const owned: GPUBuffer[] = [];
  const make = (size: number, usage: number, data?: ArrayBuffer) => {
    const b = device.createBuffer({ size, usage });
    owned.push(b);
    if (data) device.queue.writeBuffer(b, 0, data);
    return b;
  };
  const authored = new Float32Array(36);
  for (let i = 0; i < 4; i++) {
    const d = oct((6 + ((i & 1) + 0.2) * 0.5) / 4 - 1, (2 + ((i >>> 1) + 0.8) * 0.5) / 4 - 1);
    const mass = d.reduce((a, b) => a + Math.abs(b), 0) ** 3;
    authored.set([...d, mass, 0, 0, i === 0 ? 20 : i === 1 ? 200 : 0, 0], i * 8);
  }
  authored.set([1.00000393, 1.234567e20, 4.9876543, 1.234567e-20], 32);
  const inputs = make(authored.byteLength, 128 | 8, authored.buffer),
    packets = make(8 * 40, 128 | 4),
    results = make((N + 105) * 16, 128 | 4),
    outputs = make((N + 32) * 40, 128 | 4);
  const total = packets.size + results.size + outputs.size,
    staging = make(total, 1 | 8);
  const empty = device.createBindGroupLayout({ entries: [] }),
    layout = device.createBindGroupLayout({
      entries: [0, 1, 2, 3].map((binding) => ({
        binding,
        visibility: 4,
        buffer: { type: binding === 0 ? 'read-only-storage' : 'storage' },
      })),
    }),
    pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [empty, empty, layout] }),
    group = device.createBindGroup({
      layout,
      entries: [inputs, packets, results, outputs].map((buffer, binding) => ({
        binding,
        resource: { buffer },
      })),
    });
  const pipeline = async (text: string, entryPoint: string) => {
    const compiled = (
      await compileShader(text, {
        id: 'private-cv40-proof',
        computeEntry: entryPoint,
        imports: await rayShaderTestImports(),
      })
    ).unwrap();
    const module = device.createShaderModule({ code: compiled.wgsl });
    expect((await module.getCompilationInfo()).messages.filter((m) => m.type === 'error')).toEqual(
      [],
    );
    return device.createComputePipeline({
      layout: pipelineLayout,
      compute: { module, entryPoint },
    });
  };
  const run = async (p: GPUComputePipeline, groups: number) => {
    const e = device.createCommandEncoder(),
      pass = e.beginComputePass();
    pass.setPipeline(p);
    pass.setBindGroup(2, group);
    pass.dispatchWorkgroups(groups);
    pass.end();
    e.copyBufferToBuffer(packets, 0, staging, 0, packets.size);
    e.copyBufferToBuffer(results, 0, staging, packets.size, results.size);
    e.copyBufferToBuffer(outputs, 0, staging, packets.size + results.size, outputs.size);
    device.queue.submit([e.finish()]);
    await staging.mapAsync(1);
    const bytes = staging.getMappedRange().slice(0);
    staging.unmap();
    return bytes;
  };
  try {
    await run(await pipeline(code, 'proofPrepare'), 1);
    const bytes = await run(await pipeline(code, 'proofPhases'), N / 64);
    const raw = new Uint32Array(bytes, 0, packets.size / 4),
      values = new Float32Array(bytes, packets.size, results.size / 4),
      encoded = new Uint32Array(bytes, packets.size + results.size, outputs.size / 4);
    const beams = rawBeams(raw.slice(0, 8)),
      massExpected = beams.reduce((a, b) => a + b.mass, 0) / 4,
      first = encoded.slice(0, 10),
      mass = floatWord(requireProofValue(first[6])),
      moments = dense(first);
    expect(Math.abs(mass - massExpected)).toBeLessThan(32 * 2 ** -23 * massExpected);
    expect(mass).toBeGreaterThan(0);
    expect(mass).toBeLessThan(3 * Math.sqrt(3) + 0.02);
    const candidates = [
      ...beams.map((b) => ({ ...b, probability: (0.37 * b.mass) / (4 * massExpected) })),
      ...beams.map((b) => ({
        ...b,
        color: 0,
        rgb: [0, 0, 0],
        probability: (0.63 * b.mass) / (4 * massExpected),
      })),
    ];
    const lineage = new Set(candidates.map((b) => `${b.color}:${b.axis}`));
    const expected = [0, 0, 0, 0],
      range = [0, 0, 0, 0];
    for (const b of candidates) {
      const d = directionDecode(b.axis),
        front = mass * Math.max(requireProofValue(d[2]), 0),
        back = mass * Math.max(-requireProofValue(d[2]), 0);
      for (let c = 0; c < 4; c++) {
        const color = c === 3 ? 1 : requireProofValue(b.rgb[c]);
        const v =
          requireProofValue(requireProofValue(moments[c])[2]) < 0
            ? color * front
            : requireProofValue(requireProofValue(moments[c])[2]) + color * back;
        expected[c] = requireProofValue(expected[c]) + b.probability * v;
        range[c] = Math.max(requireProofValue(range[c]), Math.abs(v));
      }
    }
    const mean = [0, 0, 0, 0];
    for (let i = 0; i < N; i++) {
      const at = i * 10;
      expect(requireProofValue(encoded[at + 7]) >>> 30).toBe(3);
      expect(Array.from(encoded.slice(at, at + 5))).toEqual(Array.from(first.slice(0, 5)));
      expect(requireProofValue(encoded[at + 6])).toBe(requireProofValue(first[6]));
      expect(
        lineage.has(
          `${requireProofValue(encoded[at + 5])}:${requireProofValue(encoded[at + 7]) & 0xfffff}`,
        ),
      ).toBe(true);
      for (let c = 0; c < 4; c++) {
        const value = requireProofValue(values[i * 4 + c]);
        expect(Number.isFinite(value) && value >= 0).toBe(true);
        mean[c] = requireProofValue(mean[c]) + value / N;
      }
    }
    // Eight PPS intervals: midpoint quadrature plus f32 CDF boundary rounding.
    const bounds = range.map((r) => r * (8 / N + 64 * 2 ** -23));
    for (let c = 0; c < 4; c++)
      expect(
        Math.abs(requireProofValue(mean[c]) - requireProofValue(expected[c])),
      ).toBeLessThanOrEqual(requireProofValue(bounds[c]) + 1e-8);
    const anchor = 'let position=phase*massSum;';
    expect(code.split(anchor)).toHaveLength(2);
    const wrongBytes = await run(
        await pipeline(code.replace(anchor, 'let position=0.5*massSum;'), 'proofPhases'),
        N / 64,
      ),
      wrong = new Float32Array(wrongBytes, packets.size, results.size / 4);
    let wrongBlue = 0;
    for (let i = 0; i < N; i++) wrongBlue += requireProofValue(wrong[i * 4 + 2]) / N;
    expect(Math.abs(wrongBlue - requireProofValue(expected[2]))).toBeGreaterThan(
      10 * requireProofValue(bounds[2]),
    );
    const clampAnchor =
      'return DistributionQuery(select(projected+back,front,projected<vec4f(0.0)),1.0);';
    expect(code.split(clampAnchor)).toHaveLength(2);
    const clampedBytes = await run(
        await pipeline(
          code.replace(
            clampAnchor,
            'return DistributionQuery(max(projected+back,vec4f(0.0)),1.0);',
          ),
          'proofPhases',
        ),
        N / 64,
      ),
      clamped = new Float32Array(clampedBytes, packets.size, results.size / 4);
    let clampedBlue = 0;
    for (let i = 0; i < N; i++) clampedBlue += requireProofValue(clamped[i * 4 + 2]) / N;
    expect(Math.abs(clampedBlue - requireProofValue(expected[2]))).toBeGreaterThan(
      10 * requireProofValue(bounds[2]),
    );
    // Restore genuine phase packets before the reuse test.
    await run(await pipeline(code, 'proofPhases'), N / 64);
    const reusedBytes = await run(await pipeline(code, 'proofReuse'), 1),
      reused = new Uint32Array(reusedBytes, 0, packets.size / 4);
    for (let word = 0; word < 8; word++) {
      const mask = word === 7 ? ~(3 << 26) : 0xffffffff;
      expect((requireProofValue(reused[2 * 10 + word]) & mask) >>> 0).toBe(
        (requireProofValue(reused[3 * 10 + word]) & mask) >>> 0,
      );
    }
    const authoredWords = new Uint32Array(authored.buffer);
    expect(requireProofValue(reused[4 * 10 + 8])).toBe(requireProofValue(authoredWords[32]));
    expect(requireProofValue(reused[4 * 10 + 9])).toBe(requireProofValue(authoredWords[33]));
    const controlsBytes = await run(await pipeline(code, 'proofControls'), 1),
      controls = new Float32Array(controlsBytes, packets.size, results.size / 4),
      controlPackets = new Uint32Array(controlsBytes, 0, packets.size / 4);
    verifyScalarControls(controls, controlPackets, authoredWords, N);
    const codecBytes = await run(await pipeline(code, 'proofCodec'), 1),
      codecValues = new Float32Array(codecBytes, packets.size, results.size / 4),
      codecPackets = new Uint32Array(codecBytes, packets.size + results.size, outputs.size / 4),
      codecRecords = [];
    for (let i = 0; i < 24; i++) {
      const decoded = dense(codecPackets.slice((N + i) * 10, (N + i + 1) * 10));
      for (let c = 0; c < 4; c++) {
        const original = Array.from(
            codecValues.slice((N + i * 4 + c) * 4, (N + i * 4 + c) * 4 + 3),
          ),
          length = Math.hypot(...original),
          bound =
            Math.max(length * 2 ** -9, 2 ** -135) +
            length * ((2 * Math.sqrt(18)) / 4095 + 16 * 2 ** -23);
        const error = Math.hypot(
          ...requireProofValue(decoded[c]).map((v, j) => v - requireProofValue(original[j])),
        );
        expect(error).toBeLessThanOrEqual(bound + 1e-44);
        codecRecords.push({ i, c, original, decoded: requireProofValue(decoded[c]), error, bound });
      }
    }
    expect(errors).toEqual([]);
    const report = {
      status: 'PASS',
      scope:
        'Production CV40 actual GPU proof: finite authored distribution, independently decoded quantized inputs, explicit vector-codec bounds, PPS interval expectation, fixed-phase and clamped-residual mutations and exact 256-step self reuse. Not final Renderer or performance acceptance.',
      proofSourceSha256: createHash('sha256').update(code).digest('hex'),
      productionShaderSha256: createHash('sha256').update(read('ray-screen-probe')).digest('hex'),
      backend: process.env.FORGEAX_WEBGPU_NODE,
      adapter: { vendor: adapter.info.vendor, device: adapter.info.device },
      mass,
      massExpected,
      expected,
      mean,
      bounds,
      wrongBlue,
      clampedBlue,
      codecRecords,
      scalarControls: Array.from(controls.slice((N + 96) * 4, (N + 105) * 4)),
      metadataBits: [requireProofValue(reused[48]), requireProofValue(reused[49])],
      errors,
    };
    mkdirSync(R, { recursive: true });
    writeFileSync(`${R}/${process.env.FORGEAX_WEBGPU_NODE}.json`, JSON.stringify(report, null, 2));
  } finally {
    for (const b of owned) b.destroy();
    device.destroy();
  }
});
