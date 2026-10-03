/**
 * agent-core boundary guard.
 *
 * Fails if any file under a target root (src/, test/, scripts/) imports
 * anything that resolves outside the package directory, with two exceptions:
 *   - Node builtins and the bare packages in ALLOWED_BARE_SPECS (the
 *     package's fixed third-party surface);
 *   - entries in KNOWN_VIOLATIONS, an allowlist of known outside imports.
 *     It is empty, so every outside import fails.
 *
 * Checked import forms: static `import ... from`, `export ... from`,
 * dynamic `import()`, `require()`, type-position `import("...").T`, and
 * `vi.mock`/`jest.mock` string paths. Dynamic forms are the reason this
 * guard exists: a dynamic `import()` of code outside the package is
 * invisible to a static import scan and to `no-restricted-imports`.
 *
 * KNOWN_VIOLATIONS is a ratchet: it may only shrink. An entry whose
 * violation no longer occurs is stale and fails the guard, so removed
 * imports force entry deletion instead of letting the list rot.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isBuiltin } from 'node:module';
import ts from 'typescript';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

// Every root is checked against the whole package directory (REPO_ROOT), so
// test/ may import src/ but nothing may reach outside the package. The guard
// fails loudly rather than silently no-oping if a root is missing.
const TARGET_ROOTS: readonly string[] = ['src', 'test', 'scripts'];

// Third-party packages agent-core may import directly: @github/copilot-sdk,
// plus vitest for the in-tree tests. Node builtins are always allowed.
// `express` is the package's optional peer dependency — it is confined to the
// proxy/ subdirectory (the ./proxy subpath), which is the only agent-core
// module that touches it.
const ALLOWED_BARE_SPECS: ReadonlySet<string> = new Set([
    '@github/copilot-sdk',
    'vitest',
    'express',
    // Test and tooling dependencies (devDependencies): the CapiProxy test
    // harness parses YAML snapshots; the lint scripts use the TS compiler.
    'yaml',
    'typescript',
]);

interface KnownViolation {
    /** Repo-root-relative POSIX path of the file containing the import. */
    file: string;
    /** Module specifier exactly as written in the source. */
    spec: string;
    /** Tracking number for the entry, printed alongside it. */
    backEdge: number;
}

// The allowlist is empty — any violation fails the guard outright. Keyed by
// (file, spec) so entries survive line shifts.
const KNOWN_VIOLATIONS: readonly KnownViolation[] = [];

type ViolationKind =
    | 'static-import'
    | 'export-from'
    | 'dynamic-import'
    | 'dynamic-import-non-literal'
    | 'require'
    | 'require-non-literal'
    | 'type-import'
    | 'module-mock';

interface FoundImport {
    /** Repo-root-relative POSIX path of the file containing the import. */
    file: string;
    line: number;
    spec: string;
    kind: ViolationKind;
}

function toRepoRel(absPath: string): string {
    return path.relative(REPO_ROOT, absPath).split(path.sep).join('/');
}

function isInside(target: string, rootAbs: string): boolean {
    const rel = path.relative(rootAbs, target);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * True if `spec`, imported from `absFile`, stays inside `rootAbs` (or is a
 * permitted bare specifier). Non-literal dynamic specifiers are handled by
 * the caller — they can never be proven to stay inside.
 */
function resolvesInsideTree(spec: string, absFile: string, rootAbs: string): boolean {
    if (spec.startsWith('./') || spec.startsWith('../')) {
        return isInside(path.resolve(path.dirname(absFile), spec), rootAbs);
    }
    if (spec.startsWith('@/')) {
        // tsconfig paths: "@/*": ["./*"] — alias to the repo root.
        return isInside(path.resolve(REPO_ROOT, spec.slice('@/'.length)), rootAbs);
    }
    // Bare specifier: Node builtin or an allowlisted third-party package.
    if (isBuiltin(spec)) {
        return true;
    }
    return ALLOWED_BARE_SPECS.has(spec);
}

function getLine(sourceFile: ts.SourceFile, node: ts.Node): number {
    return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function specifierText(node: ts.Expression | undefined): string | undefined {
    return node !== undefined && ts.isStringLiteral(node) ? node.text : undefined;
}

function collectImportsFromFile(absFile: string): FoundImport[] {
    const content = fs.readFileSync(absFile, 'utf8');
    const sourceFile = ts.createSourceFile(absFile, content, ts.ScriptTarget.Latest, true);
    const repoRel = toRepoRel(absFile);
    const found: FoundImport[] = [];

    function record(node: ts.Node, spec: string, kind: ViolationKind): void {
        found.push({ file: repoRel, line: getLine(sourceFile, node), spec, kind });
    }

    function visit(node: ts.Node): void {
        if (ts.isImportDeclaration(node)) {
            const spec = specifierText(node.moduleSpecifier);
            if (spec !== undefined) {
                record(node, spec, 'static-import');
            }
        } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
            const spec = specifierText(node.moduleSpecifier);
            if (spec !== undefined) {
                record(node, spec, 'export-from');
            }
        } else if (ts.isImportTypeNode(node)) {
            // Type-position import("...").T — e.g. `import("express").Response`.
            const arg = node.argument;
            const literal = ts.isLiteralTypeNode(arg) ? arg.literal : arg;
            const spec = ts.isStringLiteral(literal) ? literal.text : undefined;
            if (spec !== undefined) {
                record(node, spec, 'type-import');
            }
        } else if (ts.isCallExpression(node)) {
            if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
                const spec = specifierText(node.arguments[0]);
                if (spec !== undefined) {
                    record(node, spec, 'dynamic-import');
                } else {
                    // Cannot be proven to stay inside the tree.
                    record(node, '<non-literal>', 'dynamic-import-non-literal');
                }
            } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
                const spec = specifierText(node.arguments[0]);
                if (spec !== undefined) {
                    record(node, spec, 'require');
                } else {
                    record(node, '<non-literal>', 'require-non-literal');
                }
            } else if (
                ts.isPropertyAccessExpression(node.expression) &&
                ts.isIdentifier(node.expression.expression) &&
                (node.expression.expression.text === 'vi' || node.expression.expression.text === 'jest') &&
                (node.expression.name.text === 'mock' || node.expression.name.text === 'doMock')
            ) {
                const spec = specifierText(node.arguments[0]);
                if (spec !== undefined) {
                    record(node, spec, 'module-mock');
                }
            }
        }
        ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return found;
}

