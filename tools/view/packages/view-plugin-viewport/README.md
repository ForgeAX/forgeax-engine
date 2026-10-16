# View viewport plugin

View owns input bindings, sampling and presentation placement. Engine owns the canvas, target lifetime, camera mathematics and submitted-frame picking.

### Canvas document input

`viewportInputPlugin` binds the existing `ViewWorkspaceInputController` in a document
that owns an isolated Editor canvas. The selected exact target and generation come
from the ordinary workspace state. Page or target replacement releases listeners and
cancels pending picks. Activate this plugin after `engineWorkspacePresentation` is
published; its native injection lifetime owns the admitted presentation.

Camera input uses the presentation's live target when it is in the same document.
The shared controller samples and coalesces pointer deltas once per render frame,
flushes the final delta before commit, and cancels its frame lease on retirement.
Camera math remains in Engine; workspace selection continues through the shared API.

### Play presentation lifetime

An adopted Play document remains attached and renderable until Engine acknowledges
cleanup, including Stop before its document arrives. An unselected Play is transparent
and ignores pointer input; CSS visibility must not suspend its native animation frames
while startup or cleanup still owns work. Engine remains the readiness and retirement
authority. The presentation Fiber removes the frame only after that ownership ends.

The Editor preview stays hidden while an adopted Play is starting, including after
Stop has revoked Game observations. It becomes eligible for presentation when that
Play reaches readiness or retires, so its Renderer does not compete with startup.
