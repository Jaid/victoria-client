/* eslint-disable unicorn/custom-error-definition -- Delivery policy and HTTP status are required domain-specific error fields. */
export type FailureKind = 'authentication' | 'permanent' | 'retry' | 'too-large'
export default class DeliveryError extends Error {
  constructor(message: string, readonly kind: FailureKind, readonly retryAfter = 0, readonly status?: number) {
    super(message)
    this.name = 'DeliveryError'
  }
}
