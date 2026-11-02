# Modeling case gallery

Single-Pack kernel and tool cases on the Show turntable, one subject per case
(`../assets/show/gallery.ts`). A subject names its Packs; the Show shows every mesh each Pack
publishes (LOD levels excluded), with the Pack's `material/<slot>` materials where it publishes
them and the Show palette elsewhere. Same Show controls and debug panel as `../README.md`.

Add a case: re-export its Pack here (`assets/<case>.pack.ts`) and add a subject
`{ name, source, packs: [{ packageId }] }` to `GALLERY_SUBJECTS`.
