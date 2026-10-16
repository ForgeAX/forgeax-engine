const FIELD_ALIASES = Object.freeze({
  vendor: [
    'sppci_vendor',
    'spdisplays_vendor',
    'spdisplays_vendor_name',
    'vendor',
    'vendor_name',
    'manufacturer',
  ],
  device: [
    'sppci_model',
    'spdisplays_model',
    'spdisplays_gpu_model',
    'spdisplays_device_name',
    'chipset_model',
    'chipset',
    'model',
    '_name',
    'name',
  ],
  driver: [
    'spdisplays_mtlgpufamilysupport',
    'spdisplays_metal_family_support',
    'spdisplays_metal_family',
    'spdisplays_metalfamily',
    'spdisplays_metal',
    'metal_support',
    'metal',
    'driver',
    'driver_name',
  ],
  deviceType: [
    'sppci_device_type',
    'spdisplays_device_type',
    'spdisplays_gpu_type',
    'device_type',
    'type',
  ],
});

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeKey(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function stringValues(value) {
  if (typeof value === 'string') return value.trim().length > 0 ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap(stringValues);
  return [];
}

function firstString(record, keys, { skipGeneric = false } = {}) {
  if (!isRecord(record)) return '';
  const wanted = new Set(keys.map(normalizeKey));
  for (const [key, value] of Object.entries(record)) {
    if (!wanted.has(normalizeKey(key))) continue;
    for (const candidate of stringValues(value)) {
      if (!skipGeneric || !/^(?:spdisplays?[_ -]?(?:gpu|ndrvs|display)|gpu|graphics)$/i.test(candidate)) {
        return candidate;
      }
    }
  }
  return '';
}

function recordText(record) {
  if (!isRecord(record)) return '';
  return Object.entries(record)
    .flatMap(([key, value]) => [key, ...stringValues(value)])
    .join(' ');
}

function collectRecords(value, records) {
  if (Array.isArray(value)) {
    for (const child of value) collectRecords(child, records);
    return;
  }
  if (!isRecord(value)) return;
  records.push(value);
  for (const child of Object.values(value)) collectRecords(child, records);
}

function factsForRecord(record) {
  const vendor = firstString(record, FIELD_ALIASES.vendor);
  const device = firstString(record, FIELD_ALIASES.device, { skipGeneric: true });
  const driver = firstString(record, FIELD_ALIASES.driver);
  const deviceType = firstString(record, FIELD_ALIASES.deviceType);
  const text = recordText(record);
  const explicitGpu =
    /(?:gpu|graphics|metal|agx|accelerator)/i.test(deviceType) ||
    /(?:sppci_device_type|spdisplays_device_type|spdisplays_gpu_type|chipset_model|metal_support|mtlgpu)/i.test(text);
  const appleSilicon = /\bapple\s+(?:m\d|a\d+)/i.test(`${vendor} ${device} ${text}`);
  const metal = /\bmetal\b|spdisplays_metal|mtlgpu/i.test(`${driver} ${text}`);
  const software = /(?:cpu|llvmpipe|swiftshader|software|virtual|basic render)/i.test(text);
  const score =
    (explicitGpu ? 12 : 0) +
    (deviceType ? 4 : 0) +
    (device && !/^(?:spdisplays?[_ -]?(?:gpu|ndrvs|display)|gpu|graphics)$/i.test(device) ? 5 : 0) +
    (vendor ? 2 : 0) +
    (driver ? 2 : 0) +
    (appleSilicon ? 3 : 0) +
    (metal ? 2 : 0) -
    (software ? 20 : 0);
  return { vendor, device, driver, deviceType, explicitGpu, appleSilicon, metal, software, score };
}

function projectFacts(records) {
  const candidates = records.map(factsForRecord).sort((left, right) => right.score - left.score);
  const best = candidates[0] ?? {};
  const completeCandidate = candidates.find(
    (candidate) => candidate.vendor && candidate.device && candidate.driver && candidate.deviceType,
  );
  const vendor = completeCandidate?.vendor || best.vendor || candidates.find((candidate) => candidate.vendor)?.vendor || '';
  const device =
    completeCandidate?.device ||
    best.device ||
    candidates.find((candidate) => candidate.device && !/display|ndrvs/i.test(candidate.device))?.device ||
    '';
  const driver = completeCandidate?.driver || best.driver || candidates.find((candidate) => candidate.driver)?.driver || '';
  const explicitDeviceType =
    completeCandidate?.deviceType ||
    best.deviceType ||
    candidates.find((candidate) => candidate.deviceType)?.deviceType ||
    '';
  const hasAppleSilicon = candidates.some((candidate) => candidate.appleSilicon) || /\bapple\s+m\d/i.test(device);
  const hasMetal = candidates.some((candidate) => candidate.metal) || /metal/i.test(driver);
  const deviceType = explicitDeviceType || (hasAppleSilicon && hasMetal ? 'apple-gpu' : '');
  const physicalEvidence = candidates.some((candidate) => candidate.explicitGpu) || (hasAppleSilicon && hasMetal);
  const identity = `${vendor} ${device} ${driver} ${deviceType}`;
  const physicalGpu = Boolean(
    vendor &&
      device &&
      driver &&
      deviceType &&
      physicalEvidence &&
      !/(cpu|llvmpipe|swiftshader|software|virtual|paravirt|basic render)/i.test(identity),
  );
  return {
    source: 'system_profiler',
    vendor,
    device,
    driver,
    deviceType,
    physicalGpu,
  };
}

/**
 * Project the nested SPDisplaysDataType payload into the physical-GPU facts
 * consumed by the performance admission gate.
 *
 * system_profiler has emitted both a compact JSON record and a nested display
 * group across hosted macOS images. Walk every record and score GPU evidence
 * instead of assuming the useful sppci_* fields live at one fixed depth.
 */
export function parseMacSystemProfilerAdapterFacts(payload) {
  const records = [];
  collectRecords(payload?.SPDisplaysDataType ?? payload, records);
  return projectFacts(records);
}

/**
 * The JSON system_profiler projection is empty on some headless GitHub-hosted
 * macOS sessions even though the text provider still reports the Metal GPU.
 * Parse only the stable identity lines and keep the same conservative gate.
 */
export function parseMacSystemProfilerText(text) {
  if (typeof text !== 'string') return projectFacts([]);
  const records = [];
  let current = {};
  const flush = () => {
    if (Object.keys(current).length > 0) records.push(current);
    current = {};
  };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^([^:]+):\s*(.*?)\s*$/);
    if (!match) continue;
    const key = normalizeKey(match[1]);
    const value = match[2].replace(/\s+\([^)]*\)\s*$/, '').trim();
    if (!value) continue;
    if (key === 'chipsetmodel' || key === 'gpumodel') current.sppci_model = value;
    else if (key === 'vendor') current.sppci_vendor = value;
    else if (key === 'type' || key === 'devicetype') current.sppci_device_type = value;
    else if (key === 'metalsupport' || key === 'metal') current.spdisplays_mtlgpufamilysupport = value;
    else if (key === 'driver' || key === 'drivername') current.driver = value;
  }
  flush();
  return projectFacts(records);
}

