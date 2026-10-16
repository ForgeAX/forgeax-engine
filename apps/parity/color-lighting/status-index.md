# Color Lighting Status Index

This index is a recovery map, not a second coverage ledger. The `CaseReport`
and its `attachmentEvidence` fields are the single status authority.

## Generate and read the current matrix

Run the single parity command from the repository root:

```bash
pnpm bench:color-lighting-parity
```

It writes `report/color-lighting-parity/status-index.json` from the case
manifest and named reports. The generated index contains `schemaVersion`,
`authority`, `required`, `primary`, `matrix`, and per-case `cases`; it must be
read as fail-closed evidence, not edited by hand. The required dimensions are
declared in [`package.json`](./package.json) under `parityMatrix`.

| Matrix dimension | Required values | A pass requires |
| :-- | :-- | :-- |
| Required parity backend roster | `browser-webgpu`, `dawn`, `chromium-webgl2` | The case authority declares the required backend cells; each cell must execute and produce named evidence |
| Chromium fallback sentinel slice | Six final-display cases only | The Chromium runner pairs ForgeaX rhi-wgpu WebGL2 with Three r184 WebGLRenderer while proving WebGPU is absent; hello-triangle is supporting channel proof, not a blanket pass |
| Pipeline | `urp`, `hdrp` | Each required producer has independent provenance |
| Case | Required manifest cases | `CaseReport.status=complete` and `verdict=passed` |

> [!IMPORTANT]
> `status-index.json` is partial while any required dimension is not executed.
> Do not infer completion from a single backend, a final canvas, or an
> aggregate metric.

`applicableBackends` and `matrixRequiredBackends` are part of the generated
per-case authority projection. M0 contract cases have no GPU matrix; the six
Chromium fallback sentinel cases add a `chromium-webgl2` cell; M4-M6 HDR cases
still require browser WebGPU and Dawn. The index counts `(caseId, backendId)`
cells rather than projecting one global backend status. Chromium WebGL2 does
not upgrade an HDR, linear-readback, transparent HDRP, or IBL case.

## Read the report in this order

| Order | Report field | Question | Next owner |
| :-: | :-- | :-- | :-- |
| 1 | `status`, `verdict` | Did the named case execute and pass? | [`run-parity.ts`](./src/cli/run-parity.ts) |
| 2 | `missingPipelineIds` | Is unified Standard producer evidence absent? | Live browser or Dawn producer |
| 3 | `linearHdr` | Is native HDR evidence ready and fresh? | `observeCurrentFrame` and readback |
| 4 | `finalDisplay` | Is the display capture available? | Final canvas readback; diagnostic only |
| 5 | `readback` | Which readback owner ran? | [`readback-probe.ts`](./src/capture/readback-probe.ts) |
| 6 | `firstDivergence` | Which owner must be repaired first? | The named owner, then rerun the case |

## State to action

| State or reason | Meaning | Recovery |
| :-- | :-- | :-- |
| `status=complete` | The report has complete named captures and metrics | Inspect the report budget and divergence before accepting |
| `status=partial` | A capture or producer stage did not complete | Run the named browser/Dawn producer and preserve the failure report |
| `status=failed` | The named contract or budget failed | Repair the `firstDivergence` owner and rerun the same `caseId` |
| `missingPipelineIds` contains `standard` | Unified Standard producer evidence is incomplete | Do not promote another pipeline, final canvas, replay, or smoke output |
| `linearHdr.status` is not `ready` | Native HDR bytes are absent | Repair frame, format, `COPY_SRC`, copy/map, or producer lifetime |
| `linearHdr.format` is not `rgba16float` | The HDR domain is not native | Reject the capture; do not apply a guessed conversion |
| `linearHdr.pipelineId` mismatches the `SceneCase` | Provenance is cross-wired | Re-run the expected producer and inspect pipeline installation |
| `readback.source=unavailable` | The required readback capability did not execute | Restore the declared readback owner; fallback is not HDR evidence |
| `observation-evidence-missing` | Observation metadata or bytes are incomplete | Read `detail.owner` and `detail.reason`, then draw a fresh frame |
| `status-incomplete` | A required adapter readback is unavailable | Restore both primary readbacks before numerical comparison |

## Producer proof matrix

| Producer | Execution proof | Evidence that counts | Evidence that does not count |
| :-- | :-- | :-- | :-- |
| URP browser | Browser test draws the direct-light case and observes `linear-hdr` | Live `forgeax::standard` `rgba16float` bytes, raw hash, frame, backend, size, and final capture | Browser skip, generic smoke, final canvas only |
| HDRP Dawn | Dawn test installs `forgeax::standard`, draws, and observes `linear-hdr` | Independent live `forgeax::standard` native bytes, raw hash, frame, backend, size, and final capture | URP capture relabeled as HDRP, replay texture, analytic substitute |
| Three r184 | Three adapter captures the same `SceneCase` | Independent named capture and provenance in `CaseReport` | Shared adapter, same provenance, aggregate diff only |

## Chromium fallback sentinel recovery

The required Chromium fallback cells are:

`default-srgb-texture`, `material-alpha-mask-default`, `material-alpha-blend`,
`tone-aces-filmic-2`, `direct-directional-urp`, and `transparent-ldr-urp`.

Run the fresh-process runner locally with a Chromium installation:

```bash
xvfb-run -a env FORGEAX_BROWSER_HEADLESS=0 FORGEAX_FALLBACK_BROWSER=chromium \
  node scripts/dev-verify/verify-webkit-color-lighting.mjs
```

If a cell is `not-executed`, the artifact is missing/malformed, or the page
reports a WebGL2 surface teardown panic, the matrix remains partial/failed.
The runner must also record `webgpuAdapterStatus=absent|unavailable` and
`webgl2=true`; Chromium may expose a truthy `navigator.gpu` object while its
adapter is disabled. An available adapter, request error, or mismatched
channel proof is a failure, not a fallback.
`transparent-hdr-hdrp` and `ibl-constant-environment` remain outside this
fallback slice until a native HDR fallback producer exists.

## Error recovery

Errors are closed and carry `code`, `expected`, `hint`, and discriminated
`detail`. Route by code; do not parse the error message or reuse a nearby exit
code. The exhaustive CLI mapping is in
[`exit-code.ts`](./src/cli/exit-code.ts), and the union plus recovery hints are
in [`errors.ts`](./src/errors.ts).

<details>
<summary>Attachment audit falsification checklist</summary>

The cross-pipeline audit must fail closed for each mutation below:

- remove `COPY_SRC`;
- retain an observation after its producer resource retires;
- substitute a replay or final-canvas source;
- use the wrong format or size;
- change the squared finite-range or radians-to-degrees authority;
- guess an intensity multiplier or curve;
- point HDRP evidence at URP provenance;
- pass the same observation object to both pipeline slots.

</details>

## Authoritative links

- [`Status index builder`](./src/coverage/build-status-index.ts)
- [`Visual evidence schema`](./schemas/visual-evidence.schema.json)
- [`SceneCase` schema](./schemas/scene-case.schema.json)
- [`CaseReport` schema](./schemas/case-report.schema.json)
- [`AttachmentEvidence` validator](./src/capture/attachment-readback.ts)
- [`Renderer` capture projection](./src/main.ts)
- [`Cross-pipeline audit test`](./src/integration/__tests__/cross-pipeline-audit.test.ts)
- [`Direct-light browser producer test`](./cases/direct-light/__tests__/direct-light.browser.test.ts)
- [`Direct-light Dawn producer test`](./cases/direct-light/__tests__/direct-light.dawn.test.ts)
