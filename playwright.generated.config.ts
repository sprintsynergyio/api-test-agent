import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'generated',
  testIgnore: '**/.candidate/**',
  timeout: 60_000,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'reports/html', open: 'never' }],
    ['json', { outputFile: 'reports/results.json' }],
  ],
});
