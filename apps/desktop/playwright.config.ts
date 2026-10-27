import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './tests', testMatch: ['desktop.spec.ts', 'writing.spec.ts', 'spatial.spec.ts', 'account.spec.ts', 'derivatives.spec.ts'], workers: 1, timeout: 60000, expect: { timeout: 12000 }, reporter: 'list' });
