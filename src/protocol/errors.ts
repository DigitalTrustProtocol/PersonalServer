/** `DTP-ERR` codes (resolver-api.md § Messages). */
export type ErrorCode =
  | 'invalid'
  | 'auth-required'
  | 'restricted'
  | 'rate-limited'
  | 'error'
  | 'busy'
  | 'cancelled'
  | 'not-found'
  | 'unsupported'

export class OpError extends Error {
  readonly code: ErrorCode
  constructor(code: ErrorCode, message: string) {
    super(message)
    this.name = 'OpError'
    this.code = code
  }
}

export const invalid = (message: string) => new OpError('invalid', message)
