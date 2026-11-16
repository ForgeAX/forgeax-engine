import { defineResource } from '@forgeax/engine-ecs';
import type { ActionConfig } from './action-state';
import type { GamepadFeedback } from './gamepad-feedback';
import type { InputBackend, InputSnapshot } from './input-snapshot';

export const INPUT_SNAPSHOT_RESOURCE_KEY = defineResource<InputSnapshot>('InputSnapshot');

export const INPUT_MAP_KEY = defineResource<readonly ActionConfig[]>('InputMap');

export const INPUT_BACKEND_KEY = defineResource<InputBackend>('InputBackend');

export const GAMEPAD_FEEDBACK_KEY = defineResource<GamepadFeedback>('GamepadFeedback');
