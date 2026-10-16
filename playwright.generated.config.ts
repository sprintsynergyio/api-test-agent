import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'generated',
  testIgnore: '**/.candidate/**',
  timeout: 60_000,
  // Generated tests share one live API. Running them one at a time keeps one test from
  // changing data another test is reading.
  workers: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'reports/html', open: 'never' }],
    ['json', { outputFile: 'reports/results.json' }],
  ],
});
