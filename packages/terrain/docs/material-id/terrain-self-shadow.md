# Terrain self-shadow repair contract

> [!WARNING]
> The design passed independent review. Candidate source wiring is implemented; GPU execution, visual acceptance and performance remain pending. The visible polygon outlines are a real quality failure. The material pair's 1/255 agreement and fresh-device replay do not make that image acceptable.

## Observed cause

The original ordinary-weight and ID images contain the same fine dark outlines. Immutable replay replacing only the directional shadow factor with one removes them. The independently checked receiver-plane gradient and normal-offset projection agree with a separate linear-system solution within 1.5e-11 at an actual affected receiver. This rules out a large sign or scale error there; GPU post-work normal readback is required separately.

A finite PCF footprint crosses neighboring noncoplanar triangles. The current receiver position, primitive normal and first shadow-map depth cannot distinguish an unoccluded adjacent slope from a separate near caster. A wider bias previously erased the eight-centimetre caster. The existing primitive normal and per-tap comparison correction remain necessary.

## Geometry semantics and routing

Terrain is a finite opaque height surface without holes. Opaque triangles block light from either side; the ordinary Terrain caster therefore uses both faces. This corrects the old one-sided shadow behavior. It introduces no solid volume, boundary wall or skirt. Ordinary Mesh caster policies remain authored policies.

For a nondegenerate receiver on the current submitted continuous, single-valued triangle heightfield whose actual outward primitive normal points toward the light, the ray initially leaves its surface. Its first subsequent intersection with that heightfield, while inside the convex author/local XZ domain, is a back-facing intersection. A root-specific caster projection can omit that root's front faces while retaining its real blockers. All other roots and independent casters remain present with their ordinary policies. This proof uses the admitted Terrain transform: `terrainTranslationValid` accepts only an identity linear transform with translation, shared by Render and Physics. Local and translated world XZ domains are equivalent and actual triangle winding does not reverse; rotation, scale and mirror are currently rejected.

| Receiver | Directional PCF depth family |
|:--|:--|
| Ordinary Mesh or another root | Ordinary family; Terrain casts with both faces |
| Terrain, actual primitive Ng dot L positive | Same-root back faces plus every other ordinary caster |
| Terrain, Ng dot L zero or negative | Ordinary family |
| PCSS | Ordinary family; back-face blocker distance is not reused as a penumbra estimate |

The routing normal is the current submitted primitive normal before quantization. Forward chooses its family from that normal and the current light direction. The GBuffer writer makes the same decision and stores either zero or the root's base; Deferred decodes the already chosen base. Its existing 12-bit octahedral normal still serves receiver bias and plane correction, but cannot decide this topology branch: quantization can reverse the sign near zero. Baked material normals, texture gradients and camera-facing guesses do not choose the family. There is no cosine threshold above zero.

Degenerate derivatives route to ordinary base zero; the existing shading-normal fallback can serve bias but cannot establish this geometric proof. The camera-facing derivative normal is restored to the primitive's outward orientation using the existing front-facing fact before the routing decision.

An exact frozen sign counterexample uses N=[0,1,0] and L=normalize([0,-1e-5,-1]): the original dot is approximately -1e-5, while the existing oct12 codes [2048,4095] decode to a dot of +0.00023426. The opposite disagreement is also required. Both must preserve the writer's unquantized decision.

The finite-edge counterexample is intentional: with h(x)=0 through x=1 and h(x)=10(x-1) through the root edge x=2, a ray from (0.5,0) toward (1,1) intersects the rising slope from behind. The old front-only caster misses it. The repaired opaque-surface contract requires that real intersection to block light. Below-light and reflected-direction controls must use the same triangle-ray reference.

## Existing owners and added cost

| Owner | Required responsibility |
|:--|:--|
| Terrain Cook | Canonical opaque Terrain shadow pass admits both faces; full author heights and weights remain unchanged |
| Renderer view projection | Derive receiver identity from World plus Terrain entity instance; assets reused by different entities remain distinct receivers |
| Typed shadow graph | Allocate additional cascade layers in the existing depth array and record the corresponding caster sets |
| Standard Forward | Derive the physical layer base from the full instance roster ordinal and the accepted View cascade count |
| Standard Deferred | GBuffer chooses the base using unquantized primitive Ng and light direction; carry it in the unused high eight bits of receiver geometry and preserve its 24-bit normal |
| Shadow cache and transaction | Retain each view's family allocation with its accepted picture; allocation changes rewrite depth, and rejected submissions never commit it |

