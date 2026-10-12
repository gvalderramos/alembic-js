import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    { ignores: ['bin/**', 'bin-test/**', 'build/**', 'build-tools/**', '**/node_modules/**', 'sandbox/out/**', '.deps/**', 'dist/**', 'prebuilds/**'] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ['**/*.ts'],
        languageOptions: { globals: globals.node },
    },
    {
        // three.js is injected by the caller and intentionally untyped.
        files: ['src/three.ts'],
        rules: { '@typescript-eslint/no-explicit-any': 'off' },
    },
    {
        files: ['scripts/**/*.js'],
        languageOptions: { sourceType: 'commonjs', globals: globals.node },
        rules: { '@typescript-eslint/no-require-imports': 'off' },
    },
);
