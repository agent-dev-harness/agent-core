// Test-support entrypoint: runner internals that app test harnesses drive
// directly (e.g. building a sandbox without initializeWorkspace()).
// Production code must use the workspace entrypoint instead.
export * as nativeRunner from './workspace/nativeRunner';
