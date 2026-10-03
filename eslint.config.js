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
                                "❌ Import SDK types and CopilotClient from src/copilotSdk/boundary.ts, the package's single SDK seam, not from @github/copilot-sdk directly.",
                        },
                    ],
                },
            ],
        },
    },
    {
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
                        "❌ Do not call CopilotClient.createSession directly. Use SessionWrapper from src/copilotSdk/sessionWrapper.ts so the session's tool policy is bound and enforced.",
                },
                {
                    selector:
                        "CallExpression[callee.property.name='resumeSession']",
                    message:
                        "❌ Do not call CopilotClient.resumeSession directly. Use SessionWrapper from src/copilotSdk/sessionWrapper.ts so the full tool policy (availableTools/onPermissionRequest/autoApproveAll) is re-derived on resume instead of risking a partial config.",
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
            // eslint-disable escape hatches.
            "@typescript-eslint/no-explicit-any": "error",
            "@typescript-eslint/ban-ts-comment": "error",
        },
    },
];
