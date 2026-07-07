# Project-Centric Cockpit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two-flat-list global Settings with a project-centric two-rail cockpit where a user picks a project from a persistent list and edits that project's harness team model assignments in a tree.

**Architecture:** Backend-first. (1) A host-owned project registry (Rust, mirrors `providers.rs`). (2) Three additive engine RPCs over the existing `loadHarness`/`validateHarness`/`writeHarness` primitives. (3) A shared React `ProjectContext` + two-rail shell that the existing screens are refactored to consume. (4) The harness-setting tree panel on top of the RPCs.

**Tech Stack:** Tauri 2 (Rust host), Node/TypeScript engine sidecar over JSON-RPC, React 18 + Vite, vitest + @testing-library/react, `cargo test`.

## Global Constraints

- **No content logging:** never `console.*` under `apps/desktop/src/` (enforced by `noConsoleLogging.test.ts`); never log a secret, method, params, or result. One line each — copy verbatim.
- **Secrets never in metadata:** the project registry stores only `{ path, name }` — no keys, ever (same invariant as `providers.rs`).
- **TypeScript strict:** `noUncheckedIndexedAccess` is on — index access is `T | undefined`; guard it.
- **Test globals are off:** every `*.test.ts(x)` imports its own vitest globals and calls `afterEach(cleanup)` explicitly.
- **Engine RPC error shape:** validation/■not-found failures throw `RpcMethodError(RpcErrorCodes.SERVER_ERROR, msg, { issues })`, mirroring `engine.harness.export`.
- **Harness writes preserve provenance:** all writes go through `writeHarness`, which recomputes `manifest.artifacts` — never hand-roll a partial file write.
- **Agent model shape:** `AgentModel = "frontier" | { kind: string; model: string; providerId?: string }` — identical on engine and frontend.

---

## Task 1: Project registry store (Rust host)

Mirrors `apps/desktop/src-tauri/src/providers.rs` exactly, but for `{ path, name }` project metadata in MRU order (front = most recently opened). `add` is upsert-to-front (used for both "add new" and "bump on select"); `remove` deletes by path.

**Files:**
- Create: `apps/desktop/src-tauri/src/projects.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs` (add `mod projects;`, manage store, register 3 commands)

**Interfaces:**
- Produces (Tauri commands): `list_projects() -> Vec<ProjectMeta>`, `add_project(project: ProjectMeta) -> ()`, `remove_project(path: String) -> ()`, where `ProjectMeta { path: String, name: String }`.

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/src-tauri/src/projects.rs` with the store + a `#[cfg(test)]` module mirroring `providers.rs`:

```rust
//! Host-owned project registry (non-secret). Mirrors `providers.rs`: a JSON
//! array at `<app_config_dir>/projects.json`, MRU-ordered (front = most
//! recently opened). Stores ONLY `{ path, name }` — never a secret.

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectMeta {
    pub path: String,
    pub name: String,
}

pub trait ProjectBackend: Send + Sync {
    fn read(&self) -> Result<Vec<ProjectMeta>, String>;
    fn write(&self, projects: &[ProjectMeta]) -> Result<(), String>;
}

pub struct FileProjectBackend {
    path: PathBuf,
}

impl FileProjectBackend {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl ProjectBackend for FileProjectBackend {
    fn read(&self) -> Result<Vec<ProjectMeta>, String> {
        match std::fs::read_to_string(&self.path) {
            Ok(json) => serde_json::from_str(&json).map_err(|err| err.to_string()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(err) => Err(err.to_string()),
        }
    }

    fn write(&self, projects: &[ProjectMeta]) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
        let json = serde_json::to_string_pretty(projects).map_err(|err| err.to_string())?;
        std::fs::write(&self.path, json).map_err(|err| err.to_string())
    }
}

pub struct ProjectRegistryStore {
    backend: Arc<dyn ProjectBackend>,
}

impl ProjectRegistryStore {
    pub fn new(backend: Arc<dyn ProjectBackend>) -> Self {
        Self { backend }
    }

    pub fn list(&self) -> Result<Vec<ProjectMeta>, String> {
        self.backend.read()
    }

    /// Upsert-to-front by `path`: remove any existing entry with the same
    /// path, then insert at index 0 so the list stays MRU-ordered.
    pub fn add(&self, project: ProjectMeta) -> Result<(), String> {
        let mut projects = self.backend.read()?;
        projects.retain(|p| p.path != project.path);
        projects.insert(0, project);
        self.backend.write(&projects)
    }

    pub fn remove(&self, path: &str) -> Result<(), String> {
        let mut projects = self.backend.read()?;
        projects.retain(|p| p.path != path);
        self.backend.write(&projects)
    }
}

/// `invoke('list_projects')`.
#[tauri::command]
pub fn list_projects(state: State<'_, Arc<ProjectRegistryStore>>) -> Result<Vec<ProjectMeta>, String> {
    state.inner().list()
}

/// `invoke('add_project', { project })`.
#[tauri::command]
pub fn add_project(state: State<'_, Arc<ProjectRegistryStore>>, project: ProjectMeta) -> Result<(), String> {
    state.inner().add(project)
}

/// `invoke('remove_project', { path })`.
#[tauri::command]
pub fn remove_project(state: State<'_, Arc<ProjectRegistryStore>>, path: String) -> Result<(), String> {
    state.inner().remove(&path)
}

#[cfg(test)]
#[derive(Default)]
pub struct FakeProjectBackend {
    projects: std::sync::Mutex<Vec<ProjectMeta>>,
}

#[cfg(test)]
impl ProjectBackend for FakeProjectBackend {
    fn read(&self) -> Result<Vec<ProjectMeta>, String> {
        Ok(self.projects.lock().expect("fake project backend mutex poisoned").clone())
    }
    fn write(&self, projects: &[ProjectMeta]) -> Result<(), String> {
        *self.projects.lock().expect("fake project backend mutex poisoned") = projects.to_vec();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> ProjectRegistryStore {
        ProjectRegistryStore::new(Arc::new(FakeProjectBackend::default()))
    }

    fn proj(path: &str) -> ProjectMeta {
        ProjectMeta { path: path.into(), name: path.rsplit('/').next().unwrap_or(path).into() }
    }

    #[test]
    fn add_then_list_round_trips() {
        let s = store();
        s.add(proj("/repo/alpha")).unwrap();
        let all = s.list().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].path, "/repo/alpha");
        assert_eq!(all[0].name, "alpha");
    }

    #[test]
    fn add_moves_existing_to_front_without_duplicating() {
        let s = store();
        s.add(proj("/repo/alpha")).unwrap();
        s.add(proj("/repo/beta")).unwrap();
        s.add(proj("/repo/alpha")).unwrap(); // re-open alpha
        let all = s.list().unwrap();
        assert_eq!(all.len(), 2, "re-adding same path must not duplicate");
        assert_eq!(all[0].path, "/repo/alpha", "re-added project must move to front");
        assert_eq!(all[1].path, "/repo/beta");
    }

    #[test]
    fn remove_deletes_by_path() {
        let s = store();
        s.add(proj("/repo/alpha")).unwrap();
        s.add(proj("/repo/beta")).unwrap();
        s.remove("/repo/alpha").unwrap();
        let all = s.list().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].path, "/repo/beta");
    }

    #[test]
    fn list_on_missing_file_is_empty_not_error() {
        assert_eq!(store().list().unwrap(), Vec::new());
    }

    #[test]
    fn serialized_project_never_contains_a_key_field() {
        let json = serde_json::to_string(&proj("/repo/alpha")).unwrap();
        assert!(!json.to_lowercase().contains("key"), "project meta must never serialize a key: {json}");
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/desktop/src-tauri && cargo test projects::`
Expected: FAIL — `projects.rs` not yet declared as a module, so it won't compile / tests won't be found until Step 3 wires `mod projects;`.

- [ ] **Step 3: Wire the module + state + commands into `lib.rs`**

In `apps/desktop/src-tauri/src/lib.rs`, add `mod projects;` beside the other `mod` declarations, then in the `setup` closure (right after the `ProviderConfigStore` block) add:

```rust
// Host-owned project registry (see `projects.rs`). MRU list of opened repos.
let projects_path = app
    .path()
    .app_config_dir()
    .map_err(|err| std::io::Error::other(format!("no app config dir: {err}")))?
    .join("projects.json");
app.manage(Arc::new(projects::ProjectRegistryStore::new(Arc::new(
    projects::FileProjectBackend::new(projects_path),
))));
```

And in `tauri::generate_handler![ ... ]` add, after the `providers::*` entries:

