import obsidianmd from 'eslint-plugin-obsidianmd';
import tseslint from 'typescript-eslint';

/**
 * Mirrors the automated checks that run when a community release is scanned.
 * `src/web-client.ts` is not Obsidian plugin code: it is serialized into the
 * HTML pages served by the local API and runs in a plain browser, so the
 * Obsidian DOM/settings rules do not apply there.
 */
export default tseslint.config(
  { ignores: ['main.js', 'cli.mjs', 'node_modules/**', 'tests/**'] },
  ...obsidianmd.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    files: ['src/**/*.ts'],
    // The community review reports type-safety findings as warnings; keep them visible without failing lint.
    rules: {
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unnecessary-type-assertion': 'warn',
      'no-control-regex': 'warn',
      '@typescript-eslint/no-deprecated': 'warn',
    },
  },
  {
    // Standalone Node CLI distributed as cli.mjs: printing to the terminal is the product.
    files: ['src/cli.ts'],
    rules: {
      'no-console': 'off',
      'obsidianmd/rule-custom-message': 'off',
      'obsidianmd/prefer-window-timers': 'off',
    },
  },
  {
    files: ['src/web-client.ts'],
    rules: {
      // Browser page script: Obsidian's createEl/setCssProps/instanceOf helpers do not exist here.
      'obsidianmd/prefer-create-el': 'off',
      'obsidianmd/prefer-instanceof': 'off',
      'obsidianmd/no-static-styles-assignment': 'error',
      'no-unsanitized/property': 'error',
      'no-unsanitized/method': 'error',
      'obsidianmd/prefer-window-timers': 'off',
      'obsidianmd/prefer-active-doc': 'off',
      'no-restricted-syntax': 'off',
      'no-alert': 'off',
    },
  },
);
