// @ts-check
/**
 * Starts Electron with a clean environment. Shells spawned by VS Code
 * extensions inherit ELECTRON_RUN_AS_NODE=1, which turns electron.exe into
 * plain Node and makes the app fail with "bad option" errors.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
/** In Node, the electron package exports the path of its binary. */
const electronBinary = /** @type {string} */ (require('electron'));

const { ELECTRON_RUN_AS_NODE: _ignored, ...environment } = process.env;

const child = spawn(electronBinary, process.argv.slice(2), { stdio: 'inherit', env: environment });

for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) {
  process.on(signal, () => child.kill(signal));
}

child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal === null ? 0 : 1);
});
