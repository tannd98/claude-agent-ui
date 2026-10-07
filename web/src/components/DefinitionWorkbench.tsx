import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, FilePlus2, FileWarning, Lock, RotateCcw, Search, Trash2 } from "lucide-react";
import * as React from "react";
import {
  getConfig,
  isApiError,
  queryKeys,
  type AppConfig,
  type FieldError,
  type Scope,
  type ValidationResult,
  type WritableScope,
} from "../lib/api.ts";
import { cn, plural } from "../lib/utils.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { Page } from "./Page.tsx";
import { ScopeBadge } from "./ScopeBadge.tsx";
import { EmptyState, ErrorState, LoadingState, errorMessage } from "./States.tsx";
import { TwoPane } from "./TwoPane.tsx";
import { Button } from "./ui/button.tsx";
import { Select } from "./ui/field.tsx";

/**
 * The screen Agents and Skills share.
 *
 * Both areas are the same thing on disk — a Markdown file with YAML frontmatter, in one of
 * three places, two of which are writable — so they are one screen with an adapter rather than
 * two screens that drift. Everything that differs between them (the routes, the nouns, the
 * copy, the agent's skill-access panel, the Run now button) arrives through
 * {@link DefinitionAdapter}; nothing below branches on `kind`.
 *
 * Layout is TwoPane: list left, editor right. Density dial 8 — the list is scannable at a
 * glance and the editor gets the rest of the width.
 */

/* --- What the two resources have in common ------------------------------------------- */

/** The fields every list entry carries, whichever route it came from. */
export interface DefinitionSummary {
  id: string;
  name: string;
  description: string;
  scope: Scope;
  plugin: string | null;
  editable: boolean;
  /** Why it cannot be edited, as a sentence to render as-is. Null when it can. */
  readOnlyReason: string | null;
  valid: boolean;
  error: string | null;
}

/** A list entry plus the file itself. */
export interface DefinitionContent extends DefinitionSummary {
  content: string;
}

export interface DefinitionAdapter<TItem extends DefinitionSummary, TDetail extends DefinitionContent> {
  /** Used for ids and nothing else; no behaviour below branches on it. */
  kind: "agent" | "skill";
  title: string;
  pageDescription: string;
  /** Lower case, as it appears mid-sentence: "agent", "skill". */
  noun: string;
  /** What the list shows when nothing is on disk yet. */
  emptyIcon: React.ComponentType<{ className?: string }>;
  emptyDescription: string;
  /** The extra sentence in the delete confirmation, where deleting takes more than one file. */
  deleteWarning?: React.ReactNode;

  listKey: readonly unknown[];
  detailKey: (id: string) => readonly unknown[];
  list: () => Promise<TItem[]>;
  get: (id: string) => Promise<TDetail>;
  create: (content: string, scope: WritableScope) => Promise<{ id: string }>;
  update: (id: string, content: string) => Promise<unknown>;
  remove: (id: string) => Promise<unknown>;
  /** Checks a draft without writing it. Resolves for every draft; only the server being gone throws. */
  validate: (content: string) => Promise<ValidationResult>;
  /** Starting content for a new file, so "New" opens something that already parses. */
  template: (config: AppConfig) => string;

  /** A second line in the list row — the skill's `ref`, the agent's model. */
  meta?: (item: TItem) => React.ReactNode;
  /** Header actions for a saved item, e.g. Run now. */
  actions?: (detail: TDetail) => React.ReactNode;
  /** Rendered under the editor, e.g. the skills an agent can reach. */
  aside?: (detail: TDetail) => React.ReactNode;
}

/* --- Selection ------------------------------------------------------------------------ */

type Selection =
  | { kind: "none" }
  | { kind: "item"; id: string }
  /** `seq` makes two consecutive "New" clicks distinct, so the editor remounts with a fresh draft. */
  | { kind: "new"; scope: WritableScope; seq: number };

const SCOPE_ORDER: Record<Scope, number> = { user: 0, project: 1, plugin: 2 };

/* --- The screen ----------------------------------------------------------------------- */

