import { getCompetitionEnv } from "./db";

export interface CompetitionStoredObject {
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

export interface CompetitionObjectStorage {
  get(key: string): Promise<CompetitionStoredObject | null>;
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ): Promise<unknown>;
  delete(key: string): Promise<void>;
}

export function getCompetitionStorage(): CompetitionObjectStorage {
  const binding = getCompetitionEnv().COMPETITION_STORAGE as Partial<CompetitionObjectStorage> | undefined;
  if (!binding || typeof binding.get !== "function" || typeof binding.put !== "function" || typeof binding.delete !== "function") {
    throw new Error("比赛模型存储暂不可用：缺少 COMPETITION_STORAGE 绑定。 ");
  }
  return binding as CompetitionObjectStorage;
}
