# Geometry sources and uncertainty

| Source | Used for | Boundary |
|:--|:--|:--|
| [Palace Museum: Taihedian](https://www.dpm.org.cn/explore/building/236465.html) | Eleven by five bays, double-eave hip roof, 26.92 m hall plus 8.13 m terrace, visual reference | Reference photographs are research evidence, not pasted onto geometry |
| [Palace Museum: Wumen](https://www.dpm.org.cn/explore/building/236454.html) | Five towers, U-shaped gate assembly | Current detailed geometry remains approximate |
| [Palace Museum: inner palaces](https://www.dpm.org.cn/lemmas/241672.html) | Qianqinggong, Jiaotaidian, Kunninggong sequence | Context does not establish every roof profile |
| [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) | 1,201 mapped building footprints inside the working precinct boundary | Roof pitch and untagged heights are estimates; the map is not a measured architectural survey |

The footprint dataset in `assets/footprints.ts` is derived from OpenStreetMap data, copyright OpenStreetMap contributors, available under the [Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/). Preserve this attribution and the database license when distributing the source dataset or a derived database. The complete original query result and query history are retained in the Engine experiment evidence directory.

Coordinates are projected from WGS84 around the mapped Taihedian center (39.9158956, 116.39081395), then rotated approximately 2.09 degrees to align the palace axis. This is a local architectural visualization projection, not a geographic surveying tool. Detail geometry replaces selected major mapped buildings; surrounding wall outlines use mapped polygons, while their roof envelopes use bounding dimensions. Buildings with an envelope wider/deeper than 130 m are omitted from that context layer. These limitations prevent a claim of survey accuracy or a proven 85% visual match.

## Decorative iteration

`assets/caihua.png` is an AI-generated albedo study of Qing imperial painted timber, created with imagegen on 2026-09-13. It is not a museum scan and is not evidence that the painted motifs reproduce a specific beam. Marble relief, moat width, the approximate Inner Golden Water River curve, five bridge geometry and garden trees are authored estimates for visual study; they are not surveyed geometry.

## Roof-form correction

The current source distinguishes hip, gable-hip and pyramidal roofs instead of reusing a double-eave hip roof for every hall. [Zhonghedian](https://www.dpm.org.cn/explore/building/236464.html) and [Jiaotaidian](https://www.dpm.org.cn/explore/building/236467.html) have three-by-three bays, one eave tier and a central gilded finial. [Baohedian](https://www.dpm.org.cn/explore/building/236434.html) has a double-eave gable-hip roof. Wumen's wing pavilions use pyramidal upper roofs. Profiles and ornament carving remain authored approximations; these corrected types do not establish whole-palace acceptance.

## Stone and Meridian Gate iteration

`assets/hanbaiyu-albedo.png` is a generated diffuse stone texture imported through the image producer, with stable Meta GUID, repeated sampling and mipmaps. It is a material study, not a Palace Museum surface scan. It replaces uniform grain on the marble, stone and paving materials.

The [Museum's Wumen record](https://www.dpm.org.cn/explore/building/236454.html) establishes the 12 m base and three front plus two side openings. The current mesh models five actual arch tunnels; opening widths, spring height and side-portal placement remain estimates. Independent ray/triangle tests distinguish all open passages from solid piers and the wall above the arches.

## Waterways and bridge placement

OpenStreetMap water-surface ways and five inner Jinshui bridge centerlines were fetched on 2026-09-13 through Overpass. `assets/waterways.ts` preserves the projected contours and triangulation, with OSM object IDs. Projection is fitted to the already authored Taihedian footprint (maximum calibration residual 0.004 m against rounded project coordinates); this is numerical alignment, not surveying accuracy. The Engine evidence folder retains raw Overpass responses and the projection script. Mapbox Earcut 3.0.2 was used offline to triangulate the contours; no Three.js runtime or game dependency was added.

Bridge width (8 m center, 5.3 m sides), rise (1.35 m), bank height and water elevation remain visualization estimates. The same measured surface contour owns bank placement. The dry southern Meridian Gate approach is preserved. Museum reference for Taihemen specifies nine by four bays and a double-eave gable-hip roof: https://www.dpm.org.cn/explore/building/236439.html.

Context roofs now derive from the exact same polygon as their walls. `footprint-triangulations.ts` contains offline Earcut indices into that source; the generator checks projected polygon area before publication. A sampled distance-to-eave height field approximates hip surfaces without filling concave courtyard recesses. This is an estimated roof surface, not a surveyed ridge layout or proof of detailed roof styles for peripheral buildings.

## Inner hall platforms

The Museum's Jiaotaidian record describes the three inner halls on a 2 m platform. Official front and oblique photographs show open paved connectors and low green/yellow glazed parapets (https://www.dpm.org.cn/explore/building/236467.html; images `s5e99791384387.jpg` and `s5e99791387403.jpg`). OSM ways 638981252 and 638981261 are interpreted as the connecting platform and southern approach, based on their plan positions around the separately mapped halls. The authoring model explicitly extrudes these as stone decks at 2 m; it does not infer platform identity from a generic `building=yes` tag or low height. The southern approach steps, masonry profile and parapet dimensions still require refinement. Source images are references only and are not redistributed as game textures.

The authored hall roofs include a wooden underside 0.12 m below the tile surface. This estimated assembly thickness closes the underside between rafters while preserving ordinary back-face culling; it is not a survey measurement.

The four simplified context outlines 638981206, 638981215, 638981227 and 638981228 are replaced by the authored inner-hall glazed parapets. They are not rendered a second time as roofed buildings. Their exact original mapping semantics are not inferred globally; the replacement follows the photographed local assembly.

Jiaotaidian body/eave estimates were refined against the retained Museum photographs: 13.5 m body width/depth, 4.15 m overhang and 3.7 m roof rise (21.8 m outer roof width). These are visualization estimates, not surveyed dimensions. Small-hall columns use the same member scale as timber framing; detailed facades now contain visible grid lattice bars rather than blank panel subdivisions.

Jiaotaidian's photographed finial is a rounded gilded ball above a ringed pedestal. The common pyramidal roof now uses that profile and the common hip-ridge ornament path. Seven small ornaments per pyramidal hip are a photograph-based visualization estimate; individual sculptural identities are still simplified. The apex-location test uses the actual highest vertices, rather than treating the upper 5 cm of a rounded ball as a mathematical point.

Palace-name plaques use editable SVG lettering under forgeax-engine-assets/demo-assets/palace/plaque-sources and baked 512 by 768 PNG albedo textures. The three Chinese characters are the hall names, rendered with the local Songti SC font, then imported through the ordinary CLI image route. These are legibility studies, not calligraphic facsimiles; the historical Manchu inscriptions and carved borders are not reproduced. The same tube surface now uses radial normals for smooth columns and glazed tile rolls while retaining its source geometry.

Double-eave name panels sit forward of the upper eave and within the gap above the lower curved roof. Their vertical interval derives from the same roof-rise function used by the mesh generator; panel clearance is verified against all generated triangle surfaces from a below-eave viewing ray. This replaces the earlier fixed placement that hid part of Taihedian's name behind the roof edge.

All hand-authored hall roof forms use an estimated 0.30 m tile-roll pitch on both roof directions. This removes the earlier coarse hip-roof depiction; it is not a surveyed tile dimension. Tube meshes share indexed ring vertices, retain smooth radial normals and use cylindrical UVs with one seam. Roof curves and radial tessellation are retained. Context-building roof ridges remain simplified estimates.

## Context roof partitions

`tools/roof-authoring/generate.mjs` derives a straight-skeleton partition from each eligible mapped footprint using [str8 0.5.0](https://github.com/matthewjacobson/str8) and Earcut 3.0.2. The pinned tool dependencies are isolated from the game runtime. `assets/roof-partitions.ts` contains only coordinates, triangle/ridge indices and the source-input digest; stale inputs fail the project regression. Run `npm ci --prefix tools/roof-authoring --ignore-scripts` and `node tools/roof-authoring/generate.mjs` with Node 26 (the tested host) after changing footprints.

All 1,160 eligible footprints partition successfully; the largest relative projected-area discrepancy is 1.23e-7. Retained ridge vertices and planar normals replace the coarse distance-field mesh. Pitch remains an authored estimate, scaled uniformly to at most 6 m rise. This does not identify historical roof style: [Qian Dong Wu Suo](https://www.dpm.org.cn/explore/building/236577.html), for example, includes hard-gable roofs. Generic context hips are still a visualization approximation, not surveyed reconstruction. The output footprint data retains its OSM/ODbL attribution.

OSM `height` is interpreted as the complete building height, including its roof, following [the source tag definition](https://wiki.openstreetmap.org/wiki/Key:height). The estimated roof and ridge are reserved inside that envelope; the earlier model incorrectly added them above the stated height. All 354 eligible explicitly tagged non-wall buildings are checked against their total envelope. Missing heights retain estimated 4.7 m walls; this is not additional survey evidence.

The actual `buildPalace()` entry also checks the footprint digest before constructing any geometry. A direct on-disk coordinate edit without regeneration is rejected through the real `project build` path; the previous coordinate bytes were restored after the experiment. This prevents a skipped test run from silently accepting stale derived roofs.

## Presentation sampling

The authored scene Camera uses the Engine TAA mode. Same-pose hardware comparisons showed roof and window aliasing persisted with shadows disabled; MSAA improved edge coverage and TAA reduced the remaining high-frequency patterns. TAA retained valid history during a 60-frame, 6 m camera translation. At 1280×720 it used 31,334,400 history bytes; fixed-view browser-observed cadence stayed near 33.3 ms, which is not isolated GPU timing or a worst-case performance claim. TAA also changes static image pixels as history/jitter evolves, so exact PNG equality is not a general proof of released gameplay input. No roof geometry or Engine-wide AA default was changed by this presentation choice.

### Corner towers

The [Palace Museum corner-tower entry](https://www.dpm.org.cn/explore/building/236522.html) supplies the 8.73 m square center, three-by-three bays, outer 1.60 m / inner 3.98 m projecting bays and 27.50 m ground-to-finial height. Two official photos were inspected, including the close oblique view `s5e9d3f0db3657.jpg`. The project replaces ordinary square halls with asymmetric cross-shaped walls and three interlocking roof levels. Roof elevation splits, overhangs, joinery and lattice patterns remain authored estimates. The geometry is a study, not a measured conservation model. Reference photographs remain report evidence and are not shipped game textures.

## Kunninggong elevation

The [Museum building entry](https://www.dpm.org.cn/explore/building/236487.html) establishes nine bays including corridors, three depth bays, a double-eave hip roof, an entrance east of the central bay and straight lattice windows. The official oblique photograph `s5e997ecca81fc.jpg` was inspected. Current geometry corrects the depth columns and replaces the generic south panels with window aprons, straight mullions and one east-adjacent pair of board doors. Width/depth, equal bay spacing, window proportions, roof carving and terminal corridor enclosures remain approximations; no measured-facade acceptance is claimed.
