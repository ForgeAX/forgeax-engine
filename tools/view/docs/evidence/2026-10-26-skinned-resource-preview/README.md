# Skinned resource preview evidence

Paired review: View PR #239
and [Engine PR #4731](https://github.com/ForgeaX-Games/forgeax-engine/pull/4731).
`results.json` records the exact Engine implementation used for the pixel proof;
the Engine PR pins the corresponding View candidate through `tools/view`.

The proof script produced 45 successful observations: 44 resource/thumbnail
checks and at least 60 completed Play frames with presentation `ready`.
Its input is the accepted local game-3d project containing Steve, rather than
an unchanged template checkout. Both Steve materials declare cutoff 0.5. Those
author assets remain in the original game workspace with the previously
accepted uncommitted content; the paired runtime change does not replace them.
`results.json` records all measured image extents, opaque coverage and target
identities. Selected images are retained here; remaining routine captures stay
in the local diagnosis archive and can be reproduced with
`scripts/verify-skinned-resource-previews.mjs PROJECT ENGINE EVIDENCE`.

The old Steve Mesh lost 9,912 background pixels. Its repaired capture retains
891,308/891,308 opaque pixels. The repaired Outer plane retains
893,894/893,894 opaque pixels, with transparent texels revealing the sky.
`coverage-replay.json` records the independent RHI controls, including preserved
fractional alpha-to-coverage.

The native Codex panel is connected to Game 3D and has Steve Mesh and Outer
Material pages open. The active Mesh page reports 144 triangles, 288 vertices,
one UV channel, two submeshes and two material slots. Pixel evidence was
inspected in the ordinary browser; nested native-frame screenshots are not
available through the current automation surface.

The user accepted the native preview on 2026-10-26 and requested final local
cleanup. The current View panel and its owning backend remain available.

View tests: 658 passed. Architecture checks: 53 passed. Strict types and build
passed. Engine focused tests: 22 passed; game tests: 51 passed; game types and
build passed. Independent lifecycle/source review found no remaining blocking
implementation finding.

Full browser qualification is blocked by missing Chrome Beta. Dawn and core
native smoke qualification are blocked by missing `dawn.node` (and Go for its
attempted rebuild). The source template's `project check` also rejects its local
pnpm link locator; `project engine check` reports the intended binding healthy.
The local candidate is not represented as a complete release gate pass.
