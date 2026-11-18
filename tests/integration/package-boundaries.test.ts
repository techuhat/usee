import { describe, expect, it } from 'vitest';

import { APPLICATION_API_VERSION } from '@usee/application';
import { CONTRACTS_API_VERSION, desktopInvokeChannels } from '@usee/contracts';
import { DOMAIN_MODEL_VERSION } from '@usee/domain';
import {
  MANIFEST_FILE_NAME,
  PROJECT_BUNDLE_DIRECTORIES,
  PROJECT_FORMAT_VERSION,
} from '@usee/project-format';

describe('workspace packages', () => {
  it('load through their public entry points in dependency order', () => {
    expect(CONTRACTS_API_VERSION).toBe(1);
    expect(DOMAIN_MODEL_VERSION).toBe(1);
    expect(APPLICATION_API_VERSION).toBe(1);
    expect(PROJECT_FORMAT_VERSION).toBe(11);
  });

  it('expose the foundation contracts the shell relies on', () => {
    expect(desktopInvokeChannels.getRuntimeInfo.channel).toBe('desktop.app.get-runtime-info');
    expect(MANIFEST_FILE_NAME).toBe('manifest.json');
    expect(PROJECT_BUNDLE_DIRECTORIES).toContain('metadata/interactions');
  });
});
