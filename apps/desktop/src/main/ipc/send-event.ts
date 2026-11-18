import type { WebContents } from 'electron';

import { parseEventPayload, type EventChannel, type EventPayload } from '@usee/contracts';

/**
 * Sends a schema-checked notification to a trusted page. Payloads are checked
 * before they leave main, as docs/ipc.md requires for main → renderer events.
 */
export function sendEvent<Channel extends EventChannel>(
  contents: Pick<WebContents, 'getURL' | 'isDestroyed' | 'send'>,
  definition: Channel,
  payload: EventPayload<Channel>,
  isTrustedUrl: (url: string) => boolean,
): boolean {
  if (contents.isDestroyed() || !isTrustedUrl(contents.getURL())) {
    return false;
  }
  const parsed = parseEventPayload(definition, payload);
  if (!parsed.success) {
    return false;
  }
  contents.send(definition.channel, parsed.data);
  return true;
}
