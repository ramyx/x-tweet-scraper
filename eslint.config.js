import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-restricted-syntax': [
        'error',
        {
          // Assessment §6: the cap must be enforced where results are emitted, and
          // must not be bypassable. That only holds if there is exactly one write
          // path to the dataset. `quota.ts` is exempted in its own override below.
          selector: "CallExpression[callee.property.name='pushData']",
          message: 'pushData() is only allowed in src/domain/quota.ts (free-tier enforcement point).',
        },
      ],
    },
  },
  {
    files: ['src/domain/quota.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
);
