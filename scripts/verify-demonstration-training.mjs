#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBrowserJourney } from './verify-platform-plugin-browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
verifyBrowserJourney({
  trainBC: true,
  defaultOutput: path.join(root, 'dist/testing/demonstration-training.json'),
}).catch((error) => {
  console.error(error.message);
  process.exitCode = error.exitCode ?? 1;
});
