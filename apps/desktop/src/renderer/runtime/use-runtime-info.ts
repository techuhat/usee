import { useEffect, useState } from 'react';

import type { AppError, RuntimeInfo } from '@usee/contracts';

export type RuntimeInfoState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly info: RuntimeInfo }
  | { readonly status: 'failed'; readonly error: AppError };

export function useRuntimeInfo(): RuntimeInfoState {
  const [state, setState] = useState<RuntimeInfoState>({ status: 'loading' });

  useEffect(() => {
    let isCurrent = true;
    // The bridge resolves with a Result and never rejects.
    void window.desktop.getRuntimeInfo().then((result) => {
      if (isCurrent) {
        setState(
          result.ok
            ? { status: 'ready', info: result.value }
            : { status: 'failed', error: result.error },
        );
      }
    });
    return () => {
      isCurrent = false;
    };
  }, []);

  return state;
}
