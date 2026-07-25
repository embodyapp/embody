# Getting Started with Embody

Welcome! This guide will walk you step-by-step through setting up your local development environment for **Embody**, running the local PostgreSQL database, running development servers, executing tests, and using the `embody` CLI binary.

---

## 📋 Prerequisites

Before starting, ensure your local machine has the following tools installed:

1. **Node.js**: `v20.0.0` or higher (`node -v`)
2. **pnpm**: `v10.0.0` or higher (`pnpm -v`). Install via npm if needed:
   ```bash
   npm install -g pnpm
   ```
3. **Docker & Docker Desktop**: Required to run PostgreSQL with Row-Level Security (RLS) locally.
4. **Git**: Version control (`git --version`).

---

## 🛠️ Step-by-Step Setup

### Step 1: Clone the Repository & Install Dependencies

Open your terminal and navigate to the project directory:

```bash
cd embody
pnpm install
```

`pnpm` will automatically install dependencies for all packages in the monorepo using workspace routing (`pnpm-workspace.yaml`).

---

### Step 2: Start the PostgreSQL Database

Embody requires PostgreSQL to store business data, execute Row-Level Security (RLS) policies, and handle transactional outbox events.

Start the database container in the background using Docker Compose:

```bash
pnpm db:up
```

> [!TIP]
> To verify that PostgreSQL is running, run:
> ```bash
> docker ps
> ```
> You should see a container running `postgres:16-alpine` on port `5432`.

To stop the database container when you are finished working:
```bash
pnpm db:down
```

---

### Step 3: Configure Environment Variables

Embody uses `.env` files for configuration. Copy the provided `.env.example` file:

```bash
cp .env.example .env
```

Default `.env` contents:
```env
DATABASE_URL=postgres://embody:embody@localhost:5432/embody
PORT=3000
NODE_ENV=development
```

---

### Step 4: Run Development Server

To start all packages and services in development watch mode:

```bash
pnpm dev
```

This uses **Turbo Repo** (`turbo run dev`) to start the services in parallel. The host server boots up, topology-sorts installed plugins, runs migrations automatically, and mounts REST endpoints and MCP tools.

You will see logs indicating that `@embody/core` and `@embody/crm` plugins have initialized successfully.

---

## 🧪 Running Tests & Typechecks

### Run Unit & Integration Tests
Embody uses **Vitest** for fast testing:

```bash
pnpm test
```

### Run TypeScript Typechecking
To verify TypeScript safety across all monorepo packages:

```bash
pnpm typecheck
```

---

## 💻 Using the `embody` CLI

Embody includes a command-line interface binary located in `framework/cli`.

### Build the Monorepo Packages First
```bash
pnpm build
```

### Run CLI Subcommands
You can interact with Embody via the CLI executable:

```bash
pnpm --filter @embody/cli run start --help
```

Plugins can register their own CLI subcommands via `registerCliCommands` (e.g. `embody crm:deals:list`).

---

## 📁 What's Next?

Now that your local environment is set up, explore the rest of the documentation:

- 🏗️ Read the [**Architecture Overview**](file:///Users/nimrodfeldman/playground/embody/docs/architecture-overview.md) to understand how plugins fit together.
- 📁 Explore the [**Directory Structure**](file:///Users/nimrodfeldman/playground/embody/docs/directory-structure.md) to locate code across packages.
- 🧩 Learn [**How to Write a Plugin**](file:///Users/nimrodfeldman/playground/embody/docs/writing-plugins.md) to add new features!
