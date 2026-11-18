/**
 * ESLint flat config: typescript-eslint (strict, type-aware) + eslint-plugin-vue
 * (recommended) + Prettier compatibility. `any` is banned.
 */
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import pluginVue from 'eslint-plugin-vue';
import vueParser from 'vue-eslint-parser';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'src/protocol/timegrapher_hid.d.ts'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...pluginVue.configs['flat/recommended'],
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: ['.vue'],
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      'vue/multi-word-component-names': 'off',
    },
  },
  {
    files: ['**/*.mjs', '**/*.js', 'vite.config.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  prettier,
);
