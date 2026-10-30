/**
 * Client side of the context engine: local memory as context candidates
 * (offline fallback; the server has the whole shared memory when online)
 * and the token-savings estimate (CONTEXT_ENGINE.md §8).
 *
 * Savings compare what the package delivered with a conservative baseline
 * of what an agent reads to rediscover the same context: README and
 * manifests, the files the task touches, and `git log -n 50 --stat`.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { countTextTokens } from '../compact/token-budget.js';
import { classifyObservation, toMemoryStatus } from '../domain/memory.js';
import type { Observation } from '../types.js';
import type { ContextMemory } from './engine.js';

/** Local ids are prefixed so tools can tell them from server ids (sync keys). */
export const LOCAL_ID_PREFIX = 'obs:';

export function observationToContextMemory(obs: Observation): ContextMemory {
  const { category, confidence } = classifyObservation(obs);
  return {
    id: `${LOCAL_ID_PREFIX}${obs.id}`,
    category,
    confidence,
    status: toMemoryStatus(obs.status),
    title: obs.title,
    content: obs.narrative,
    facts: obs.facts ?? [],
    component: obs.entityName ?? null,
    relatedFiles: obs.filesModified ?? [],
    updatedAt: obs.updatedAt ?? obs.createdAt,
  };
}

const MANIFESTS = ['package.json', 'pyproject.toml', 'requirements.txt', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'composer.json', 'Gemfile'];
const MAX_FILE_BYTES = 256 * 1024;

function fileTokens(root: string, relPath: string): number {
  try {
    const full = path.join(root, relPath);
    const stat = fs.statSync(full);
    if (!stat.isFile()) return 0;
    const content = fs.readFileSync(full).subarray(0, MAX_FILE_BYTES);
    if (content.includes(0)) return 0;
    return countTextTokens(content.toString('utf8'));
  } catch {
    return 0;
  }
}

export interface SavingsEstimate {
  baselineTokens: number;
  deliveredTokens: number;
  /** 1 − delivered / baseline, never below 0. */
  savings: number;
  files: number;
}

export function estimateBaselineTokens(root: string, files: string[]): { tokens: number; files: number } {
  const readme = fs.existsSync(root) ? fs.readdirSync(root).filter((name) => /^readme(\.|$)/i.test(name)) : [];
  const paths = [...new Set([...readme, ...MANIFESTS.filter((name) => fs.existsSync(path.join(root, name))), ...files])];
  let tokens = 0;
  for (const relPath of paths) tokens += fileTokens(root, relPath);
  try {
    const log = execFileSync('git', ['-c', 'safe.directory=*', 'log', '-n', '50', '--stat', '--no-color'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 });
    tokens += countTextTokens(log);
  } catch { /* no history */ }
  return { tokens, files: paths.length };
}

export function estimateSavings(root: string | null, files: string[], deliveredTokens: number): SavingsEstimate | null {
  if (!root) return null;
  const baseline = estimateBaselineTokens(root, files);
  if (baseline.tokens === 0) return null;
  return {
    baselineTokens: baseline.tokens,
    deliveredTokens,
    savings: Math.max(0, Number((1 - deliveredTokens / baseline.tokens).toFixed(3))),
    files: baseline.files,
  };
}

/** Files touched by the last commits of the branch (recent_git_bonus). */
export function recentGitFiles(root: string, commits = 10): string[] {
  try {
    const out = execFileSync('git', ['-c', 'safe.directory=*', 'log', '-n', String(commits), '--name-only', '--format='], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return [...new Set(out.split('\n').map((line) => line.trim()).filter(Boolean))].slice(0, 200);
  } catch {
    return [];
  }
}