export function DefinitionWorkbench<TItem extends DefinitionSummary, TDetail extends DefinitionContent>({
  adapter,
}: {
  adapter: DefinitionAdapter<TItem, TDetail>;
}) {
  const items = useQuery({ queryKey: adapter.listKey, queryFn: adapter.list });
  const config = useQuery({ queryKey: queryKeys.config, queryFn: getConfig });

  const [selection, setSelection] = React.useState<Selection>({ kind: "none" });
  const [filter, setFilter] = React.useState("");
  const [dirty, setDirty] = React.useState(false);
  // Where the user asked to go while there were unsaved edits. Held until they answer.
  const [pending, setPending] = React.useState<Selection | null>(null);
  const [newSeq, setNewSeq] = React.useState(0);

  /** Every selection change goes through here, so nothing can discard an edit silently. */
  const request = React.useCallback(
    (next: Selection) => {
      if (dirty) setPending(next);
      else setSelection(next);
    },
    [dirty],
  );

  const commit = React.useCallback((next: Selection) => {
    setDirty(false);
    setSelection(next);
  }, []);

  const startNew = () => {
    setNewSeq((n) => n + 1);
    request({ kind: "new", scope: "user", seq: newSeq + 1 });
  };

  const needle = filter.trim().toLowerCase();
  const visible = (items.data ?? [])
    .filter((item) =>
      needle ? `${item.name} ${item.description} ${item.plugin ?? ""}`.toLowerCase().includes(needle) : true,
    )
    .sort((a, b) => SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] || a.name.localeCompare(b.name));

  const selectedId = selection.kind === "item" ? selection.id : null;

  return (
    <Page
      title={adapter.title}
      description={adapter.pageDescription}
      bodyClassName="flex"
      actions={
        <Button variant="primary" size="sm" onClick={startNew}>
          <FilePlus2 aria-hidden="true" />
          New {adapter.noun}
        </Button>
      }
    >
      <TwoPane
        listLabel={adapter.title}
        mobilePane={selection.kind === "none" ? "list" : "detail"}
        list={
          <>
            {/* Sticky so the filter stays reachable in a long plugin list. */}
            <div className="sticky top-0 z-10 border-b border-border bg-surface p-2">
              <label htmlFor={`${adapter.kind}-filter`} className="sr-only">
                Filter {adapter.title.toLowerCase()}
              </label>
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle"
                  aria-hidden="true"
                />
                <input
                  id={`${adapter.kind}-filter`}
                  type="search"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter by name"
                  className={cn(
                    "h-[var(--button-height-md)] w-full rounded-[var(--field-radius)] border border-[var(--field-border)]",
                    "bg-[var(--field-bg)] pl-7 pr-2 text-sm text-[var(--field-fg)]",
                    "placeholder:text-[var(--field-placeholder)]",
                  )}
                />
              </div>
            </div>
            {items.isLoading ? (
              <LoadingState label={`Loading ${adapter.title.toLowerCase()}`} className="p-2" />
            ) : items.error ? (
              <ErrorState error={items.error} onRetry={() => void items.refetch()} />
            ) : visible.length === 0 ? (
              <EmptyState
                icon={adapter.emptyIcon}
                title={needle ? "Nothing matches that filter" : `No ${adapter.noun}s found`}
                description={needle ? "Clear the filter to see everything on disk." : adapter.emptyDescription}
                action={
                  needle ? (
                    <Button variant="secondary" size="sm" onClick={() => setFilter("")}>
                      Clear filter
                    </Button>
                  ) : (
                    <Button variant="primary" size="sm" onClick={startNew}>
                      <FilePlus2 aria-hidden="true" />
                      New {adapter.noun}
                    </Button>
                  )
                }
              />
            ) : (
              <ul className="flex flex-col gap-px p-2">
                {visible.map((item) => (
                  <ListRow
                    key={item.id}
                    item={item}
                    meta={adapter.meta?.(item)}
                    selected={item.id === selectedId}
                    onSelect={() => request({ kind: "item", id: item.id })}
                  />
                ))}
              </ul>
            )}
          </>
        }
        detailLabel={`${adapter.title} editor`}
        detail={
          selection.kind === "item" ? (
            <DetailPane
              key={selection.id}
              adapter={adapter}
              id={selection.id}
              onDirtyChange={setDirty}
              onReplaced={(id) => commit({ kind: "item", id })}
              onDeleted={() => commit({ kind: "none" })}
              onBack={() => request({ kind: "none" })}
            />
          ) : selection.kind === "new" ? (
            <Editor
              key={`new-${selection.seq}`}
              adapter={adapter}
              mode="new"
              initialScope={selection.scope}
              initialContent={config.data ? adapter.template(config.data) : ""}
              loadingTemplate={config.isLoading}
              templateError={config.error}
              onDirtyChange={setDirty}
              onReplaced={(id) => commit({ kind: "item", id })}
              onDeleted={() => commit({ kind: "none" })}
              onBack={() => request({ kind: "none" })}
            />
          ) : (
            <EmptyState
              icon={adapter.emptyIcon}
              title={`No ${adapter.noun} selected`}
              description={`Pick one on the left to read or edit it, or start a new ${adapter.noun}.`}
              action={
                <Button variant="primary" size="sm" onClick={startNew}>
                  <FilePlus2 aria-hidden="true" />
                  New {adapter.noun}
                </Button>
              }
            />
          )
        }
      />

      {/* Switching away from unsaved edits asks first. Cancel is the focused default. */}
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
        tone="danger"
        title="Discard your unsaved changes?"
        description={`This ${adapter.noun} has edits that have not been saved. Leaving now throws them away.`}
        cancelLabel="Keep editing"
        confirmLabel="Discard changes"
        onConfirm={() => {
          if (pending) commit(pending);
          setPending(null);
        }}
      />
    </Page>
  );
}

