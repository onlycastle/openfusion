// Bench workspace layout under ~/.openfusion/bench/ (outside any source repo).

import os from "node:os";
import path from "node:path";

export function defaultBenchRoot(): string {
  return path.join(os.homedir(), ".openfusion", "bench");
}

/** Safe directory name for owner/repo → owner__repo */
export function repoDirName(repo: string): string {
  return repo.replace(/\//g, "__");
}

export function clonePath(benchRoot: string, repo: string): string {
  return path.join(benchRoot, "clones", repoDirName(repo));
}

export function harnessBundlePath(benchRoot: string, repo: string): string {
  return path.join(benchRoot, "harness", repoDirName(repo));
}

export function runsDir(benchRoot: string): string {
  return path.join(benchRoot, "runs");
}

export function runDir(benchRoot: string, runId: string): string {
  return path.join(runsDir(benchRoot), runId);
}
