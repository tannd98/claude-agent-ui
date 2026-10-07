import { AlertTriangle, Layers, Loader2, MessageCircleQuestion, Plug, PlugZap } from "lucide-react";
import type * as React from "react";
import { useConnectionState } from "../hooks/useEventStream.ts";
import { useSystemStatus } from "../hooks/useSystemStatus.ts";
import type { ConnectionState } from "../lib/eventStream.ts";
import { cn, plural } from "../lib/utils.ts";

/**
 * The persistent bottom bar. Present on every screen, 28px tall, always telling the operator
 * three things: how many agents are running, how deep the queue is, and whether the live
 * connection those two numbers depend on is actually up.
 *
 * That third one is not decoration. Every number here arrives over SSE, so a bar that stayed
 * confident while the stream was down would be quietly lying.
 */
export function StatusBar() {
  const { running, needsInput, queued, maxConcurrent, error } = useSystemStatus();
  const connection = useConnectionState();
  const spoken =
    running === null
      ? "Reading system status"
      : [
          `${plural(running, "agent")} running`,
          `${queued === null ? "queue unavailable" : plural(queued, "task")} queued`,
          needsInput ? `${plural(needsInput, "run")} needing input` : null,
        ]
          .filter(Boolean)
          .join(", ");

  return (
    <footer
      // A landmark, so a screen reader user can jump straight to the counters.
      aria-label="System status"
      className={cn(
        "flex h-[var(--statusbar-height)] shrink-0 items-center gap-4 px-3",
        "border-t border-[var(--statusbar-border)] bg-[var(--statusbar-bg)]",
        "text-2xs text-[var(--statusbar-fg)]",
      )}
      style={{ zIndex: "var(--z-statusbar)" }}
    >
      {/*
        One atomic live region for both counters — ux-guidelines No. 118. Announcing
        "2 running, 3 queued" once beats two regions racing to read bare numbers.
      */}
      <div role="status" aria-live="polite" aria-atomic="true" className="flex items-center gap-4">
        <span className="sr-only">{spoken}</span>

        <Metric
          icon={running ? Loader2 : Plug}
          spin={Boolean(running)}
          label="Running"
          value={running === null ? "—" : String(running)}
          emphasis={Boolean(running)}
          title={
            running === null ? "The run list has not been read yet." : `${plural(running, "agent run")} in progress`
          }
        />

        <Metric
          icon={Layers}
          label="Queued"
          value={queued === null ? "—" : String(queued)}
          emphasis={(queued ?? 0) > 0}
          title={
            queued === null
              ? "The task queue has not been read yet."
              : // Names the concurrency limit, so a backlog that is not moving is explained by
                // the bar rather than looking stuck.
                `${plural(queued, "task")} waiting to start` +
                (maxConcurrent === null ? "" : `; up to ${maxConcurrent} run at once`)
          }
        />

        {/*
          Only rendered when there is something to act on. A permanent "Needs input 0" is
          noise; an amber counter that appears is a signal — and a run parked on a prompt
          would otherwise be invisible from every screen but Agents.
        */}
        {Boolean(needsInput) && (
          <Metric
            icon={MessageCircleQuestion}
            label="Needs input"
            value={String(needsInput)}
            tone="attention"
            emphasis
            title={`${plural(needsInput!, "run")} parked on a prompt. Attach to the session to answer it.`}
          />
        )}
      </div>

      {error != null && (
        <span className="flex items-center gap-1.5 text-[var(--status-failed-fg)]">
          <AlertTriangle className="size-3" aria-hidden="true" />
          Could not read runs
        </span>
      )}

      <div className="ml-auto">
        <ConnectionIndicator state={connection} />
      </div>
    </footer>
  );
}

interface MetricProps {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  emphasis?: boolean;
  spin?: boolean;
  /** `live` is green (something is happening), `attention` amber (something needs you). */
  tone?: "live" | "attention";
  title: string;
}

function Metric({ icon: Icon, label, value, emphasis, spin, tone = "live", title }: MetricProps) {
  const accent = tone === "attention" ? "var(--status-waiting-fg)" : "var(--status-running-fg)";
  return (
    <span
      className="flex items-center gap-1.5"
      title={title}
      // Set once here; the icon draws in currentColor and the label inherits.
      style={emphasis ? { color: accent } : undefined}
    >
      <Icon
        aria-hidden="true"
        className={cn("size-3", !emphasis && "text-fg-subtle", spin && "motion-safe:animate-spin")}
      />
      {/* Label as well as number: a bare "2" in a status bar means nothing on its own. */}
      <span>{label}</span>
      <span
        className={cn(
          "font-mono font-medium tabular-nums",
          // A live count reads as plain strong text; only an attention count is coloured.
          !emphasis && "font-normal text-[var(--statusbar-fg)]",
          emphasis && tone === "live" && "text-[var(--statusbar-fg-strong)]",
        )}
      >
        {value}
      </span>
    </span>
  );
}

const CONNECTION_COPY: Record<ConnectionState, { label: string; title: string }> = {
  open: { label: "Live", title: "Connected to the event stream; these numbers are current." },
  connecting: { label: "Connecting", title: "Opening the event stream." },
  offline: {
    label: "Reconnecting",
    title: "The event stream dropped. Retrying with backoff; the numbers above may be stale.",
  },
};

function ConnectionIndicator({ state }: { state: ConnectionState }) {
  const copy = CONNECTION_COPY[state];
  const Icon = state === "open" ? PlugZap : Plug;
  return (
    <span
      className={cn(
        "flex items-center gap-1.5",
        state === "open" && "text-[var(--status-running-fg)]",
        state === "offline" && "text-[var(--status-failed-fg)]",
      )}
      title={copy.title}
    >
      <Icon aria-hidden="true" className="size-3" />
      {/* Word, not just a coloured dot — ux-guidelines No. 37. */}
      {copy.label}
    </span>
  );
}
