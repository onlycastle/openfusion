import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  engineClient,
  getSecret,
  setSecret,
  type RuntimeConfiguration,
  type RuntimeExtensionRegistration,
  type RuntimeSkillSummary,
} from "../engineClient";
import { Spinner } from "../ui/Spinner";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function RuntimeSettingsPane({ projectDir }: { projectDir?: string | null }) {
  const [configuration, setConfiguration] = useState<RuntimeConfiguration | null>(null);
  const [extensions, setExtensions] = useState<RuntimeExtensionRegistration[]>([]);
  const [skills, setSkills] = useState<RuntimeSkillSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [retentionDays, setRetentionDays] = useState(7);
  const [retentionGiB, setRetentionGiB] = useState(1);
  const [mcpId, setMcpId] = useState("");
  const [mcpTransport, setMcpTransport] = useState<"streamable-http" | "stdio">("streamable-http");
  const [mcpEndpoint, setMcpEndpoint] = useState("");
  const [credentialRef, setCredentialRef] = useState("");
  const [credentialValue, setCredentialValue] = useState("");
  const [persistCredential, setPersistCredential] = useState(false);
  const [hookId, setHookId] = useState("");
  const [hookExecutable, setHookExecutable] = useState("");
  const [hookMode, setHookMode] = useState<"observational" | "enforcing">("observational");

  const reload = useCallback(async () => {
    if (!projectDir) return;
    setError(null);
    try {
      const [status, registered, discovered] = await Promise.all([
        engineClient.runtimeStatus(projectDir),
        engineClient.runtimeExtensionsList(projectDir),
        engineClient.runtimeSkillsDiscover(projectDir),
      ]);
      setConfiguration(status.configuration);
      setRetentionDays(status.configuration.retentionDays);
      setRetentionGiB(Math.max(1, Math.round(status.configuration.retentionBytes / 1024 ** 3)));
      setExtensions(registered.extensions);
      setSkills(discovered.skills);
      for (const extension of registered.extensions) {
        if (extension.kind !== "mcp") continue;
        const reference = extension.config.credentialRef;
        if (typeof reference !== "string") continue;
        const value = await getSecret(`mcp:${reference}`);
        if (value !== null) await engineClient.runtimeCredentialConfigure(reference, value);
      }
    } catch (cause) {
      setError(message(cause));
    }
  }, [projectDir]);

  useEffect(() => { void reload(); }, [reload]);

  const byKey = useMemo(
    () => new Map(extensions.map((extension) => [`${extension.kind}:${extension.id}`, extension])),
    [extensions],
  );

  const updateConfiguration = useCallback(async (update: Partial<RuntimeConfiguration>) => {
    if (!projectDir) return;
    setBusy(true);
    setError(null);
    try {
      const traceKey = update.traceEnabled === true
        ? await engineClient.ensureRuntimeKey(projectDir)
        : undefined;
      const result = await engineClient.runtimeConfigure(projectDir, {
        ...update,
        ...(traceKey === undefined ? {} : { traceKey }),
      });
      setConfiguration(result.configuration);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }, [projectDir]);

  const approve = useCallback(async (extension: RuntimeExtensionRegistration, approved: boolean) => {
    if (!projectDir) return;
    setBusy(true);
    try {
      await engineClient.runtimeExtensionApprove(projectDir, extension, approved);
      await reload();
    } catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  }, [projectDir, reload]);

  const enable = useCallback(async (extension: RuntimeExtensionRegistration, enabled: boolean) => {
    if (!projectDir) return;
    setBusy(true);
    try {
      await engineClient.runtimeExtensionEnable(projectDir, extension, enabled);
      await reload();
    } catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  }, [projectDir, reload]);

  const registerSkill = useCallback(async (skill: RuntimeSkillSummary) => {
    if (!projectDir) return;
    setBusy(true);
    try {
      const result = await engineClient.runtimeExtensionRegister(projectDir, {
        kind: "skill",
        id: skill.id,
        fingerprint: skill.fingerprint,
        config: { sourcePath: skill.sourcePath, dialect: skill.dialect },
        diagnostics: skill.diagnostics.map(({ code, message: diagnostic }) => ({ code, message: diagnostic })),
      });
      await engineClient.runtimeExtensionApprove(projectDir, result.extension, true);
      await engineClient.runtimeExtensionEnable(projectDir, result.extension, true);
      await reload();
    } catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  }, [projectDir, reload]);

  const submitMcp = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    if (!projectDir || !mcpId.trim() || !mcpEndpoint.trim()) return;
    setBusy(true);
    try {
      if (credentialRef.trim() && credentialValue) {
        await setSecret(`mcp:${credentialRef.trim()}`, credentialValue, persistCredential);
        await engineClient.runtimeCredentialConfigure(credentialRef.trim(), credentialValue);
      }
      const config = mcpTransport === "stdio"
        ? { id: mcpId.trim(), transport: "stdio", command: mcpEndpoint.trim(), cwd: projectDir }
        : {
            id: mcpId.trim(),
            transport: "streamable-http",
            url: mcpEndpoint.trim(),
            ...(credentialRef.trim() ? { credentialRef: credentialRef.trim() } : {}),
          };
      await engineClient.runtimeMcpRegister(projectDir, config);
      setMcpId("");
      setMcpEndpoint("");
      setCredentialValue("");
      await reload();
    } catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  }, [credentialRef, credentialValue, mcpEndpoint, mcpId, mcpTransport, persistCredential, projectDir, reload]);

  const submitHook = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    if (!projectDir || !hookId.trim() || !hookExecutable.trim()) return;
    setBusy(true);
    try {
      const definition = { id: hookId.trim(), mode: hookMode, executable: hookExecutable.trim() };
      const { fingerprint } = await engineClient.runtimeHookFingerprint(definition);
      await engineClient.runtimeExtensionRegister(projectDir, {
        kind: "hook",
        id: definition.id,
        fingerprint,
        config: { mode: definition.mode, executable: definition.executable },
      });
      setHookId("");
      setHookExecutable("");
      await reload();
    } catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  }, [hookExecutable, hookId, hookMode, projectDir, reload]);

  if (!projectDir) {
    return <section className="settings-pane"><h2 className="settings-section-title">Runtime</h2><p className="settings-empty">Select a project to configure its runtime.</p></section>;
  }
  if (configuration === null) {
    return <p role="status" className="settings-loading"><Spinner label="Loading runtime settings" /> Loading runtime settings…</p>;
  }

  return (
    <section className="settings-pane runtime-settings">
      <h2 className="settings-section-title">Runtime</h2>
      <p className="settings-lede">Durable traces, sandbox grants, skills, MCP servers, hooks, and child-session opt-in are project scoped.</p>
      {error && <p role="alert" className="error-text">{error}</p>}

      <fieldset disabled={busy} className="runtime-settings-group">
        <legend>Durability and authority</legend>
        <label><input type="checkbox" checked={configuration.traceEnabled} onChange={(event) => void updateConfiguration({ traceEnabled: event.target.checked })} /> Encrypted exact-resume traces</label>
        <label><input type="checkbox" checked={configuration.sandboxGrants.includes("network")} onChange={(event) => void updateConfiguration({ sandboxGrants: event.target.checked ? ["network"] : [] })} /> Allow sandboxed network access</label>
        <label><input type="checkbox" checked={configuration.childrenEnabled} onChange={(event) => void updateConfiguration({ childrenEnabled: event.target.checked })} /> Enable isolated child sessions</label>
        <div className="runtime-settings-inline">
          <label>Retention days <input type="number" min={1} max={3650} value={retentionDays} onChange={(event) => setRetentionDays(Number(event.target.value))} /></label>
          <label>Retention GiB <input type="number" min={1} value={retentionGiB} onChange={(event) => setRetentionGiB(Number(event.target.value))} /></label>
          <button type="button" onClick={() => void updateConfiguration({ retentionDays, retentionBytes: retentionGiB * 1024 ** 3 })}>Save retention</button>
        </div>
      </fieldset>

      <div className="runtime-settings-group">
        <h3>Skills</h3>
        {skills.length === 0 ? <p>No Claude Code or Codex skills discovered.</p> : (
          <ul className="runtime-extension-list">
            {skills.map((skill) => {
              const registered = byKey.get(`skill:${skill.id}`);
              return <li key={skill.sourcePath}><span><strong>{skill.name}</strong> <small>{skill.dialect}</small><br />{skill.description}</span>{!skill.requiresApproval ? <em>Instructions available</em> : registered?.enabled ? <em>Enabled</em> : <button disabled={busy} type="button" onClick={() => void registerSkill(skill)}>Approve & enable</button>}</li>;
            })}
          </ul>
        )}
      </div>

      <div className="runtime-settings-group">
        <h3>MCP servers</h3>
        <form className="runtime-settings-form" onSubmit={submitMcp}>
          <input aria-label="MCP id" placeholder="Server id" value={mcpId} onChange={(event) => setMcpId(event.target.value)} />
          <select aria-label="MCP transport" value={mcpTransport} onChange={(event) => setMcpTransport(event.target.value as typeof mcpTransport)}><option value="streamable-http">Streamable HTTP</option><option value="stdio">stdio</option></select>
          <input aria-label="MCP endpoint" placeholder={mcpTransport === "stdio" ? "/absolute/server-command" : "https://…/mcp"} value={mcpEndpoint} onChange={(event) => setMcpEndpoint(event.target.value)} />
          {mcpTransport === "streamable-http" && <><input aria-label="MCP credential reference" placeholder="Credential reference (optional)" value={credentialRef} onChange={(event) => setCredentialRef(event.target.value)} /><input aria-label="MCP credential" type="password" placeholder="Credential value (write-only)" value={credentialValue} onChange={(event) => setCredentialValue(event.target.value)} /><label><input type="checkbox" checked={persistCredential} onChange={(event) => setPersistCredential(event.target.checked)} /> Save in Keychain</label></>}
          <button disabled={busy} type="submit">Register</button>
        </form>
      </div>

      <div className="runtime-settings-group">
        <h3>Process hooks</h3>
        <form className="runtime-settings-form" onSubmit={submitHook}>
          <input aria-label="Hook id" placeholder="Hook id" value={hookId} onChange={(event) => setHookId(event.target.value)} />
          <select aria-label="Hook mode" value={hookMode} onChange={(event) => setHookMode(event.target.value as typeof hookMode)}><option value="observational">Observational</option><option value="enforcing">Enforcing</option></select>
          <input aria-label="Hook executable" placeholder="/absolute/hook-command" value={hookExecutable} onChange={(event) => setHookExecutable(event.target.value)} />
          <button disabled={busy} type="submit">Register</button>
        </form>
      </div>

      <div className="runtime-settings-group">
        <h3>Approval fingerprints</h3>
        {extensions.length === 0 ? <p>No capability-bearing extensions registered.</p> : <ul className="runtime-extension-list">{extensions.map((extension) => <li key={`${extension.kind}:${extension.id}`}><span><strong>{extension.id}</strong> <small>{extension.kind} · {extension.fingerprint.slice(0, 18)}…</small><br />{extension.approvalStatus}{extension.enabled ? " · enabled" : ""}</span><span className="runtime-extension-actions">{extension.approvalStatus !== "approved" ? <button disabled={busy} type="button" onClick={() => void approve(extension, true)}>Approve</button> : <><button disabled={busy} type="button" onClick={() => void enable(extension, !extension.enabled)}>{extension.enabled ? "Disable" : "Enable"}</button><button disabled={busy} type="button" onClick={() => void approve(extension, false)}>Revoke</button>{extension.kind === "mcp" && <button disabled={busy} type="button" onClick={() => void engineClient.runtimeMcpConnect(projectDir, extension.id).then(reload).catch((cause) => setError(message(cause)))}>Discover tools</button>}</>}</span></li>)}</ul>}
      </div>
    </section>
  );
}
