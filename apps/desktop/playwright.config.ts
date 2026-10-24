import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './tests', testMatch: 'desktop.spec.ts', workers: 1, timeout: 60000, expect: { timeout: 12000 }, reporter: 'list' });