function walkTsFiles(dir: string): string[] {
    const results: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const filePath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...walkTsFiles(filePath));
        } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
            results.push(filePath);
        }
    }
    return results;
}

function main(): void {
    console.log('=== agent-core boundary guard ===');

    const missingRoots = TARGET_ROOTS.filter((root) => !fs.existsSync(path.join(REPO_ROOT, root)));
    if (missingRoots.length > 0) {
        console.error('\n❌ ERROR: Expected target root(s) do not exist:\n');
        for (const root of missingRoots) {
            console.error(`  ${root}`);
        }
        console.error(
            '\nThis usually means the source tree has been reorganized and TARGET_ROOTS is stale. ' +
            'Update scripts/check-boundary.ts rather than letting this check silently no-op.\n'
        );
        process.exit(1);
    }

    const files: string[] = [];
    for (const root of TARGET_ROOTS) {
        const rootAbs = path.join(REPO_ROOT, root);
        const rootFiles = walkTsFiles(rootAbs);
        if (rootFiles.length === 0) {
            console.error(`\n❌ ERROR: Target root "${root}" exists but contains no .ts/.tsx files. Refusing to silently pass.\n`);
            process.exit(1);
        }
        files.push(...rootFiles);
    }
    console.log(`Scanning ${TARGET_ROOTS.length} root(s), ${files.length} file(s): ${TARGET_ROOTS.join(', ')}`);

    const found: FoundImport[] = [];
    for (const absFile of files) {
        found.push(...collectImportsFromFile(absFile));
    }

    // Classify each found import against the package directory.
    const boundaryViolations = found.filter(
        (imp) => !resolvesInsideTree(imp.spec, path.join(REPO_ROOT, imp.file), REPO_ROOT),
    );

    const allowlistKeys = new Map<string, KnownViolation>();
    for (const known of KNOWN_VIOLATIONS) {
        allowlistKeys.set(`${known.file}::${known.spec}`, known);
    }

    const matchedKeys = new Set<string>();
    const fresh: FoundImport[] = [];
    for (const imp of boundaryViolations) {
        const key = `${imp.file}::${imp.spec}`;
        if (allowlistKeys.has(key)) {
            matchedKeys.add(key);
        } else {
            fresh.push(imp);
        }
    }
    const stale = [...allowlistKeys.keys()].filter((key) => !matchedKeys.has(key));

    if (matchedKeys.size > 0) {
        console.log(`\nAllowlisted outside imports (KNOWN_VIOLATIONS — may only shrink): ${matchedKeys.size}/${KNOWN_VIOLATIONS.length} entries still active`);
        for (const imp of boundaryViolations) {
            const known = allowlistKeys.get(`${imp.file}::${imp.spec}`);
            if (known) {
                console.log(`  [entry ${known.backEdge}] ${imp.file}:${imp.line}  "${imp.spec}"  (${imp.kind})`);
            }
        }
    }

    let failed = false;
    if (fresh.length > 0) {
        failed = true;
        console.error('\n❌ NEW boundary violation(s) — agent-core importing from outside its own tree, not in KNOWN_VIOLATIONS:');
        for (const imp of fresh) {
            console.error(`  ${imp.file}:${imp.line}  "${imp.spec}"  (${imp.kind})`);
        }
        console.error('\nagent-core must not import from outside the package. ' +
            'Fix the import; do not add a KNOWN_VIOLATIONS entry without owner sign-off.\n');
    }
    if (stale.length > 0) {
        failed = true;
        const noun = stale.length === 1 ? 'entry' : 'entries';
        console.error(`\n❌ Stale KNOWN_VIOLATIONS ${noun} — the violation no longer occurs; delete the ${noun} (the allowlist may only shrink):`);
        for (const key of stale) {
            const known = allowlistKeys.get(key);
            if (known) {
                console.error(`  [entry ${known.backEdge}] ${known.file}  "${known.spec}"`);
            }
        }
        console.error('');
    }

    if (failed) {
        process.exit(1);
    }

    console.log(`\n✅ Boundary clean: ${boundaryViolations.length} import(s) outside the tree, all covered by KNOWN_VIOLATIONS (${KNOWN_VIOLATIONS.length} entries, ${matchedKeys.size} active).`);
    process.exit(0);
}

main();
