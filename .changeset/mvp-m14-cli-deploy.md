---
"@embody/cli": minor
"create-embody-app": minor
"@embody/gateway": minor
"@embody/cloud-contracts": minor
---

Add the hosted deploy and control journey to the CLI: `embody deploy` (pack, upload, submit; the deployment ID is printed at once and a rerun resumes the same deployment), `embody deployments status|cancel` (reconnect by ID; cancellation uses the server-side fence), `embody apps status` and `embody mcp setup` (workspace MCP URL and private Claude Code configuration, never printing the credential). Ctrl-C stops only local waiting. Documented exit codes now include deployment failed (8), cancelled (9) and wait timeout (10). Workspace gateway URLs (`/w/<workspace>`), root URLs with a workspace and reverse-proxy prefixes are all accepted. Request timeouts report cold starts and unknown write outcomes. Hosted scaffolds declare `embody.hosted` in package.json. The gateway serves `GET /v1/workspaces/:workspace/apps`, and `AppStatus` carries an optional `name`.
