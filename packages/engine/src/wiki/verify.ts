import { existsSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CheckResultV2, StageReport } from "@openfusion/shared";
import type { Engine } from "../engine.js";
import { stageMessageId } from "../harness/registry.js";
import { enforceStagePolicy } from "../verification/policy.js";
import {
  captureHeadProjectSnapshot,
  snapshotDigest,
  type ProjectSnapshot,
} from "../verification/project.js";
import { MAX_WIKI_FILE_BYTES, type WikiCoverage } from "./indexer.js";
import { querySymbols, renderMap } from "./query.js";
import { rankFiles } from "./rank.js";
import { wikiDbPath, type SymbolHit, type WikiStore } from "./store.js";

const MAX_CANARIES = 8;
const DELIVERY_TIMEOUT_MS = 5_000;

export type WikiOperationalVerdict = "passed" | "failed" | "inconclusive";

export interface WikiVerificationResult {
  operational: WikiOperationalVerdict;
  quality: "inconclusive";
  sourceFingerprint: string;
  stages: {
    index: StageReport;
    retrieval: StageReport;
    delivery: StageReport;
  };
}

export interface WikiDeliveryProbeResult {
  started: boolean;
  toolsListed: boolean;
  roundtrip: boolean;
  reasonCode?: string;
}

export interface VerifyWikiOptions {
  deliveryProbe?: (
    engine: Engine,
    projectDir: string,
    canary: SymbolHit,
  ) => Promise<WikiDeliveryProbeResult>;
}

function parseCoverage(raw: string | null): WikiCoverage | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const input = value as Record<string, unknown>;
    const keys: Array<keyof WikiCoverage> = [
      "supportedTracked",
      "currentEntries",
      "unchanged",
      "oversized",
      "unreadable",
      "parseFailed",
      "removed",
    ];
    if (!keys.every((key) => Number.isInteger(input[key]) && (input[key] as number) >= 0)) {
      return null;
    }
    return Object.fromEntries(keys.map((key) => [key, input[key]])) as unknown as WikiCoverage;
  } catch {
    return null;
  }
}

function startReport(
  stageId: string,
  inputDigest: string,
  checks: CheckResultV2[],
  started: number,
  outputDigest?: string,
): StageReport {
  return enforceStagePolicy({
    schemaVersion: 2,
    stageId,
    policyVersion: 2,
    attempt: 1,
    inputRef: { id: "project-snapshot", digest: inputDigest },
    ...(outputDigest === undefined
      ? {}
      : { outputRef: { id: "wiki-index", digest: outputDigest } }),
    execution: "completed",
    // enforceStagePolicy derives the authoritative verdict after filling
    // any omitted policy checks.
    verdict: "passed",
    checks,
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
  });
}

function unavailableReport(
  stageId: "setup.wiki.retrieval" | "setup.wiki.delivery",
  inputDigest: string,
  reasonCode: string,
): StageReport {
  const policyChecks =
    stageId === "setup.wiki.retrieval"
      ? ["wiki.query-canaries", "wiki.map-canary"]
      : ["wiki.mcp-started", "wiki.mcp-tools-listed", "wiki.mcp-roundtrip"];
  const started = Date.now();
  return startReport(
    stageId,
    inputDigest,
    policyChecks.map((id) => ({
      id,
      required: true,
      status: "inconclusive" as const,
      messageId: stageMessageId(id, "inconclusive"),
      evidence: { reasonCode },
    })),
    started,
  );
}

function selectCanaries(store: WikiStore): SymbolHit[] {
  const symbols = store.allSymbols();
  const files = new Map(store.listFileRecords().map((file) => [file.path, file]));
  const rankedOrder = new Map(
    rankFiles(symbols, store.allRefs()).map((entry, index) => [entry.file, index]),
  );
  const selected: SymbolHit[] = [];
  const seen = new Set<string>();
  const languages = new Set<string>();

  const ordered = [...symbols].sort((a, b) => {
    const rank = (rankedOrder.get(a.file) ?? Number.MAX_SAFE_INTEGER) -
      (rankedOrder.get(b.file) ?? Number.MAX_SAFE_INTEGER);
    return rank || a.file.localeCompare(b.file) || a.row - b.row || a.name.localeCompare(b.name);
  });

  for (const symbol of ordered) {
    const language = files.get(symbol.file)?.lang;
    if (language === undefined || languages.has(language)) continue;
    selected.push(symbol);
    languages.add(language);
    seen.add(`${symbol.file}\0${symbol.name}\0${symbol.row}\0${symbol.col}`);
    if (selected.length >= MAX_CANARIES) return selected;
  }
  for (const symbol of ordered) {
    const key = `${symbol.file}\0${symbol.name}\0${symbol.row}\0${symbol.col}`;
    if (seen.has(key)) continue;
    selected.push(symbol);
    seen.add(key);
    if (selected.length >= MAX_CANARIES) break;
  }
  return selected;
}