/* --- List row -------------------------------------------------------------------------- */

function ListRow({
  item,
  meta,
  selected,
  onSelect,
}: {
  item: DefinitionSummary;
  meta?: React.ReactNode;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "flex w-full cursor-pointer flex-col items-start gap-1 rounded-[var(--radius-md)] px-3 py-2",
          "text-left transition-colors duration-[var(--duration-fast)]",
          selected ? "bg-surface-selected" : "hover:bg-surface-hover",
        )}
      >
        <span className="flex w-full items-center gap-2">
          <span className="truncate text-sm font-medium text-fg">{item.name}</span>
          {!item.valid && (
            <FileWarning className="size-3.5 shrink-0 text-danger-fg" aria-label="Claude Code cannot load this file" />
          )}
          <ScopeBadge scope={item.scope} plugin={item.plugin} className="ml-auto" />
        </span>
        <span className={cn("line-clamp-2 text-xs", item.valid ? "text-fg-muted" : "text-danger-fg")}>
          {item.error ?? (item.description || "No description in the frontmatter.")}
        </span>
        {meta}
      </button>
    </li>
  );
}

/* --- Detail pane: loads the file, then hands it to the editor ------------------------- */

interface PaneHandlers {
  onDirtyChange: (dirty: boolean) => void;
  /** A new file took this one's place — a create, or a copy of a read-only one. */
  onReplaced: (id: string) => void;
  onDeleted: () => void;
  /** Clears the selection. Below `md` only one pane is shown, so this is the way back. */
  onBack: () => void;
}

function DetailPane<TItem extends DefinitionSummary, TDetail extends DefinitionContent>({
  adapter,
  id,
  ...handlers
}: { adapter: DefinitionAdapter<TItem, TDetail>; id: string } & PaneHandlers) {
  const detail = useQuery({ queryKey: adapter.detailKey(id), queryFn: () => adapter.get(id) });

  if (detail.isLoading) return <LoadingState label={`Loading the ${adapter.noun}`} rows={8} className="p-4" />;
  if (detail.error) return <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />;
  if (!detail.data) return null;

  return (
    <Editor
      adapter={adapter}
      mode="edit"
      detail={detail.data}
      initialContent={detail.data.content}
      initialScope="user"
      {...handlers}
    />
  );
}

/* --- Inline validation ----------------------------------------------------------------- */

/**
 * Checks the draft a short beat after typing stops — ux-guidelines No. 56.
 *
 * The debounce is the whole design: per keystroke would be a request per character for no extra
 * information, and on-blur would leave a broken file unmarked for as long as the cursor stays in
 * the box. 400ms is inside the Doherty threshold, so the mark still feels like a response to the
 * typing rather than a later interruption.
 */
const VALIDATE_DEBOUNCE_MS = 400;

