import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { useEffect, useMemo, useState } from "react";
import {
  createSchedule,
  getConfig,
  listAgents,
  queryKeys,
  updateSchedule,
  type PermissionMode,
  type OverlapPolicy,
  type Schedule,
} from "../lib/api.ts";
import { describeCron } from "../lib/cron.ts";
import { PRIORITY_LEVELS } from "../lib/taskStatus.ts";
import { PermissionModeField } from "./PermissionModeField.tsx";
import { ServerRunningNotice } from "./ServerRunningNotice.tsx";
import { errorMessage } from "./States.tsx";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogPanel } from "./ui/dialog.tsx";
import { Field, Select, Switch, TextArea, TextInput } from "./ui/field.tsx";

const NAME_LIMIT = 80;
const TITLE_LIMIT = 80;
const FORM_ID = "schedule-form";

/**
 * Patterns worth offering, because the point of this screen is that nobody should have to
 * remember cron. Each one is also a live example of what the field accepts.
 */
const PRESETS: { cron: string; label: string }[] = [
  { cron: "0 9 * * 1-5", label: "Weekday mornings" },
  { cron: "0 * * * *", label: "Hourly" },
  { cron: "0 3 * * *", label: "Nightly" },
  { cron: "0 9 * * 1", label: "Monday mornings" },
  { cron: "0 2 1 * *", label: "Monthly" },
];

/**
 * Every IANA zone the browser knows, so the field is a choice rather than a thing to spell.
 *
 * A typed timezone is the quiet failure this screen exists to prevent: the server rejects an
 * unknown name, but `Europe/Amsterdam` typed as `Europe/Amsterdm` and `America/New_York` typed
 * as `US/Eastern` are two different kinds of wrong, and only one of them gets caught.
 */
function timeZones(): string[] | null {
  const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  try {
    const zones = supported?.("timeZone");
    return zones && zones.length > 0 ? zones : null;
  } catch {
    return null;
  }
}

export interface ScheduleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The schedule being edited, or null to create a new one. */
  schedule: Schedule | null;
  /** Called with the saved schedule so the screen can highlight and announce the row. */
  onSaved: (schedule: Schedule, created: boolean) => void;
}