function currentCoverage(
  store: WikiStore,
  snapshot: ProjectSnapshot,
  storedCoverage: WikiCoverage | null,
): { complete: boolean; issueCount: number } {
  if (storedCoverage === null) return { complete: false, issueCount: 1 };
  const records = new Map(store.listFileRecords().map((record) => [record.path, record]));
  let issueCount = 0;
  for (const file of snapshot.files) {
    const record = records.get(file.path);
    if (file.state === "readable") {
      if (record === undefined || `sha256:${record.hash}` !== file.hash) issueCount += 1;
    } else if (record !== undefined) {
      // An explicitly excluded or unreadable file must not keep serving an
      // older symbol projection as though it were current.
      issueCount += 1;
    }
  }
  const trackedPaths = new Set(snapshot.files.map((file) => file.path));
  for (const record of records.values()) {
    if (!trackedPaths.has(record.path)) issueCount += 1;
  }
  if (snapshot.unreadableFiles > 0) issueCount += snapshot.unreadableFiles;
  if (storedCoverage.parseFailed > 0 || storedCoverage.unreadable > 0) {
    issueCount += storedCoverage.parseFailed + storedCoverage.unreadable;
  }
  if (storedCoverage.supportedTracked !== snapshot.trackedFiles) issueCount += 1;
  if (storedCoverage.currentEntries !== records.size) issueCount += 1;
  return { complete: issueCount === 0, issueCount };
}

function textContent(result: unknown): string | null {
  if (typeof result !== "object" || result === null || !("content" in result)) return null;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  const first = content[0];
  if (typeof first !== "object" || first === null) return null;
  const text = (first as { text?: unknown }).text;
  return typeof text === "string" ? text : null;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("wiki delivery probe timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function runWikiDeliveryProbe(
  engine: Engine,
  projectDir: string,
  canary: SymbolHit,
): Promise<WikiDeliveryProbeResult> {
  let client: Client | undefined;
  let started = false;
  try {
    const server = await withTimeout(
      engine.wiki.startMcpServer(engine, projectDir),
      DELIVERY_TIMEOUT_MS,
    );
    started = true;
    client = new Client({ name: "openfusion-wiki-verifier", version: "0.0.1" });
    await withTimeout(
      client.connect(new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { Authorization: `Bearer ${server.bearerToken}` } },
      })),
      DELIVERY_TIMEOUT_MS,
    );
    const tools = await withTimeout(client.listTools(), DELIVERY_TIMEOUT_MS);
    const names = tools.tools.map((tool) => tool.name);
    const toolsListed = names.includes("wiki_query") && names.includes("wiki_map");
    if (!toolsListed) {
      return { started: true, toolsListed: false, roundtrip: false, reasonCode: "mcp-tools-missing" };
    }

    const queryResult = await withTimeout(
      client.callTool({ name: "wiki_query", arguments: { symbol: canary.name } }),
      DELIVERY_TIMEOUT_MS,
    );
    const queryText = textContent(queryResult);
    const queryPayload = queryText === null
      ? null
      : (JSON.parse(queryText) as { definitions?: Array<{ file?: string; row?: number }> });
    const queryPassed = queryPayload?.definitions?.some(
      (definition) => definition.file === canary.file && definition.row === canary.row,
    ) === true;

    const mapResult = await withTimeout(
      client.callTool({ name: "wiki_map", arguments: { budgetTokens: 1024 } }),
      DELIVERY_TIMEOUT_MS,
    );
    const mapText = textContent(mapResult);
    const roundtrip = queryPassed && mapText !== null && mapText.includes(canary.file);
    return {
      started: true,
      toolsListed: true,
      roundtrip,
      ...(roundtrip ? {} : { reasonCode: "mcp-roundtrip-mismatch" }),
    };
  } catch {
    return { started, toolsListed: false, roundtrip: false, reasonCode: "mcp-unavailable" };
  } finally {
    await client?.close().catch(() => {});
  }
}

