import { defineConfig } from '@playwright/test';
import documents from './playwright.documents.config';
export default defineConfig({ ...documents, testMatch: 'sample-workspace.spec.ts', workers: 2, timeout: 45000 });
