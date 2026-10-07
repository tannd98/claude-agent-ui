import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, MessageSquare, RotateCw, X } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { Page } from "../components/Page.tsx";
import { EmptyState, ErrorState, LoadingState, errorMessage } from "../components/States.tsx";
import { StatusBadge } from "../components/StatusBadge.tsx";
import { TwoPane } from "../components/TwoPane.tsx";
import { Button } from "../components/ui/button.tsx";
import {
  cancelTask,
  getTaskTranscript,
  listTasks,
  queryKeys,
  retryTask,
  type TaskView,
  type TranscriptMessage,
} from "../lib/api.ts";
import { cancelOutcome, duration, priorityLabel, taskBadge } from "../lib/taskStatus.ts";
import { cn } from "../lib/utils.ts";

/**
 * One task in full: the transcript on the left, what we know about it on the right.
 *
 * There is no `GET /api/tasks/:id` — the list is the resource, and it arrives whole and stays
 * current over SSE. Reading the row out of that cache means this screen never issues a second
 * request for data it already has, and it updates with the table rather than lagging behind it.
 */
export function TaskDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const tasks = useQuery({ queryKey: queryKeys.tasks, queryFn: listTasks });
  const task = tasks.data?.tasks.find((t) => t.id === id) ?? null;

  if (tasks.isLoading) {
    return (
      <Page title="Task" description="Loading">
        <LoadingState label="Loading task" rows={6} className="p-6" />
      </Page>
    );
  }

  if (tasks.error) {
    return (
      <Page title="Task" description="Could not be read">
        <ErrorState error={tasks.error} onRetry={() => void tasks.refetch()} />
      </Page>
    );
  }

  if (!task) {
    return (
      <Page title="Task" description="Not found" actions={<BackButton />}>
        <EmptyState
          title="That task no longer exists"
          description="It may have been pruned by the history cap, which keeps the most recent finished tasks and drops the oldest."
          action={
            <Button asChild variant="secondary">
              <Link to="/tasks">Back to tasks</Link>
            </Button>
          }
        />
      </Page>
    );
  }

  const badge = taskBadge(task);
  return (
    <Page
      title={task.title}
      description={`${badge.label} · ${task.agent}`}
      bodyClassName="flex"
      actions={
        <>
          <BackButton />
          <TaskActions task={task} onRetried={(newId) => navigate(`/tasks/${newId}`)} />
        </>
      }
    >
      <TwoPane
        listLabel="Transcript"
        mobilePane="list"
        listWidth="24rem"
        list={<Transcript task={task} />}
        detailLabel="Task details"
        detail={<Metadata task={task} />}
      />
    </Page>
  );
}

function BackButton() {
  return (
    <Button asChild variant="ghost" size="sm">
      <Link to="/tasks">
        <ArrowLeft aria-hidden="true" />
        All tasks
      </Link>
    </Button>
  );
}

/* ---------------------------------------------------------------------------------------- */

function TaskActions({ task, onRetried }: { task: TaskView; onRetried: (id: string) => void }) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState<string | null>(null);
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: queryKeys.tasks });

  const cancel = useMutation({
    mutationFn: () => cancelTask(task.id),
    // A cancel that lost its race comes back with the outcome the task actually reached. The
    // header badge corrects itself from the refetch, but silence next to a badge that now reads
    // "Succeeded" looks like the button did nothing, so the reason gets said out loud.
    onSuccess: (settled) => {
      setNote(settled.state === "cancelled" ? null : cancelOutcome(settled));
      invalidate();
    },
    onError: (e) => {
      setNote(errorMessage(e));
      invalidate();
    },
  });

  const retry = useMutation({
    mutationFn: () => retryTask(task.id),
    onSuccess: (created) => {
      setNote(null);
      invalidate();
      // Retry clones, so the new task is a different row with a different id. Following it is
      // the only reading of "retry" that is not a no-op from here.
      onRetried(created.id);
    },
    onError: (e) => {
      setNote(errorMessage(e));
      invalidate();
    },
  });

  const terminal = task.state !== "queued" && task.state !== "running";
  const busy = cancel.isPending || retry.isPending;

  return (
    <>
      {note && (
        <span role="status" className="max-w-md truncate text-xs text-fg-muted" title={note}>
          {note}
        </span>
      )}
      {terminal ? (
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => retry.mutate()}>
          <RotateCw aria-hidden="true" />
          Retry
        </Button>
      ) : (
        <ConfirmDialog
          trigger={
            <Button variant="secondary" size="sm" disabled={busy}>
              <X aria-hidden="true" />
              Cancel
            </Button>
          }
          title={task.state === "queued" ? "Drop this task from the queue?" : "Stop this task?"}
          description={
            task.state === "queued"
              ? `"${task.title}" has not started, so nothing is lost. It stays in the list as cancelled.`
              : `"${task.title}" is part-way through. Work the agent has already done is kept; work it has not done will not happen.`
          }
          confirmLabel="Cancel task"
          cancelLabel="Keep it"
          onConfirm={() => cancel.mutate()}
        />
      )}
    </>
  );
}

