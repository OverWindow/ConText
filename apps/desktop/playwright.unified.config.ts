import { defineConfig } from '@playwright/test';
import base from './playwright.config';
export default defineConfig({ ...base, testMatch:'unified-ui.spec.ts', outputDir:'test-results-unified-IPC', timeout:150000 });
