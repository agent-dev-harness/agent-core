// Installs the packed package into a throwaway consumer project and checks it the way a consumer
// sees it: every entrypoint loads with import and require(), exports exactly the README's names,
// and type-checks under moduleResolution nodenext without any export collapsing to `any`.
// npm pack runs the prepare script, so this checks a fresh build, as a GitHub install does.
// Usage: npm run check:consumer   (needs the npm registry)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = '@agent-dev-harness/agent-core';

// The README "Entrypoints" table. Changing a list here means the public API changed.
const RUNTIME_EXPORTS: Readonly<Record<string, readonly string[]>> = {
    [PKG]: [
        'CopilotClient', 'LIST_TERMINAL_DOCKER_TOOL', 'OPENROUTER_SESSION_ID_HEADER', 'PROVIDERS',
        'ProviderRegistry', 'READ_TERMINAL_DOCKER_TOOL', 'RUN_TERMINAL_DOCKER_TOOL',
        'STOP_TERMINAL_DOCKER_TOOL', 'SessionWrapper', 'SlidingWindowCircularBuffer',
        'TERMINAL_DOCKER_TOOLS', 'WRITE_TERMINAL_DOCKER_TOOL', 'cleanSubprocessLogs', 'clearCleanCache',
        'defineTool', 'enforceWorkingMemoryTruncation', 'isProviderType', 'makeRunTerminalDockerHandler',
        'makeTerminalDockerHandlers', 'parseExecToolArgs', 'runForcedToolTurnUntilTimeout',
        'truncateExecResult',
    ],
    [`${PKG}/workspace`]: [
        'GitSandbox', 'TRAVERSAL_ERROR', 'getExecCommand', 'getGitSandbox', 'getWorkspaceHostLocation',
        'getWorkspaceRoot', 'initializeWorkspace', 'killProcessGroup', 'resolveWorkDir',
    ],
    [`${PKG}/proxy`]: ['OPENROUTER_SESSION_ID_HEADER', 'mountProviderProxyRoute'],
    [`${PKG}/types`]: [],
};

const TYPE_CHECK = `
import { SessionWrapper, ProviderRegistry, makeTerminalDockerHandlers, runForcedToolTurnUntilTimeout } from '${PKG}';
import { initializeWorkspace, GitSandbox } from '${PKG}/workspace';
import { mountProviderProxyRoute } from '${PKG}/proxy';
import type { CopilotSession, SessionEvent } from '${PKG}/types';

type IsAny<T> = 0 extends 1 & T ? true : false;
const notAny: [
    IsAny<typeof SessionWrapper>, IsAny<typeof ProviderRegistry>, IsAny<typeof makeTerminalDockerHandlers>,
    IsAny<typeof runForcedToolTurnUntilTimeout>, IsAny<typeof initializeWorkspace>, IsAny<typeof GitSandbox>,
    IsAny<typeof mountProviderProxyRoute>, IsAny<CopilotSession>, IsAny<SessionEvent>,
] = [false, false, false, false, false, false, false, false, false];
export { notAny };
`;

function run(cwd: string, command: string, args: string[]): string {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout}${result.stderr}${result.error ?? ''}`);
    }
    return result.stdout;
}

function main(): void {
    const repoPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
        devDependencies: Record<string, string>;
    };
    const devVersion = (name: string): string => `${name}@${repoPkg.devDependencies[name]}`;

    const consumer = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-core-consumer-'));
    try {
        console.log(`=== consumer project: ${consumer} ===`);
        const tarball = run(REPO_ROOT, 'npm', ['pack', '--silent', '--pack-destination', consumer]).trim();
        fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
        run(consumer, 'npm', [
            'install', '--no-audit', '--no-fund', path.join(consumer, tarball),
            devVersion('express'), devVersion('typescript'), devVersion('@types/node'), devVersion('@types/express'),
        ]);

        const expected = JSON.stringify(RUNTIME_EXPORTS);
        fs.writeFileSync(path.join(consumer, 'esm.mjs'),
            `const expected = ${expected};\nconst actual = {};\n` +
            `for (const spec of Object.keys(expected)) actual[spec] = Object.keys(await import(spec)).sort();\n` +
            'console.log(JSON.stringify(actual));\n');
        fs.writeFileSync(path.join(consumer, 'cjs.cjs'),
            `const expected = ${expected};\nconst actual = {};\n` +
            `for (const spec of Object.keys(expected)) actual[spec] = Object.keys(require(spec)).sort();\n` +
            'console.log(JSON.stringify(actual));\n');
        const want = JSON.stringify(Object.fromEntries(
            Object.entries(RUNTIME_EXPORTS).map(([spec, names]) => [spec, [...names].sort()]),
        ));
        const failures: string[] = [];
        for (const loader of ['esm.mjs', 'cjs.cjs']) {
            const got = run(consumer, process.execPath, [loader]).trim();
            console.log(`${got === want ? 'PASS' : 'FAIL'}  ${loader}: entrypoints load and export the README's names`);
            if (got !== want) failures.push(`${loader}\n  expected ${want}\n  actual   ${got}`);
        }

        fs.writeFileSync(path.join(consumer, 'consumer.ts'), TYPE_CHECK);
        fs.writeFileSync(path.join(consumer, 'tsconfig.json'), JSON.stringify({
            compilerOptions: {
                module: 'nodenext', moduleResolution: 'nodenext', target: 'ES2022', strict: true,
                noEmit: true, types: ['node'],
            },
            files: ['consumer.ts'],
        }));
        const tsc = spawnSync(process.execPath, [path.join(consumer, 'node_modules/typescript/bin/tsc'), '-p', '.'],
            { cwd: consumer, encoding: 'utf8' });
        console.log(`${tsc.status === 0 ? 'PASS' : 'FAIL'}  tsc (nodenext): declarations resolve and no export is any`);
        if (tsc.status !== 0) failures.push(`tsc\n${tsc.stdout}${tsc.stderr}`);

        if (failures.length > 0) {
            console.error(`\n❌ Consumer check failed:\n${failures.join('\n')}`);
            process.exit(1);
        }
        console.log('\n✅ The packed package works for an ESM, CommonJS and nodenext TypeScript consumer.');
    } finally {
        fs.rmSync(consumer, { recursive: true, force: true });
    }
}

main();