export async function verifyWiki(
  engine: Engine,
  projectDir: string,
  options: VerifyWikiOptions = {},
): Promise<WikiVerificationResult> {
  const parser = await engine.wiki.getParser();
  const extensions = parser.supportedExtensions();
  const snapshot = captureHeadProjectSnapshot(projectDir, {
    includePath: (relativePath) => extensions.has(path.extname(relativePath)),
    maxFileBytes: MAX_WIKI_FILE_BYTES,
  });
  const inputDigest = snapshot.snapshotDigest;
  const dbPresent = existsSync(wikiDbPath(snapshot.projectDir));
  const indexStarted = Date.now();

  if (!dbPresent) {
    const index = startReport(
      "setup.wiki.index",
      inputDigest,
      [
        { id: "wiki.db-present", required: true, status: "failed", messageId: stageMessageId("wiki.db-present", "failed"), evidence: { reasonCode: "wiki-db-missing" } },
      ],
      indexStarted,
    );
    return {
      operational: "failed",
      quality: "inconclusive",
      sourceFingerprint: snapshot.sourceFingerprint,
      stages: {
        index,
        retrieval: unavailableReport("setup.wiki.retrieval", inputDigest, "wiki-index-unavailable"),
        delivery: unavailableReport("setup.wiki.delivery", inputDigest, "wiki-index-unavailable"),
      },
    };
  }

  let store: WikiStore;
  try {
    store = engine.wiki.getStore(projectDir);
  } catch {
    const index = startReport(
      "setup.wiki.index",
      inputDigest,
      [
        { id: "wiki.db-present", required: true, status: "passed", messageId: stageMessageId("wiki.db-present", "passed") },
        { id: "wiki.db-integrity", required: true, status: "failed", messageId: stageMessageId("wiki.db-integrity", "failed"), evidence: { reasonCode: "db-open-failed" } },
      ],
      indexStarted,
    );
    return {
      operational: "failed",
      quality: "inconclusive",
      sourceFingerprint: snapshot.sourceFingerprint,
      stages: {
        index,
        retrieval: unavailableReport("setup.wiki.retrieval", inputDigest, "wiki-index-unavailable"),
        delivery: unavailableReport("setup.wiki.delivery", inputDigest, "wiki-index-unavailable"),
      },
    };
  }

  const integrity = store.integrityCheck();
  const storedHead = store.getMeta("head_sha");
  const storedSource = store.getMeta("source_fingerprint");
  const coverage = currentCoverage(store, snapshot, parseCoverage(store.getMeta("coverage")));
  const outputDigest =
    storedHead === null || storedSource === null ? undefined : snapshotDigest(storedHead, storedSource);
  const index = startReport(
    "setup.wiki.index",
    inputDigest,
    [
      { id: "wiki.db-present", required: true, status: "passed", messageId: stageMessageId("wiki.db-present", "passed") },
      {
        id: "wiki.db-integrity",
        required: true,
        status: integrity.ok ? "passed" : "failed",
        messageId: stageMessageId("wiki.db-integrity", integrity.ok ? "passed" : "failed"),
        evidence: {
          count: integrity.messages.length,
          expectedCount: 1,
          ...(integrity.ok ? {} : { reasonCode: "db-open-failed" }),
        },
      },
      {
        id: "wiki.head-current",
        required: true,
        status: storedHead === snapshot.headSha && snapshot.headStable ? "passed" : "failed",
        messageId: stageMessageId(
          "wiki.head-current",
          storedHead === snapshot.headSha && snapshot.headStable ? "passed" : "failed",
        ),
        ...(storedHead === snapshot.headSha && snapshot.headStable
          ? {}
          : { evidence: { reasonCode: "wiki-head-mismatch" } }),
      },
      {
        id: "wiki.source-current",
        required: true,
        status: storedSource === snapshot.sourceFingerprint ? "passed" : "failed",
        messageId: stageMessageId(
          "wiki.source-current",
          storedSource === snapshot.sourceFingerprint ? "passed" : "failed",
        ),
        ...(storedSource === snapshot.sourceFingerprint
          ? {}
          : { evidence: { reasonCode: "wiki-source-mismatch" } }),
      },
      {
        id: "wiki.coverage-complete",
        required: true,
        status:
          snapshot.trackedFiles === 0
            ? "inconclusive"
            : coverage.complete
              ? "passed"
              : "failed",
        messageId: stageMessageId(
          "wiki.coverage-complete",
          snapshot.trackedFiles === 0
            ? "inconclusive"
            : coverage.complete
              ? "passed"
              : "failed",
        ),
        evidence: {
          count: coverage.issueCount,
          expectedCount: 0,
          ...(snapshot.trackedFiles === 0 || !coverage.complete
            ? { reasonCode: "wiki-coverage-incomplete" }
            : {}),
        },
      },
    ],
    indexStarted,
    outputDigest,
  );

  if (index.verdict !== "passed") {
    return {
      operational: index.verdict === "failed" ? "failed" : "inconclusive",
      quality: "inconclusive",
      sourceFingerprint: snapshot.sourceFingerprint,
      stages: {
        index,
        retrieval: unavailableReport("setup.wiki.retrieval", inputDigest, "wiki-index-not-ready"),
        delivery: unavailableReport("setup.wiki.delivery", inputDigest, "wiki-index-not-ready"),
      },
    };
  }

  const retrievalStarted = Date.now();
  const canaries = selectCanaries(store);
  const queryPassed =
    canaries.length > 0 &&
    canaries.every((canary) =>
      querySymbols(store, canary.name).definitions.some(
        (definition) =>
          definition.file === canary.file &&
          definition.name === canary.name &&
          definition.kind === canary.kind &&
          definition.row === canary.row &&
          definition.col === canary.col,
      ),
    );
  const map = renderMap(store, 1024);
  const mapPaths = map
    .split("\n")
    .filter((line) => line.length > 0 && !line.startsWith("  "));
  const indexedPaths = new Set(store.listFiles());
  const mapPassed =
    canaries.length > 0 &&
    map.length <= 1024 * 4 &&
    map.includes(canaries[0]!.file) &&
    mapPaths.every((file) => indexedPaths.has(file));
  const retrieval = startReport(
    "setup.wiki.retrieval",
    inputDigest,
    [
      {
        id: "wiki.query-canaries",
        required: true,
        status: canaries.length === 0 ? "inconclusive" : queryPassed ? "passed" : "failed",
        messageId: stageMessageId(
          "wiki.query-canaries",
          canaries.length === 0 ? "inconclusive" : queryPassed ? "passed" : "failed",
        ),
        evidence: {
          count: canaries.length,
          ...(canaries.length === 0 || !queryPassed ? { reasonCode: "wiki-query-failed" } : {}),
        },
      },
      {
        id: "wiki.map-canary",
        required: true,
        status: canaries.length === 0 ? "inconclusive" : mapPassed ? "passed" : "failed",
        messageId: stageMessageId(
          "wiki.map-canary",
          canaries.length === 0 ? "inconclusive" : mapPassed ? "passed" : "failed",
        ),
        evidence: {
          count: mapPaths.length,
          ...(canaries.length === 0 || !mapPassed ? { reasonCode: "wiki-map-failed" } : {}),
        },
      },
    ],
    retrievalStarted,
    outputDigest,
  );

  if (retrieval.verdict !== "passed") {
    return {
      operational: retrieval.verdict === "failed" ? "failed" : "inconclusive",
      quality: "inconclusive",
      sourceFingerprint: snapshot.sourceFingerprint,
      stages: {
        index,
        retrieval,
        delivery: unavailableReport("setup.wiki.delivery", inputDigest, "wiki-retrieval-not-ready"),
      },
    };
  }

  const deliveryStarted = Date.now();
  const deliveryResult = await (options.deliveryProbe ?? runWikiDeliveryProbe)(
    engine,
    projectDir,
    canaries[0]!,
  );
  const delivery = startReport(
    "setup.wiki.delivery",
    inputDigest,
    [
      {
        id: "wiki.mcp-started",
        required: true,
        status: deliveryResult.started ? "passed" : "failed",
        messageId: stageMessageId("wiki.mcp-started", deliveryResult.started ? "passed" : "failed"),
        ...(deliveryResult.started ? {} : { evidence: { reasonCode: deliveryResult.reasonCode ?? "mcp-unavailable" } }),
      },
      {
        id: "wiki.mcp-tools-listed",
        required: true,
        status: deliveryResult.started
          ? deliveryResult.toolsListed
            ? "passed"
            : "failed"
          : "inconclusive",
        messageId: stageMessageId(
          "wiki.mcp-tools-listed",
          deliveryResult.started
            ? deliveryResult.toolsListed
              ? "passed"
              : "failed"
            : "inconclusive",
        ),
        ...(!deliveryResult.toolsListed
          ? { evidence: { reasonCode: deliveryResult.reasonCode ?? "mcp-tools-missing" } }
          : {}),
      },
      {
        id: "wiki.mcp-roundtrip",
        required: true,
        status: deliveryResult.toolsListed
          ? deliveryResult.roundtrip
            ? "passed"
            : "failed"
          : "inconclusive",
        messageId: stageMessageId(
          "wiki.mcp-roundtrip",
          deliveryResult.toolsListed
            ? deliveryResult.roundtrip
              ? "passed"
              : "failed"
            : "inconclusive",
        ),
        ...(!deliveryResult.roundtrip
          ? { evidence: { reasonCode: deliveryResult.reasonCode ?? "mcp-roundtrip-mismatch" } }
          : {}),
      },
    ],
    deliveryStarted,
    outputDigest,
  );

  const verdicts = [index.verdict, retrieval.verdict, delivery.verdict];
  const operational: WikiOperationalVerdict = verdicts.includes("failed")
    ? "failed"
    : verdicts.every((verdict) => verdict === "passed")
      ? "passed"
      : "inconclusive";
  return {
    operational,
    quality: "inconclusive",
    sourceFingerprint: snapshot.sourceFingerprint,
    stages: { index, retrieval, delivery },
  };
}
