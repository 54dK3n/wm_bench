import {
  type CompetitionEvaluationSet,
  validateCompetitionEvaluationSet,
} from "./evaluation-format";
import type { CompetitionObjectStorage } from "./storage";

const MAX_CACHE_ENTRIES_PER_STORAGE = 12;
const CACHE_TTL_MS = 10 * 60 * 1_000;

interface EvaluationCacheEntry {
  readonly promise: Promise<CompetitionEvaluationSet>;
  touchedAt: number;
}

export interface CompetitionEvaluationReference {
  readonly division: string;
  readonly version: string;
  readonly objectKey: string;
}

export interface CompetitionEvaluationCacheSnapshot {
  readonly entries: number;
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
}

const caches = new WeakMap<object, Map<string, EvaluationCacheEntry>>();
let entryCount = 0;
let cacheHits = 0;
let cacheMisses = 0;
let cacheEvictions = 0;

function referenceKey(reference: CompetitionEvaluationReference): string {
  return `${reference.division}\u0000${reference.version}\u0000${reference.objectKey}`;
}

function cacheFor(storage: CompetitionObjectStorage): Map<string, EvaluationCacheEntry> {
  let cache = caches.get(storage as object);
  if (!cache) {
    cache = new Map();
    caches.set(storage as object, cache);
  }
  return cache;
}

function prune(cache: Map<string, EvaluationCacheEntry>, now: number): void {
  for (const [key, entry] of cache) {
    if (now - entry.touchedAt <= CACHE_TTL_MS) continue;
    cache.delete(key);
    entryCount -= 1;
    cacheEvictions += 1;
  }
  while (cache.size >= MAX_CACHE_ENTRIES_PER_STORAGE) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
    entryCount -= 1;
    cacheEvictions += 1;
  }
}

export function primeCompetitionEvaluationCache(
  storage: CompetitionObjectStorage,
  reference: CompetitionEvaluationReference,
  evaluation: CompetitionEvaluationSet,
  now = Date.now(),
): void {
  const cache = cacheFor(storage);
  const key = referenceKey(reference);
  const existing = cache.get(key);
  if (!existing) {
    prune(cache, now);
    entryCount += 1;
  } else {
    cache.delete(key);
  }
  cache.set(key, { promise: Promise.resolve(evaluation), touchedAt: now });
}

export function loadCompetitionEvaluationSet(
  storage: CompetitionObjectStorage,
  reference: CompetitionEvaluationReference,
  now = Date.now(),
): Promise<CompetitionEvaluationSet> {
  const cache = cacheFor(storage);
  const key = referenceKey(reference);
  const existing = cache.get(key);
  if (existing && now - existing.touchedAt <= CACHE_TTL_MS) {
    cacheHits += 1;
    existing.touchedAt = now;
    cache.delete(key);
    cache.set(key, existing);
    return existing.promise;
  }
  if (existing) {
    cache.delete(key);
    entryCount -= 1;
    cacheEvictions += 1;
  }
  prune(cache, now);
  cacheMisses += 1;
  const promise = (async () => {
    const stored = await storage.get(reference.objectKey);
    if (!stored) throw new Error("测试集对象缺失。");
    return validateCompetitionEvaluationSet(JSON.parse(await stored.text()) as unknown);
  })();
  cache.set(key, { promise, touchedAt: now });
  entryCount += 1;
  void promise.catch(() => {
    const current = cache.get(key);
    if (current?.promise !== promise) return;
    cache.delete(key);
    entryCount -= 1;
  });
  return promise;
}

export function competitionEvaluationCacheSnapshot(): CompetitionEvaluationCacheSnapshot {
  return Object.freeze({
    entries: entryCount,
    hits: cacheHits,
    misses: cacheMisses,
    evictions: cacheEvictions,
  });
}
