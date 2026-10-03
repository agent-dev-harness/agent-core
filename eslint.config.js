import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [
    {
        ignores: ["dist/**"],
    },
    {
        files: ["**/*.ts"],
        languageOptions: {
            parser: tsParser,
        },
        rules: {
            "no-restricted-imports": [
                "error",
                {
                    paths: [
                        {
                            name: "@github/copilot-sdk",
                            message:
                                "❌ Import SDK types and CopilotClient from src/copilotSdk/boundary.ts, the package's single SDK seam (SYS-REQ-024), not from @github/copilot-sdk directly.",
                        },
                    ],
                },
            ],
        },
    },
    {
        // The SDK seam itself, and tests that exercise the raw SDK client or
        // capture its baseline, are the places allowed to import the SDK.
        files: [
            "src/copilotSdk/boundary.ts",
            "test/sessionWrapper.integration.test.ts",
            "test/scripts/capture-system-message-baseline.ts",
        ],
        rules: {
            "no-restricted-imports": "off",
        },
    },
    {
        // CopilotClient.createSession/resumeSession must only be
        // called from SessionWrapper (src/copilotSdk/sessionWrapper.ts), which
        // binds and re-derives a session's tool policy on every create/resume.
        // Calling either method anywhere else can silently drop
        // `availableTools`/`onPermissionRequest`/`autoApproveAll`. boundary.ts is exempt because
        // it *is* the SDK boundary -- its `super.createSession`/`super.resumeSession`
        // calls are the base-class delegation the override wraps, not a bypass.
        // sessionWrapper.ts is exempt for the same reason: it *is* the sanctioned
        // SDK entry point (SYS-REQ-026/027 families), and its own
        // `sendAndWait()` create/resume calls (SYS-REQ-027c/d) are that entry
        // point's implementation, not a bypass of it.
        // Test files are exempt where they intentionally exercise the raw SDK
        // client itself (e.g. proxy/integration tests), not SessionWrapper.
        files: ["src/**/*.ts", "scripts/**/*.ts"],
        ignores: [
            "src/copilotSdk/boundary.ts",
            "src/copilotSdk/sessionWrapper.ts",
            "**/*.test.ts",
        ],
        rules: {
            "no-restricted-syntax": [
                "error",
                {
                    selector:
                        "CallExpression[callee.property.name='createSession']",
                    message:
                        "❌ Do not call CopilotClient.createSession directly. Use SessionWrapper from src/copilotSdk/sessionWrapper.ts so the session's tool policy is bound and enforced (SYS-REQ-026/027). If this call site predates the wrapper and hasn't been migrated yet, add a documented eslint-disable-next-line referencing the issue rather than removing this rule.",
                },
                {
                    selector:
                        "CallExpression[callee.property.name='resumeSession']",
                    message:
                        "❌ Do not call CopilotClient.resumeSession directly. Use SessionWrapper from src/copilotSdk/sessionWrapper.ts so the full tool policy (availableTools/onPermissionRequest/autoApproveAll) is re-derived on resume instead of risking a partial config (SYS-REQ-026/027). If this call site predates the wrapper and hasn't been migrated yet, add a documented eslint-disable-next-line referencing the issue rather than removing this rule.",
                },
            ],
        },
    },
    {
        files: ["src/copilotSdk/boundary.ts"],
        plugins: {
            "@typescript-eslint": tsPlugin,
        },
        rules: {
            // check-explicit-any is a secondary layer that also rejects
            // eslint-disable escape hatches.
            "@typescript-eslint/no-explicit-any": "error",
            "@typescript-eslint/ban-ts-comment": "error",
        },
    },
];
