# Game Feedback

记录开发期间确认的 Engine、SDK、模板、构建、资产、运行时或浏览器问题。该文件会和根
`README.md` 一起原样进入 Web ZIP；不要写入 token、密码、私有 URL 或其他敏感信息。

### 2026-10-20 — Showcase contact shadows lost after inheriting camera-wide CSM coverage

- Scope: template
- Reproduction: open the unchanged Game 3D showcase with the native WebGPU renderer after #4120; inspect the player feet, pedestal and block contacts.
- Expected: centimeter-scale shadow detail throughout the small showcase.
- Actual: removing the authored 56 m shadow distance extended coverage to the camera default of 2000 m. RHI Debug measured cascade splits of 334.724 / 703.524 / 2000 m and 32.01 cm per near-cascade texel at 1280 x 720. Three 2048-square maps and the Vogel PCF filter were active. Switching only to PCF5 retained the poor coverage and did not recover the contacts.
- Evidence: before/after browser images, matching RHI replay images, depth layers and View uniform readback are attached to the fixing PR. The source regression is `apps/preview/src/__tests__/game3d-shadow-budget.unit.test.ts` in the Engine repository; it checks the actual template through native extraction at three aspect ratios.
- Status: fixed — the template explicitly uses 56 m shadow coverage. Near-cascade texels are 0.93 cm at 16:9, with the same map allocation, filter, bias, lighting and camera defaults. Engine algorithms are unchanged.

### 2026-10-20 — Newly exposed Sun parameters stayed hidden after a legacy draft open

- Scope: Engine, View, template
- Reproduction: open the original Scene and its Parameters panel, then add literal runtime parameters to `assets/scene.pack.ts` from code.
- Expected: controls appear in the existing View and immediately edit the existing Sun.
- Actual: the imported package ID prevented the first draft open; subsequent source changes did not retry it. Cold production also rejected the Scene's pure physics, Skin and sky schema imports after opting into live parameters.
- Evidence: Engine `workspace-pack-authoring.integration.test.ts`, the maintained Pack authoring browser journey, and View `docs/evidence/2026-10-20-game3d-sun/`.
- Status: fixed — source events recover the bound draft without generation or Catalog scans; View clears the old error. The generation allowlist admits the named schemas while retaining runtime-service rejection. Game3D exposes Sun color and intensity, with literal defaults as their single source. Real browsers verified both cold loading and external discovery, live lighting and Save/reopen while retaining the page and Scene target.

### 2026-10-12 — Player animation and camera were sampled in different updates

- Scope: template
- Reproduction: the native Rapier temporal-alignment regression under `assets/player/__tests__/` starts movement and advances zero, one and multiple fixed steps per Update.
- Expected: current input selects the current animation pose; Scene publishes the camera position written after physics in the same Update.
- Actual: movement changed the walk weight after animation had sampled, and camera following wrote Transform after Scene propagation. The red regression observed an unchanged joint at animation time 0.1 s and a 0.014 m camera local/world position mismatch.
- Evidence: `assets/player/__tests__/temporal-alignment.test.ts`.
- Status: fixed — input selects walk weight before animation, and camera following precedes Scene propagation. Actual phone smoothness still requires verification on the rebuilt package; this regression does not establish frame throughput.

```markdown
### YYYY-MM-DD — Short issue title

- Scope: Engine | SDK | template | build | asset | runtime | browser
- Reproduction: exact command or smallest user-visible sequence
- Expected: what should happen
- Actual: what happened
- Evidence: log, screenshot, URL, or commit path
- Status: open | workaround | fixed | blocked
```
