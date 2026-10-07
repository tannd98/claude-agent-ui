import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { Dialog, DialogPanel } from "./dialog.tsx";

/**
 * Where focus goes when the dialog closes.
 *
 * Radix restores focus to a `<Dialog.Trigger>` and to nothing else. Every dialog in this app is
 * opened from state instead — a row's Edit button, a page's New button — so without the handler
 * in DialogPanel a keyboard user who presses Escape is dropped on `<body>` and has to tab from
 * the top of the document back to where they were. It looks fine in a screenshot and it is
 * unusable without a mouse, which is exactly the kind of regression worth a test.
 */

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Edit the thing
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPanel title="Edit the thing" description="A form, opened from state rather than a Trigger.">
          <label>
            Name
            <input />
          </label>
        </DialogPanel>
      </Dialog>
    </>
  );
}

describe("DialogPanel", () => {
  it("gives focus back to whatever opened it, which is never a Radix Trigger here", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const opener = screen.getByRole("button", { name: "Edit the thing" });
    opener.focus();
    await user.click(opener);

    const dialog = await screen.findByRole("dialog");
    // The trap has focus somewhere inside; which element is Radix's business, not ours.
    expect(dialog.contains(document.activeElement)).toBe(true);

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(opener).toHaveFocus();
  });
});
