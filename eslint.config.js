// ESLint 9 flat config.
// Follows the style rules in AGENTS.md. Rules are intentionally lenient for the
// initial rollout (see TESTING_INFRASTRUCTURE_PLAN.md "Risk Mitigation"): start
// with warnings, tighten gradually.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
    {
        ignores: ['dist/', 'node_modules/', 'data/', '*.js', '*.mjs', '*.cjs', 'src/client/**'],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    prettier,
    {
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
        },
        rules: {
            '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
            '@typescript-eslint/no-explicit-any': 'warn',
            'no-console': ['warn', { allow: ['warn', 'error'] }],
            'no-var': 'error',
            'prefer-const': 'error',
        },
    },
);
