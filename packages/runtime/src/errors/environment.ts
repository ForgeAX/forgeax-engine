// Runtime keeps this import path for its public assembly error contract, while
// render owns the canonical construction error and its structured details.
export {
  EngineEnvironmentError,
  type EngineEnvironmentErrorDetail,
} from '@forgeax/engine-render/internal/construct-renderer';
