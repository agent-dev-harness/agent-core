import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';

const entryPoints = [
    'src/index.ts',
    'src/workspace/index.ts',
    'src/proxy/index.ts',
    'src/types.ts',
];

rmSync('dist', { recursive: true, force: true });

// splitting keeps one copy of each shared module across entrypoints; without
// it, module-level state (the workspace runner and GitSandbox singletons)
// would be duplicated per entrypoint and initializeWorkspace() from
// ./workspace would not be seen by the root entrypoint's code.
await build({
    entryPoints,
    outbase: 'src',
    outdir: 'dist',
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    packages: 'external',
    sourcemap: true,
    tsconfig: 'tsconfig.json',
});

execFileSync('npx', ['tsc', '-p', 'tsconfig.build.json'], { stdio: 'inherit' });
