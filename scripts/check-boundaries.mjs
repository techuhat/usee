// @ts-check
/**
 * Enforces the module boundaries in docs/repository-structure.md:
 * which workspace packages, third-party packages and Node built-ins each
 * source zone may import, plus no deep imports, no relative imports that
 * escape a zone, no undeclared dependencies and no workspace cycles.
 */
import { readdir, readFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript';

/**
 * @typedef {object} ZoneRule
 * @property {string} dir Source directory, relative to its workspace.
 * @property {readonly string[]} workspace Workspace packages the zone may import.
 * @property {readonly string[]} external Third-party packages the zone may import.
 * @property {boolean} nodeBuiltins Whether Node built-in modules are allowed.
 */

/**
 * @typedef {object} WorkspaceRule
 * @property {string} name Package name.
 * @property {string} dir Workspace directory, relative to the repository root.
 * @property {readonly ZoneRule[]} zones Every file under `src/` must sit in exactly one zone.
 */

const CONTRACTS = '@usee/contracts';
const DOMAIN = '@usee/domain';

/** @type {readonly WorkspaceRule[]} */
export const WORKSPACE_RULES = [
  {
    name: CONTRACTS,
    dir: 'packages/contracts',
    zones: [{ dir: 'src', workspace: [], external: ['zod'], nodeBuiltins: false }],
  },
  {
    name: DOMAIN,
    dir: 'packages/domain',
    zones: [{ dir: 'src', workspace: [CONTRACTS], external: [], nodeBuiltins: false }],
  },
  {
    name: '@usee/application',
    dir: 'packages/application',
    zones: [{ dir: 'src', workspace: [CONTRACTS, DOMAIN], external: [], nodeBuiltins: false }],
  },
  {
    name: '@usee/project-format',
    dir: 'packages/project-format',
    zones: [{ dir: 'src', workspace: [CONTRACTS, DOMAIN], external: ['zod'], nodeBuiltins: false }],
  },
  {
    name: '@usee/adapter-recorder-host',
    dir: 'packages/adapter-recorder-host',
    zones: [
      {
        dir: 'src',
        workspace: [CONTRACTS, '@usee/application'],
        external: [],
        nodeBuiltins: true,
      },
    ],
  },
  {
    name: '@usee/adapter-project-fs',
    dir: 'packages/adapter-project-fs',
    zones: [
      {
        dir: 'src',
        workspace: [CONTRACTS, DOMAIN, '@usee/application', '@usee/project-format'],
        external: [],
        nodeBuiltins: true,
      },
    ],
  },
  {
    name: '@usee/adapter-ffmpeg',
    dir: 'packages/adapter-ffmpeg',
    zones: [
      {
        dir: 'src',
        workspace: [CONTRACTS, DOMAIN, '@usee/application'],
        external: [],
        nodeBuiltins: true,
      },
    ],
  },
  {
    name: '@usee/desktop',
    dir: 'apps/desktop',
    zones: [
      {
        dir: 'src/main',
        workspace: [
          CONTRACTS,
          '@usee/application',
          '@usee/adapter-recorder-host',
          '@usee/adapter-project-fs',
          '@usee/adapter-ffmpeg',
          '@usee/domain',
        ],
        external: ['electron'],
        nodeBuiltins: true,
      },
      { dir: 'src/preload', workspace: [CONTRACTS], external: ['electron'], nodeBuiltins: false },
      {
        // Domain is pure: the preview evaluates camera, blur and cursor with the
        // same functions export will use, while main keeps the project truth.
        dir: 'src/renderer',
        workspace: [CONTRACTS, DOMAIN],
        external: ['react', 'react-dom', 'zustand'],
        nodeBuiltins: false,
      },
    ],
  },
];

/** Packages any `*.test.ts(x)` file may import in addition to its zone's allowances. */
export const TEST_IMPORTS = ['vitest'];

const WORKSPACE_SCOPE = '@usee/';
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const TEST_FILE = /\.test\.tsx?$/;
const SKIPPED_DIRECTORIES = new Set(['dist', 'node_modules', 'coverage']);
const NODE_BUILTINS = new Set(builtinModules);

/** @param {string} specifier */
function packageNameOf(specifier) {
  const segments = specifier.split('/');
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : (segments[0] ?? specifier);
}

/** @param {string} specifier */
function isNodeBuiltin(specifier) {
  return specifier.startsWith('node:') || NODE_BUILTINS.has(packageNameOf(specifier));
}

/** @param {string} child @param {string} parent */
function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** @param {string} root @param {string} filePath */
function display(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/');
}

/** @param {string} directory @returns {Promise<string[]>} */
async function collectSourceFiles(directory) {
  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name)) {
      files.push(...(await collectSourceFiles(entryPath)));
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(entryPath);
    }
  }
  return files;
}

/** @param {string} filePath */
async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

/** @param {Record<string, unknown>} manifest @returns {Set<string>} */
function declaredDependencies(manifest) {
  /** @type {Set<string>} */
  const names = new Set();
  for (const field of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    const block = manifest[field];
    if (block && typeof block === 'object') {
      for (const name of Object.keys(block)) {
        names.add(name);
      }
    }
  }
  return names;
}

/**
 * @param {{ root: string, rules?: readonly WorkspaceRule[], testImports?: readonly string[] }} options
 * @returns {Promise<string[]>} One message per violation; empty when the tree is clean.
 */
