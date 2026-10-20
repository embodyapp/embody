import type {
  BuildProvider,
  BuildRecipeConfig,
  DeploymentRecord,
  DeploymentStageContext,
  StageResult,
} from "../../src/index.js";

export declare const recipe: BuildRecipeConfig;
export declare function pin(value: string): string;
export declare function createFixtureTables(
  migrationUrl: string,
  runtimeRole: string,
): Promise<void>;
export interface FixtureTask {
  name: string;
  scheduleAt: string;
  body: unknown;
}
export declare function createTableQueue(connectionString: string): {
  outage: boolean;
  enqueue(task: {
    name: string;
    scheduleAt: string;
    body: unknown;
  }): Promise<"created" | "duplicate">;
  due(workspaceId: string, now: Date): Promise<FixtureTask[]>;
  pending(workspaceId: string): Promise<FixtureTask[]>;
  acknowledge(name: string): Promise<void>;
  lose(workspaceId: string): Promise<void>;
  close(): Promise<void>;
};
export declare function createTableBuildProvider(
  connectionString: string,
  afterSubmit?: () => Promise<void>,
): BuildProvider & {
  builds(tagPrefix: string): Promise<{ id: string; tag: string; status: string }[]>;
  buildsFor(deploymentId: string): Promise<{ id: string; status: string }[]>;
  close(): Promise<void>;
};
export declare function createTableStages(
  connectionString: string,
  afterCreate?: () => Promise<void>,
): {
  nameOf(deployment: DeploymentRecord): string;
  provision(context: DeploymentStageContext): Promise<StageResult>;
  check(context: DeploymentStageContext): Promise<StageResult>;
  abandon(deployment: DeploymentRecord): Promise<void>;
  resources(workspaceId: string): Promise<{ name: string; labels: Record<string, string> }[]>;
  close(): Promise<void>;
};
export declare const requestOnly: Record<string, unknown>;
