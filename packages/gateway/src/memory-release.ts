import type {
  AppDatabase,
  AppIdentityProvider,
  AppResourceNames,
  CandidateProvider,
  CandidateSpec,
  CandidateState,
  HealthProbe,
  MigrationPolicyEntry,
  WorkflowVersionInUse,
} from "./release-stages.js";

/**
 * In-memory M13 providers for tests and local development, modelling the Cloud Run, IAM, Secret
 * Manager and Cloud SQL behaviour the release stages rely on: creation is asynchronous (a
 * candidate is `pending` for `readyAfterGets` reads), names are unique, invoker bindings are
 * replaced exactly, and nothing is authoritative except what was created. Not durable.
 */
export class MemoryCandidateProvider implements CandidateProvider {
  public readonly services = new Map<
    string,
    { spec: CandidateSpec; gets: number; invokers: readonly string[]; failed: boolean }
  >();
  public created = 0;
  public removed: string[] = [];
  /** Reads a new candidate stays `pending` before it becomes ready. */
  public readyAfterGets = 1;
  /** Image references whose revisions never become ready (a crashing container). */
  public readonly failingImages = new Set<string>();
  public constructor(
    private readonly projectNumber = "123456789012",
    private readonly region = "us-central1",
  ) {}
  public endpointOf(name: string): string {
    return `https://${name}-${this.projectNumber}.${this.region}.run.app`;
  }
  private state(name: string): CandidateState | null {
    const service = this.services.get(name);
    if (!service) return null;
    const ready = service.gets > this.readyAfterGets;
    return {
      name,
      endpoint: this.endpointOf(name),
      image: service.spec.image,
      status: service.failed ? "failed" : ready ? "ready" : "pending",
      labels: { ...service.spec.labels },
      annotations: { ...service.spec.annotations },
    };
  }
  public get(name: string): Promise<CandidateState | null> {
    const service = this.services.get(name);
    if (service) {
      service.gets += 1;
      if (service.gets > this.readyAfterGets && this.failingImages.has(service.spec.image))
        service.failed = true;
    }
    return Promise.resolve(this.state(name));
  }
  public create(spec: CandidateSpec): Promise<void> {
    if (!/@sha256:[a-f0-9]{64}$/.test(spec.image))
      return Promise.reject(new Error("Candidates deploy digest references only"));
    if (!this.services.has(spec.name)) {
      this.services.set(spec.name, { spec, gets: 0, invokers: [], failed: false });
      this.created += 1;
    }
    return Promise.resolve();
  }
  public setInvokers(name: string, members: readonly string[]): Promise<void> {
    const service = this.services.get(name);
    if (!service) return Promise.reject(new Error("Candidate not found"));
    service.invokers = [...members];
    return Promise.resolve();
  }
  public remove(name: string): Promise<void> {
    if (this.services.delete(name)) this.removed.push(name);
    return Promise.resolve();
  }
  public list(): Promise<readonly CandidateState[]> {
    return Promise.resolve([...this.services.keys()].map((name) => this.state(name)!));
  }
}