export async function checkBoundaries({
  root,
  rules = WORKSPACE_RULES,
  testImports = TEST_IMPORTS,
}) {
  /** @type {string[]} */
  const violations = [];
  const rootManifest = await readJson(path.join(root, 'package.json'));
  const rootDependencies = declaredDependencies(rootManifest);

  const declaredWorkspaces = Array.isArray(rootManifest.workspaces) ? rootManifest.workspaces : [];
  for (const workspaceDir of declaredWorkspaces) {
    if (!rules.some((rule) => rule.dir === workspaceDir)) {
      violations.push(`Workspace "${workspaceDir}" has no boundary rule in check-boundaries.mjs.`);
    }
  }

  /** @type {Map<string, string[]>} */
  const workspaceGraph = new Map();

  for (const rule of rules) {
    const workspaceRoot = path.join(root, rule.dir);
    const manifestPath = path.join(workspaceRoot, 'package.json');
    const manifest = await readJson(manifestPath);
    const manifestLabel = display(root, manifestPath);

    if (manifest.name !== rule.name) {
      violations.push(`${manifestLabel} is named "${manifest.name}", expected "${rule.name}".`);
    }

    const declared = declaredDependencies(manifest);
    const allowedWorkspace = new Set(rule.zones.flatMap((zone) => zone.workspace));
    const workspaceDependencies = [...declared].filter((name) => name.startsWith(WORKSPACE_SCOPE));
    workspaceGraph.set(rule.name, workspaceDependencies);
    for (const dependency of workspaceDependencies) {
      if (!allowedWorkspace.has(dependency)) {
        violations.push(`${manifestLabel} declares ${dependency}, which ${rule.name} may not use.`);
      }
    }

    const zones = rule.zones
      .map((zone) => ({ ...zone, absoluteDir: path.join(workspaceRoot, zone.dir) }))
      .sort((left, right) => right.absoluteDir.length - left.absoluteDir.length);
    /** @param {string} filePath */
    const zoneOf = (filePath) => zones.find((zone) => isInside(filePath, zone.absoluteDir));

    for (const filePath of await collectSourceFiles(path.join(workspaceRoot, 'src'))) {
      const label = display(root, filePath);
      const zone = zoneOf(filePath);
      if (zone === undefined) {
        violations.push(`${label} is outside every boundary zone of ${rule.name}.`);
        continue;
      }

      const isTest = TEST_FILE.test(filePath);
      const source = await readFile(filePath, 'utf8');
      const preprocessed = ts.preProcessFile(source, true, true);
      const specifiers = [
        ...preprocessed.importedFiles.map((reference) => reference.fileName),
        ...preprocessed.typeReferenceDirectives.map((reference) => reference.fileName),
      ];

      for (const specifier of specifiers) {
        if (specifier.startsWith('.')) {
          const target = path.resolve(path.dirname(filePath), specifier);
          if (zoneOf(target) !== zone) {
            violations.push(
              `${label} imports "${specifier}", which leaves its zone (${zone.dir}).`,
            );
          }
          continue;
        }

        if (path.isAbsolute(specifier) || /^[A-Za-z]:/.test(specifier)) {
          violations.push(`${label} imports the absolute path "${specifier}".`);
          continue;
        }

        if (specifier.startsWith(WORKSPACE_SCOPE)) {
          const name = packageNameOf(specifier);
          if (specifier !== name) {
            violations.push(`${label} deep-imports "${specifier}"; import "${name}" instead.`);
          } else if (name === rule.name) {
            violations.push(`${label} imports its own package "${name}".`);
          } else if (!zone.workspace.includes(name)) {
            violations.push(
              `${label} imports ${name}, which ${zone.dir} of ${rule.name} may not use.`,
            );
          } else if (!declared.has(name)) {
            violations.push(`${label} imports ${name} without declaring it in ${manifestLabel}.`);
          }
          continue;
        }

        if (isNodeBuiltin(specifier)) {
          if (!zone.nodeBuiltins) {
            violations.push(
              `${label} imports Node built-in "${specifier}", forbidden in ${zone.dir}.`,
            );
          }
          continue;
        }

        const name = packageNameOf(specifier);
        const isTestImport = isTest && testImports.includes(name);
        if (!zone.external.includes(name) && !isTestImport) {
          violations.push(`${label} imports "${name}", which is not allowed in ${zone.dir}.`);
        } else if (!declared.has(name) && !(isTestImport && rootDependencies.has(name))) {
          violations.push(`${label} imports "${name}" without declaring it in ${manifestLabel}.`);
        }
      }
    }
  }

  violations.push(...findCycles(workspaceGraph));
  return violations;
}

/** @param {Map<string, string[]>} graph @returns {string[]} */
function findCycles(graph) {
  /** @type {string[]} */
  const cycles = [];
  /** @type {Set<string>} */
  const done = new Set();
  /** @type {string[]} */
  const stack = [];

  /** @param {string} name */
  const visit = (name) => {
    if (done.has(name)) {
      return;
    }
    const index = stack.indexOf(name);
    if (index !== -1) {
      cycles.push(`Circular workspace dependency: ${[...stack.slice(index), name].join(' -> ')}.`);
      return;
    }
    stack.push(name);
    for (const dependency of graph.get(name) ?? []) {
      if (graph.has(dependency)) {
        visit(dependency);
      }
    }
    stack.pop();
    done.add(name);
  };

  for (const name of graph.keys()) {
    visit(name);
  }
  return cycles;
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const violations = await checkBoundaries({ root });
  if (violations.length > 0) {
    process.stderr.write(`Boundary check failed (${violations.length}):\n`);
    for (const violation of violations) {
      process.stderr.write(`  - ${violation}\n`);
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write('Boundary check passed.\n');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(
      `Boundary check crashed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
