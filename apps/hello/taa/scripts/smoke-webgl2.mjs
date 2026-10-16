import {
  aggregateTemporalDemand,
  standardTemporalLaneAdmission,
} from '@forgeax/engine-render/internal/temporal';

const demand = aggregateTemporalDemand({ taa: true, motionBlur: true });
const available = standardTemporalLaneAdmission({
  lane: 'cpu-webgl2',
  demand,
  capabilities: { compute: false, storageBuffer: false, rgba16floatRenderable: true },
});
if (available.status !== 'available' || available.structuralOnly) {
  throw new Error('CPU-WebGL2 temporal admission did not preserve portable raster semantics');
}
const unavailable = standardTemporalLaneAdmission({
  lane: 'cpu-webgl2',
  demand,
  capabilities: { compute: false, storageBuffer: false, rgba16floatRenderable: false },
});
if (unavailable.status !== 'unavailable' || unavailable.reason !== 'capability-missing') {
  throw new Error('CPU-WebGL2 capability loss was not explicit');
}
const rasterOnly = standardTemporalLaneAdmission({
  lane: 'cpu-webgl2',
  demand,
  capabilities: { compute: false, storageBuffer: false, rgba16floatRenderable: true },
});
if (rasterOnly.status !== 'available' || rasterOnly.structuralOnly) {
  throw new Error('CPU-WebGL2 motion blur did not use the raster lane');
}
console.log(
  JSON.stringify({
    backend: 'webgl2',
    status: 'structural-contract-pass',
    admission: available,
    capabilityLoss: unavailable,
    rasterOnly,
    note: 'Real 60-frame WebGL2 raster/readback runs in the required webkit-fallback job.',
  }),
);