```rust
projects::list_projects,
projects::add_project,
projects::remove_project,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/desktop/src-tauri && cargo test projects::`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/projects.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): host-owned project registry store + commands"
```

---

## Task 2: Project registry frontend wrappers

Free functions mirroring the `list_provider_configs` / `save_provider_config` wrappers in `engineClient.ts` (Rust host commands, NOT engine RPC).

**Files:**
- Modify: `apps/desktop/src/engineClient.ts` (add `ProjectMeta` type + 3 wrappers near the provider-metadata section, ~line 776)
- Test: `apps/desktop/src/engineClient.projects.test.ts` (create)

**Interfaces:**
- Consumes: `invoke` from `@tauri-apps/api/core`.
- Produces: `interface ProjectMeta { path: string; name: string }`; `listProjects(): Promise<ProjectMeta[]>`; `addProject(project: ProjectMeta): Promise<void>`; `removeProject(path: string): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/engineClient.projects.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  Channel: class {},
}));

import { listProjects, addProject, removeProject } from "./engineClient";

beforeEach(() => invokeMock.mockReset());
afterEach(() => vi.clearAllMocks());

describe("project registry wrappers", () => {
  it("listProjects invokes list_projects", async () => {
    invokeMock.mockResolvedValue([{ path: "/r/a", name: "a" }]);
    await expect(listProjects()).resolves.toEqual([{ path: "/r/a", name: "a" }]);
    expect(invokeMock).toHaveBeenCalledWith("list_projects");
  });

  it("addProject passes the project object", async () => {
    invokeMock.mockResolvedValue(undefined);
    await addProject({ path: "/r/a", name: "a" });
    expect(invokeMock).toHaveBeenCalledWith("add_project", { project: { path: "/r/a", name: "a" } });
  });

  it("removeProject passes the path", async () => {
    invokeMock.mockResolvedValue(undefined);
    await removeProject("/r/a");
    expect(invokeMock).toHaveBeenCalledWith("remove_project", { path: "/r/a" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/engineClient.projects.test.ts`
Expected: FAIL — `listProjects` is not exported.

- [ ] **Step 3: Add the wrappers**

In `apps/desktop/src/engineClient.ts`, after the provider-metadata command block (after `deleteProviderConfig`, ~line 777), add:

```ts
// ---------------------------------------------------------------------------
// Project registry commands (non-secret) — Rust host, NOT engine RPC.
// ---------------------------------------------------------------------------

/** A remembered project. Mirrors `projects.rs`'s `ProjectMeta`. Never a key. */
export interface ProjectMeta {
  path: string;
  name: string;
}

/** `invoke('list_projects')` — MRU order, front = most recently opened. */
export function listProjects(): Promise<ProjectMeta[]> {
  return invoke<ProjectMeta[]>("list_projects");
}

/** `invoke('add_project', { project })` — upsert-to-front. */
export function addProject(project: ProjectMeta): Promise<void> {
  return invoke("add_project", { project });
}

/** `invoke('remove_project', { path })` — metadata only; never touches the repo. */
export function removeProject(path: string): Promise<void> {
  return invoke("remove_project", { path });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/engineClient.projects.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/engineClient.ts apps/desktop/src/engineClient.projects.test.ts
git commit -m "feat(desktop): project registry frontend wrappers"
```

---

## Task 3: `engine.harness.read` RPC

Returns the trimmed team view for a ready harness; throws (mirroring `engine.harness.export`) when absent or structurally invalid.

**Files:**
- Modify: `packages/engine/src/harness/schema.ts` (export `AgentModelSchema` — currently a private const)
- Modify: `packages/engine/src/harness/methods.ts` (register `engine.harness.read`)
- Test: `packages/engine/test/harness-methods-read.test.ts` (create — engine tests live in `test/`, import from `../src/`)

**Interfaces:**
- Consumes: `loadHarness`, `validateHarness`, `HarnessValidationError` (already imported in `methods.ts`).
- Produces: `engine.harness.read({ projectDir })` →
  `{ agents: Array<{ name: string; role: string; taskClasses: string[]; model: AgentModel }>, defaultAgent: string, escalation: number }`
  where `AgentModel = "frontier" | { kind: string; model: string; providerId?: string }`.

- [ ] **Step 1: Export `AgentModelSchema`**

In `packages/engine/src/harness/schema.ts`, change `const AgentModelSchema = ...` (line 71) to `export const AgentModelSchema = ...`. Add the inferred type after it:

```ts
export type AgentModel = z.infer<typeof AgentModelSchema>;
```

- [ ] **Step 2: Write the failing test**

Create `packages/engine/test/harness-methods-read.test.ts`. This mirrors the house pattern from `test/frontier-methods.test.ts`: build the engine with `createEngine()`, drive a method with a `call()` helper that passes a full JSON-RPC message to `dispatcher.dispatch`, and read `res.result` / `res.error` (method errors come back as `res.error`, they do NOT reject):

```ts
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEngine, type Engine } from "../src/engine.js";
import { writeHarness } from "../src/harness/store.js";
import type { HarnessBundle } from "../src/harness/schema.js";

let dir: string;
let engine: Engine;

afterEach(async () => {
  await engine.close();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(method: string, params: unknown): Promise<any> {
  return engine.dispatcher.dispatch({ jsonrpc: "2.0", id: 1, method, params });
}

function bundle(): HarnessBundle {
  return {
    manifest: {
      schemaVersion: 1, generatorVersion: "test", engine: "test", headSha: "abc",
      generatedAt: "2026-07-06T00:00:00.000Z",
      verification: { structural: "pass", evals: "pending" }, artifacts: [],
    },
    pages: [{ slug: "architecture", title: "A", digest: "d", body: "b" }],
    agents: [
      { name: "coder", role: "writes code", description: "d", prompt: "p", taskClasses: ["codegen"],
        model: { kind: "deepseek", model: "deepseek-v4-flash", providerId: "deepseek" },
        escalation: { maxAttempts: 2 } },
      { name: "fallback", role: "default", description: "d", prompt: "p", taskClasses: ["docs"],
        model: "frontier", escalation: { maxAttempts: 1 } },
    ],
    routing: {
      version: 1,
      taskClasses: { codegen: { agent: "coder" }, docs: { agent: "fallback" } },
      escalation: { failuresBeforeFrontier: 2 },
      defaults: { agent: "fallback" },
    },
  };
}

describe("engine.harness.read", () => {
  it("returns the trimmed team view for a ready harness", async () => {
    engine = createEngine();
    dir = mkdtempSync(path.join(os.tmpdir(), "of-read-"));
    await writeHarness(dir, bundle());

    const res = await call("engine.harness.read", { projectDir: dir });

    expect(res.error).toBeUndefined();
    expect(res.result.escalation).toBe(2);
    expect(res.result.defaultAgent).toBe("fallback");
    expect(res.result.agents).toHaveLength(2);
    expect(res.result.agents[0]).toEqual({
      name: "coder", role: "writes code", taskClasses: ["codegen"],
      model: { kind: "deepseek", model: "deepseek-v4-flash", providerId: "deepseek" },
    });
    expect(res.result.agents[1].model).toBe("frontier");
    // prompt/body are NOT leaked into the read shape
    expect(res.result.agents[0].prompt).toBeUndefined();
  });

  it("errors when no harness has been generated", async () => {
    engine = createEngine();
    dir = mkdtempSync(path.join(os.tmpdir(), "of-read-"));
    const res = await call("engine.harness.read", { projectDir: dir });
    expect(res.result).toBeUndefined();
    expect(res.error.message).toMatch(/no valid harness/i);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/engine && npx vitest run test/harness-methods-read.test.ts`
Expected: FAIL — `Method not found: engine.harness.read`.

- [ ] **Step 4: Register the method**

In `packages/engine/src/harness/methods.ts`, inside `registerHarnessMethods`, after the `engine.harness.export` registration, add:

```ts
registerMethod(engine.dispatcher, "engine.harness.read", ProjectParamsSchema, ({ projectDir }) => {
  let bundle;
  try {
    bundle = loadHarness(projectDir);
  } catch (err) {
    if (err instanceof HarnessValidationError) {
      throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, err.message, { issues: err.issues });
    }
    throw err;
  }
  if (bundle === null) {
    throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, "no valid harness; run engine.harness.generate first");
  }
  const structuralIssues = validateHarness(bundle);
  if (structuralIssues.length > 0) {
    throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, "no valid harness; run engine.harness.generate first", {
      issues: structuralIssues,
    });
  }
  return {
    agents: bundle.agents.map((a) => ({
      name: a.name,
      role: a.role,
      taskClasses: a.taskClasses,
      model: a.model,
    })),
    defaultAgent: bundle.routing.defaults.agent,
    escalation: bundle.routing.escalation.failuresBeforeFrontier,
  };
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/engine && npx vitest run test/harness-methods-read.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/harness/schema.ts packages/engine/src/harness/methods.ts packages/engine/test/harness-methods-read.test.ts
git commit -m "feat(engine): engine.harness.read returns trimmed team view"
```

---

## Task 4: `engine.harness.updateAgentModel` + `engine.harness.updateEscalation`

Both writers share the shape: load → mutate → `validateHarness` → `writeHarness`. Registered together (one deliverable).

**Files:**
- Modify: `packages/engine/src/harness/methods.ts`
- Test: `packages/engine/test/harness-methods-update.test.ts` (create)

**Interfaces:**
- Consumes: `AgentModelSchema` (from Task 3), `loadHarness`, `validateHarness`, `writeHarness`.
- Produces:
  - `engine.harness.updateAgentModel({ projectDir, agentName, model })` → `{ updated: true }`; throws on unknown agent / malformed model / resulting structural issue.
  - `engine.harness.updateEscalation({ projectDir, failuresBeforeFrontier })` → `{ updated: true }`; `failuresBeforeFrontier` ∈ 1..3.

- [ ] **Step 1: Write the failing tests**

Create `packages/engine/test/harness-methods-update.test.ts` (same house pattern as Task 3; the `bundle()` factory is repeated so tasks stay independent):

```ts
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEngine, type Engine } from "../src/engine.js";
import { loadHarness, writeHarness } from "../src/harness/store.js";
import type { HarnessBundle } from "../src/harness/schema.js";

let dir: string;
let engine: Engine;

afterEach(async () => {
  await engine.close();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(method: string, params: unknown): Promise<any> {
  return engine.dispatcher.dispatch({ jsonrpc: "2.0", id: 1, method, params });
}

function bundle(): HarnessBundle {
  return {
    manifest: {
      schemaVersion: 1, generatorVersion: "test", engine: "test", headSha: "abc",
      generatedAt: "2026-07-06T00:00:00.000Z",
      verification: { structural: "pass", evals: "pending" }, artifacts: [],
    },
    pages: [{ slug: "architecture", title: "A", digest: "d", body: "b" }],
    agents: [
      { name: "coder", role: "writes code", description: "d", prompt: "p", taskClasses: ["codegen"],
        model: { kind: "deepseek", model: "deepseek-v4-flash", providerId: "deepseek" },
        escalation: { maxAttempts: 2 } },
    ],
    routing: {
      version: 1, taskClasses: { codegen: { agent: "coder" } },
      escalation: { failuresBeforeFrontier: 2 }, defaults: { agent: "coder" },
    },
  };
}

async function setup(): Promise<void> {
  engine = createEngine();
  dir = mkdtempSync(path.join(os.tmpdir(), "of-upd-"));
  await writeHarness(dir, bundle());
}

describe("engine.harness.updateAgentModel", () => {
  it("reassigns an agent's model and persists it", async () => {
    await setup();
    const res = await call("engine.harness.updateAgentModel", {
      projectDir: dir, agentName: "coder",
      model: { kind: "moonshot", model: "kimi-k2.7-code", providerId: "moonshot" },
    });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ updated: true });
    expect(loadHarness(dir)!.agents[0].model).toEqual({ kind: "moonshot", model: "kimi-k2.7-code", providerId: "moonshot" });
  });

  it("accepts the frontier sentinel", async () => {
    await setup();
    await call("engine.harness.updateAgentModel", { projectDir: dir, agentName: "coder", model: "frontier" });
    expect(loadHarness(dir)!.agents[0].model).toBe("frontier");
  });

  it("errors on an unknown agent", async () => {
    await setup();
    const res = await call("engine.harness.updateAgentModel", { projectDir: dir, agentName: "nope", model: "frontier" });
    expect(res.error.message).toMatch(/unknown agent/i);
  });

  it("errors on a malformed model", async () => {
    await setup();
    const res = await call("engine.harness.updateAgentModel", { projectDir: dir, agentName: "coder", model: { kind: "moonshot" } });
    expect(res.error.message).toMatch(/invalid params/i);
  });

  it("preserves manifest provenance after a write", async () => {
    await setup();
    await call("engine.harness.updateAgentModel", { projectDir: dir, agentName: "coder", model: "frontier" });
    const reloaded = loadHarness(dir)!;
    expect(reloaded.manifest.generatorVersion).toBe("test");
    expect(reloaded.manifest.artifacts.length).toBeGreaterThan(0);
  });
});

describe("engine.harness.updateEscalation", () => {
  it("sets failuresBeforeFrontier", async () => {
    await setup();
    const res = await call("engine.harness.updateEscalation", { projectDir: dir, failuresBeforeFrontier: 3 });
    expect(res.result).toEqual({ updated: true });
    expect(loadHarness(dir)!.routing.escalation.failuresBeforeFrontier).toBe(3);
  });

  it("errors on out-of-range values", async () => {
    await setup();
    const res = await call("engine.harness.updateEscalation", { projectDir: dir, failuresBeforeFrontier: 9 });
    expect(res.error.message).toMatch(/invalid params/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/engine && npx vitest run test/harness-methods-update.test.ts`
Expected: FAIL — both methods not found.

- [ ] **Step 3: Register both writers**

In `packages/engine/src/harness/methods.ts`, adjust the top-of-file imports. `z` and `validateHarness` are already imported; extend the two `./schema.js` / `./store.js` lines so the final state is:

```ts
// existing: import { z } from "zod";  (leave as-is)
import { AgentModelSchema, validateHarness, type HarnessBundle } from "./schema.js"; // add AgentModelSchema + HarnessBundle
import { HarnessValidationError, harnessStatus, loadHarness, writeHarness } from "./store.js"; // add writeHarness
```

Then define the param schemas near `ExportParamsSchema` (top of file):

```ts
const UpdateAgentModelParamsSchema = z.object({
  projectDir: z.string().min(1),
  agentName: z.string().min(1),
  model: AgentModelSchema,
});

const UpdateEscalationParamsSchema = z.object({
  projectDir: z.string().min(1),
  failuresBeforeFrontier: z.number().int().min(1).max(3),
});
```

Then, inside `registerHarnessMethods` after `engine.harness.read`, add a shared helper + the two registrations:

```ts
// Load → (caller mutates) → validate → atomic write. Throws the same
// "no valid harness" shape as read/export when the bundle is absent, and
// carries validateHarness issues when a mutation would break referential
// integrity. All persistence goes through writeHarness so manifest
// provenance (and the artifacts prune list) is recomputed correctly.
async function mutateHarness(projectDir: string, mutate: (b: HarnessBundle) => void): Promise<void> {
  let bundle;
  try {
    bundle = loadHarness(projectDir);
  } catch (err) {
    if (err instanceof HarnessValidationError) {
      throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, err.message, { issues: err.issues });
    }
    throw err;
  }
  if (bundle === null) {
    throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, "no valid harness; run engine.harness.generate first");
  }
  mutate(bundle);
  const issues = validateHarness(bundle);
  if (issues.length > 0) {
    throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, "edit would break the harness", { issues });
  }
  await writeHarness(projectDir, bundle);
}

registerMethod(engine.dispatcher, "engine.harness.updateAgentModel", UpdateAgentModelParamsSchema, async ({ projectDir, agentName, model }) => {
  await mutateHarness(projectDir, (bundle) => {
    const agent = bundle.agents.find((a) => a.name === agentName);
    if (agent === undefined) {
      throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, `unknown agent "${agentName}"`);
    }
    agent.model = model;
  });
  return { updated: true };
});

registerMethod(engine.dispatcher, "engine.harness.updateEscalation", UpdateEscalationParamsSchema, async ({ projectDir, failuresBeforeFrontier }) => {
  await mutateHarness(projectDir, (bundle) => {
    bundle.routing.escalation.failuresBeforeFrontier = failuresBeforeFrontier;
  });
  return { updated: true };
});
```

> Note: a `RpcMethodError` thrown *inside* the `mutate` callback propagates out of `mutateHarness` unchanged — it is not a `HarnessValidationError`, so the try/catch above does not swallow it. (`HarnessBundle` is imported via the schema-import line in the step above.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/engine && npx vitest run test/harness-methods-update.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/harness/methods.ts packages/engine/test/harness-methods-update.test.ts
git commit -m "feat(engine): harness updateAgentModel + updateEscalation writers"
```

---

## Task 5: Harness read/update frontend wrappers

**Files:**
- Modify: `apps/desktop/src/engineClient.ts` (types + 3 class methods near the other `harness*` wrappers, ~line 566)
- Test: `apps/desktop/src/engineClient.harness.test.ts` (create)

**Interfaces:**
- Produces (on `EngineClient`): `harnessRead(projectDir): Promise<HarnessTeam>`, `harnessUpdateAgentModel(projectDir, agentName, model): Promise<{ updated: boolean }>`, `harnessUpdateEscalation(projectDir, failuresBeforeFrontier): Promise<{ updated: boolean }>`.
- Types: `AgentModel`, `HarnessAgentView`, `HarnessTeam`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/engineClient.harness.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  Channel: class {},
}));

import { EngineClient } from "./engineClient";

beforeEach(() => invokeMock.mockReset());
afterEach(() => vi.clearAllMocks());

describe("harness read/update wrappers", () => {
  it("harnessRead calls engine.harness.read", async () => {
    const team = { agents: [], defaultAgent: "coder", escalation: 2 };
    invokeMock.mockResolvedValue(team);
    const client = new EngineClient();
    await expect(client.harnessRead("/r/a")).resolves.toEqual(team);
    expect(invokeMock).toHaveBeenCalledWith("engine_call", {
      method: "engine.harness.read", params: { projectDir: "/r/a" }, timeoutMs: undefined,
    });
  });

  it("harnessUpdateAgentModel forwards agentName + model", async () => {
    invokeMock.mockResolvedValue({ updated: true });
    const client = new EngineClient();
    await client.harnessUpdateAgentModel("/r/a", "coder", { kind: "moonshot", model: "kimi-k2.7-code", providerId: "moonshot" });
    expect(invokeMock).toHaveBeenCalledWith("engine_call", {
      method: "engine.harness.updateAgentModel",
      params: { projectDir: "/r/a", agentName: "coder", model: { kind: "moonshot", model: "kimi-k2.7-code", providerId: "moonshot" } },
      timeoutMs: undefined,
    });
  });

  it("harnessUpdateEscalation forwards the count", async () => {
    invokeMock.mockResolvedValue({ updated: true });
    const client = new EngineClient();
    await client.harnessUpdateEscalation("/r/a", 3);
    expect(invokeMock).toHaveBeenCalledWith("engine_call", {
      method: "engine.harness.updateEscalation",
      params: { projectDir: "/r/a", failuresBeforeFrontier: 3 }, timeoutMs: undefined,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/engineClient.harness.test.ts`
Expected: FAIL — `harnessRead` is not a method on `EngineClient`.

- [ ] **Step 3: Add types + methods**

In `apps/desktop/src/engineClient.ts`, add these exported types near `HarnessStatus` (~line 264):

```ts
/** Mirrors the engine's `AgentModel` (harness/schema.ts). */
export type AgentModel = "frontier" | { kind: string; model: string; providerId?: string };

/** One row of the harness team, as `engine.harness.read` returns it. */
export interface HarnessAgentView {
  name: string;
  role: string;
  taskClasses: string[];
  model: AgentModel;
}

/** `engine.harness.read` result — the trimmed, editable team view. */
export interface HarnessTeam {
  agents: HarnessAgentView[];
  defaultAgent: string;
  escalation: number;
}
```

Then, inside the `EngineClient` class after `harnessGenerate` (~line 566), add:

```ts
/** `engine.harness.read` — the team view for a READY harness. Throws an
 * `EngineError` when the harness is absent/invalid; gate on `harnessStatus`
 * first for the missing/stale/invalid distinction. */
harnessRead(projectDir: string, opts?: CallOptions): Promise<HarnessTeam> {
  return this.call<HarnessTeam>("engine.harness.read", { projectDir }, opts);
}

/** `engine.harness.updateAgentModel` — reassign one agent's model. */
harnessUpdateAgentModel(projectDir: string, agentName: string, model: AgentModel, opts?: CallOptions): Promise<{ updated: boolean }> {
  return this.call<{ updated: boolean }>("engine.harness.updateAgentModel", { projectDir, agentName, model }, opts);
}

/** `engine.harness.updateEscalation` — set failuresBeforeFrontier (1–3). */
harnessUpdateEscalation(projectDir: string, failuresBeforeFrontier: number, opts?: CallOptions): Promise<{ updated: boolean }> {
  return this.call<{ updated: boolean }>("engine.harness.updateEscalation", { projectDir, failuresBeforeFrontier }, opts);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/engineClient.harness.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/engineClient.ts apps/desktop/src/engineClient.harness.test.ts
git commit -m "feat(desktop): harness read/update engineClient wrappers"
```

---

## Task 6: `ProjectContext` (shared project + section state)

The spine: one source of truth for the active project, the project list, and which Rail 2 section is showing.

**Files:**
- Create: `apps/desktop/src/ProjectContext.tsx`
- Test: `apps/desktop/src/ProjectContext.test.tsx`

**Interfaces:**
- Consumes: `listProjects`, `addProject`, `removeProject`, `ProjectMeta` (Task 2).
- Produces: `type Section = "chat" | "harness" | "evals"`; `baseName(dir: string): string`; `<ProjectProvider>`; `useProject(): { projects, activeProjectDir, section, selectProject, addProjectByPath, removeProjectByPath, setSection }`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/ProjectContext.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

const { listProjectsMock, addProjectMock, removeProjectMock } = vi.hoisted(() => ({
  listProjectsMock: vi.fn(), addProjectMock: vi.fn(), removeProjectMock: vi.fn(),
}));
vi.mock("./engineClient", () => ({
  listProjects: listProjectsMock, addProject: addProjectMock, removeProject: removeProjectMock,
}));

import { ProjectProvider, useProject, baseName } from "./ProjectContext";

afterEach(cleanup);
beforeEach(() => {
  listProjectsMock.mockReset(); addProjectMock.mockReset(); removeProjectMock.mockReset();
  addProjectMock.mockResolvedValue(undefined); removeProjectMock.mockResolvedValue(undefined);
});

function Probe() {
  const { projects, activeProjectDir, section, addProjectByPath, setSection } = useProject();
  return (
    <div>
      <span data-testid="active">{activeProjectDir ?? "none"}</span>
      <span data-testid="section">{section}</span>
      <span data-testid="count">{projects.length}</span>
      <button onClick={() => void addProjectByPath("/r/beta")}>add</button>
      <button onClick={() => setSection("harness")}>harness</button>
    </div>
  );
}

describe("ProjectContext", () => {
  it("baseName returns the last path segment", () => {
    expect(baseName("/a/b/openfusion")).toBe("openfusion");
    expect(baseName("/")).toBe("/");
  });

  it("hydrates from listProjects and selects the most recent", async () => {
    listProjectsMock.mockResolvedValue([{ path: "/r/alpha", name: "alpha" }]);
    render(<ProjectProvider><Probe /></ProjectProvider>);
    await waitFor(() => expect(screen.getByTestId("active").textContent).toBe("/r/alpha"));
    expect(screen.getByTestId("count").textContent).toBe("1");
  });

  it("addProjectByPath adds, re-lists, and activates", async () => {
    listProjectsMock.mockResolvedValueOnce([]); // initial hydrate
    listProjectsMock.mockResolvedValueOnce([{ path: "/r/beta", name: "beta" }]); // after add
    render(<ProjectProvider><Probe /></ProjectProvider>);
    await waitFor(() => expect(screen.getByTestId("active").textContent).toBe("none"));
    fireEvent.click(screen.getByText("add"));
    await waitFor(() => expect(addProjectMock).toHaveBeenCalledWith({ path: "/r/beta", name: "beta" }));
    await waitFor(() => expect(screen.getByTestId("active").textContent).toBe("/r/beta"));
  });

  it("setSection switches the active section", async () => {
    listProjectsMock.mockResolvedValue([]);
    render(<ProjectProvider><Probe /></ProjectProvider>);
    fireEvent.click(screen.getByText("harness"));
    expect(screen.getByTestId("section").textContent).toBe("harness");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/ProjectContext.test.tsx`
Expected: FAIL — module `./ProjectContext` not found.

- [ ] **Step 3: Implement the context**

Create `apps/desktop/src/ProjectContext.tsx`:

```tsx
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { addProject, listProjects, removeProject, type ProjectMeta } from "./engineClient";

export type Section = "chat" | "harness" | "evals";

/** Last path segment, or the raw string when it has none (e.g. "/"). */
export function baseName(dir: string): string {
  const segments = dir.split("/").filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? dir;
}

interface ProjectContextValue {
  projects: ProjectMeta[];
  activeProjectDir: string | null;
  section: Section;
  selectProject: (path: string) => void;
  addProjectByPath: (path: string) => Promise<void>;
  removeProjectByPath: (path: string) => Promise<void>;
  setSection: (section: Section) => void;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function useProject(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (ctx === null) throw new Error("useProject must be used within <ProjectProvider>");
  return ctx;
}

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [activeProjectDir, setActiveProjectDir] = useState<string | null>(null);
  const [section, setSection] = useState<Section>("chat");

  useEffect(() => {
    listProjects()
      .then((list) => {
        setProjects(list);
        setActiveProjectDir((current) => current ?? list[0]?.path ?? null);
      })
      .catch(() => {});
  }, []);

  const selectProject = useCallback((path: string) => {
    setActiveProjectDir(path);
    setSection("chat");
    // Bump to front (MRU) then resync the list order. Best-effort.
    void addProject({ path, name: baseName(path) })
      .then(() => listProjects())
      .then(setProjects)
      .catch(() => {});
  }, []);

  const addProjectByPath = useCallback(async (path: string) => {
    await addProject({ path, name: baseName(path) });
    setProjects(await listProjects());
    setActiveProjectDir(path);
    setSection("chat");
  }, []);

  const removeProjectByPath = useCallback(async (path: string) => {
    await removeProject(path);
    const list = await listProjects();
    setProjects(list);
    setActiveProjectDir((current) => (current === path ? list[0]?.path ?? null : current));
  }, []);

  return (
    <ProjectContext.Provider
      value={{ projects, activeProjectDir, section, selectProject, addProjectByPath, removeProjectByPath, setSection }}
    >
      {children}
    </ProjectContext.Provider>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/ProjectContext.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/ProjectContext.tsx apps/desktop/src/ProjectContext.test.tsx
git commit -m "feat(desktop): ProjectContext — shared project + section state"
```

---

## Task 7: `HarnessSettingPanel` (the tree)

The centerpiece. Gates on `harnessStatus`; when ready, renders `harnessRead` agents with a per-agent model `<select>` (options = `frontier` + persisted providers from `listProviderConfigs`) and an escalation `<select>`. Edits are optimistic.

**Files:**
- Create: `apps/desktop/src/components/HarnessSettingPanel.tsx`
- Test: `apps/desktop/src/components/HarnessSettingPanel.test.tsx`
- Modify: `apps/desktop/src/styles.css` (tree styles — minimal)

**Interfaces:**
- Consumes: `useProject` (activeProjectDir), `engineClient.harnessStatus/harnessRead/harnessUpdateAgentModel/harnessUpdateEscalation`, `listProviderConfigs`, `HarnessTeam`, `AgentModel`, `HarnessStatus`, `classifyHarness`-equivalent logic.
- Produces: `<HarnessSettingPanel />` (reads active project from context).

> Model options: only PERSISTED providers (`listProviderConfigs`) are offered — they carry a `model` and survive relaunch, which a routing.yaml assignment requires. Session-only providers are intentionally not selectable here; note this in a caption.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/components/HarnessSettingPanel.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

const { harnessStatusMock, harnessReadMock, updateModelMock, updateEscMock, listConfigsMock } = vi.hoisted(() => ({
  harnessStatusMock: vi.fn(), harnessReadMock: vi.fn(), updateModelMock: vi.fn(), updateEscMock: vi.fn(), listConfigsMock: vi.fn(),
}));
vi.mock("../engineClient", () => ({
  engineClient: {
    harnessStatus: harnessStatusMock, harnessRead: harnessReadMock,
    harnessUpdateAgentModel: updateModelMock, harnessUpdateEscalation: updateEscMock,
  },
  listProviderConfigs: listConfigsMock,
}));
vi.mock("../ProjectContext", () => ({ useProject: () => ({ activeProjectDir: "/r/alpha" }) }));

import { HarnessSettingPanel } from "./HarnessSettingPanel";

afterEach(cleanup);
beforeEach(() => {
  for (const m of [harnessStatusMock, harnessReadMock, updateModelMock, updateEscMock, listConfigsMock]) m.mockReset();
  harnessStatusMock.mockResolvedValue({ present: true, structural: "pass", headSha: "abc" });
  harnessReadMock.mockResolvedValue({
    agents: [
      { name: "coder", role: "writes code", taskClasses: ["codegen"], model: { kind: "deepseek", model: "deepseek-v4-flash", providerId: "deepseek" } },
      { name: "fallback", role: "default", taskClasses: ["docs"], model: "frontier" },
    ],
    defaultAgent: "fallback", escalation: 2,
  });
  listConfigsMock.mockResolvedValue([
    { id: "deepseek", kind: "deepseek", model: "deepseek-v4-flash" },
    { id: "moonshot", kind: "moonshot", model: "kimi-k2.7-code" },
  ]);
  updateModelMock.mockResolvedValue({ updated: true });
  updateEscMock.mockResolvedValue({ updated: true });
});

describe("HarnessSettingPanel", () => {
  it("renders the agent team with model selects once ready", async () => {
    render(<HarnessSettingPanel />);
    await waitFor(() => expect(screen.getByText("coder")).toBeTruthy());
    expect(screen.getByText("fallback")).toBeTruthy();
    // task-class chips are read-only text
    expect(screen.getByText("codegen")).toBeTruthy();
  });

  it("reassigns an agent's model on select change (optimistic)", async () => {
    render(<HarnessSettingPanel />);
    await waitFor(() => expect(screen.getByText("coder")).toBeTruthy());
    const select = screen.getByLabelText(/model for coder/i);
    fireEvent.change(select, { target: { value: "moonshot" } });
    await waitFor(() => expect(updateModelMock).toHaveBeenCalledWith(
      "/r/alpha", "coder", { kind: "moonshot", model: "kimi-k2.7-code", providerId: "moonshot" },
    ));
  });

  it("updates escalation on change", async () => {
    render(<HarnessSettingPanel />);
    await waitFor(() => expect(screen.getByText("coder")).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/escalate to frontier/i), { target: { value: "3" } });
    await waitFor(() => expect(updateEscMock).toHaveBeenCalledWith("/r/alpha", 3));
  });

  it("shows a generate prompt when no harness exists", async () => {
    harnessStatusMock.mockResolvedValue({ present: false, structural: "pass", headSha: "abc" });
    render(<HarnessSettingPanel />);
    await waitFor(() => expect(screen.getByText(/no harness yet/i)).toBeTruthy());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/components/HarnessSettingPanel.test.tsx`
Expected: FAIL — component not found.

- [ ] **Step 3: Implement the panel**

Create `apps/desktop/src/components/HarnessSettingPanel.tsx`:

```tsx
import { useCallback, useEffect, useMemo, useState } from "react";
import { engineClient, listProviderConfigs, type AgentModel, type HarnessAgentView, type HarnessTeam } from "../engineClient";
import { useProject } from "../ProjectContext";

function friendlyMessage(err: unknown): string {
  if (err instanceof Error && err.message.trim().length > 0) return err.message;
  if (typeof err === "string" && err.trim().length > 0) return err;
  return "Something went wrong. Please try again.";
}

interface ModelOption {
  /** `<select>` value: "frontier" or the provider id. */
  value: string;
  label: string;
  model: AgentModel;
}

/** Serialize an AgentModel to a `<select>` value for comparison. */
function modelToValue(model: AgentModel): string {
  return model === "frontier" ? "frontier" : model.providerId ?? model.kind;
}

type PanelState =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "error"; message: string }
  | { status: "ready"; team: HarnessTeam };

export function HarnessSettingPanel() {
  const { activeProjectDir } = useProject();
  const [state, setState] = useState<PanelState>({ status: "loading" });
  const [options, setOptions] = useState<ModelOption[]>([]);

  const load = useCallback((dir: string) => {
    setState({ status: "loading" });
    Promise.all([engineClient.harnessStatus(dir), listProviderConfigs()])
      .then(([status, configs]) => {
        setOptions([
          { value: "frontier", label: "frontier", model: "frontier" },
          ...configs.map((c) => ({
            value: c.id,
            label: `${c.kind} · ${c.model}`,
            model: { kind: c.kind, model: c.model, providerId: c.id } as AgentModel,
          })),
        ]);
        if (!status.present) {
          setState({ status: "missing" });
          return;
        }
        return engineClient.harnessRead(dir).then((team) => setState({ status: "ready", team }));
      })
      .catch((err: unknown) => setState({ status: "error", message: friendlyMessage(err) }));
  }, []);

  useEffect(() => {
    if (activeProjectDir === null) {
      setState({ status: "error", message: "Select a project first." });
      return;
    }
    load(activeProjectDir);
  }, [activeProjectDir, load]);

  const onModelChange = useCallback(
    (agentName: string, value: string) => {
      if (activeProjectDir === null) return;
      const option = options.find((o) => o.value === value);
      if (option === undefined) return;
      // Optimistic: reflect immediately, reconcile (reload) on failure.
      setState((prev) =>
        prev.status === "ready"
          ? { status: "ready", team: { ...prev.team, agents: prev.team.agents.map((a) => (a.name === agentName ? { ...a, model: option.model } : a)) } }
          : prev,
      );
      engineClient.harnessUpdateAgentModel(activeProjectDir, agentName, option.model).catch(() => load(activeProjectDir));
    },
    [activeProjectDir, options, load],
  );

  const onEscalationChange = useCallback(
    (value: string) => {
      if (activeProjectDir === null) return;
      const n = Number(value);
      setState((prev) => (prev.status === "ready" ? { status: "ready", team: { ...prev.team, escalation: n } } : prev));
      engineClient.harnessUpdateEscalation(activeProjectDir, n).catch(() => load(activeProjectDir));
    },
    [activeProjectDir, load],
  );

  if (state.status === "loading") return <div className="harness-panel-screen"><p role="status">Loading harness…</p></div>;
  if (state.status === "error") return <div className="harness-panel-screen"><p role="alert" className="error-text">{state.message}</p></div>;
  if (state.status === "missing") {
    return (
      <div className="harness-panel-screen">
        <p>No harness yet. Generate one from the Chat tab, then return here to tune models.</p>
      </div>
    );
  }

  return (
    <div className="harness-panel-screen">
      <h2 className="harness-tree-title">Harness setting</h2>
      <div className="harness-tree-root">Claude Code <span className="muted-text">orchestrator · frontier</span></div>
      <ul className="harness-tree">
        {state.team.agents.map((agent) => (
          <AgentRow key={agent.name} agent={agent} options={options} onChange={onModelChange} />
        ))}
      </ul>
      <label className="harness-escalation">
        Escalate to frontier after{" "}
        <select aria-label="Escalate to frontier after N failed attempts" value={state.team.escalation} onChange={(e) => onEscalationChange(e.target.value)}>
          <option value={1}>1</option>
          <option value={2}>2</option>
          <option value={3}>3</option>
        </select>{" "}
        failed attempts
      </label>
      {options.length === 1 && (
        <p className="muted-text harness-tree-caption">Only frontier is available — add a model provider in Settings to route work to cheaper models.</p>
      )}
    </div>
  );
}

function AgentRow({ agent, options, onChange }: { agent: HarnessAgentView; options: ModelOption[]; onChange: (name: string, value: string) => void }) {
  const current = useMemo(() => modelToValue(agent.model), [agent.model]);
  const selectId = `model-${agent.name}`;
  return (
    <li className="harness-tree-row">
      <span className="harness-agent-name">{agent.name}</span>
      <span className="harness-agent-classes">
        {agent.taskClasses.map((tc) => (
          <span key={tc} className="harness-class-chip">{tc}</span>
        ))}
      </span>
      <label className="sr-only" htmlFor={selectId}>{`Model for ${agent.name}`}</label>
      <select id={selectId} value={current} onChange={(e) => onChange(agent.name, e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </li>
  );
}
```

- [ ] **Step 4: Add minimal styles**

Append to `apps/desktop/src/styles.css`:

```css
.harness-panel-screen { padding: 24px 28px; max-width: 720px; }
.harness-tree-title { margin: 0 0 16px; }
.harness-tree-root { font-weight: 600; margin-bottom: 8px; }
.harness-tree { list-style: none; margin: 0 0 20px; padding: 0 0 0 12px; border-left: 1px solid var(--hairline, #333); }
.harness-tree-row { display: grid; grid-template-columns: 1fr auto minmax(200px, 260px); gap: 12px; align-items: center; padding: 8px 0; }
.harness-agent-name { font-weight: 500; }
.harness-agent-classes { display: flex; gap: 4px; flex-wrap: wrap; }
.harness-class-chip { font-size: 11px; padding: 1px 6px; border-radius: 4px; background: var(--chip-bg, #222); color: var(--muted, #999); }
.harness-escalation { display: block; margin-top: 8px; }
.harness-tree-caption { margin-top: 12px; }
```

> If `styles.css` already defines the `--hairline`/`--chip-bg`/`--muted` custom properties, drop the fallbacks; otherwise the inline fallbacks keep it self-contained.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/components/HarnessSettingPanel.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/components/HarnessSettingPanel.tsx apps/desktop/src/components/HarnessSettingPanel.test.tsx apps/desktop/src/styles.css
git commit -m "feat(desktop): HarnessSettingPanel — per-agent model tree"
```

---

## Task 8: `AppRail` (Rail 1 — app + projects)

**Files:**
- Create: `apps/desktop/src/components/AppRail.tsx`
- Test: `apps/desktop/src/components/AppRail.test.tsx`
- Modify: `apps/desktop/src/styles.css`

**Interfaces:**
- Consumes: `useProject`, `open` from `@tauri-apps/plugin-dialog`, `FusionMark`.
- Produces: `<AppRail onOpenSettings={() => void} />`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/components/AppRail.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

const { openMock, useProjectMock } = vi.hoisted(() => ({ openMock: vi.fn(), useProjectMock: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openMock }));
vi.mock("../ProjectContext", () => ({ useProject: () => useProjectMock() }));
vi.mock("./Logo", () => ({ FusionMark: () => <svg data-testid="mark" /> }));

import { AppRail } from "./AppRail";

afterEach(cleanup);
const selectProject = vi.fn();
const addProjectByPath = vi.fn();
const removeProjectByPath = vi.fn();
beforeEach(() => {
  openMock.mockReset(); selectProject.mockReset(); addProjectByPath.mockReset(); removeProjectByPath.mockReset();
  useProjectMock.mockReturnValue({
    projects: [{ path: "/r/alpha", name: "alpha" }, { path: "/r/beta", name: "beta" }],
    activeProjectDir: "/r/alpha", selectProject, addProjectByPath, removeProjectByPath,
  });
});

describe("AppRail", () => {
  it("lists projects and marks the active one", () => {
    render(<AppRail onOpenSettings={vi.fn()} />);
    const alpha = screen.getByRole("button", { name: "alpha" });
    expect(alpha.getAttribute("aria-current")).toBe("true");
  });

  it("selects a project on click", () => {
    render(<AppRail onOpenSettings={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "beta" }));
    expect(selectProject).toHaveBeenCalledWith("/r/beta");
  });

  it("opens the folder dialog and adds the chosen path", async () => {
    openMock.mockResolvedValue("/r/gamma");
    render(<AppRail onOpenSettings={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /add/i }));
    await waitFor(() => expect(addProjectByPath).toHaveBeenCalledWith("/r/gamma"));
  });

  it("fires onOpenSettings", () => {
    const onOpenSettings = vi.fn();
    render(<AppRail onOpenSettings={onOpenSettings} />);
    fireEvent.click(screen.getByRole("button", { name: /settings/i }));
    expect(onOpenSettings).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/components/AppRail.test.tsx`
Expected: FAIL — component not found.

- [ ] **Step 3: Implement `AppRail`**

Create `apps/desktop/src/components/AppRail.tsx`:

```tsx
import { open } from "@tauri-apps/plugin-dialog";
import { useProject } from "../ProjectContext";
import { FusionMark } from "./Logo";

export function AppRail({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { projects, activeProjectDir, selectProject, addProjectByPath, removeProjectByPath } = useProject();

  const onAdd = (): void => {
    open({ directory: true })
      .then((selected) => {
        if (typeof selected === "string") void addProjectByPath(selected);
      })
      .catch(() => {});
  };

  return (
    <nav className="app-rail" aria-label="Projects" data-tauri-drag-region>
      <div className="app-rail-head" data-tauri-drag-region>
        <FusionMark />
        <span className="app-rail-word">OpenFusion</span>
      </div>
      <div className="app-rail-label" aria-hidden="true">Projects</div>
      <ul className="project-list" aria-label="Projects">
        {projects.map((project) => (
          <li key={project.path} className="project-list-item">
            <button
              type="button"
              className={project.path === activeProjectDir ? "project-item project-item-active" : "project-item"}
              aria-current={project.path === activeProjectDir ? "true" : undefined}
              onClick={() => selectProject(project.path)}
            >
              {project.name}
            </button>
            <button
              type="button"
              className="project-remove"
              aria-label={`Remove ${project.name}`}
              onClick={() => void removeProjectByPath(project.path)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="project-add" onClick={onAdd}>+ Add</button>
      <div className="app-rail-foot">
        <button type="button" className="nav-link" onClick={onOpenSettings}>Settings</button>
      </div>
    </nav>
  );
}
```

- [ ] **Step 4: Add rail styles**

Append to `apps/desktop/src/styles.css`:

```css
.app-rail { display: flex; flex-direction: column; gap: 6px; padding: 12px 10px; width: 200px; min-width: 200px; }
.app-rail-head { display: flex; align-items: center; gap: 8px; padding: 8px 6px; }
.app-rail-head > * { pointer-events: none; }
.app-rail-word { font-weight: 600; }
.app-rail-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted, #999); padding: 8px 6px 2px; }
.project-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.project-list-item { display: flex; align-items: center; }
.project-item { flex: 1; text-align: left; padding: 6px 8px; border-radius: 6px; background: none; border: none; color: inherit; cursor: pointer; }
.project-item-active { background: var(--active-bg, #26262b); }
.project-remove { opacity: 0; background: none; border: none; color: var(--muted, #999); cursor: pointer; padding: 0 6px; }
.project-list-item:hover .project-remove { opacity: 1; }
.project-add { text-align: left; padding: 6px 8px; background: none; border: none; color: var(--muted, #999); cursor: pointer; }
.app-rail-foot { margin-top: auto; }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/components/AppRail.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/components/AppRail.tsx apps/desktop/src/components/AppRail.test.tsx apps/desktop/src/styles.css
git commit -m "feat(desktop): AppRail — projects rail"
```

---

## Task 9: `ProjectRail` (Rail 2 — project sections)

**Files:**
- Create: `apps/desktop/src/components/ProjectRail.tsx`
- Test: `apps/desktop/src/components/ProjectRail.test.tsx`
- Modify: `apps/desktop/src/styles.css`

**Interfaces:**
- Consumes: `useProject`, `baseName`, `Section`.
- Produces: `<ProjectRail />`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/components/ProjectRail.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

const { useProjectMock } = vi.hoisted(() => ({ useProjectMock: vi.fn() }));
vi.mock("../ProjectContext", () => ({ useProject: () => useProjectMock(), baseName: (d: string) => d.split("/").filter(Boolean).pop() ?? d }));

import { ProjectRail } from "./ProjectRail";

afterEach(cleanup);
const setSection = vi.fn();
beforeEach(() => {
  setSection.mockReset();
  useProjectMock.mockReturnValue({ activeProjectDir: "/r/alpha", section: "chat", setSection });
});

describe("ProjectRail", () => {
  it("shows the active project name and the three sections", () => {
    render(<ProjectRail />);
    expect(screen.getByText("alpha")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Chat" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "Harness setting" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Evals" })).toBeTruthy();
  });

  it("switches section on click", () => {
    render(<ProjectRail />);
    fireEvent.click(screen.getByRole("button", { name: "Harness setting" }));
    expect(setSection).toHaveBeenCalledWith("harness");
  });

  it("renders an empty state when no project is active", () => {
    useProjectMock.mockReturnValue({ activeProjectDir: null, section: "chat", setSection });
    render(<ProjectRail />);
    expect(screen.getByText(/no project selected/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/components/ProjectRail.test.tsx`
Expected: FAIL — component not found.

- [ ] **Step 3: Implement `ProjectRail`**

Create `apps/desktop/src/components/ProjectRail.tsx`:

```tsx
import { baseName, useProject, type Section } from "../ProjectContext";

const SECTIONS: Array<{ id: Section; label: string }> = [
  { id: "chat", label: "Chat" },
  { id: "harness", label: "Harness setting" },
  { id: "evals", label: "Evals" },
];

export function ProjectRail() {
  const { activeProjectDir, section, setSection } = useProject();

  if (activeProjectDir === null) {
    return <nav className="project-rail project-rail-empty" aria-label="Project sections">No project selected</nav>;
  }

  return (
    <nav className="project-rail" aria-label="Project sections">
      <div className="project-rail-head">{baseName(activeProjectDir)}</div>
      <ul className="section-list">
        {SECTIONS.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              className={s.id === section ? "section-item section-item-active" : "section-item"}
              aria-current={s.id === section ? "page" : undefined}
              onClick={() => setSection(s.id)}
            >
              {s.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
```

- [ ] **Step 4: Add rail styles**

Append to `apps/desktop/src/styles.css`:

```css
.project-rail { display: flex; flex-direction: column; gap: 4px; padding: 12px 10px; width: 200px; min-width: 200px; border-left: 1px solid var(--hairline, #2a2a2e); }
.project-rail-empty { color: var(--muted, #999); padding: 16px 12px; }
.project-rail-head { font-weight: 600; padding: 8px 6px 10px; }
.section-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.section-item { width: 100%; text-align: left; padding: 6px 8px; border-radius: 6px; background: none; border: none; color: inherit; cursor: pointer; }
.section-item-active { background: var(--active-bg, #26262b); }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/components/ProjectRail.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/components/ProjectRail.tsx apps/desktop/src/components/ProjectRail.test.tsx apps/desktop/src/styles.css
git commit -m "feat(desktop): ProjectRail — per-project section nav"
```

---

## Task 10: `App` three-pane restructure

Wrap the app in `ProjectProvider`, render `AppRail` + `ProjectRail` + a `MainPane` that switches on `section`. Retire the old `Nav` + `useHashRoute`. Keep the engine-events subscription and launch reconfigure.

**Files:**
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/App.test.tsx`
- Modify: `apps/desktop/src/styles.css` (three-pane grid)
- Delete: `apps/desktop/src/components/Nav.tsx`, `apps/desktop/src/router.ts`

**Interfaces:**
- Consumes: `ProjectProvider`, `useProject`, `AppRail`, `ProjectRail`, `OrchestrateScreen`, `HarnessSettingPanel`, `EvalsScreen`, `SettingsDialog`, `engineClient`, `reconfigureProvidersOnLaunch`.

- [ ] **Step 1: Update the App test**

Replace `apps/desktop/src/App.test.tsx`'s body with a version that asserts the three-pane shell (keep the existing `invoke`/`Channel` hoisted-mock header — it already handles `list_projects` returning `[]` via the default `return Promise.resolve(undefined)` fallthrough; add an explicit case):

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";

afterEach(cleanup);

const { invokeMock, FakeChannel } = vi.hoisted(() => {
  class FakeChannel<T> { onmessage: ((message: T) => void) | undefined; }
  return { invokeMock: vi.fn(), FakeChannel };
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  Channel: FakeChannel,
}));

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "engine_call") return Promise.resolve({ providers: [] });
    if (cmd === "list_projects") return Promise.resolve([]);
    if (cmd === "list_provider_configs") return Promise.resolve([]);
    if (cmd === "frontier_login_status") return Promise.resolve({ state: "disconnected" });
    return Promise.resolve(undefined);
  });
});

import { App } from "./App";

describe("App shell", () => {
  it("renders both rails", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByRole("navigation", { name: /projects/i })).toBeTruthy());
    expect(screen.getByRole("navigation", { name: /project sections/i })).toBeTruthy();
  });

  it("subscribes to engine events exactly once", async () => {
    render(<App />);
    await waitFor(() => {
      const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === "engine_events");
      expect(calls).toHaveLength(1);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/App.test.tsx`
Expected: FAIL — App still renders the old `Nav`; there is no `navigation` named "Project sections".

- [ ] **Step 3: Rewrite `App.tsx`**

Replace `apps/desktop/src/App.tsx` with:

```tsx
import { useEffect, useState } from "react";
import { AppRail } from "./components/AppRail";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { HarnessSettingPanel } from "./components/HarnessSettingPanel";
import { ProjectRail } from "./components/ProjectRail";
import { SettingsDialog } from "./components/SettingsDialog";
import { engineClient, reconfigureProvidersOnLaunch, type EngineNotification } from "./engineClient";
import { ProjectProvider, useProject } from "./ProjectContext";
import { EvalsScreen } from "./screens/EvalsScreen";
import { OrchestrateScreen } from "./screens/OrchestrateScreen";

/** MAIN pane: renders the active Rail 2 section for the active project. */
function MainPane({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { section } = useProject();
  if (section === "harness") return <HarnessSettingPanel />;
  if (section === "evals") return <EvalsScreen />;
  return <OrchestrateScreen onOpenSettings={onOpenSettings} />;
}

export function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [lastNotification, setLastNotification] = useState<EngineNotification | null>(null);
  const [notificationCount, setNotificationCount] = useState(0);

  useEffect(() => {
    const unsubscribe = engineClient.onEngineEvent((notification) => {
      setLastNotification(notification);
      setNotificationCount((count) => count + 1);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    void reconfigureProvidersOnLaunch().catch(() => {});
  }, []);

  return (
    <ErrorBoundary>
      <ProjectProvider>
        <div className="shell shell-three-pane">
          <AppRail onOpenSettings={() => setSettingsOpen(true)} />
          <ProjectRail />
          <main className="content">
            <MainPane onOpenSettings={() => setSettingsOpen(true)} />
          </main>
        </div>
        <footer className="status-bar">
          <span>Engine events received: {notificationCount}</span>
          {lastNotification && <span className="status-bar-detail">last: {lastNotification.method}</span>}
        </footer>
        <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      </ProjectProvider>
    </ErrorBoundary>
  );
}
```

- [ ] **Step 4: Add three-pane layout styles + delete dead files**

Append to `apps/desktop/src/styles.css`:

```css
.shell-three-pane { display: flex; flex-direction: row; align-items: stretch; height: 100%; }
.shell-three-pane .content { flex: 1; overflow: auto; }
```

Delete the retired navigation:

```bash
git rm apps/desktop/src/components/Nav.tsx apps/desktop/src/router.ts
```

> If `Nav.tsx`/`router.ts` have companion tests, delete those too (there are none at plan time — verify with `ls apps/desktop/src/**/Nav.test.tsx apps/desktop/src/router.test.ts 2>/dev/null`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/desktop && npx vitest run src/App.test.tsx`
Expected: PASS (2 tests). Then run the full frontend suite to catch any import of the deleted `router`/`Nav`: `npx vitest run` — fix any broken import by removing it.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/App.tsx apps/desktop/src/App.test.tsx apps/desktop/src/styles.css apps/desktop/src/components/Nav.tsx apps/desktop/src/router.ts
git commit -m "feat(desktop): three-pane shell replaces top-nav + hash router"
```

---

## Task 11: `OrchestrateScreen` consumes `ProjectContext`

Remove the screen's private `projectDir` state and folder-picker; read the active project from context. The composer's folder chip becomes a read-only project name. Harness/wiki status refresh keys off `activeProjectDir`.

**Files:**
- Modify: `apps/desktop/src/screens/OrchestrateScreen.tsx`
- Modify: `apps/desktop/src/screens/OrchestrateScreen.test.tsx`

**Interfaces:**
- Consumes: `useProject` (`activeProjectDir`).
- Produces: same `<OrchestrateScreen onOpenSettings? />` signature (unchanged externally).

- [ ] **Step 1: Update the test to drive project via context**

At the top of `apps/desktop/src/screens/OrchestrateScreen.test.tsx`, add a mock for `ProjectContext` so the screen sees a fixed active project (this replaces the old folder-dialog interaction). Add near the other `vi.mock` calls:

```tsx
const { useProjectMock } = vi.hoisted(() => ({ useProjectMock: vi.fn() }));
vi.mock("../ProjectContext", () => ({ useProject: () => useProjectMock() }));
```

In `beforeEach`, set: `useProjectMock.mockReturnValue({ activeProjectDir: "/r/alpha" });`

Then update any existing test that clicked "Choose a project" to instead assert the screen already reflects `/r/alpha` (e.g. the project name renders and harness status is checked for it). Remove assertions that depend on the `open()` dialog picker inside this screen.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/screens/OrchestrateScreen.test.tsx`
Expected: FAIL — the screen still uses local `projectDir` state and the `open` picker; `useProject` is not consumed.

- [ ] **Step 3: Refactor the screen to read context**

In `apps/desktop/src/screens/OrchestrateScreen.tsx`:

1. Add the import: `import { useProject } from "../ProjectContext";`
2. Replace the local project state line `const [projectDir, setProjectDir] = useState<string | null>(null);` with:

```tsx
const { activeProjectDir } = useProject();
const projectDir = activeProjectDir;
```

3. Delete `handleChooseProject` and its `open({ directory: true })` body, and remove the `import { open } from "@tauri-apps/plugin-dialog";` line.
4. Replace the effect that reacted to a manual pick with one that reacts to the active project changing:

```tsx
useEffect(() => {
  if (projectDir === null) return;
  projectDirRef.current = projectDir;
  setChatOpen(false);
  resetRunState();
  refreshHarnessState(projectDir);
}, [projectDir, refreshHarnessState, resetRunState]);
```

5. In the composer, replace the picker `<button className="composer-chip" onClick={handleChooseProject} …>` with a read-only chip:

```tsx
<span className="composer-chip composer-chip-static">
  <FolderGlyph />
  <span>{projectName ?? "No project selected"}</span>
</span>
```

6. In `setupView`, replace the `handleChooseProject` button with static project text (the project is chosen in Rail 1 now); keep the "Build harness" / "Recheck project" actions.

> These edits remove every `setProjectDir(...)` call. After editing, grep the file: `grep -n "setProjectDir\|handleChooseProject\|plugin-dialog" apps/desktop/src/screens/OrchestrateScreen.tsx` must return nothing.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/screens/OrchestrateScreen.test.tsx`
Expected: PASS. Then `npx vitest run` for the whole suite.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/screens/OrchestrateScreen.tsx apps/desktop/src/screens/OrchestrateScreen.test.tsx
git commit -m "refactor(desktop): OrchestrateScreen reads active project from context"
```

---

## Task 12: `EvalsScreen` consumes `ProjectContext`

Same treatment: drop the screen-local `projectDir` picker; read from context. It now renders as the Rail 2 "Evals" section.

**Files:**
- Modify: `apps/desktop/src/screens/EvalsScreen.tsx`
- Modify: `apps/desktop/src/screens/EvalsScreen.test.tsx`

**Interfaces:**
- Consumes: `useProject` (`activeProjectDir`).

- [ ] **Step 1: Inspect the screen's current project handling**

Run: `grep -n "projectDir\|open(\|plugin-dialog\|useState" apps/desktop/src/screens/EvalsScreen.tsx`
This shows every site to change (mirror of OrchestrateScreen: a local `projectDir` state + a folder picker).

- [ ] **Step 2: Update the test to drive project via context**

At the top of `apps/desktop/src/screens/EvalsScreen.test.tsx`, add:

```tsx
const { useProjectMock } = vi.hoisted(() => ({ useProjectMock: vi.fn() }));
vi.mock("../ProjectContext", () => ({ useProject: () => useProjectMock() }));
```

In `beforeEach`: `useProjectMock.mockReturnValue({ activeProjectDir: "/r/alpha" });`
Replace any "choose project" dialog interaction with assertions that the screen already targets `/r/alpha`.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/screens/EvalsScreen.test.tsx`
Expected: FAIL — screen still owns local project state.

- [ ] **Step 4: Refactor the screen**

In `apps/desktop/src/screens/EvalsScreen.tsx`:
1. `import { useProject } from "../ProjectContext";`
2. Replace the local `const [projectDir, setProjectDir] = useState…` with `const { activeProjectDir: projectDir } = useProject();`
3. Delete the folder-picker handler + `@tauri-apps/plugin-dialog` import; replace the picker button with static project-name text.
4. Ensure any effect that loaded eval state on pick now keys off `[projectDir]`.

> Grep after: `grep -n "setProjectDir\|plugin-dialog" apps/desktop/src/screens/EvalsScreen.tsx` must return nothing.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/screens/EvalsScreen.test.tsx`
Expected: PASS. Then run the whole suite + typecheck: `npx vitest run && npx tsc --noEmit`.

- [ ] **Step 6: Final full-stack verification + commit**

```bash
cd apps/desktop && npx vitest run && npx tsc --noEmit
cd ../../packages/engine && npx vitest run
cd ../../apps/desktop/src-tauri && cargo test
```
Expected: all green.

```bash
git add apps/desktop/src/screens/EvalsScreen.tsx apps/desktop/src/screens/EvalsScreen.test.tsx
git commit -m "refactor(desktop): EvalsScreen reads active project from context"
```

---

## Appendix: What this plan deliberately defers

- **Chat-history persistence** — Rail 2 "Chat" shows the live `OrchestrateScreen` session only; a session store is a separate plan.
- **Task-class ↔ agent remapping** — chips are read-only; editing `routing.taskClasses` risks dangling refs and is out of scope.
- **Editing agent prompts / roles / team composition** — the generator owns those.
- **Session-only providers as model options** — only persisted providers (which carry a model and survive relaunch) are selectable in the tree.
