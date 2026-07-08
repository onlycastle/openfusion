import { z } from "zod";
import { RpcErrorCodes } from "@openfusion/shared";
import type { Engine } from "../engine.js";
import { RpcMethodError } from "../rpc/errors.js";
import { resolveProjectKey } from "../rpc/guards.js";
import { registerMethod } from "../rpc/register.js";
import { HarnessGenError } from "./driver.js";
import { exportHarness } from "./exporters.js";
import { generateHarness, type GenerateHarnessResult } from "./generate.js";
import { AgentModelSchema, CARD_SLUG, validateHarness, type HarnessBundle } from "./schema.js";
import { HarnessValidationError, harnessStatus, loadHarness, setCardState, writeHarness } from "./store.js";

const ProjectParamsSchema = z.object({ projectDir: z.string().min(1) });

const ExportParamsSchema = z.object({
  projectDir: z.string().min(1),
  format: z.enum(["agents-md", "claude-subagents"]),
});

const UpdateAgentModelParamsSchema = z.object({
  projectDir: z.string().min(1),
  agentName: z.string().min(1),
  model: AgentModelSchema,
});

const UpdateEscalationParamsSchema = z.object({
  projectDir: z.string().min(1),
  failuresBeforeFrontier: z.number().int().min(1).max(3),
});

const CardUpdateParamsSchema = z.object({
  projectDir: z.string().min(1),
  // Same 2500-char ceiling as WikiPageSchema.digest (schema.ts) — the card's
  // digest is the one page digest injected into EVERY worker prompt
  // unconditionally, so it alone gets the wider budget.
  digest: z.string().min(1).max(2500),
});

// Shared by engine.harness.read (card: null vs populated) and
// engine.harness.card.update/.approve's "no project card" guard: the card
// slug (schema.ts's CARD_SLUG) must be present as an actual wiki page. A
// bundle can be hand-edited (spec §7.4) into having one without the other,
// so this alone is not sufficient for read's non-null card — see
// engine.harness.read below, which additionally requires
// manifest.verification.card !== undefined.
function findCardPage(bundle: HarnessBundle): HarnessBundle["pages"][number] | undefined {
  return bundle.pages.find((p) => p.slug === CARD_SLUG);
}

// Holds the per-project in-flight generation map. Mirrors WikiService.build's
// #building coalescing exactly: a second engine.harness.generate call for a
// project already generating returns the SAME promise instead of racing a
// second frontier session (and a second writeHarness) against the first.
export class HarnessService {
  #generating = new Map<string, Promise<GenerateHarnessResult>>();

  // Per-project write queue: chains each mutateHarness call onto the tail of
  // the previous one for the SAME project, so the RPC dispatcher's natural
  // concurrency (nothing serializes two near-simultaneous
  // engine.harness.updateAgentModel calls upstream of here) can't let a
  // second call's loadHarness read stale disk state before the first call's
  // writeHarness lands — the classic read-mutate-write race that silently
  // clobbers whichever write lands first. Keyed by resolveProjectKey so
  // distinct spellings/symlinks of the same project share one queue.
  #writeChain = new Map<string, Promise<unknown>>();

  generate(engine: Engine, projectDir: string): Promise<GenerateHarnessResult> {
    const key = resolveProjectKey(projectDir);
    const inFlight = this.#generating.get(key);
    if (inFlight !== undefined) return inFlight;

    const promise = generateHarness(engine, projectDir).finally(() => {
      this.#generating.delete(key);
    });
    this.#generating.set(key, promise);
    return promise;
  }

  // Whole-branch review (final review fix wave, Important — approval-gate
  // bypass): #generating and #writeChain above were NEVER cross-serialized,
  // only each self-serialized. generateHarness's writeHarness call REPLACES
  // THE ENTIRE BUNDLE (every wiki page including the project card, every
  // agent, all of routing.yaml — see generate.ts's own writeHarness call) —
  // there is no partial-generation state a mutate could safely interleave
  // with. A mutate racing an in-flight regenerate was therefore always
  // wrong, in either direction: (a) mutateHarness's own loadHarness reads
  // the PRE-generate bundle, and its writeHarness then either clobbers or
  // gets clobbered by generation's own writeHarness landing moments later —
  // a silently lost edit either way; (b) worse, for card.approve
  // specifically, a user can click Approve on a draft they are looking at
  // in the desktop review panel at the EXACT moment a background regenerate
  // has already replaced that page on disk with an entirely different,
  // never-reviewed draft — the approval they think they're granting to the
  // card they read is silently granted to content they never saw at all.
  // That is the approval-gate bypass this method exists to close: every
  // mutate RPC handler (card.update, card.approve, updateAgentModel,
  // updateEscalation — registerHarnessMethods below) checks this at the top
  // of its serializeWrite callback (so the check itself serializes with
  // other mutates, not just with generation) and rejects with SERVER_ERROR
  // rather than touching disk while a regenerate is in flight. See
  // harness-methods-update.test.ts's "approval-gate race" tests for the
  // exact scenario pinned.
  isGenerating(projectDir: string): boolean {
    return this.#generating.has(resolveProjectKey(projectDir));
  }

