import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionContext, useEventStreamConnection } from "../hooks/useEventStream.ts";
import { SERVER_EVENTS } from "../lib/eventStream.ts";
import { createQueryClient } from "../lib/queryClient.ts";
import { FakeEventSource } from "../test/fakeEventSource.ts";
import { StatusBar } from "./StatusBar.tsx";

/**
 * The milestone's success condition in a test: an event pushed on the SSE stream visibly
 * updates the status bar, with no polling in between.
 */

function run(runId: string, status: "running" | "finished" | "waiting") {
  return {
    runId,
    agent: "reviewer",
    cwd: "/Users/dev/projects/demo",
    status,
    waiting: status === "waiting" ? { reason: "permission" as const, detail: "permission to write a file" } : null,
    sessionId: `session-${runId}`,
    startedAt: 1_700_000_000_000,
    endedAt: null,
    finalText: null,
    attachCommand: `claude attach ${runId}`,
  };
}

/** Mirrors AppShell: one stream, published on the context the status bar reads. */
function Harness() {
  const connection = useEventStreamConnection({
    eventSourceFactory: (url) => new FakeEventSource(url) as unknown as EventSource,
  });
  return (
    <ConnectionContext.Provider value={connection}>
      <StatusBar />
    </ConnectionContext.Provider>
  );
}

let runsResponse: { runs: ReturnType<typeof run>[] };
let fetchCalls: string[];

beforeEach(() => {
  FakeEventSource.reset();
  runsResponse = { runs: [] };
  fetchCalls = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      fetchCalls.push(url);
      if (url === "/api/runs") {
        return new Response(JSON.stringify(runsResponse), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // The task queue arrives in a later milestone; the server 404s until then.
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderStatusBar() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <Harness />
    </QueryClientProvider>,
  );
}

describe("StatusBar", () => {
  it("shows the running count from the server and marks the stream live", async () => {
    runsResponse = { runs: [run("a1", "running"), run("b2", "finished")] };
    renderStatusBar();

    act(() => FakeEventSource.latest.open());

    await waitFor(() => expect(screen.getByText("Running").nextElementSibling).toHaveTextContent("1"));
    expect(screen.getByText("Live")).toBeInTheDocument();
  });

  it("updates when a run:started event arrives, without polling", async () => {
    renderStatusBar();
    act(() => FakeEventSource.latest.open());

    await waitFor(() => expect(screen.getByText("Running").nextElementSibling).toHaveTextContent("0"));
    const callsAfterFirstLoad = fetchCalls.length;

    // The server starts a run and announces it. Nothing asked; the stream told us.
    runsResponse = { runs: [run("c3", "running")] };
    act(() => FakeEventSource.latest.emit(SERVER_EVENTS.runStarted, { runId: "c3" }));

    await waitFor(() => expect(screen.getByText("Running").nextElementSibling).toHaveTextContent("1"));
    // Exactly one extra read, caused by the event. A polling client would have made more.
    expect(fetchCalls.filter((u) => u === "/api/runs")).toHaveLength(2);
    expect(fetchCalls.length).toBeGreaterThan(callsAfterFirstLoad);
  });

  it("reports the queue as unavailable rather than zero while /api/tasks/stats 404s", async () => {
    renderStatusBar();
    act(() => FakeEventSource.latest.open());

    // Wait for the load to finish first: "—" is also what the bar shows while loading, so
    // asserting on it straight away would pass for the wrong reason.
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("0 agents running"));

    expect(screen.getByText("Queued").nextElementSibling).toHaveTextContent("—");
    expect(screen.getByRole("status")).toHaveTextContent("queue unavailable");
  });

  it("says it is reconnecting when the stream drops, so stale numbers are not passed off as live", async () => {
    renderStatusBar();
    act(() => FakeEventSource.latest.open());
    await waitFor(() => expect(screen.getByText("Live")).toBeInTheDocument());

    act(() => FakeEventSource.latest.fail());

    expect(await screen.findByText("Reconnecting")).toBeInTheDocument();
  });

  it("shows a dash, not a confident zero, when the run list cannot be read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "EACCES reading the run store" }), { status: 500 })),
    );
    renderStatusBar();
    act(() => FakeEventSource.latest.open());

    expect(await screen.findByText("Could not read runs", {}, { timeout: 5_000 })).toBeInTheDocument();
    expect(screen.getByText("Running").nextElementSibling).toHaveTextContent("—");
  });

  it("surfaces a run parked on a prompt, and hides the counter when there is none", async () => {
    runsResponse = { runs: [run("a1", "running")] };
    renderStatusBar();
    act(() => FakeEventSource.latest.open());

    await waitFor(() => expect(screen.getByText("Running").nextElementSibling).toHaveTextContent("1"));
    // Nothing is waiting, so the counter is absent rather than showing a zero.
    expect(screen.queryByText("Needs input")).not.toBeInTheDocument();

    runsResponse = { runs: [run("a1", "running"), run("b2", "waiting")] };
    act(() => FakeEventSource.latest.emit(SERVER_EVENTS.runStopped, { runId: "b2" }));

    expect(await screen.findByText("Needs input")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("1 run needing input");
    // A waiting run *is* counted as running — reversed from M2, deliberately.
    //
    // It holds its concurrency slot and has not finished, which is exactly what
    // `stats.waiting ⊂ stats.running` means server-side. Excluding it here made the bar read
    // "Running 1" while the Tasks screen's own Running group read 2, on the same screen at the
    // same moment. "Needs input" is the subset callout, not a sibling: never add the two.
    expect(screen.getByText("Running").nextElementSibling).toHaveTextContent("2");
  });

  it("announces both counters as one sentence rather than two bare numbers", async () => {
    runsResponse = { runs: [run("a1", "running"), run("b2", "running")] };
    renderStatusBar();
    act(() => FakeEventSource.latest.open());

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("2 agents running"));
  });
});