function useDraftValidation(content: string, validate: (content: string) => Promise<ValidationResult>) {
  const [fields, setFields] = React.useState<FieldError[]>([]);
  const [checking, setChecking] = React.useState(false);
  // The server being unreachable is not a problem with the draft, so it must not be shown as
  // one. The save path reports it, where it is actually true.
  const [checked, setChecked] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setChecking(true);
    const timer = setTimeout(() => {
      validate(content)
        .then((result) => {
          if (cancelled) return;
          setFields(result.fields);
          setChecked(true);
        })
        .catch(() => undefined)
        .finally(() => !cancelled && setChecking(false));
    }, VALIDATE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [content, validate]);

  return { fields, checking, checked };
}

/** `frontmatter` first: when the `---` block does not parse, every other error is downstream of it. */
function orderFields(fields: FieldError[]): FieldError[] {
  return [...fields].sort((a, b) => Number(b.field === "frontmatter") - Number(a.field === "frontmatter"));
}

/* --- Editor ----------------------------------------------------------------------------- */

interface EditorProps<TItem extends DefinitionSummary, TDetail extends DefinitionContent> extends PaneHandlers {
  adapter: DefinitionAdapter<TItem, TDetail>;
  mode: "new" | "edit";
  detail?: TDetail;
  initialContent: string;
  initialScope: WritableScope;
  loadingTemplate?: boolean;
  templateError?: unknown;
}

