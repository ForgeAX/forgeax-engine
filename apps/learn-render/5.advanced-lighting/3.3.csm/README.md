# 3.3.csm：Directional CSM / PCSS MVD

这个载体复用同一个 `3.3.csm` scene 和 renderer，提供五个闭合 profile：`off`、`pcf3`、`pcf5`、`pcssMedium`、`pcssHigh`。载体只写 `DirectionalLight` author fact，并从同一个 `renderer.inspect()` 读取 backend、device generation、graph generation 和 Directional shadow inspection；算法、fallback、timing 和 RenderGraph submit 仍由 Engine 拥有。

## 运行入口

固定开发地址是 `http://127.0.0.1:5201/`。可以用 query 选择同一场景的 MVD 变量：

```text
?mvd-profile=pcssMedium&mvd-scene=near
```

profile 可选 `off`、`pcf3`、`pcf5`、`pcssMedium`、`pcssHigh`；scene 可选 `near`、`far`、`seam`、`motion`、`alpha`、`transparent`、`fallback`。键盘入口为 `o`、`3`、`5`、`m`、`h` 切换 profile，`n`、`f`、`s`、`v`、`a`、`t`、`b` 切换 scene，Space 切换 shadow off/on。

## 证据与边界

`smoke.mjs` 的 Dawn 路线使用真实 `copyTextureToBuffer` readback，并把同一帧的 RGBA hash、PNG、renderer generation 和结构化 inspection 写入 `.forgeax-debug/m4-csm-mvd/<profile>-<scene>.json`。PNG 是视觉辅助；paired readback 是数值事实，二者必须来自同一个 renderer frame。

`smoke-browser.mjs` 复用 shared RHI-debug capture，读取 live/replay pixels 并沿 shared harness 输出 PNG。若 harness 未暴露 `deviceGeneration` 或 `graphGeneration`，receipt 保留 `null` 且 verdict 不升级为完整 generation-bound 证据。WebGL2 只允许报告 fixed PCF3/PCF5 mapping；RhiNull 只允许结构化证据，不产生 pixel claim 或 GPU timing claim。

## 八项 visual expectation

Engine-owned `bindCsmMvdVisualExpectations()` 固定八项 ID：`off`、`pcf3`、`pcf5`、`pcss-medium`、`pcss-high`、`near-far`、`seam`、`motion-alpha-transparent-fallback`。调用者必须提供真实 inspect 得到的 backend 与 generation，不能使用占位 generation。

## 诚实失败

缺少 Browser WebGPU、capture hook、paired readback、PNG 或 GPU timing 时，smoke 必须输出明确的 `not-run`/environment concern。不得把 CPU wall time、RhiNull command bookkeeping、日志或缺失截图当作 GPU timing、像素通过或用户可见质量结论。

这份说明遵循 AI-user charter：输出保持稳定 ID、source/backend/generation 可机器读取，并把 unsupported、not-run 与 pass 分开，方便 AI 用户沿同一 receipt 继续诊断。
