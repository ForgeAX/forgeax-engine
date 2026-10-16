# vendor/fbx-test ATTRIBUTION

FBX fixtures used by `feat-20260615-fbx-importer-via-sdk` (engine repo: `@forgeax/engine-fbx` + `@forgeax/hello-fbx-cube` + `@forgeax/hello-fbx-skin`).

## Files

- `cube.fbx` (12128 bytes): Sourced from Autodesk FBX SDK 2020.3.7 distribution at `samples/ConvertScene/box.fbx`. Six-faces cube fixture, 24 control points / 36 indices / 12 polygons.
- `humanoid.fbx` (8983744 bytes): Sourced from Autodesk FBX SDK 2020.3.7 distribution at `samples/ViewScene/humanoid.fbx`. Skinned humanoid mesh with 80 joints + 1605 skinned vertices + 3 animation clips ('run', 'punch', 'shot').

## License

Both files are part of the Autodesk FBX SDK 2020.3.7 sample distribution. The FBX SDK is provided by Autodesk under the Autodesk License and Services Agreement. Sample assets are reproducible from the publicly-available SDK installer:

  https://aps.autodesk.com/developer/overview/fbx-sdk

These fixtures are used here for engine smoke testing and demo purposes only. Engine consumers do not redistribute these fixtures via runtime asset packs.
