# OAuth refresh policies

The connector and Feishu have separate refresh credentials. These policies apply
to credentials issued by the connector to its registered MCP clients. They do not
extend upstream Feishu authorization or the user's consent. Both clients require
PKCE and a live account, grant and persistent-connection consent. A connection
has an absolute maximum of 30 days; refresh does not move that deadline.

## Client selection

| Client ID | Token endpoint authentication | Refresh policy |
| --- | --- | --- |
| `chatgpt` | `none` | Rotating tokens, with the bounded retry policy below |
| `chatgpt_confidential` | `client_secret_post` | Reusable token until its original expiry; every token request authenticates the client |

The public client remains available. The confidential client is registered only
when the server has a valid `CONNECTOR_CHATGPT_CLIENT_SECRET`. It is intended for
a client that can keep that deployment's secret in its server-side OAuth
configuration. Possessing a refresh token alone is insufficient for this client;
authorization-code exchanges and refreshes also require the correct client secret.
The secret authenticates the client, not the person: each user still completes
Feishu login and explicitly consents to their own connection.

## Optional confidential client

Generate an independent secret from at least 32 cryptographically random bytes,
encoded as canonical base64url without padding (43–128 characters). Do not reuse
the Feishu App Secret or any signing, storage or Cookie key. Store it only in the
connector's server-side environment and the intended client's private OAuth
settings. Never place it in `CONNECTOR_DEPLOYMENT_CONFIG`, plugin files, browser
code, logs, screenshots or source control. Leave the environment key absent to
disable this client; an empty or invalid value is a configuration error.

Configure the client ID as `chatgpt_confidential`, supply the same secret and use
`client_secret_post`. The MCP URL and registered ChatGPT callback stay unchanged.
Enabling the environment key does not migrate an existing `chatgpt` grant: the
client's OAuth settings must be updated and the user must reconnect to create a
new grant bound to `chatgpt_confidential`. Verify the actual client configuration
and token exchange after deployment before recording migration as complete.

For this client, the provider issues new access tokens while retaining the
original refresh token. Successful refreshes, repeated requests and long idle
periods do not renew its expiry or its grant/consent deadline. A revoked grant,
removed consent, disabled account, missing upstream permissions or expired
upstream authorization can still stop the connection sooner. Changing or removing
the configured client secret also requires coordinated client reconfiguration.
This mode does not promise a permanent connection.

## Public client: bounded retry policy

The provider normally rotates a public client's refresh token. After a successful
rotation, an identical retry with the previous token may receive the same signed
token response for 30 seconds. The successor token has a 60-second cooldown during
which the same request also receives that response. Both deadlines start at the
original result; neither a retry nor cooldown use extends them. `expires_in`
decreases with the original access token's remaining lifetime. No older ancestor
is exchanged for the latest descendant.

This is a deliberate short exception to immediate reuse detection. A public
client's bearer token cannot prove whether a duplicate came from a network retry
or an attacker. Scope, resource and client must match, all live grant, consent and
account checks still apply, and the cached successor must be unconsumed and valid.
An old token reused outside its retry window follows the provider's normal grant
revocation behavior. Rotation and the original absolute 30-day maximum remain.
The confidential client does not use this public-client response replay path;
its requests must reach the provider's client-secret verification.

## Public retry persistence and failure handling

A grant-level lease serializes normal refresh work. A durable `RefreshRetry`
claim, acquired with an atomic consume operation, additionally prevents a second
worker from rotating the same source when a lease expires during delayed I/O.
The claim retains binding hashes and completion metadata until the original
refresh token expires. `RefreshResponse` contains the encrypted, already signed
result for at most 60 seconds. Keys use domain-separated HMACs; diagnostics never
include tokens, token identifiers, account identifiers or response payloads.
Both models are indexed by grant and removed by revocation; a grant tombstone
prevents late writes from restoring revoked credentials. No new database table,
public storage endpoint or enterprise permission is required by these refresh
policies.

An uncertain claim or incomplete result returns `temporarily_unavailable` without
running the provider a second time. If the provider has finished unsuccessfully
and a request-local marker proves it never attempted to consume the source token,
the winning worker may release only its own pending claim. This lets temporary
validation-read failures recover on a later request. The marker is set before
calling storage; an uncertain consume is never treated as an untouched token.
Claim removal is attempted once, without an unsafe retry after a lost acknowledgement.
Finite idempotent receipt-write/readback recovery handles transient storage
failures. A crash after claiming but before a durable response can still require
reconnection. The implementation cannot guarantee recovery from arbitrarily
delayed client responses or every outage.

An `expired_replay` diagnostic establishes that a consumed public refresh token
was presented outside its retry window and the replay handling revoked its grant.
Because diagnostics omit token and grant identifiers, the time between two log
entries alone cannot establish that both requests used the same token lineage.

## Verification

- `node scripts/test-confidential-refresh.mjs`: optional client configuration,
  required client authentication, repeated refreshes, fixed expiry and isolation
  from public-client credentials.
- `node scripts/test-refresh-retry-storage.mjs`: actual repository and SQL
  generation with synthetic storage, atomic claims and revocation isolation.
- `node scripts/test-oidc-refresh-retry.mjs`: actual provider and loopback HTTP,
  duplicate requests, response loss, multiple instances and security boundaries.
- `node scripts/probe-auth-outages.mjs`: storage fault injection and fail-closed
  behavior through the actual provider.
- `node scripts/probe-oidc.mjs`: full OAuth/OIDC protocol regression after build.
- `node scripts/probe-cloud-confidential-refresh.mjs`: opt-in deployment verification
  of confidential-client authentication, repeated refreshes and fixed expiry using
  isolated synthetic records. It reads the configured client secret only in memory,
  does not access real Feishu business data and cleans up its own records.
- `node scripts/probe-cloud-refresh-retry.mjs`: opt-in deployment verification
  of the public-client retry policy, using isolated synthetic encrypted records
  and the real cloud token endpoint. It never reads an existing user's credentials
  and cleans up its own records.

These are verification entry points, not a statement that a deployment or client
migration has passed them. Passing synthetic checks is not evidence of
uninterrupted operation for days. Record the deployed revision, actual user
reconnection and observed production refreshes separately. The confidential
client must be tested with the intended host's OAuth configuration as well.

## References

- [OAuth security BCP, refresh token protection](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.14.2)
- [Auth0 rotation overlap configuration](https://auth0.com/docs/secure/tokens/refresh-tokens/configure-refresh-token-rotation)

These references motivate the client authentication and bounded overlap choices;
they do not certify this implementation or make public bearer-token retries
distinguishable from theft.
