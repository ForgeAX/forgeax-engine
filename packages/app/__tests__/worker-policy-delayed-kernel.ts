// Exercise the App startup budget through a real DedicatedWorker module load.
await new Promise((resolve) => setTimeout(resolve, 6_000));
export { default } from './worker-policy-kernel';