/* ---------------------------------------------------------------------------------------- */

function Transcript({ task }: { task: TaskView }) {
  const transcript = useQuery({
    queryKey: queryKeys.taskTranscript(task.id),
    queryFn: () => getTaskTranscript(task.id),
  });

  if (transcript.isLoading) return <LoadingState label="Loading transcript" rows={6} className="p-3" />;
  if (transcript.error) return <ErrorState error={transcript.error} onRetry={() => void transcript.refetch()} />;

  const messages = transcript.data?.messages ?? [];
  if (messages.length === 0) {
    return (
      <EmptyState
        icon={MessageSquare}
        title={task.state === "queued" ? "Not started yet" : "Nothing was said"}
        description={
          task.state === "queued"
            ? "The transcript appears once this task starts running."
            : "This task produced no transcript messages."
        }
      />
    );
  }

  return (
    <div className="flex flex-col">
      {transcript.data?.truncated && (
        // Pinned rather than placed at the top of the list, so it stays true after scrolling.
        <p className="sticky top-0 z-10 border-b border-border bg-surface px-3 py-2 text-2xs text-fg-muted">
          Showing the last {messages.length} messages. Earlier messages are not shown.
        </p>
      )}
      <ol className="flex flex-col gap-3 p-3">
        {messages.map((message, index) => (
          <Message key={index} message={message} />
        ))}
      </ol>
    </div>
  );
}

function Message({ message }: { message: TranscriptMessage }) {
  const isUser = message.role === "user";
  return (
    <li
      className={cn(
        "flex flex-col gap-1",
        // A rule rather than a bubble: at console density, two indent levels read faster than
        // two background colours, and it survives a long code block without boxing it.
        isUser && "border-l-2 border-border-strong pl-3",
      )}
    >
      <span className="flex items-baseline gap-2">
        <span className="text-2xs font-semibold uppercase tracking-[var(--tracking-wide)] text-fg-subtle">
          {isUser ? "You" : "Agent"}
        </span>
        {message.at !== null && (
          <time dateTime={new Date(message.at).toISOString()} className="text-2xs text-fg-subtle">
            {new Date(message.at).toLocaleTimeString()}
          </time>
        )}
      </span>
      <p className="whitespace-pre-wrap font-mono text-2xs leading-relaxed text-fg">{message.text}</p>
    </li>
  );
}

/* ---------------------------------------------------------------------------------------- */

function Metadata({ task }: { task: TaskView }) {
  const badge = taskBadge(task);
  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={badge.status} label={badge.label} title={badge.title} />
        {task.waiting && task.attachCommand && (
          <span className="text-xs text-fg-muted">
            Answer it in a terminal: <code className="font-mono text-2xs text-fg">{task.attachCommand}</code>
          </span>
        )}
      </div>

      {task.error && (
        <section>
          <h2 className="text-xs font-medium text-danger-fg">Why it failed</h2>
          <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-fg-muted">{task.error}</p>
        </section>
      )}

      {task.result && (
        <section>
          <h2 className="text-xs font-medium text-fg-muted">
            {task.state === "blocked" ? "What it is blocked on" : "Result"}
          </h2>
          <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap font-mono text-2xs leading-relaxed text-fg">
            {task.result}
          </pre>
        </section>
      )}

      <section>
        <h2 className="text-xs font-medium text-fg-muted">Prompt</h2>
        <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-fg">{task.prompt}</p>
      </section>

      <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-2 text-xs">
        <Row label="Agent">{task.agent}</Row>
        <Row label="Working directory" mono>
          {task.cwd}
        </Row>
        <Row label="Priority">{priorityLabel(task.priority)}</Row>
        <Row label="Attempts">
          {task.attempts} of {task.maxAttempts}
        </Row>
        <Row label="Permission mode">
          {task.permissionMode === "bypassPermissions" ? "Skipping permission prompts" : "Asks before each tool"}
        </Row>
        <Row label="Unattended">{task.unattended ? "Yes — will not ask questions" : "No"}</Row>
        <Row label="Created">{new Date(task.createdAt).toLocaleString()}</Row>
        {task.startedAt !== null && <Row label="Started">{new Date(task.startedAt).toLocaleString()}</Row>}
        {task.finishedAt !== null && (
          <Row label="Finished">
            {new Date(task.finishedAt).toLocaleString()}
            {(() => {
              const ran = duration(task.startedAt, task.finishedAt);
              return ran ? ` (${ran})` : "";
            })()}
          </Row>
        )}
        {task.runId && (
          <Row label="Run id" mono>
            {task.runId}
          </Row>
        )}
        {task.sessionId && (
          <Row label="Session id" mono>
            {task.sessionId}
          </Row>
        )}
        {task.attachCommand && (
          <Row label="Attach" mono>
            {task.attachCommand}
          </Row>
        )}
      </dl>
    </div>
  );
}

function Row({ label, mono, children }: { label: string; mono?: boolean; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-fg-subtle">{label}</dt>
      <dd className={cn("min-w-0 break-words text-fg-muted", mono && "font-mono text-2xs")}>{children}</dd>
    </>
  );
}
