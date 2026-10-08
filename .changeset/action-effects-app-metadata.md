---
"@embody/core": minor
"@embody/host": minor
"@embody/cli": minor
"@embody/gateway": minor
"create-embody-app": minor
---

Add action `effect` (`read`, `write`, `destructive`), `title` and `idempotent` metadata, plus optional app `title`, `description` and `instructions`. Generated CRUD actions and workflow controls declare effects automatically; custom actions without an effect are treated as `write` (`actionEffect()`). `defineApp`, `embody dev` configs and `new Kernel({ app })` place app metadata in the manifest. The gateway validates the new metadata at registration and reserves the app ID `embody`. All fields are optional; manifest `protocolVersion` stays `1`.
