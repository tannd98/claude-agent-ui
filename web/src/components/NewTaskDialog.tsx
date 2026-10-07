import { useMutation, useQuery } from "@tanstack/react-query";
import * as React from "react";
import { useEffect, useState } from "react";
import { createTask, getConfig, listAgents, queryKeys, type PermissionMode, type TaskView } from "../lib/api.ts";
import { PRIORITY_LEVELS } from "../lib/taskStatus.ts";
import { PermissionModeField } from "./PermissionModeField.tsx";
import { errorMessage } from "./States.tsx";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogPanel } from "./ui/dialog.tsx";
import { Field, Select, Switch, TextArea, TextInput } from "./ui/field.tsx";

/** The server's cap. The counter stays hidden until a prompt is actually near it. */
const PROMPT_LIMIT = 100_000;
const COUNTER_FROM = 90_000;
const TITLE_LIMIT = 80;

/** The footer buttons live outside the <form>, so the submit button reaches it by id. */
const FORM_ID = "new-task-form";

export interface NewTaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the created task so the screen can highlight and announce the new row. */
  onCreated: (task: TaskView) => void;
}

export function NewTaskDialog({ open, onOpenChange, onCreated }: NewTaskDialogProps) {
  const agents = useQuery({ queryKey: queryKeys.agents, queryFn: listAgents, enabled: open });
  const config = useQuery({ queryKey: queryKeys.config, queryFn: getConfig, enabled: open });

  const [agentId, setAgentId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [cwd, setCwd] = useState("");
  const [priority, setPriority] = useState(0);
  const [unattended, setUnattended] = useState(true);
  // Hardcoded, never seeded from `config.permissionMode`. A queued task has nobody there to
  // answer, so it must not inherit a global bypass — see the M4 contract on POST /api/tasks.
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("ask");

  // Fill the two defaults the server would apply anyway, so they are visible and editable
  // rather than a surprise applied after submit. Note which two: `permissionMode` is not one
  // of them, and must never become one.
  const { defaultCwd, starterPrompt } = config.data ?? {};
  useEffect(() => {
    if (!open) return;
    if (defaultCwd) setCwd((current) => current || defaultCwd);
    if (starterPrompt) setPrompt((current) => current || starterPrompt);
  }, [open, defaultCwd, starterPrompt]);

  const runnable = (agents.data ?? []).filter((a) => a.valid);

  const create = useMutation({
    mutationFn: createTask,
    onSuccess: (task) => {
      onCreated(task);
      reset();
      onOpenChange(false);
    },
  });

  function reset() {
    setAgentId("");
    setTitle("");
    setPriority(0);
    setUnattended(true);
    setPermissionMode("ask");
    setCwd("");
    setPrompt("");
    create.reset();
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!agentId || promptTooLong) return;
    create.mutate({
      agentId,
      cwd: cwd.trim() || undefined,
      prompt,
      title: title.trim() || undefined,
      permissionMode,
      unattended,
      priority,
    });
  }

  const derivedTitle =
    prompt
      .split("\n")
      .find((l) => l.trim())
      ?.trim()
      .slice(0, TITLE_LIMIT) ?? "";
  const promptTooLong = prompt.length > PROMPT_LIMIT;

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogPanel
          title="New task"
          description="One agent run, queued and watched. It starts as soon as a slot is free."
          footer={
            <>
              <Button type="button" variant="secondary" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                form={FORM_ID}
                variant="primary"
                disabled={!agentId || promptTooLong || create.isPending}
                // A disabled button that does not say why is a dead end.
                disabledReason={
                  !agentId
                    ? "Choose an agent first."
                    : promptTooLong
                      ? "The prompt is over the length limit."
                      : "Adding the task…"
                }
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

            <Field
              label="Agent"
              help={
                agents.isLoading
                  ? "Reading the agents on disk…"
                  : runnable.length === 0
                    ? "No usable agent definitions were found. Fix or add one on the Agents screen."
                    : undefined
              }
              error={agents.error ? errorMessage(agents.error) : null}
            >
              {({ id, describedBy, invalid }) => (
                <Select
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid || undefined}
                  required
                  value={agentId}
                  onChange={(e) => setAgentId(e.target.value)}
                  disabled={runnable.length === 0}
                >
                  <option value="" disabled>
                    Choose an agent…
                  </option>
                  {runnable.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>

            <Field
              label="Prompt"
              help={
                // A counter on an empty box is noise; one beside a 95k prompt is the only
                // warning there is before a 400.
                prompt.length >= COUNTER_FROM
                  ? `${prompt.length.toLocaleString()} of ${PROMPT_LIMIT.toLocaleString()} characters`
                  : "What the agent should do. Nobody will be watching it run, so be specific."
              }
              error={
                promptTooLong
                  ? `The prompt is ${(prompt.length - PROMPT_LIMIT).toLocaleString()} characters too long.`
                  : null
              }
            >
              {({ id, describedBy, invalid }) => (
                <TextArea
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid || undefined}
                  rows={6}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                />
              )}
            </Field>

            <Field label="Title" help="Optional. This is what the task list shows.">
              {({ id, describedBy }) => (
                <TextInput
                  id={id}
                  aria-describedby={describedBy}
                  type="text"
                  value={title}
                  maxLength={TITLE_LIMIT}
                  // The fallback is visible rather than a surprise: this is exactly what the
                  // server derives when the field is left empty.
                  placeholder={derivedTitle || "Taken from the first line of the prompt"}
                  onChange={(e) => setTitle(e.target.value)}
                />
              )}
            </Field>

            <Field label="Working directory" help="The agent runs here. The directory must already exist.">
              {({ id, describedBy }) => (
                <TextInput
                  id={id}
                  aria-describedby={describedBy}
                  type="text"
                  value={cwd}
                  onChange={(e) => setCwd(e.target.value)}
                  className="font-mono text-xs"
                />
              )}
            </Field>

            <Field label="Priority" help="Higher priority starts first. Ties go to whichever was queued first.">
              {({ id, describedBy }) => (
                <Select
                  id={id}
                  aria-describedby={describedBy}
                  value={String(priority)}
                  onChange={(e) => setPriority(Number(e.target.value))}
                >
                  {PRIORITY_LEVELS.map((level) => (
                    <option key={level.value} value={level.value}>
                      {level.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>

            {/*
              Two controls with a rule between them, never worded as one idea. `unattended`
              governs *questions*; `permissionMode` governs *tool permissions*. An unattended
              task can still park on a permission prompt — that is what Needs permission is for.

              The permission control is PermissionModeField rather than a second switch: it is
              the one piece of wording the CEO's decision names verbatim, and two
              implementations of the most dangerous control in the product is one too many.
            */}
            <div className="flex flex-col gap-4 border-t border-border pt-4">
              <Switch
                checked={unattended}
                onCheckedChange={setUnattended}
                label="Run unattended"
                help="The agent will not stop to ask you questions. Recommended for queued work, since nobody is watching it run."
              />
              <PermissionModeField
                value={permissionMode}
                onChange={setPermissionMode}
                cwd={cwd}
                name="new-task-permission-mode"
              />
            </div>
          </form>
        </DialogPanel>
      </Dialog>
    </>
  );
}
