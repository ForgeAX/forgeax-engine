import { createHash } from 'node:crypto';

const array = (value, label) => {
  if (!Array.isArray(value)) throw new Error(`R8 profile ${label} is missing or invalid`);
  return value;
};

const record = (value, label) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`R8 profile ${label} is missing or invalid`);
  }
  return value;
};

export function profileTransferSummary(profile) {
  const root = record(profile, 'export');
  const capture = record(root.capture, 'capture');
  const model = record(root.model, 'model');
  const sidecars = record(root.sidecars, 'sidecars');
  const receipts = array(sidecars.receipts, 'receipts');
  const completionCpu = array(sidecars.completionCpu, 'completionCpu');
  const nativePhysics = array(sidecars.nativePhysics, 'nativePhysics');
  const gpu = array(sidecars.gpu, 'gpu');
  const records = array(capture.records, 'capture records');
  const phases = array(model.phases, 'model phases');

  return {
    captureId: capture.captureId,
    version: root.version,
    captureSchemaVersion: capture.schemaVersion,
    retainedEventCount: capture.completeness?.retainedEventCount ?? null,
    captureRecordCount: records.length,
    modelPhaseCount: phases.length,
    receiptsCount: receipts.length,
    completionCpuCount: completionCpu.length,
    nativePhysicsCount: nativePhysics.length,
    gpuCount: gpu.length,
    renderPassCpuIdentityCount: receipts.reduce(
      (count, receipt) =>
        count +
        (Array.isArray(receipt?.renderPassCpuIdentities)
          ? receipt.renderPassCpuIdentities.length
          : 0),
      0,
    ),
    gpuPassIdentityCount: gpu.reduce(
      (count, row) =>
        count + (Array.isArray(row?.timings?.frame?.passes) ? row.timings.frame.passes.length : 0),
      0,
    ),
    sidecarsSha256: createHash('sha256').update(JSON.stringify(sidecars)).digest('hex'),
  };
}

export function assertProfileTransfer(profile, preflight, expectedCaptureId) {
  const actual = profileTransferSummary(profile);
  if (actual.captureId !== expectedCaptureId || preflight?.captureId !== expectedCaptureId) {
    throw new Error(`R8 profile capture identity mismatch: expected ${expectedCaptureId}`);
  }

  const mismatches = Object.keys(actual).filter((key) => actual[key] !== preflight[key]);
  if (mismatches.length > 0) {
    const detail = Object.fromEntries(
      mismatches.map((key) => [key, { preflight: preflight[key], downloaded: actual[key] }]),
    );
    throw new Error(
      `R8 downloaded profile counts or identities differ from preflight: ${JSON.stringify(detail)}`,
    );
  }

  const sidecars = profile.sidecars;
  for (const [name, rows] of Object.entries({
    receipts: sidecars.receipts,
    completionCpu: sidecars.completionCpu,
    nativePhysics: sidecars.nativePhysics,
    gpu: sidecars.gpu,
  })) {
    const mismatch = rows.findIndex((row) => row?.captureId !== expectedCaptureId);
    if (mismatch !== -1) {
      throw new Error(`R8 downloaded profile ${name}[${mismatch}] has an unexpected capture ID`);
    }
  }

  return actual;
}
