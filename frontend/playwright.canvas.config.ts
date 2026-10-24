import { defineConfig } from "@playwright/test";
import documentsConfig from "./playwright.documents.config";
export default defineConfig({ ...documentsConfig, testMatch: "canvas.spec.ts" });
