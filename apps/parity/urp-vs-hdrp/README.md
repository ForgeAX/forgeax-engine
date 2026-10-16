# Standard lighting-lane parity fixture

Standard direct-vs-clustered pixel-parity fixture.

Renders the same scene (≤ 4 PointLight) twice — left canvas through the
Standard direct-lighting lane, right canvas through the Standard
clustered-lighting lane — and
exposes `window.__captureLeft` / `window.__captureRight` for the
`scripts/bench/pixel-parity.mjs` runner.

## AC-22 gate

- **AC-22 target** — Standard direct-vs-clustered pixel parity ε ≤ 0.001 (normalised), ≤ 4
  PointLight subset.
- **Frozen threshold** — the package metric keeps the pixel-count threshold at
  zero with per-pixel epsilon `0.001`; no empty-lane or legacy pipeline
  allowance is part of this gate.

The renderer profile and lane identity are the only configuration difference;
no pipeline registry or install step is involved.
