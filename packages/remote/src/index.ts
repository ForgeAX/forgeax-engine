// @forgeax/engine-remote - inspector transport and eval core.
//
// The runtime server lives under the ./server sub-path. DevKit owns the public
// command tree; AI users import the shared error model from this top entry:
//
//   import { RemoteError, type RemoteErrorCode } from '@forgeax/engine-remote';
//
// The error model SSOT (4-member closed RemoteErrorCode union) lives in
// src/errors.ts and is also exposed via the ./errors sub-path for callers that
// want type-only imports without pulling the runtime surface (D-P4 bundle
// isolation + AGENTS.md "Inspector / Console" evolution contract minor
// add-only).
//
// M2 w8: routing layer (Registry / sandbox / wireDefaultInspectors /
// register-plugin-inspector / discoverPlugins) deleted; eval is the sole
// command channel.

export { RemoteError, type RemoteErrorCode } from './errors';
