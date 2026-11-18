import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkBoundaries, WORKSPACE_RULES } from '../../scripts/check-boundaries.mjs';

const RULES = [
  {
    name: '@usee/core',
    dir: 'packages/core',
    zones: [{ dir: 'src', workspace: [], external: ['zod'], nodeBuiltins: false }],
  },
  {
    name: '@usee/app',
    dir: 'apps/app',
    zones: [
      {
        dir: 'src/main',
        workspace: ['@usee/core'],
        external: ['electron'],
        nodeBuiltins: true,
      },
      {
        dir: 'src/ui',
        workspace: ['@usee/core'],
        external: ['react'],
        nodeBuiltins: false,
      },
    ],
  },
];

let root = '';

async function write(relativePath: string, content: string): Promise<void> {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

async function writeManifest(dir: string, manifest: Record<string, unknown>): Promise<void> {
  await write(path.join(dir, 'package.json'), JSON.stringify(manifest));
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'boundaries-'));
  await writeManifest('.', {
    name: 'fixture',
    workspaces: ['packages/core', 'apps/app'],
    devDependencies: { vitest: '1.0.0' },
  });
  await writeManifest('packages/core', { name: '@usee/core', dependencies: { zod: '1' } });
  await writeManifest('apps/app', {
    name: '@usee/app',
    dependencies: { '@usee/core': '*', react: '1' },
    devDependencies: { electron: '1' },
  });
  await write(
    'packages/core/src/index.ts',
    "import { z } from 'zod';\nexport const schema = z.string();\n",
  );
  await write(
    'packages/core/src/index.test.ts',
    "import { it } from 'vitest';\nit('runs', () => {});\n",
  );
  await write(
    'apps/app/src/main/main.ts',
    "import path from 'node:path';\nimport { app } from 'electron';\nimport { schema } from '@usee/core';\nimport { helper } from './helper';\nexport { app, helper, path, schema };\n",
  );
  await write('apps/app/src/main/helper.ts', 'export const helper = 1;\n');
  await write(
    'apps/app/src/ui/view.tsx',
    "import { useState } from 'react';\nimport type { schema } from '@usee/core';\nexport { useState, type schema };\n",
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const check = () => checkBoundaries({ root, rules: RULES, testImports: ['vitest'] });

describe('checkBoundaries', () => {
  it('passes a tree that follows every rule', async () => {
    await expect(check()).resolves.toEqual([]);
  });

  it('rejects Node built-ins in a pure zone', async () => {
    await write(
      'packages/core/src/io.ts',
      "import { readFile } from 'node:fs';\nexport { readFile };\n",
    );
    await expect(check()).resolves.toEqual([
      expect.stringContaining('packages/core/src/io.ts imports Node built-in "node:fs"'),
    ]);
  });

  it('rejects platform packages in the UI zone', async () => {
    await write(
      'apps/app/src/ui/ipc.ts',
      "import { ipcRenderer } from 'electron';\nexport { ipcRenderer };\n",
    );
    await expect(check()).resolves.toEqual([
      expect.stringContaining(
        'apps/app/src/ui/ipc.ts imports "electron", which is not allowed in src/ui',
      ),
    ]);
  });

  it('rejects relative imports that cross into another zone', async () => {
    await write(
      'apps/app/src/ui/leak.ts',
      "import { helper } from '../main/helper';\nexport { helper };\n",
    );
    await expect(check()).resolves.toEqual([
      expect.stringContaining(
        'apps/app/src/ui/leak.ts imports "../main/helper", which leaves its zone',
      ),
    ]);
  });

  it('rejects deep imports into another package', async () => {
    await write('apps/app/src/main/deep.ts', "import '@usee/core/src/index';\n");
    await expect(check()).resolves.toEqual([expect.stringContaining('deep-imports')]);
  });

  it('rejects allowed packages that the manifest does not declare', async () => {
    await writeManifest('packages/core', { name: '@usee/core' });
    await expect(check()).resolves.toEqual([
      expect.stringContaining('imports "zod" without declaring it'),
    ]);
  });

  it('rejects workspace dependencies outside the rules and cycles', async () => {
    await writeManifest('packages/core', {
      name: '@usee/core',
      dependencies: { zod: '1', '@usee/app': '*' },
    });
    const violations = await check();
    expect(violations).toContainEqual(
      expect.stringContaining('declares @usee/app, which @usee/core may not use'),
    );
    expect(violations).toContainEqual(expect.stringContaining('Circular workspace dependency'));
  });

  it('rejects files outside every zone and workspaces without a rule', async () => {
    await write('apps/app/src/shared/util.ts', 'export const util = 1;\n');
    await writeManifest('.', {
      name: 'fixture',
      workspaces: ['packages/core', 'apps/app', 'apps/new'],
    });
    const violations = await check();
    expect(violations).toContainEqual(
      expect.stringContaining('apps/app/src/shared/util.ts is outside'),
    );
    expect(violations).toContainEqual(expect.stringContaining('"apps/new" has no boundary rule'));
  });

  it('ships a rule for every workspace in this repository', () => {
    const names = WORKSPACE_RULES.map((rule) => rule.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
