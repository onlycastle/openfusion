import { createHash } from "node:crypto";
import type { ModelMessage } from "ai";
import { ArtifactRefSchema, type ArtifactRef } from "@openfusion/shared";
import { runtimeFingerprint } from "./context.js";

export const MAX_INLINE_CONTEXT_BYTES = 32 * 1024;
export const MAX_TASK_CONTEXT_BYTES = 256 * 1024;

export interface ContextSnapshotIdentity {
  baseSha: string;
  snapshotId?: string;
  wikiDigest?: string | null;
}

export interface RetrievedWikiContext {
  content: string;
  snapshotDigest: string;
  queryId: string;
}

export interface ContextCompilerInput {
  snapshot: ContextSnapshotIdentity;
  instructions: string;
  task: string;
  approvedProjectContext?: string;
  retrievedWiki?: RetrievedWikiContext;
  artifactRefs?: readonly ArtifactRef[];
}

export interface CompiledContextSource {
  id: string;
  kind: "instructions" | "project" | "wiki" | "task" | "artifact";
  digest: string;
  bytes: number;
}

export interface CompiledModelContext {
  schemaVersion: 1;
  snapshot: ContextSnapshotIdentity;
  fingerprint: string;
  messages: ModelMessage[];
  sources: CompiledContextSource[];
}

function normalized(value: string): string {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function bounded(label: string, value: string, limit: number): string {
  const text = normalized(value);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > limit) {
    throw new Error(`${label} exceeds the ${limit}-byte inline context limit; use an artifact reference`);
  }
  return text;
}

function source(id: string, kind: CompiledContextSource["kind"], content: string): CompiledContextSource {
  return { id, kind, digest: digest(content), bytes: Buffer.byteLength(content, "utf8") };
}

/**
 * Compiles a deterministic initial model view pinned to one source snapshot.
 * Stable instructions and approved repository context always precede the
 * volatile task. Content-bearing tool output is never accepted here; callers
 * can include only validated artifact identities.
 */
export class ContextCompiler {
  compile(input: ContextCompilerInput): CompiledModelContext {
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(input.snapshot.baseSha)) {
      throw new Error("context snapshot baseSha is invalid");
    }
    const instructions = bounded("instructions", input.instructions, MAX_INLINE_CONTEXT_BYTES);
    const task = bounded("task", input.task, MAX_TASK_CONTEXT_BYTES);
    const project = input.approvedProjectContext === undefined
      ? undefined
      : bounded("approved project context", input.approvedProjectContext, MAX_INLINE_CONTEXT_BYTES);
    const wiki = input.retrievedWiki === undefined
      ? undefined
      : bounded("retrieved wiki context", input.retrievedWiki.content, MAX_INLINE_CONTEXT_BYTES);
    if (
      input.retrievedWiki !== undefined &&
      input.snapshot.wikiDigest !== undefined &&
      input.snapshot.wikiDigest !== null &&
      input.retrievedWiki.snapshotDigest !== input.snapshot.wikiDigest
    ) {
      throw new Error("retrieved wiki context does not match the task snapshot");
    }
    const artifacts = (input.artifactRefs ?? []).map((ref) => ArtifactRefSchema.parse(ref));
    if (artifacts.length > 64) throw new Error("context contains too many artifact references");

    const sections = [`# Instructions\n\n${instructions}`];
    const sources: CompiledContextSource[] = [source("instructions", "instructions", instructions)];
    if (project !== undefined && project.length > 0) {
      sections.push(`# Approved project context\n\n${project}`);
      sources.push(source("approved-project", "project", project));
    }
    if (wiki !== undefined && wiki.length > 0 && input.retrievedWiki !== undefined) {
      sections.push(`# Retrieved repository context\n\n${wiki}`);
      sources.push(source(input.retrievedWiki.queryId, "wiki", wiki));
    }
    sections.push(`# Task\n\n${task}`);
    sources.push(source("task", "task", task));
    if (artifacts.length > 0) {
      const refs = artifacts.map((ref) => `- ${ref.id} (${ref.digest})`).join("\n");
      sections.push(`# Referenced artifacts\n\n${refs}\n\nUse the artifact reader for bounded pages.`);
      for (const ref of artifacts) {
        sources.push({ id: ref.id, kind: "artifact", digest: ref.digest, bytes: 0 });
      }
    }

    const snapshot = { ...input.snapshot };
    const messages: ModelMessage[] = [{ role: "user", content: sections.join("\n\n") }];
    const fingerprint = runtimeFingerprint({ snapshot, sources });
    return { schemaVersion: 1, snapshot, fingerprint, messages, sources };
  }
}
