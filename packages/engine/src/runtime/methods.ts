import { z } from "zod";
import { RpcErrorCodes } from "@openfusion/shared";
import type { Engine } from "../engine.js";
import { OrchestrateFrontierSelectionsSchema } from "../engines/selection.js";
import { RpcMethodError } from "../rpc/errors.js";
import { requireGitRepo } from "../rpc/guards.js";
import { registerMethod } from "../rpc/register.js";
import { RuntimeContentLockedError } from "./crypto.js";
import { RuntimeVersionConflictError } from "./store.js";
import { discoverSkills } from "./skills.js";
import {
  fingerprintMcpConfiguration,
  type McpServerConfiguration,
} from "./mcp.js";
import { runtimeFingerprint } from "./context.js";

const ProjectSchema = z.object({ projectDir: z.string().min(1) });

const ConfigureSchema = z.object({
  projectDir: z.string().min(1),
  traceKey: z.string().min(1).optional(),
  traceEnabled: z.boolean().optional(),
  retentionDays: z.number().int().min(1).max(3650).optional(),
  retentionBytes: z.number().int().min(1024 * 1024).optional(),
  sandboxGrants: z.array(z.string().min(1)).optional(),
  enabledExtensions: z.array(z.string().min(1)).optional(),
  childrenEnabled: z.boolean().optional(),
});

const StartSchema = z.object({
  projectDir: z.string().min(1),
  task: z.string().min(1),
  maxWorkerAttempts: z.number().int().min(1).max(3).optional(),
  workerTimeoutMs: z.number().int().min(1000).max(1_800_000).optional(),
  reviewTimeoutMs: z.number().int().min(100).max(3_600_000).optional(),
  frontier: OrchestrateFrontierSelectionsSchema.optional(),
  runId: z.string().min(1).optional(),
});

const GetSchema = z.object({
  projectDir: z.string().min(1),
  sessionId: z.string().min(1),
  includeEvents: z.boolean().optional(),
  afterSeq: z.number().int().min(0).optional(),
  eventLimit: z.number().int().min(1).max(5000).optional(),
});

const ListSchema = z.object({
  projectDir: z.string().min(1),
  status: z.enum([
    "created",
    "running",
    "waiting-approval",
    "interrupted",
    "needs-recovery",
    "completed",
    "failed",
    "cancelled",
  ]).optional(),
  kind: z.enum(["orchestrate", "worker", "child", "review", "escalation"]).optional(),
  parentSessionId: z.string().min(1).nullable().optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

const ActionSchema = z.object({
  projectDir: z.string().min(1),
  sessionId: z.string().min(1),
  expectedVersion: z.number().int().min(1),
  action: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("respond-approval"),
      approvalId: z.string().min(1),
      approved: z.boolean(),
      response: z.unknown().optional(),
    }),
    z.object({ type: z.literal("resume") }),
    z.object({ type: z.literal("recover-current-state") }),
    z.object({ type: z.literal("recover-checkpoint") }),
    z.object({ type: z.literal("cancel") }),
    z.object({
      type: z.literal("send-child"),
      childSessionId: z.string().min(1),
      message: z.unknown(),
    }),
    z.object({ type: z.literal("close-child"), childSessionId: z.string().min(1) }),
    z.object({ type: z.literal("import-child-diff"), childSessionId: z.string().min(1) }),
  ]),
});

const ReadOutputSchema = z.object({
  projectDir: z.string().min(1),
  artifactId: z.string().min(1),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(1024 * 1024).optional(),
});

const ExtensionKindSchema = z.enum(["skill", "mcp", "hook"]);
const ExtensionListSchema = ProjectSchema.extend({ kind: ExtensionKindSchema.optional() });
const ExtensionRegisterSchema = ProjectSchema.extend({
  kind: ExtensionKindSchema,
  id: z.string().min(1).max(128),
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  config: z.record(z.string(), z.unknown()),
  diagnostics: z.array(z.object({ code: z.string(), message: z.string() })).optional(),
});
const ExtensionApprovalSchema = ProjectSchema.extend({
  kind: ExtensionKindSchema,
  id: z.string().min(1),
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  approved: z.boolean(),
});
const ExtensionEnableSchema = ExtensionApprovalSchema.omit({ approved: true }).extend({ enabled: z.boolean() });
const SkillDiscoverSchema = ProjectSchema;
const McpConfigurationSchema = z.discriminatedUnion("transport", [
  z.object({
    id: z.string().min(1).max(128),
    transport: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    cwd: z.string().min(1),
    environment: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    id: z.string().min(1).max(128),
    transport: z.literal("streamable-http"),
    url: z.string().url(),
    credentialRef: z.string().min(1).optional(),
  }),
]);
const McpRegisterSchema = ProjectSchema.extend({ config: McpConfigurationSchema });
const McpConnectSchema = ProjectSchema.extend({ id: z.string().min(1) });
const CredentialSchema = z.object({
  reference: z.string().min(1).max(128),
  value: z.string().optional(),
});