export class MemoryAppIdentityProvider implements AppIdentityProvider {
  public readonly accounts = new Set<string>();
  public readonly secrets = new Map<string, { accessor: string; versions: string[] }>();
  public readonly queues = new Map<string, { invoker: string; enqueuer: string }>();
  /** Calls that report `pending` before an account exists (IAM propagation). */
  public pendingAccountCalls = 0;
  public constructor(private readonly project = "embody-cloud") {}
  public ensureAccount(accountId: string): Promise<{ email: string } | "pending"> {
    if (!this.accounts.has(accountId)) {
      this.accounts.add(accountId);
      if (this.pendingAccountCalls > 0) {
        this.pendingAccountCalls -= 1;
        return Promise.resolve("pending");
      }
    }
    return Promise.resolve({ email: `${accountId}@${this.project}.iam.gserviceaccount.com` });
  }
  public ensureSecret(secretId: string, accessorEmail: string): Promise<void> {
    const secret = this.secrets.get(secretId);
    if (!secret) this.secrets.set(secretId, { accessor: accessorEmail, versions: [] });
    else secret.accessor = accessorEmail;
    return Promise.resolve();
  }
  public latestSecretVersion(secretId: string): Promise<string | null> {
    const versions = this.secrets.get(secretId)?.versions ?? [];
    return Promise.resolve(versions.length ? String(versions.length) : null);
  }
  public addSecretVersion(secretId: string, payload: string): Promise<string> {
    const secret = this.secrets.get(secretId);
    if (!secret) return Promise.reject(new Error("Secret not found"));
    secret.versions.push(payload);
    return Promise.resolve(String(secret.versions.length));
  }
  /** Test access: the payload a runtime would receive (the controller never reads it). */
  public payload(secretId: string): string | undefined {
    return this.secrets.get(secretId)?.versions.at(-1);
  }
  public ensureWakeQueue(
    queueId: string,
    invokerAccount: string,
    runtimeEmail: string,
  ): Promise<{ queue: string; invokerEmail: string }> {
    const invokerEmail = `${invokerAccount}@${this.project}.iam.gserviceaccount.com`;
    this.queues.set(queueId, { invoker: invokerEmail, enqueuer: runtimeEmail });
    return Promise.resolve({
      queue: `projects/${this.project}/locations/us-central1/queues/${queueId}`,
      invokerEmail,
    });
  }
}

/** App database model: applied migrations, a data checksum and workflow versions in use. */
export class MemoryAppDatabase implements AppDatabase {
  public readonly databases = new Map<
    string,
    {
      applied: number[];
      marker: string | null;
      password: string | null;
      rows: Map<string, string>;
      workflows: WorkflowVersionInUse[];
    }
  >();
  public constructor(private readonly policy: readonly MigrationPolicyEntry[]) {}
  private db(names: AppResourceNames) {
    const db = this.databases.get(names.database);
    if (!db) throw new Error("Database not provisioned");
    return db;
  }
  public ensure(names: AppResourceNames): Promise<void> {
    if (!this.databases.has(names.database))
      this.databases.set(names.database, {
        applied: [],
        marker: null,
        password: null,
        rows: new Map(),
        workflows: [],
      });
    return Promise.resolve();
  }
  public credentialMarker(names: AppResourceNames): Promise<string | null> {
    return Promise.resolve(this.db(names).marker);
  }
  public setCredential(names: AppResourceNames, password: string, marker: string): Promise<void> {
    const db = this.db(names);
    db.password = password;
    db.marker = marker;
    return Promise.resolve();
  }
  public runtimeUrl(names: AppResourceNames, password: string): string {
    return `postgresql://${names.runtimeRole}:${password}@/${names.database}?host=/cloudsql/fixture`;
  }
  public appliedMigrations(names: AppResourceNames): Promise<readonly number[]> {
    return Promise.resolve([...this.db(names).applied]);
  }
  public applyNextMigration(names: AppResourceNames, target: number): Promise<"applied" | "current"> {
    const db = this.db(names);
    const next = this.policy.find((m) => m.version <= target && !db.applied.includes(m.version));
    if (!next) return Promise.resolve("current");
    if (next.compatibility !== "expand")
      return Promise.reject(new Error("Contract migrations are refused before execution"));
    db.applied.push(next.version);
    db.applied.sort((a, b) => a - b);
    return Promise.resolve("applied");
  }
  public activeWorkflowVersions(names: AppResourceNames): Promise<readonly WorkflowVersionInUse[]> {
    return Promise.resolve([...this.db(names).workflows]);
  }
}

/** Health of memory candidates: ready unless the endpoint is marked unhealthy. */
export class MemoryHealthProbe implements HealthProbe {
  public readonly unhealthy = new Set<string>();
  public probes = 0;
  public ready(endpoint: string): Promise<boolean> {
    this.probes += 1;
    return Promise.resolve(!this.unhealthy.has(endpoint));
  }
}
