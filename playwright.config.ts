import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/template',
  timeout: 60_000,
  reporter: 'list',
});