/**
 * Keep one lower-level Darwin fallback for sessions where system_profiler is
 * present but has no WindowServer display record. IOAccelerator/AGX is an
 * explicit hardware service, so it is stronger evidence than inferring a GPU
 * from the machine model alone.
 */
export function parseMacIoregAdapterFacts(text) {
  if (typeof text !== 'string') return { source: 'ioreg', vendor: '', device: '', driver: '', deviceType: '', physicalGpu: false };
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /<class\s+[^>]*(?:agx|ioaccelerator|gpu)/i.test(line));
  if (start < 0) return { source: 'ioreg', vendor: '', device: '', driver: '', deviceType: '', physicalGpu: false };
  const next = lines.slice(start + 1).findIndex((line) => /^\s*\+-o\s+.*<class\s+/i.test(line));
  const block = lines.slice(start, next < 0 ? lines.length : start + 1 + next).join('\n');
  const read = (pattern) => block.match(pattern)?.[1]?.trim() ?? '';
  const device = read(/"model"\s*=\s*"([^"]+)"/i);
  const driver =
    read(/"MetalPlugin(?:Name|ClassName)"\s*=\s*"([^"]+)"/i) ||
    read(/"IOClass"\s*=\s*"([^"]+)"/i);
  const className = read(/<class\s+([^,>]+)/i);
  const deviceType = className || 'IOAccelerator';
  const vendor = /apple/i.test(`${device} ${driver} ${block}`) ? 'Apple' : read(/"vendor(?:-id|_name)?"\s*=\s*"?([^"\n>]+)"?/i);
  const identity = `${vendor} ${device} ${driver} ${deviceType}`;
  const physicalGpu = Boolean(
    vendor &&
      device &&
      driver &&
      /(?:agx|ioaccelerator|gpu|graphics)/i.test(deviceType) &&
      !/(cpu|llvmpipe|swiftshader|software|virtual|paravirt|basic render)/i.test(identity),
  );
  return {
    source: 'ioreg',
    vendor,
    device,
    driver,
    deviceType,
    physicalGpu,
  };
}

/**
 * Derive the only accepted hosted macOS paravirtual attestation. The direct
 * Metal probe is authoritative for a physical device; this fallback is valid
 * only when the named GitHub provider, native-gpu runner facts, Metal request,
 * non-fallback adapter, and the complete ioreg service pair agree.
 */
