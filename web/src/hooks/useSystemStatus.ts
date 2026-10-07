import { useQuery } from "@tanstack/react-query";
import { getTaskStats, listRuns, queryKeys, type RunStatus } from "../lib/api.ts";

/**
 * What the status bar shows, assembled from the resources that own each number.
 *
 * Two sources, deliberately not merged into one: `/api/runs` knows about *every* background
 * session, including one a user started from their own terminal, and `/api/tasks/stats` knows
 * about the queue. "Running" is the first — an operator asking "is anything running?" means all
 * of it — and "Queued" is the second, because only the queue has a queue.
 */
export interface SystemStatus {
  /** `null` until the run list has been read, and again if reading it fails. */
  running: number | null;
  /** Runs parked on a prompt a human has to answer. The one counter that demands action. */
  needsInput: number | null;
  /** Tasks waiting to start. `null` only while the first read is in flight or it failed. */
  queued: number | null;
  /** How many tasks the queue runs at once, so the bar can say what the backlog is waiting for. */
  maxConcurrent: number | null;
  isLoading: boolean;
  error: unknown;
}

/**
 * Both queries are invalidated by the SSE stream (see useEventStream.ts). Neither has a
 * refetch interval, here or in the client defaults: nothing in this app polls.
 */
export function useSystemStatus(): SystemStatus {
  const runs = useQuery({ queryKey: queryKeys.runs, queryFn: listRuns });
  const stats = useQuery({ queryKey: queryKeys.taskStats, queryFn: getTaskStats });

  const count = (status: RunStatus) => (runs.data ? runs.data.runs.filter((r) => r.status === status).length : null);

  const inFlight = count("running");
  const parked = count("waiting");

  return {
    // Waiting counts as running, exactly as `stats.waiting ⊂ stats.running` does server-side: a
    // parked session is still occupying a slot and has not finished. Counting it separately
    // would have the bar say "1 running" while the Tasks screen says "Running 2".
    // Not `?? 0`: a confident zero while the read is failing is the same lie as a confident
    // zero for a queue we cannot see.
    running: inFlight === null || parked === null ? null : inFlight + parked,
    needsInput: parked,
    queued: stats.data?.queued ?? null,
    maxConcurrent: stats.data?.maxConcurrent ?? null,
    isLoading: runs.isLoading,
    error: runs.error,
  };
}
