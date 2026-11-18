// @ts-check
/**
 * Builds and tests native/recorder-host with CMake + Ninja inside a Visual
 * Studio developer environment. Uses the CMake and Ninja bundled with Visual
 * Studio when they are not on PATH.
 *
 *   node scripts/build-native.mjs [--debug] [--no-tests]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDirectory = path.join(root, 'native', 'recorder-host');
const configuration = process.argv.includes('--debug') ? 'Debug' : 'Release';
const runTests = !process.argv.includes('--no-tests');
const buildDirectory = path.join(sourceDirectory, 'build', configuration.toLowerCase());

if (process.platform !== 'win32') {
  process.stderr.write('The recorder host builds on Windows only.\n');
  process.exit(1);
}

// Shells such as Git Bash drop variables with parentheses, but vcvars64.bat
// needs ProgramFiles(x86) to find vswhere and the toolchain.
const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
const vswhere = path.join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
if (!existsSync(vswhere)) {
  process.stderr.write('Visual Studio Build Tools with the C++ workload are required.\n');
  process.exit(1);
}

const installation = execFileSync(
  vswhere,
  [
    '-latest',
    '-products',
    '*',
    '-requires',
    'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '-property',
    'installationPath',
  ],
  { encoding: 'utf8' },
).trim();
if (installation === '') {
  process.stderr.write('No Visual Studio installation with the x64 C++ tools was found.\n');
  process.exit(1);
}

const vcvars = path.join(installation, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
const bundled = path.join(installation, 'Common7', 'IDE', 'CommonExtensions', 'Microsoft', 'CMake');
// cmd expands %VARS% when it parses the whole line, before vcvars runs, so
// extra PATH entries are passed through the environment instead.
const steps = [
  `call "${vcvars}" >nul`,
  `cmake -S "${sourceDirectory}" -B "${buildDirectory}" -G Ninja -DCMAKE_BUILD_TYPE=${configuration} -DCMAKE_CXX_COMPILER=cl`,
  `cmake --build "${buildDirectory}"`,
  ...(runTests ? [`ctest --test-dir "${buildDirectory}" --output-on-failure`] : []),
];

// VsDevCmd.bat runs vswhere.exe from its own directory, which
// NoDefaultCurrentDirectoryInExePath (set by some sandboxed shells) forbids.
const { NoDefaultCurrentDirectoryInExePath: _ignored, ...inherited } = process.env;
const result = spawnSync('cmd.exe', ['/d', '/s', '/c', `"${steps.join(' && ')}"`], {
  stdio: 'inherit',
  windowsVerbatimArguments: true,
  env: {
    ...inherited,
    'ProgramFiles(x86)': programFilesX86,
    ProgramFiles: process.env['ProgramFiles'] ?? 'C:\\Program Files',
    PATH: [
      process.env['PATH'] ?? '',
      path.join(bundled, 'CMake', 'bin'),
      path.join(bundled, 'Ninja'),
    ].join(path.delimiter),
  },
});
process.exitCode = result.status ?? 1;
