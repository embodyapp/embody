---
"@embody/auth": minor
"@embody/gateway": minor
"@embody/host": minor
"@embody/storage": minor
---

Add hosted ES256 signing and public JWKS, short-lived app/workspace-bound verification,
key rotation cache bounds and separate provider invocation credentials. Hosted gateways
now require asymmetric signing configuration (a breaking hosted-library configuration change
in this pre-1.0 release); hosted app environments reject shared signing secrets and platform
database configuration. The hosted executable also requires `GATEWAY_SERVICE_ACCOUNT_EMAIL`
and obtains Cloud Run provider invocation tokens from that gateway workload's metadata
identity. Only admitted default HTTPS `*.run.app` service origins are supported, not custom
domains. Reference-profile HS256 remains supported. Hosted PostgreSQL startup now verifies
maintenance-applied migration versions without issuing DDL; runtime needs read-only access
to its own migration ledger, never CREATE or ledger mutation privileges.