function mapRuntimeError(error: unknown): never {
  if (error instanceof RuntimeVersionConflictError) {
    throw new RpcMethodError(RpcErrorCodes.BUSY, error.message, {
      sessionId: error.sessionId,
      expectedVersion: error.expectedVersion,
      actualVersion: error.actualVersion,
    });
  }
  if (error instanceof RuntimeContentLockedError) {
    throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, error.message, { locked: true });
  }
  throw error;
}

export function registerRuntimeMethods(engine: Engine): void {
  registerMethod(engine.dispatcher, "engine.runtime.configure", ConfigureSchema, (params) => {
    requireGitRepo(params.projectDir);
    try {
      const configuration = engine.runtime.configure(params.projectDir, params);
      return { configured: true, configuration };
    } catch (error) {
      return mapRuntimeError(error);
    }
  });

  registerMethod(engine.dispatcher, "engine.runtime.status", ProjectSchema, async (params) => {
    requireGitRepo(params.projectDir);
    return engine.runtime.status(params.projectDir);
  });

  registerMethod(engine.dispatcher, "engine.runtime.credentials.configure", CredentialSchema, (params) => {
    engine.runtime.configureCredential(params.reference, params.value);
    return { configured: params.value !== undefined };
  });

  registerMethod(engine.dispatcher, "engine.runtime.extensions.list", ExtensionListSchema, (params) => {
    requireGitRepo(params.projectDir);
    return { extensions: engine.runtime.getStore(params.projectDir).listExtensions(params.kind) };
  });

  registerMethod(engine.dispatcher, "engine.runtime.extensions.register", ExtensionRegisterSchema, (params) => {
    requireGitRepo(params.projectDir);
    return {
      extension: engine.runtime.getStore(params.projectDir).registerExtension({
        kind: params.kind,
        id: params.id,
        fingerprint: params.fingerprint,
        config: params.config,
        diagnostics: params.diagnostics,
      }),
    };
  });

  registerMethod(engine.dispatcher, "engine.runtime.extensions.approve", ExtensionApprovalSchema, (params) => {
    requireGitRepo(params.projectDir);
    return {
      extension: engine.runtime.getStore(params.projectDir).approveExtension(
        params.kind,
        params.id,
        params.fingerprint,
        params.approved,
      ),
    };
  });

  registerMethod(engine.dispatcher, "engine.runtime.extensions.enable", ExtensionEnableSchema, (params) => {
    requireGitRepo(params.projectDir);
    const store = engine.runtime.getStore(params.projectDir);
    const extension = store.setExtensionEnabled(
      params.kind,
      params.id,
      params.fingerprint,
      params.enabled,
    );
    const enabledExtensions = store.listExtensions()
      .filter((entry) => entry.enabled)
      .map((entry) => `${entry.kind}:${entry.id}`);
    store.configure({ enabledExtensions });
    return { extension };
  });

  registerMethod(engine.dispatcher, "engine.runtime.skills.discover", SkillDiscoverSchema, (params) => {
    requireGitRepo(params.projectDir);
    const skills = discoverSkills(params.projectDir).map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      dialect: skill.dialect,
      sourcePath: skill.sourcePath,
      resources: skill.resources,
      allowedTools: skill.allowedTools,
      invocation: skill.invocation,
      fingerprint: skill.fingerprint,
      requiresApproval: skill.requiresApproval,
      diagnostics: skill.diagnostics,
    }));
    return { skills };
  });

  registerMethod(engine.dispatcher, "engine.runtime.mcp.register", McpRegisterSchema, (params) => {
    requireGitRepo(params.projectDir);
    const config = params.config as McpServerConfiguration;
    const fingerprint = fingerprintMcpConfiguration(config);
    return {
      extension: engine.runtime.getStore(params.projectDir).registerExtension({
        kind: "mcp",
        id: config.id,
        fingerprint,
        config: config as unknown as Record<string, unknown>,
      }),
    };
  });

  registerMethod(engine.dispatcher, "engine.runtime.mcp.connect", McpConnectSchema, async (params) => {
    requireGitRepo(params.projectDir);
    const store = engine.runtime.getStore(params.projectDir);
    const extension = store.getExtension("mcp", params.id);
    if (extension === null) throw new Error(`MCP server is not registered: ${params.id}`);
    const result = await engine.runtime.mcp.connect({
      config: extension.config as unknown as McpServerConfiguration,
      approvedFingerprints: store.approvedExtensionFingerprints(),
      credentialResolver: async (reference) => engine.runtime.resolveCredential(reference),
    });
    if (result.inventoryFingerprint !== undefined && result.inventoryFingerprint !== extension.fingerprint) {
      store.registerExtension({
        kind: "mcp",
        id: extension.id,
        fingerprint: result.inventoryFingerprint,
        config: extension.config,
        diagnostics: result.status === "inventory-approval-required"
          ? [{ code: "approval-required", message: "Discovered MCP tool schemas require approval." }]
          : [],
      });
    }
    return result;
  });

  registerMethod(engine.dispatcher, "engine.runtime.hooks.fingerprint", z.object({
    id: z.string().min(1),
    mode: z.enum(["observational", "enforcing"]),
    executable: z.string().min(1),
    args: z.array(z.string()).optional(),
  }), (params) => ({
    fingerprint: runtimeFingerprint({ profile: "process-hook-v1", ...params }),
  }));

  registerMethod(engine.dispatcher, "engine.orchestrate.start", StartSchema, (params) => {
    requireGitRepo(params.projectDir);
    const session = engine.runtime.startOrchestrate(engine, params);
    return {
      sessionId: session.id,
      runId: session.runId,
      status: session.status,
      version: session.version,
    };
  });

  registerMethod(engine.dispatcher, "engine.sessions.get", GetSchema, (params) => {
    requireGitRepo(params.projectDir);
    const store = engine.runtime.getStore(params.projectDir);
    const session = store.getSession(params.sessionId);
    if (session === null) {
      throw new RpcMethodError(RpcErrorCodes.INVALID_PARAMS, `session not found: ${params.sessionId}`);
    }
    try {
      return {
        session,
        pendingApproval: store.getPendingApprovalInTree(params.sessionId),
        ...(params.includeEvents === true
          ? {
              events: store.listEvents(params.sessionId, {
                afterSeq: params.afterSeq,
                limit: params.eventLimit,
              }),
            }
          : {}),
      };
    } catch (error) {
      return mapRuntimeError(error);
    }
  });

  registerMethod(engine.dispatcher, "engine.sessions.list", ListSchema, (params) => {
    requireGitRepo(params.projectDir);
    const store = engine.runtime.getStore(params.projectDir);
    return {
      sessions: store.listSessions({
        status: params.status,
        kind: params.kind,
        parentSessionId: params.parentSessionId,
        limit: params.limit,
      }),
    };
  });

  registerMethod(engine.dispatcher, "engine.sessions.action", ActionSchema, async (params) => {
    requireGitRepo(params.projectDir);
    const store = engine.runtime.getStore(params.projectDir);
    try {
      switch (params.action.type) {
        case "cancel":
          return { session: engine.runtime.cancel(engine, store, params.sessionId, params.expectedVersion) };
        case "respond-approval": {
          const result = engine.runtime.respondApproval(
            engine,
            store,
            params.sessionId,
            params.expectedVersion,
            params.action.approvalId,
            params.action.approved,
            params.action.response,
          );
          return result;
        }
        case "resume":
          return { session: engine.runtime.resumeOrchestrate(engine, store, params.sessionId) };
        case "recover-current-state":
          return {
            session: engine.runtime.recoverCurrentState(
              engine,
              store,
              params.sessionId,
              params.expectedVersion,
            ),
          };
        case "recover-checkpoint":
          return {
            session: await engine.runtime.recoverCheckpoint(
              engine,
              store,
              params.sessionId,
              params.expectedVersion,
            ),
          };
        case "send-child": {
          const parent = store.requireSession(params.sessionId);
          if (parent.version !== params.expectedVersion) {
            throw new RuntimeVersionConflictError(parent.id, params.expectedVersion, parent.version);
          }
          engine.runtime.children.send(
            store,
            parent.id,
            params.action.childSessionId,
            params.action.message,
          );
          return { session: store.updateSession(parent.id, parent.version, {}) };
        }
        case "close-child": {
          const parent = store.requireSession(params.sessionId);
          if (parent.version !== params.expectedVersion) {
            throw new RuntimeVersionConflictError(parent.id, params.expectedVersion, parent.version);
          }
          const child = engine.runtime.children.close(
            engine,
            store,
            parent.id,
            params.action.childSessionId,
          );
          return { session: store.updateSession(parent.id, parent.version, {}), child };
        }
        case "import-child-diff": {
          const importResult = await engine.runtime.children.importDiff(
            engine,
            store,
            params.sessionId,
            params.expectedVersion,
            params.action.childSessionId,
          );
          return {
            session: importResult.imported
              ? importResult.session
              : store.requireSession(params.sessionId),
            importResult,
          };
        }
      }
    } catch (error) {
      return mapRuntimeError(error);
    }
  });

  const readArtifact = (params: z.infer<typeof ReadOutputSchema>) => {
    requireGitRepo(params.projectDir);
    try {
      return engine.runtime.getStore(params.projectDir).readArtifactPage(params.artifactId, {
        offset: params.offset,
        limit: params.limit,
      });
    } catch (error) {
      return mapRuntimeError(error);
    }
  };
  registerMethod(engine.dispatcher, "engine.sessions.read_tool_output", ReadOutputSchema, readArtifact);
  registerMethod(engine.dispatcher, "engine.artifacts.read", ReadOutputSchema, readArtifact);
}
