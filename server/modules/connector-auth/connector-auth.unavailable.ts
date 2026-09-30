import { errors } from 'oidc-provider';

/** A storage outage is not evidence that an authorization has expired or been revoked. */
export class ConnectorAuthUnavailableError extends errors.TemporarilyUnavailable {
  constructor() {
    super('Authorization storage is temporarily unavailable. Please try again later.');
    this.status = 503;
    this.statusCode = 503;
    // Only the fixed description above is public; never retain a storage error or its cause.
    this.expose = true;
    this.allow_redirect = false;
  }
}

export async function connectorAuthStorageOperation<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch { throw new ConnectorAuthUnavailableError(); }
}