For C cascades and R admitted receiver roots, the depth array has C(1+R) layers, subject to the existing minimum array size. At 1024 squared, depth32float, four cascades and one root, this grows from 16 MiB to 32 MiB. Caster work also grows. These are allocation estimates; measured frame intervals, actual layers and additional draws must be published before acceptance.

The physical base must fit the eight-bit carrier (base <= 255), the complete family must fit the actual array (base + C <= allocated layers), and the total allocation C(1+R) must fit the device's maxTextureArrayLayers. Graph admission returns a structured failure on exhaustion; shader clamps, wrapping and a silently substituted shadow family are forbidden. No new GBuffer attachment is needed.

The full pre-cull roster supplies a stable instance ordinal. The shader multiplies that ordinal by the actual View cascade count rather than using an independently extracted count. Root membership, cascade count and map resolution belong to each accepted view; a failed replacement with any of these changed must not draw using the old graph and new parameters. A held view cannot interpret its old GBuffer with another view's newly reordered family roster. Pose, asset replacement, root identity and family allocation must participate in the existing content/cache proof. Abort, retry, recovery and removal retain the same submission authority.

GPU-only static depth may be copied in full into a root family before that family's dynamic GPU, CPU and feature writers. Terrain is not a GPU-scene caster, so this static layer contains no same-root front faces. The composed ordinary layer must never seed a family. Each family follows the existing logical cascade cache invalidation and the current static producer decision. After an aborted submit, a static producer may need to refill an empty retained layer even when the GPU pool reports a hit; the family must fully copy that refill before its role-specific raster. Partial static dirty rectangles must not preserve old composed family contents.

The graph-owner regression injects replacement build failure, changes an instance while preserving root count, changes cascades and map resolution, rejects a candidate submission, and retries. Removing the routing guard reproduces the stale-graph failure. Capacity exhaustion returns no graph while preserving the accepted record. A second real RHI-null graph/encoder regression reproduces the missed copy after static-layer abort, verifies three complete 32-by-32 copies on first attempt and retry, verifies static-producer-before-copy-before-family-raster ordering, and verifies zero copies on the subsequent cache hit. No caster owner is mocked; the empty caster fixture proves scheduling rather than GPU depth. These transaction checks do not establish GPU cache or image correctness.

## Required falsifiers

| Case | Reference and failure condition |
|:--|:--|
| Curved and folded heightfield, vertical light | No overhang or independent caster; original shadow-on/off peak gate remains 2/255 |
| Real sloped-light terrain self-occlusion | Exact submitted triangle-ray intersections; omitting a genuine blocker fails |
| Finite root edge and below-light | Explicit triangle intersections; no volume or imaginary wall may appear |
| Receiver-normal quantization at grazing incidence | Freeze both original/decoded sign disagreements; the GBuffer's family follows the unquantized primitive, never its decoded octahedral approximation |
| Degenerate geometric derivatives | Ordinary base zero; a shading fallback does not select the self family |
| Eight-centimetre and one-centimetre independent casters | Preserve the original eight-centimetre gate and default one-centimetre negative. Separately test one centimetre with explicit zero authored normal offset; every other scene parameter and coverage threshold remains unchanged |
| External plate and second Terrain root | Original physical caster geometry stays present; same asset GUID cannot merge receiver identities |
| PCF1, PCF3 and PCF5, Forward and Deferred | Same caster and receiver semantics; filtering occurs after the appropriate depth comparisons |
| Ordinary PCSS, Spot and Point shadows | Two-sided Terrain preserves finite-edge and below-light blockers; no directional-family assumption crosses into these paths |
| Multiple and held views | Current and retained pictures each keep their own mapping |
| Replacement, failed submit, failed completion, retry and recovery | No stale accepted map, false cache hit or prematurely committed route |
| Actual RHI capture | Original replay reproduces live output; layer roster, cull state, bindings and depth producers match the recorded routing |
| Performance and delivery | Three ABBA series per path, unchanged budgets, full required CI, immutable pictures/data and independent final review |

The geometric proof preserves the current receiver ray's real blocker. It does not prove that PCF filtering across neighboring faces introduces no edge artifact; the actual curved/folded images and near-caster gates must decide that separately.

The shadow repair belongs to the shared Terrain/Standard rendering owners. It is independent of material ID compression and cannot be implemented as a demo-only shadow disable, inflated bias or altered image threshold.