function Editor<TItem extends DefinitionSummary, TDetail extends DefinitionContent>({
  adapter,
  mode,
  detail,
  initialContent,
  initialScope,
  loadingTemplate,
  templateError,
  onDirtyChange,
  onReplaced,
  onDeleted,
  onBack,
}: EditorProps<TItem, TDetail>) {
  const queryClient = useQueryClient();
  const editorId = React.useId();
  const errorsId = `${editorId}-errors`;

  const [content, setContent] = React.useState(initialContent);
  const [baseline, setBaseline] = React.useState(initialContent);
  const [scope, setScope] = React.useState<WritableScope>(initialScope);
  const [saved, setSaved] = React.useState<string | null>(null);
  /** The file moved under an unsaved edit. Only this server writes these files, so it is rare. */
  const [clobbered, setClobbered] = React.useState(false);

  // Derived-state reset, the documented way: adjust during render rather than in an effect, so
  // the editor never paints one frame of the previous file.
  const [previous, setPrevious] = React.useState(initialContent);
  if (initialContent !== previous) {
    setPrevious(initialContent);
    setBaseline(initialContent);
    if (content === baseline) setContent(initialContent);
    else setClobbered(true);
  }

  const editable = mode === "new" || (detail?.editable ?? false);
  const dirty = editable && content !== baseline;

  React.useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const { fields: draftFields, checking, checked } = useDraftValidation(content, adapter.validate);

  const save = useMutation({
    mutationFn: () => (mode === "new" ? adapter.create(content, scope) : adapter.update(detail!.id, content)),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: adapter.listKey });
      if (mode === "new") {
        onReplaced((result as { id: string }).id);
        return;
      }
      setBaseline(content);
      setPrevious(content);
      setClobbered(false);
      setSaved(`Saved to ${detail!.name}.`);
      void queryClient.invalidateQueries({ queryKey: adapter.detailKey(detail!.id) });
    },
  });

  const remove = useMutation({
    mutationFn: () => adapter.remove(detail!.id),
    onSuccess: () => {
      // Drop the detail entry rather than invalidating it: invalidating would refetch a file
      // that no longer exists and answer 404, which is a request made only to fail.
      queryClient.removeQueries({ queryKey: adapter.detailKey(detail!.id) });
      void queryClient.invalidateQueries({ queryKey: adapter.listKey });
      onDeleted();
    },
  });

  // The read-only sentence from the server ends "copy it to your user …s to make your own
  // version". This is that sentence made into a button rather than left as advice.
  const copy = useMutation({
    mutationFn: () => adapter.create(content, "user"),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: adapter.listKey });
      onReplaced(result.id);
    },
  });

  // Field errors from a rejected save join the ones from the draft check: a save that loses a
  // race to another editor still lands on the right field.
  const saveFields = isApiError(save.error) ? save.error.fields : [];
  const fields = orderFields(saveFields.length > 0 ? saveFields : draftFields);
  const blocking = checked && fields.length > 0;

  if (loadingTemplate) return <LoadingState label="Loading the template" rows={8} className="p-4" />;
  if (templateError) return <ErrorState title="Could not load the template" error={templateError} />;

  const name = mode === "new" ? `New ${adapter.noun}` : detail!.name;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          {/* Below `md` the list is hidden, so without this the editor is a room with no door. */}
          <Button
            variant="ghost"
            size="icon"
            className="-ml-2 md:hidden"
            aria-label="Back to the list"
            onClick={onBack}
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          <h2 className="truncate text-base font-semibold leading-tight text-fg">{name}</h2>
          {detail ? (
            <ScopeBadge scope={detail.scope} plugin={detail.plugin} />
          ) : (
            <span className="text-xs text-fg-muted">not saved yet</span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {detail && adapter.actions?.(detail)}
          {detail && detail.editable && (
            <ConfirmDialog
              trigger={
                <Button variant="ghost" size="sm" aria-label={`Delete ${detail.name}`}>
                  <Trash2 aria-hidden="true" />
                  Delete
                </Button>
              }
              title={`Delete ${detail.name}?`}
              description={
                <>
                  <p>
                    This removes the {adapter.noun} from disk. It cannot be undone from here — you would have to write
                    the file again.
                  </p>
                  {adapter.deleteWarning && <p className="mt-2">{adapter.deleteWarning}</p>}
                </>
              }
              confirmLabel={`Delete ${adapter.noun}`}
              onConfirm={() => remove.mutate()}
            />
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        {mode === "new" && (
          <div className="flex items-center gap-3">
            <label htmlFor={`${editorId}-scope`} className="text-xs font-medium text-[var(--field-label-fg)]">
              Save to
            </label>
            <Select
              id={`${editorId}-scope`}
              value={scope}
              onChange={(e) => setScope(e.target.value as WritableScope)}
              className="w-56"
            >
              <option value="user">User — ~/.claude, every project</option>
              <option value="project">Project — this project only</option>
            </Select>
          </div>
        )}

        {detail && !detail.editable && detail.readOnlyReason && (
          <ReadOnlyNotice
            reason={detail.readOnlyReason}
            noun={adapter.noun}
            onCopy={() => copy.mutate()}
            copying={copy.isPending}
            copyError={copy.error}
          />
        )}

        {clobbered && (
          <p
            role="status"
            className={cn(
              "rounded-[var(--radius-md)] border border-[var(--notice-fg)] bg-[var(--notice-bg)]",
              "px-3 py-2 text-xs text-[var(--notice-fg)]",
            )}
          >
            This file changed on disk after you started editing. Saving replaces what is there now.
          </p>
        )}

        {save.error && !isApiError(save.error) && (
          <p role="alert" className="rounded-[var(--radius-md)] bg-danger-quiet px-3 py-2 text-sm text-danger-fg">
            {errorMessage(save.error)}
          </p>
        )}
        {isApiError(save.error) && save.error.fields.length === 0 && (
          <p role="alert" className="rounded-[var(--radius-md)] bg-danger-quiet px-3 py-2 text-sm text-danger-fg">
            {errorMessage(save.error)}
          </p>
        )}
        {remove.error && (
          <p role="alert" className="rounded-[var(--radius-md)] bg-danger-quiet px-3 py-2 text-sm text-danger-fg">
            {errorMessage(remove.error)}
          </p>
        )}

        <FieldErrors id={errorsId} fields={fields} />

        <div className="flex shrink-0 items-center justify-between gap-3">
          <label
            htmlFor={editorId}
            className="text-2xs font-medium uppercase tracking-[var(--tracking-wide)] text-fg-muted"
          >
            File contents
          </label>
          {/* Fixed width so the line does not reflow the label as it changes — No. 19. */}
          <span role="status" className="min-w-40 text-right text-2xs text-fg-muted">
            {dirty ? "Unsaved changes" : checking ? "Checking…" : (saved ?? "")}
          </span>
        </div>

        <textarea
          id={editorId}
          value={content}
          readOnly={!editable}
          spellCheck={false}
          onChange={(e) => {
            setContent(e.target.value);
            setSaved(null);
            // A rejected save's field errors outrank the draft check, so they have to be
            // dropped the moment the user starts fixing them — otherwise correcting the field
            // the server complained about leaves Save disabled by a message about the old text.
            if (save.error) save.reset();
          }}
          aria-invalid={blocking || undefined}
          aria-describedby={fields.length > 0 ? errorsId : undefined}
          className={cn(
            "min-h-0 flex-1 resize-none rounded-[var(--radius-md)] border p-[var(--editor-pad)]",
            "bg-[var(--editor-bg)] font-mono text-sm leading-[var(--editor-leading)] text-[var(--editor-fg)]",
            blocking ? "border-[var(--field-error-border)]" : "border-[var(--editor-border)]",
            !editable && "cursor-not-allowed text-fg-muted",
          )}
        />

        {detail && adapter.aside?.(detail)}

        <div className="flex shrink-0 items-center justify-end gap-2">
          {editable && (
            <>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setContent(baseline);
                  setSaved(null);
                }}
                disabled={!dirty}
                disabledReason="There is nothing to undo — the file matches what is on disk."
              >
                <RotateCcw aria-hidden="true" />
                Revert
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => save.mutate()}
                disabled={save.isPending || blocking || (mode === "edit" && !dirty)}
                disabledReason={
                  blocking
                    ? `Fix the ${plural(fields.length, "problem")} above first.`
                    : save.isPending
                      ? "Saving…"
                      : "There are no changes to save."
                }
              >
                {save.isPending ? "Saving…" : mode === "new" ? `Create ${adapter.noun}` : "Save"}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* --- The two explanatory strips --------------------------------------------------------- */

function ReadOnlyNotice({
  reason,
  noun,
  onCopy,
  copying,
  copyError,
}: {
  reason: string;
  noun: string;
  onCopy: () => void;
  copying: boolean;
  copyError: unknown;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-start gap-3 rounded-[var(--radius-md)] border",
        "border-[var(--readonly-border)] bg-[var(--readonly-bg)] px-3 py-2.5",
      )}
    >
      <Lock className="mt-0.5 size-4 shrink-0 text-[var(--readonly-fg)]" aria-hidden="true" />
      {/* A floor on the text column so the button wraps to its own row rather than squeezing
          the explanation into a four-word-wide ribbon at phone width. */}
      <div className="min-w-56 flex-1">
        <p className="text-sm font-medium leading-tight text-fg">Read-only</p>
        {/* The server writes this sentence to be shown; it is rendered as-is rather than
            summarised, so the reason is the plugin's own words and not our paraphrase. */}
        <p className="mt-1 text-xs leading-normal text-[var(--readonly-fg)]">{reason}</p>
        {copyError != null && (
          <p role="alert" className="mt-1 text-xs text-danger-fg">
            {errorMessage(copyError)}
          </p>
        )}
      </div>
      <Button variant="secondary" size="sm" className="max-sm:w-full" onClick={onCopy} disabled={copying}>
        {copying ? "Copying…" : `Copy to my ${noun}s`}
      </Button>
    </div>
  );
}

/**
 * The error summary — ux-guidelines No. 55 and No. 109.
 *
 * One textarea holds the whole file, so there is no per-input slot to hang a message on. The
 * summary is the inline error: it names the field, it is wired to the editor through
 * `aria-describedby`, and it is a live region so a mark appearing while typing is announced
 * rather than only seen.
 */
function FieldErrors({ id, fields }: { id: string; fields: FieldError[] }) {
  if (fields.length === 0) return null;
  return (
    <div
      id={id}
      role="alert"
      className={cn(
        "shrink-0 rounded-[var(--radius-md)] border border-[var(--field-error-border)]",
        "bg-[var(--field-error-bg)] px-3 py-2",
      )}
    >
      <p className="text-xs font-medium text-[var(--field-error-fg)]">
        {plural(fields.length, "problem")} in this file
      </p>
      <ul className="mt-1 flex flex-col gap-1">
        {fields.map((field) => (
          <li key={`${field.field}:${field.message}`} className="text-xs leading-normal text-[var(--field-error-fg)]">
            <code className="font-mono font-medium">{field.field}</code>
            {" — "}
            {field.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