export function ScheduleDialog({ open, onOpenChange, schedule, onSaved }: ScheduleDialogProps) {
  const editing = schedule !== null;
  const agents = useQuery({ queryKey: queryKeys.agents, queryFn: listAgents, enabled: open });
  const config = useQuery({ queryKey: queryKeys.config, queryFn: getConfig, enabled: open });
  const queryClient = useQueryClient();
  const zones = useMemo(timeZones, []);
  const hostZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);

  const [name, setName] = useState("");
  const [cron, setCron] = useState("0 9 * * 1-5");
  const [timezone, setTimezone] = useState(hostZone);
  const [overlapPolicy, setOverlapPolicy] = useState<OverlapPolicy>("skip");
  const [agent, setAgent] = useState("");
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [cwd, setCwd] = useState("");
  const [priority, setPriority] = useState(0);
  const [unattended, setUnattended] = useState(true);
  // Never seeded from `config.permissionMode`. A scheduled task fires with nobody watching, so
  // a global bypass must not be inherited by it — the same rule the queue's create() applies.
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("ask");

  const { defaultCwd, starterPrompt } = config.data ?? {};

  // Reload the form from whatever it was opened on. Keyed on the schedule's `updatedAt` as well
  // as its id, so re-opening after an SSE-driven refresh shows the stored values rather than
  // the ones this tab last typed.
  useEffect(() => {
    if (!open) return;
    if (schedule) {
      setName(schedule.name);
      setCron(schedule.cron);
      setTimezone(schedule.timezone);
      setOverlapPolicy(schedule.overlapPolicy);
      setAgent(schedule.task.agent);
      setPrompt(schedule.task.prompt);
      setTitle(schedule.task.title ?? "");
      setCwd(schedule.task.cwd);
      setPriority(schedule.task.priority);
      setUnattended(schedule.task.unattended);
      setPermissionMode(schedule.task.permissionMode);
      return;
    }
    setName("");
    setCron("0 9 * * 1-5");
    setTimezone(hostZone);
    setOverlapPolicy("skip");
    setAgent("");
    setTitle("");
    setPriority(0);
    setUnattended(true);
    setPermissionMode("ask");
    setCwd(defaultCwd ?? "");
    setPrompt(starterPrompt ?? "");
  }, [open, schedule, hostZone, defaultCwd, starterPrompt]);

  const runnable = (agents.data ?? []).filter((a) => a.valid);

  const save = useMutation({
    mutationFn: () => {
      const input = {
        name: name.trim(),
        cron: cron.trim(),
        timezone,
        overlapPolicy,
        task: {
          agent,
          cwd: cwd.trim(),
          prompt,
          title: title.trim() || null,
          permissionMode,
          unattended,
          priority,
        },
      };
      return editing ? updateSchedule(schedule.id, input) : createSchedule(input);
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.schedules });
      onSaved(saved, !editing);
      onOpenChange(false);
    },
  });

  function handleOpenChange(next: boolean) {
    if (!next) save.reset();
    onOpenChange(next);
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || !cron.trim() || !agent) return;
    save.mutate();
  }

  // The server's message, verbatim — it is written to be read and it quotes the real problem.
  // Matching it back to a field is a convenience on top, never a replacement: an unmatched
  // message still appears in the alert above the form.
  const serverError = save.error ? errorMessage(save.error) : null;
  const fieldError = (needle: string) =>
    serverError && serverError.toLowerCase().includes(needle) ? serverError : null;

  const english = describeCron(cron);
  const incomplete = !name.trim() || !cron.trim() || !agent;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPanel
        title={editing ? "Edit schedule" : "New schedule"}
        description="A saved task template and a cron expression. When it fires it adds a task to the queue — it never starts a run directly."
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              form={FORM_ID}
              variant="primary"
              disabled={incomplete || save.isPending}
              disabledReason={
                !name.trim()
                  ? "Give the schedule a name first."
                  : !cron.trim()
                    ? "A cron expression is required."
                    : !agent
                      ? "Choose an agent first."
                      : "Saving…"
              }
            >
              {save.isPending ? "Saving…" : editing ? "Save changes" : "Create schedule"}
            </Button>
          </>
        }
      >
        <form id={FORM_ID} onSubmit={submit} className="flex flex-col gap-4">
          {/* Deciding to depend on a schedule is the moment the limitation matters most. */}
          <ServerRunningNotice compact />

          {serverError && (
            <p role="alert" className="rounded-[var(--radius-md)] bg-danger-quiet px-3 py-2 text-sm text-danger-fg">
              {serverError}
            </p>
          )}

          <Field label="Name" help="What this schedule is for. It is what the list shows." error={fieldError("name")}>
            {({ id, describedBy, invalid }) => (
              <TextInput
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                required
                value={name}
                maxLength={NAME_LIMIT}
                placeholder="Nightly dependency audit"
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>

          <Field
            label="Cron expression"
            // The sentence is the validation an operator can actually read: a typo usually
            // produces a *different legal* expression, which no required-field check catches.
            help={
              english ? (
                <span className="text-[var(--field-label-fg)]">Runs {english}.</span>
              ) : (
                "Five fields, or six with seconds first. This is not a pattern we can put a sentence to — check it carefully."
              )
            }
            error={fieldError("cron")}
          >
            {({ id, describedBy, invalid }) => (
              <TextInput
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                required
                value={cron}
                spellCheck={false}
                onChange={(e) => setCron(e.target.value)}
                className="font-mono text-xs"
              />
            )}
          </Field>

          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((preset) => (
              <Button
                key={preset.cron}
                type="button"
                variant="secondary"
                size="sm"
                aria-pressed={cron.trim() === preset.cron}
                onClick={() => setCron(preset.cron)}
                className={cron.trim() === preset.cron ? "border-[var(--choice-border-selected)]" : undefined}
              >
                {preset.label}
              </Button>
            ))}
          </div>

          <Field
            label="Timezone"
            help="The cron expression is read in this zone, including across a daylight-saving change."
            error={fieldError("timezone")}
          >
            {({ id, describedBy, invalid }) =>
              zones ? (
                <Select
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid || undefined}
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                >
                  {/* A stored zone this browser does not list would otherwise silently become
                      the first option in the list — which is a schedule quietly moved. */}
                  {!zones.includes(timezone) && <option value={timezone}>{timezone}</option>}
                  {zones.map((zone) => (
                    <option key={zone} value={zone}>
                      {zone}
                    </option>
                  ))}
                </Select>
              ) : (
                <TextInput
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid || undefined}
                  value={timezone}
                  spellCheck={false}
                  onChange={(e) => setTimezone(e.target.value)}
                  className="font-mono text-xs"
                />
              )
            }
          </Field>

          <Field
            label="If the last task has not finished"
            help={
              overlapPolicy === "skip"
                ? "Skip this firing and record why. The queue never builds up behind a slow run."
                : "Queue it anyway — except behind a run waiting on a permission prompt, which is never stacked on."
            }
          >
            {({ id, describedBy }) => (
              <Select
                id={id}
                aria-describedby={describedBy}
                value={overlapPolicy}
                onChange={(e) => setOverlapPolicy(e.target.value as OverlapPolicy)}
              >
                <option value="skip">Skip this firing</option>
                <option value="queue">Queue it anyway</option>
              </Select>
            )}
          </Field>

          <div className="flex flex-col gap-4 border-t border-border pt-4">
            <p className="text-xs leading-normal text-fg-muted">
              The task this schedule adds to the queue, every time it fires.
            </p>

            <Field
              label="Agent"
              help={
                agents.isLoading
                  ? "Reading the agents on disk…"
                  : runnable.length === 0
                    ? "No usable agent definitions were found. Fix or add one on the Agents screen."
                    : undefined
              }
              error={agents.error ? errorMessage(agents.error) : fieldError("agent")}
            >
              {({ id, describedBy, invalid }) => (
                <Select
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid || undefined}
                  required
                  value={agent}
                  onChange={(e) => setAgent(e.target.value)}
                  disabled={runnable.length === 0}
                >
                  <option value="" disabled>
                    Choose an agent…
                  </option>
                  {/* The *runName* — the literal `claude --agent` takes. A schedule stores the
                      name, not the file id, so renaming the file breaks the schedule loudly
                      rather than silently repointing it at a different agent. */}
                  {runnable.map((one) => (
                    <option key={one.id} value={one.runName}>
                      {one.name}
                    </option>
                  ))}
                  {editing && agent && !runnable.some((one) => one.runName === agent) && (
                    <option value={agent}>{agent} — no longer on disk</option>
                  )}
                </Select>
              )}
            </Field>

            <Field
              label="Prompt"
              help="What the agent should do. Nobody will be watching it run, so be specific."
              error={fieldError("prompt")}
            >
              {({ id, describedBy, invalid }) => (
                <TextArea
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid || undefined}
                  rows={5}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                />
              )}
            </Field>

            <Field label="Task title" help="Optional. This is what the queue shows for each firing.">
              {({ id, describedBy }) => (
                <TextInput
                  id={id}
                  aria-describedby={describedBy}
                  value={title}
                  maxLength={TITLE_LIMIT}
                  placeholder="Taken from the first line of the prompt"
                  onChange={(e) => setTitle(e.target.value)}
                />
              )}
            </Field>

            <Field
              label="Working directory"
              help="The agent runs here. The directory must already exist."
              error={fieldError("cwd")}
            >
              {({ id, describedBy, invalid }) => (
                <TextInput
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid || undefined}
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

            <Switch
              checked={unattended}
              onCheckedChange={setUnattended}
              label="Run unattended"
              help="The agent will not stop to ask you questions. Strongly recommended here: a scheduled task may fire at 03:00 with nobody to answer."
            />
            <PermissionModeField
              value={permissionMode}
              onChange={setPermissionMode}
              cwd={cwd}
              name="schedule-permission-mode"
            />
          </div>
        </form>
      </DialogPanel>
    </Dialog>
  );
}
