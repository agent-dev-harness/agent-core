import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        // Tests share the workspace directory, Docker and process-level
        // state, so files run one at a time, each in a fresh worker.
        pool: 'threads',
        maxWorkers: 1,
        fileParallelism: false,
        isolate: true,
        // Tests resolve snapshots from process.cwd(); pin the root so they
        // work regardless of where vitest is launched from.
        root,
        include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    },
});
