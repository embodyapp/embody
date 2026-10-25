import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  createAgentSessionRuntime,
  createAgentSessionServices,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

/** Isolated public SDK boundary: no user resources or credential files. */
export async function withPi(
  factory: ExtensionFactory,
  run: (session: AgentSession, runtime: AgentSessionRuntime) => Promise<void>,
  model?: { provider: string; id: string },
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "genui-pi-"));
  const createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd,
    sessionManager,
    sessionStartEvent,
  }) => {
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
      ...(model ? { defaultProvider: model.provider, defaultModel: model.id } : {}),
    });
    const services = await createAgentSessionServices({
      cwd,
      agentDir: directory,
      settingsManager,
      resourceLoaderOptions: {
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [factory],
      },
    });
    if (services.resourceLoader.getExtensions().errors.length)
      throw new Error("Pi fixture extension failed to load");
    const result = await createAgentSession({
      cwd,
      agentDir: directory,
      modelRuntime: services.modelRuntime,
      resourceLoader: services.resourceLoader,
      settingsManager,
      sessionManager,
      noTools: "all",
      ...(sessionStartEvent ? { sessionStartEvent } : {}),
    });
    return { ...result, services, diagnostics: services.diagnostics };
  };
  try {
    const runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: directory,
      agentDir: directory,
      sessionManager: SessionManager.inMemory(directory),
    });
    try {
      await runtime.session.bindExtensions({});
      if (model) {
        const selected = runtime.services.modelRuntime.getModel(model.provider, model.id);
        if (!selected) throw new Error("Offline fixture model was not registered");
        await runtime.session.setModel(selected);
      }
      await run(runtime.session, runtime);
    } finally {
      await runtime.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