export function deriveAppleParavirtualAttestation({
  provider,
  runnerFacts,
  requestedBackend,
  isFallbackAdapter,
  ioregFacts,
} = {}) {
  if (
    provider !== 'github-hosted/macos-15-xlarge' ||
    runnerFacts?.environment !== 'github-hosted' ||
    runnerFacts.os !== 'macOS' ||
    runnerFacts.arch !== 'ARM64' ||
    runnerFacts.queue !== 'native-gpu' ||
    requestedBackend !== 'metal' ||
    isFallbackAdapter !== false ||
    ioregFacts?.source !== 'ioreg' ||
    ioregFacts.physicalGpu !== false ||
    ioregFacts.deviceType !== 'AppleParavirtGPU' ||
    ioregFacts.driver !== 'AppleParavirtGPUMetalIOGPUFamily'
  ) {
    return undefined;
  }
  return {
    kind: 'provider-backed-paravirtual',
    provider,
    deviceType: ioregFacts.deviceType,
    driver: ioregFacts.driver,
    requestedBackend,
    isFallbackAdapter,
  };
}

const SOFTWARE_ADAPTER_IDENTITY = /(?:cpu|llvmpipe|swiftshader|software|virtual|paravirt|basic\s+render)/i;

function emptyMetalFacts(reason) {
  return {
    source: 'metal-api',
    vendor: '',
    device: '',
    driver: '',
    deviceType: '',
    physicalGpu: false,
    ...(reason === undefined ? {} : { reason }),
  };
}

function metalRegistryId(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : '';
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  const digits = normalized.replace(/^0x/i, '');
  return digits !== '' && /^[0-9a-f]+$/i.test(digits) && !/^0+$/.test(digits) ? normalized : '';
}

function metalBoolean(record, key) {
  return typeof record?.[key] === 'boolean' ? record[key] : undefined;
}

/**
 * Project the direct Metal runtime probe into admission facts. Unlike host
 * inventory providers, a Metal device record carries a non-zero registry ID,
 * so an empty or software-named record cannot be promoted by runner labels.
 */
export function parseMacMetalDeviceFacts(payload) {
  if (!isRecord(payload)) return emptyMetalFacts('Metal probe returned a non-object payload');
  const devices = Array.isArray(payload.devices) ? payload.devices : [];
  const candidates = [payload.default, ...devices].filter(isRecord);
  const candidate = candidates.find((record) => {
    const device = typeof record.name === 'string' ? record.name.trim() : '';
    const registryID = metalRegistryId(record.registryID ?? record.registryId ?? record.registry_id);
    const identity = `${device} ${record.location ?? ''}`;
    return device && !/^(?:gpu|metal\s+device|unknown)$/i.test(device) && registryID && !SOFTWARE_ADAPTER_IDENTITY.test(identity);
  });
  if (!candidate) return emptyMetalFacts('Metal probe returned no physical device');

  const device = String(candidate.name).trim();
  const registryID = metalRegistryId(candidate.registryID ?? candidate.registryId ?? candidate.registry_id);
  const identity = `${device} ${candidate.location ?? ''}`;
  const vendor = /\bapple\b/i.test(device) ? 'Apple' : 'Metal';
  const physicalGpu = Boolean(registryID && !SOFTWARE_ADAPTER_IDENTITY.test(identity));
  return {
    source: 'metal-api',
    vendor,
    device,
    driver: 'Metal',
    deviceType: 'MTLDevice',
    physicalGpu,
    ...(physicalGpu ? { accelerationAttestation: { kind: 'direct-device' } } : {}),
    registryID,
    lowPower: metalBoolean(candidate, 'lowPower'),
    removable: metalBoolean(candidate, 'removable'),
    headless: metalBoolean(candidate, 'headless'),
    unifiedMemory: metalBoolean(candidate, 'unifiedMemory'),
    location: typeof candidate.location === 'string' ? candidate.location : '',
  };
}

export function parseMacMetalProbeOutput(output) {
  if (typeof output !== 'string' || output.trim() === '') return emptyMetalFacts('Metal probe returned empty output');
  try {
    return parseMacMetalDeviceFacts(JSON.parse(output));
  } catch {
    return emptyMetalFacts('Metal probe returned malformed JSON');
  }
}

// Keep the probe source beside its parser so the command and its projection
// evolve as one host-facts contract. xcrun compiles this stdin-only snippet on
// Darwin; no generated file or mutable host state is required.
export const MAC_METAL_PROBE_SOURCE = `
import Foundation
import Metal

func deviceRecord(_ device: MTLDevice) -> [String: Any] {
    [
        "name": device.name,
        "registryID": String(device.registryID),
        "lowPower": device.isLowPower,
        "removable": device.isRemovable,
        "headless": device.isHeadless,
        "unifiedMemory": device.hasUnifiedMemory,
        "location": String(describing: device.location)
    ]
}

var result: [String: Any] = ["devices": MTLCopyAllDevices().map(deviceRecord)]
if let device = MTLCreateSystemDefaultDevice() {
    result["default"] = deviceRecord(device)
}
let data = try JSONSerialization.data(withJSONObject: result, options: [])
print(String(decoding: data, as: UTF8.self))
`;
