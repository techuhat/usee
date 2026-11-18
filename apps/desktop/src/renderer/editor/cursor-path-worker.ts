import { deriveCursorPath, type PointerTrack } from '@usee/domain';

export interface CursorPathWorkerRequest {
  readonly requestId: number;
  readonly streamId: string;
  readonly track: PointerTrack;
  readonly smoothing: number;
}

export interface CursorPathWorkerResult {
  readonly requestId: number;
  readonly streamId: string;
  readonly xs: Float32Array;
  readonly ys: Float32Array;
}

const scope = self as unknown as {
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<CursorPathWorkerRequest>) => void,
  ): void;
  postMessage(message: CursorPathWorkerResult, transfer: Transferable[]): void;
};

scope.addEventListener('message', ({ data }) => {
  const path = deriveCursorPath(data.track, data.smoothing);
  scope.postMessage(
    { requestId: data.requestId, streamId: data.streamId, xs: path.xs, ys: path.ys },
    [path.xs.buffer as ArrayBuffer, path.ys.buffer as ArrayBuffer],
  );
});
