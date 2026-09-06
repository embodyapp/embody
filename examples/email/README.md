# Email reference application

A public-API-only Embody application demonstrating cancellable batch actions, progress, service injection, and durable consumption of `kanban.card.ready_for_review`.

## Development

```bash
pnpm --filter @embody/example-email dev
```

The default plugin deliberately has no real mail provider. Inject an implementation of `Mailer` with `createEmailPlugin(mailer)` for deployment. `RecordingMailer` and the restart-safe `JsonFileMailer` are provided only for tests and local development. The executable selects the file adapter only when `MAILER_RECORD_FILE` is explicitly set; never treat an unconfigured adapter as successful delivery.

`sendBatch` rejects empty or invalid recipient lists before sending, reports progress after every tenth and final recipient, and requires the `marketing_lead` role above 500 recipients. Provider calls receive stable idempotency keys. Event notifications use the durable event ID, allowing supporting providers to suppress duplicates after relay retries.

See `.env.example`, `docker-compose.e2e.yml`, and the Kanban README for local and distributed host configuration. `EMBODY_EVENT_SECRET` enables authenticated event reception. Production deployments must configure gateway JWT verification, registration credentials, TLS, a rotated event secret, and an explicit mail provider adapter.
