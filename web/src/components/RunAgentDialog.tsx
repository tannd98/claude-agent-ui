import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { createTask, getConfig, queryKeys, type Agent, type PermissionMode } from "../lib/api.ts";
import { PermissionModeField } from "./PermissionModeField.tsx";
import { errorMessage } from "./States.tsx";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogPanel } from "./ui/dialog.tsx";
import { Field, TextArea, TextInput } from "./ui/field.tsx";

/**
 * "Run now", from the Agents screen.
 *
 * It does not start a run. It creates a **task in the queue** — one path to starting an agent,
 * so a thing that is running is always a row in the task list with a position, a state and a
 * cancel button. A second "just run it" path would be a second place to look when something is
 * stuck, which is the thing this console exists to avoid.
 *
 * The agent is fixed: the user picked it in the list, so the form does not ask again
 * (ux-guidelines No. 106, redundant entry). Everything else the server would default is shown
 * and editable rather than applied invisibly after submit.
 */

const FORM_ID = "run-agent-form";
const TITLE_LIMIT = 80;

export interface RunAgentDialogProps {
  agent: Agent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called once the task is queued, so the screen can say so where the user is looking. */
  onQueued?: (title: string) => void;
}

export function RunAgentDialog({ agent, open, onOpenChange, onQueued }: RunAgentDialogProps) {
  const config = useQuery({ queryKey: queryKeys.config, queryFn: getConfig, enabled: open });

  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [cwd, setCwd] = useState("");
  // Never read from config: a queued task has nobody there to answer, so it does not inherit a
  // global bypass. `ask` is the start state here and the CEO decision keeps it that way.
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("ask");

  const { defaultCwd, starterPrompt } = config.data ?? {};
  useEffect(() => {
    if (!open) return;
    if (defaultCwd) setCwd((current) => current || defaultCwd);
    if (starterPrompt) setPrompt((current) => current || starterPrompt);
  }, [open, defaultCwd, starterPrompt]);

  const create = useMutation({
    mutationFn: createTask,
    onSuccess: (task) => {
      onQueued?.(task.title);
      reset();
      onOpenChange(false);
    },
  });

  function reset() {
    setPrompt("");
    setTitle("");
    setCwd("");
    setPermissionMode("ask");
    create.reset();
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    create.mutate({
      // The agent *file* id, not its runName: the server resolves it and refuses one whose
      // frontmatter does not parse, so the id is the thing that cannot drift.
      agentId: agent.id,
      cwd: cwd.trim() || undefined,
      prompt,
      title: title.trim() || undefined,
      permissionMode,
    });
  }

  const derivedTitle =
    prompt
      .split("\n")
      .find((line) => line.trim())
      ?.trim()
      .slice(0, TITLE_LIMIT) ?? "";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPanel
        title={`Run ${agent.name}`}
        description="This adds a task to the queue. It starts when a slot is free and runs unattended."
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              form={FORM_ID}
              variant="primary"
              disabled={create.isPending}
              disabledReason="Adding the task…"
            >
              {create.isPending ? "Adding…" : "Add to queue"}
            </Button>
          </>
        }
      >
        <form id={FORM_ID} onSubmit={submit} className="flex flex-col gap-4">
          {create.error && (
            <p role="alert" className="rounded-[var(--radius-md)] bg-danger-quiet px-3 py-2 text-sm text-danger-fg">
              {errorMessage(create.error)}
            </p>
          )}

          <Field label="Prompt" help="What the agent should do. Nobody will be watching it run, so be specific.">
            {({ id, describedBy }) => (
              <TextArea
                id={id}
                aria-describedby={describedBy}
                rows={6}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            )}
          </Field>

          <Field label="Working directory" help="The agent runs here. It must already exist.">
            {({ id, describedBy }) => (
              <TextInput
                id={id}
                aria-describedby={describedBy}
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                className="font-mono text-sm"
              />
            )}
          </Field>

          <Field label="Title" help="Optional. Shown in the task list.">
            {({ id, describedBy }) => (
              <TextInput
                id={id}
                aria-describedby={describedBy}
                value={title}
                maxLength={TITLE_LIMIT}
                // The fallback is visible rather than a surprise: this is what the server
                // derives when the field is left empty.
                placeholder={derivedTitle || "Taken from the first line of the prompt"}
                onChange={(e) => setTitle(e.target.value)}
              />
            )}
          </Field>

          <div className="border-t border-border pt-4">
            <PermissionModeField
              value={permissionMode}
              onChange={setPermissionMode}
              cwd={cwd}
              name="run-agent-permission-mode"
            />
          </div>
        </form>
      </DialogPanel>
    </Dialog>
  );
}
