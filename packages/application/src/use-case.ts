import type { CancellationToken, Result } from '@usee/contracts';

/**
 * One application operation. Implementations are composed by the desktop host
 * or a worker; this package only defines the shape.
 */
export interface UseCase<Request, Response> {
  execute(request: Request, cancellation?: CancellationToken): Promise<Result<Response>>;
}
