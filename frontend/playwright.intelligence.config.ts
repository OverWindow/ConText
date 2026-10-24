import { defineConfig } from '@playwright/test';
import config from './playwright.documents.config';
export default defineConfig({ ...config, testMatch: ['intelligence.spec.ts', 'versions.spec.ts'], workers: 2 });
