import { defineConfig } from 'tsup';
import runtimeConfig from './tsup.runtime.config.js';
import cliConfig from './tsup.cli.config.js';

// Keep `tsup --watch` and ad-hoc tooling compatible with the aggregate config.
// Release builds use the sequential scripts in package.json.
export default defineConfig([runtimeConfig, cliConfig]);
