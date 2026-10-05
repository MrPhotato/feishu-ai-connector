# OAuth refresh retries

The connector and Feishu have separate refresh credentials. This policy applies
to the connector credentials issued to its registered public MCP client. It does
not retry an upstream Feishu refresh or extend the user's consent.

## Bounded retry policy

The provider normally rotates a refresh token. After a successful rotation, an
identical retry with the previous token may receive the same signed token response
for 30 seconds. The successor token has a 60-second cooldown during which the same
request also receives that response. Both deadlines start at the original result;
neither a retry nor cooldown use extends them. `expires_in` decreases with the
original access token's remaining lifetime. No older ancestor is exchanged for
the latest descendant.

This is a deliberate short exception to immediate reuse detection. A public
client's bearer token cannot prove whether a duplicate came from a network retry
or an attacker. Scope, resource and client must match, all live grant, consent and
account checks still apply, and the cached successor must be unconsumed and valid.
An old token reused outside its retry window follows the provider's normal grant
revocation behavior. Rotation and the original absolute 30-day maximum remain.

## Persistence and failure handling

A grant-level lease serializes normal refresh work. A durable `RefreshRetry`
claim, acquired with an atomic consume operation, additionally prevents a second
worker from rotating the same source when a lease expires during delayed I/O.
The claim retains binding hashes and completion metadata until the original
refresh token expires. `RefreshResponse` contains the encrypted, already signed
result for at most 60 seconds. Keys use domain-separated HMACs; diagnostics never
include tokens, token identifiers, account identifiers or response payloads.
Both models are indexed by grant and removed by revocation; a grant tombstone
prevents late writes from restoring revoked credentials. No new database table,
public storage endpoint or enterprise permission is required.

An uncertain claim or incomplete result returns `temporarily_unavailable` without
running the provider a second time. If the provider has finished unsuccessfully
and a request-local marker proves it never attempted to consume the source token,
the winning worker may release only its own pending claim. This lets temporary
validation-read failures recover on a later request. The marker is set before
calling storage; an uncertain consume is never treated as an untouched token.
Claim removal is attempted once, without an unsafe retry after a lost acknowledgement.
Finite idempotent receipt-write/readback recovery handles transient storage
failures. A crash after claiming but before a durable response can still require
reconnection. The implementation cannot
guarantee recovery from arbitrarily delayed client responses or every outage.

## Verification

- `node scripts/test-refresh-retry-storage.mjs`: actual repository and SQL
  generation with synthetic storage, atomic claims and revocation isolation.
- `node scripts/test-oidc-refresh-retry.mjs`: actual provider and loopback HTTP,
  duplicate requests, response loss, multiple instances and security boundaries.
- `node scripts/probe-auth-outages.mjs`: storage fault injection and fail-closed
  behavior through the actual provider.
- `node scripts/probe-oidc.mjs`: full OAuth/OIDC protocol regression after build.
- `node scripts/probe-cloud-refresh-retry.mjs`: opt-in deployment verification
  using isolated synthetic encrypted records and the real cloud token endpoint.
  It never reads an existing user's credentials and cleans up its own records.

Passing these checks is not evidence of uninterrupted operation for days. Record
deployment, actual user reconnection and observed production refreshes separately.

## References

- [OAuth security BCP, refresh token protection](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.14.2)
- [Auth0 rotation overlap configuration](https://auth0.com/docs/secure/tokens/refresh-tokens/configure-refresh-token-rotation)

These references motivate a bounded overlap policy; they do not certify this
implementation or make bearer-token retries distinguishable from theft.
