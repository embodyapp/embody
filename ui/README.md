# ui/ — 📦 published, separate version line

Browser packages. Not part of the embody package: the runtime is headless, and how you
render it is your business.

`@embody/react` is hooks over the host's `/api` bridge. It imports nothing from any
other embody package — the few shapes that must agree with the server are re-declared
and pinned by tests, so a browser bundle never pulls in hono or postgres.
