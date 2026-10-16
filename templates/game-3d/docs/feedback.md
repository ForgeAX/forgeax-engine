# Game Feedback

记录开发期间确认的 Engine、SDK、模板、构建、资产、运行时或浏览器问题。该文件会和根
`README.md` 一起原样进入 Web ZIP；不要写入 token、密码、私有 URL 或其他敏感信息。

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
