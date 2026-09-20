# create-embody-app

Create a ready-to-run Embody TypeScript application.

```sh
npm create embody-app@latest my-agent-app
cd my-agent-app
npm install
npm test
npm run dev
```

Requires Node.js 22 or 24. The generated project includes:

- An `embody.config.ts` application definition.
- A production entrypoint and local `embody dev` script.
- An isolated test harness example.
- TypeScript, environment, Docker, and ownership-safe license defaults.

The scaffolder never overwrites a non-empty directory. Generated applications belong to their creators and are marked `UNLICENSED` until the creator selects a license.

See the [quickstart](https://github.com/nimrod4278/embody/blob/main/docs/getting-started/02-quickstart.md).

Licensed under the [Elastic License 2.0](./LICENSE).
