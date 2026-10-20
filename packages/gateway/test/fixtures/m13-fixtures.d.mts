import type {
  AppIdentityProvider,
  CandidateProvider,
  CandidateSweep,
  DeploymentStore,
  MigrationStep,
  PostgresAppDatabase,
  ReleasePlatform,
  ReleaseStages,
  BuildProvider,
} from "../../src/index.js";

export declare const PROJECT_NUMBER: string;
export declare const platform: ReleasePlatform & { prefix: string };
export declare const migrations: readonly MigrationStep[];
export declare function createM13Tables(migrationUrl: string, runtimeRole: string): Promise<void>;
export interface FixtureCandidate {
  name: string;
  spec: { image: string; labels: Record<string, string>; annotations: Record<string, string> };
  invokers: string[];
}
export declare function createTableCandidates(
  connectionString: string,
  afterCreate?: () => Promise<void>,
): CandidateProvider & {
  forWorkspace(workspaceId: string): Promise<FixtureCandidate[]>;
  close(): Promise<void>;
};
export declare function createTableIdentities(
  connectionString: string,
  afterAddVersion?: () => Promise<void>,
): AppIdentityProvider & {
  payload(secret: string): Promise<string>;
  versions(secret: string): Promise<number>;
  close(): Promise<void>;
};
export declare function appDatabase(
  provisionerUrl: string,
  afterMigration?: () => Promise<void>,
): PostgresAppDatabase;
export declare function releaseStages(options: {
  store: DeploymentStore;
  candidates: CandidateProvider;
  identities: AppIdentityProvider;
  database: PostgresAppDatabase;
  outputs: Pick<BuildProvider, "readOutput">;
}): ReleaseStages;
export declare function candidateSweep(
  store: DeploymentStore,
  candidates: CandidateProvider,
): CandidateSweep;
