import { useState } from "react";
import type { PermissionMode } from "../lib/api.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { RadioCard } from "./ui/field.tsx";

/**
 * The per-task permission choice, and the only place in this app that wording lives.
 *
 * The decision it implements (CEO, recorded on T-5 and T-10): the default stays `ask` for
 * everyone, and the unattended case is solved by asking per task instead of by moving the
 * default. So:
 *
 *   1. `ask` is preselected. Nothing pre-checks or nudges towards the dangerous option —
 *      the two cards are the same size, the same weight and in the safe-first order.
 *   2. {@link PERMISSION_HELP} is shown verbatim under the field.
 *   3. Choosing bypass does not commit on the click. It opens a confirmation that names the
 *      directory, and Cancel leaves the choice on `ask`.
 *   4. That confirmation is shown *every time*. It is deliberately not remembered and not
 *      suppressed after a first acceptance (locked on T-6). The sentence describing what
 *      `--dangerously-skip-permissions` does in a real directory is the whole point of the
 *      step; a grant that stops explaining itself stops being read, and what survives is the
 *      pre-checked box this field exists to avoid. Do not add a "don't ask again" affordance.
 *
 * ux-guidelines No. 54 (visible label), No. 55 (help read with the field), No. 35 (confirm
 * before an irreversible grant), No. 31 (the state of the choice is never implied by colour).
 */

/** The CEO's wording, verbatim. Do not paraphrase it — the decision names this sentence. */
export const PERMISSION_HELP =
  "Background tasks cannot answer permission prompts. Choose bypass only for a directory you trust.";

export interface PermissionModeFieldProps {
  value: PermissionMode;
  onChange: (mode: PermissionMode) => void;
  /** Named in the confirmation, so the grant is bounded to somewhere the user recognises. */
  cwd: string;
  /** Distinguishes the radio group when more than one form is mounted. */
  name?: string;
}

export function PermissionModeField({ value, onChange, cwd, name = "permission-mode" }: PermissionModeFieldProps) {
  const [confirming, setConfirming] = useState(false);

  return (
    <fieldset className="flex min-w-0 flex-col gap-2">
      <legend className="text-xs font-medium text-[var(--field-label-fg)]">Permission mode</legend>
      <p id={`${name}-help`} className="text-xs leading-normal text-[var(--field-help-fg)]">
        {PERMISSION_HELP}
      </p>
      <div className="flex flex-col gap-2">
        <RadioCard
          name={name}
          aria-describedby={`${name}-help`}
          checked={value === "ask"}
          onChange={() => onChange("ask")}
          label="Ask before each tool"
          description="The task parks and waits for you the first time it needs permission. It keeps its slot in the queue while it waits."
        />
        <RadioCard
          name={name}
          aria-describedby={`${name}-help`}
          checked={value === "bypassPermissions"}
          // The change is proposed, not applied: the confirmation below commits it.
          onChange={() => setConfirming(true)}
          label="Bypass permission prompts"
          description="The task runs tools without asking, so it can finish with nobody watching."
        />
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Let this task use tools without asking?"
        description={
          <>
            <p>
              The agent will run commands, edit files and use tools in{" "}
              <span className="font-mono text-xs text-fg">{cwd || "the working directory"}</span> without stopping to
              ask you first. That includes deleting and overwriting files, with your user account and your permissions.
            </p>
            <p className="mt-2">
              Choose this only for a directory you trust. Everything else should stay on “Ask before each tool”.
            </p>
          </>
        }
        cancelLabel="Keep asking me"
        confirmLabel="Bypass permission prompts"
        onConfirm={() => onChange("bypassPermissions")}
      />
    </fieldset>
  );
}
