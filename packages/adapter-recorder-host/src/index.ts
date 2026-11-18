/**
 * Node-side adapter for the native recorder host: launch with per-launch
 * secrets, authenticated handshake, framed and schema-checked messages.
 */

export { encodeFrame, FrameDecoder, RecorderProtocolError } from './framing';
export type { HostExit, LaunchRecorderHostOptions, RecorderHost } from './launch-recorder-host';
export { launchRecorderHost } from './launch-recorder-host';
export type { RecorderHostChannel } from './recorder-host-client';
export {
  RecorderHostClient,
  RecorderHostConnectionError,
  RecorderHostRequestError,
} from './recorder-host-client';
export type {
  RecorderHostSupervisor,
  RecorderHostSupervisorOptions,
} from './recorder-host-supervisor';
export { createRecorderHostSupervisor } from './recorder-host-supervisor';