  // Queues fn to run only after every previously-queued write for this
  // project has settled (success OR failure — a `.then(fn, fn)`-style
  // neutralization, so one failed mutation can never wedge later queued
  // writes behind a permanently-rejected tail). Clears the map entry once
  // this call is the last one queued, so a quiet project doesn't leak an
  // ever-growing settled-promise chain.
  serializeWrite<T>(projectDir: string, fn: () => Promise<T>): Promise<T> {
    const key = resolveProjectKey(projectDir);
    const tail = this.#writeChain.get(key) ?? Promise.resolve();
    const settled = tail.then(fn, fn);
    const cleared = settled.then(
      () => undefined,
      () => undefined,
    );
    this.#writeChain.set(key, cleared);
    cleared.finally(() => {
      if (this.#writeChain.get(key) === cleared) this.#writeChain.delete(key);
    });
    return settled;
  }
}

export function registerHarnessMethods(engine: Engine): void {
  registerMethod(engine.dispatcher, "engine.harness.generate", ProjectParamsSchema, async ({ projectDir }) => {
    try {
      const result = await engine.harness.generate(engine, projectDir);
      engine.log(`harness.generate ${projectDir}: ${result.pages} pages, ${result.agents} agents`);
      return result;
    } catch (err) {
      // HarnessGenError (driver.ts, or thrown directly by generateHarness's
      // own write-stage structural gate) is the ONE expected failure mode
      // of the pipeline — every other throw (a non-git projectDir, an
      // unregistered frontier engine) already arrives as an RpcMethodError
      // and passes through the rethrow below untouched.
      if (err instanceof HarnessGenError) {
        engine.log(`harness.generate ${projectDir} failed at stage ${err.stage ?? "unknown"}`);
        throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, err.message, {
          stage: err.stage,
          issues: err.issues,
        });
      }
      throw err;
    }
  });

