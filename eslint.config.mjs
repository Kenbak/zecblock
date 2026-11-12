import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  {
    // Adopt linting without converting the entire existing data-heavy UI in
    // one unsafe mechanical pass. These high-noise rules remain warnings or
    // are deferred; correctness, Hooks dependency, Next.js, and jsx-a11y
    // rules continue to fail CI.
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      'react-hooks/purity': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/static-components': 'off',
      'react-hooks/use-memo': 'off',
      'react/no-unescaped-entities': 'off',
    },
  },
  {
    files: ['server/**/*.js', 'scripts/**/*.js', 'scripts/**/*.mjs', 'zcg/**/*.js'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      '@next/next/no-assign-module-variable': 'off',
    },
  },
  globalIgnores([
    '.next/**',
    'server/vendor/**',
    'vendor/**',
    '.netlify/**',
    '.vercel/**',
    'coverage/**',
    'output/**',
    'public/wasm/**',
    'wasm/pkg/**',
    'packages/zcash-decoder/dist/**',
    'packages/zcash-decoder/wasm/**',
    'server/api/openapi/**',
    // Standalone apps with their own build (private explorer).
    'prototype/**',
  ]),
]);
