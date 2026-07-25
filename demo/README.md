# demo/ — 🖥️ never published

Showcase apps, to look at rather than copy.

`demo-ui` is a Vite SPA covering two CRMs. It proxies `/api` to a running embody host on
port 3100, which is what makes `@embody/react` same-origin: no CORS, and the session
cookie travels on ordinary fetches.

To start from something, copy `examples/` instead — that is what it is for.
