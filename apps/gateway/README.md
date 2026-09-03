# Gateway application

`@embody/gateway` provides the Phase 7 control plane. Configure `GatewayRegistry` with per-app registration credentials and endpoint policy, then pass it to `createGateway` with an `AuthChain` and `GatewayTokenOptions`.

Registration endpoints are available at both `/register` and `/api/registry/register` (with matching heartbeat paths); execution is `POST /api/execute/:appId/:target`.

`gatewayEventTransport(registry, secret)` is an `EventTransport` adapter for the existing durable outbox/delivery workers. It uses the immutable registry subscription directory and includes unhealthy destinations in fan-out snapshots, so deliveries retry after recovery. Durability is supplied by the configured gateway `StorageConnection` and `DeliveryWorker`; it is intentionally opt-in.