  registerMethod(engine.dispatcher, "engine.harness.status", ProjectParamsSchema, ({ projectDir }) => {
    try {
      return harnessStatus(projectDir);
    } catch (err) {
      if (err instanceof HarnessValidationError) {
        throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, err.message, { issues: err.issues });
      }
      throw err;
    }
  });

  registerMethod(engine.dispatcher, "engine.harness.export", ExportParamsSchema, async ({ projectDir, format }) => {
    let bundle;
    try {
      bundle = loadHarness(projectDir);
    } catch (err) {
      if (err instanceof HarnessValidationError) {
        throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, err.message, { issues: err.issues });
      }
      throw err;
    }
    // Requires a harness that is both PRESENT (loadHarness didn't return
    // null — something has been generated) and STRUCTURALLY VALID
    // (validateHarness's cross-artifact referential check, the same gate
    // generateHarness itself enforces at write time) — a bundle that loads
    // but fails that check (e.g. hand-edited via the Harness editor into a
    // dangling routing reference) is just as unexportable as no harness at
    // all, so both collapse to the same error MESSAGE. They are NOT
    // identical failures, though: the loadHarness-null case genuinely has
    // nothing to report, but a validateHarness failure has concrete issues
    // that would otherwise be silently discarded — those are carried in
    // error.data.issues so a caller can see exactly what's broken instead of
    // re-running validateHarness itself to find out.
    if (bundle === null) {
      throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, "no valid harness; run engine.harness.generate first");
    }
    const structuralIssues = validateHarness(bundle);
    if (structuralIssues.length > 0) {
      throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, "no valid harness; run engine.harness.generate first", {
        issues: structuralIssues,
      });
    }
    const result = await exportHarness(projectDir, bundle, format);
    engine.log(`harness.export ${projectDir} (${format}): ${result.files.length} files`);
    return result;
  });

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
    // Non-null ONLY when BOTH the project-card page and the manifest's card
    // verification field exist — a hand-edited bundle (spec §7.4) can carry
    // one without the other, and that partial state is not a usable card
    // (nothing to inject into worker prompts, or nothing to report an
    // approval state for), so it collapses to null rather than a
    // half-populated shape.
    const cardPage = findCardPage(bundle);
    const cardState = bundle.manifest.verification.card;
    const card =
      cardPage !== undefined && cardState !== undefined
        ? { digest: cardPage.digest, body: cardPage.body, state: cardState }
        : null;

    return {
      agents: bundle.agents.map((a) => ({
        name: a.name,
        role: a.role,
        taskClasses: a.taskClasses,
        model: a.model,
      })),
      defaultAgent: bundle.routing.defaults.agent,
      escalation: bundle.routing.escalation.failuresBeforeFrontier,
      card,
    };
  });

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
    await engine.harness.serializeWrite(projectDir, () => {
      // Final review Fix 1 — see HarnessService.isGenerating's own doc
      // comment for the approval-gate-bypass scenario this closes. Checked
      // HERE (inside the serializeWrite callback) rather than before the
      // serializeWrite call so it is itself serialized with every other
      // queued mutate for this project, not just with generation.
      if (engine.harness.isGenerating(projectDir)) {
        throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, "harness generation in progress; retry after it completes");
      }
      return mutateHarness(projectDir, (bundle) => {
        const agent = bundle.agents.find((a) => a.name === agentName);
        if (agent === undefined) {
          throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, `unknown agent "${agentName}"`);
        }
        agent.model = model;
      });
    });
    return { updated: true };
  });

  registerMethod(engine.dispatcher, "engine.harness.updateEscalation", UpdateEscalationParamsSchema, async ({ projectDir, failuresBeforeFrontier }) => {
    await engine.harness.serializeWrite(projectDir, () => {
      // Final review Fix 1 — see engine.harness.updateAgentModel's identical
      // guard above (and HarnessService.isGenerating's doc comment) for why
      // this check lives here.
      if (engine.harness.isGenerating(projectDir)) {
        throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, "harness generation in progress; retry after it completes");
      }
      return mutateHarness(projectDir, (bundle) => {
        bundle.routing.escalation.failuresBeforeFrontier = failuresBeforeFrontier;
      });
    });
    return { updated: true };
  });

  // An edit ALWAYS invalidates approval (spec §3.4): every successful update
  // resets manifest.verification.card to "draft" in the SAME mutateHarness
  // call that writes the new digest, so the on-disk manifest and page can
  // never observe an approved card sitting next to a digest nobody has
  // reviewed yet.
  registerMethod(engine.dispatcher, "engine.harness.card.update", CardUpdateParamsSchema, async ({ projectDir, digest }) => {
    await engine.harness.serializeWrite(projectDir, () => {
      // Final review Fix 1 — see engine.harness.updateAgentModel's identical
      // guard above (and HarnessService.isGenerating's doc comment) for why
      // this check lives here.
      if (engine.harness.isGenerating(projectDir)) {
        throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, "harness generation in progress; retry after it completes");
      }
      return mutateHarness(projectDir, (bundle) => {
        const page = findCardPage(bundle);
        if (page === undefined) {
          throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, "no project card; regenerate the harness first");
        }
        page.digest = digest;
        bundle.manifest.verification.card = "draft";
      });
    });
    return { updated: true };
  });

  // Deliberately does NOT go through mutateHarness/writeHarness: approving is
  // a manifest-only flip (mirrors setCardState's own header comment) and
  // must not re-serialize and rewrite every wiki page/agent/routing artifact
  // on disk just to change one field. Instead this loads the bundle (with
  // the exact same loadHarness error mapping engine.harness.read uses) purely
  // to check the card is actually present and approvable, then delegates the
  // single-file manifest write to store.ts's setCardState.
  registerMethod(engine.dispatcher, "engine.harness.card.approve", ProjectParamsSchema, async ({ projectDir }) => {
    await engine.harness.serializeWrite(projectDir, async () => {
      // Final review Fix 1 — see engine.harness.updateAgentModel's identical
      // guard above (and HarnessService.isGenerating's doc comment) for why
      // this check lives here. Most important of the four for THIS handler
      // specifically: without it, a user can click Approve on a card a
      // background regenerate has already silently replaced with a
      // never-reviewed draft — the approval-gate bypass this fix closes.
      if (engine.harness.isGenerating(projectDir)) {
        throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, "harness generation in progress; retry after it completes");
      }
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
      const hasApprovableCard = findCardPage(bundle) !== undefined && bundle.manifest.verification.card !== undefined;
      if (!hasApprovableCard) {
        throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, "no project card; regenerate the harness first");
      }
      await setCardState(projectDir, "approved");
    });
    return { approved: true };
  });
}
