import {
  COMPETITION_SCORING_CONCURRENCY,
  COMPETITION_SCORING_QUEUE_CAPACITY,
  MAX_COMPETITION_USERS,
} from "@/lib/competition/capacity";
import { competitionEvaluationCacheSnapshot } from "@/lib/competition/evaluation-cache";
import { jsonResponse } from "@/lib/competition/http";
import { competitionScoringQueueSnapshot } from "@/lib/competition/submission-evaluation";

export async function GET(): Promise<Response> {
  const queue = competitionScoringQueueSnapshot();
  const state = queue.uniqueJobs >= queue.capacity
    ? "saturated"
    : queue.active > 0 || queue.pending > 0 ? "busy" : "ready";
  return jsonResponse({
    ok: true,
    service: "workshop-competition",
    capacity: {
      users: MAX_COMPETITION_USERS,
      expectedConcurrentUsers: 500,
      scoringConcurrency: COMPETITION_SCORING_CONCURRENCY,
      scoringQueueCapacity: COMPETITION_SCORING_QUEUE_CAPACITY,
    },
    scoringQueue: queue,
    evaluationCache: competitionEvaluationCacheSnapshot(),
    state,
  });
}
