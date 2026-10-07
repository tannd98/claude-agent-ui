import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { Button } from "./ui/button.tsx";

describe("ConfirmDialog", () => {
  function setup(onConfirm = vi.fn()) {
    render(
      <ConfirmDialog
        trigger={<Button variant="danger">Delete run</Button>}
        title="Delete this run?"
        description="The run record and its transcript reference are removed. The session itself is not deleted."
        confirmLabel="Delete run"
        onConfirm={onConfirm}
      />,
    );
    return { onConfirm, user: userEvent.setup() };
  }

  it("confirms only when the user says so", async () => {
    const { onConfirm, user } = setup();

    await user.click(screen.getByRole("button", { name: "Delete run" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Delete this run?");
    expect(onConfirm).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("puts initial focus on Cancel so a stray Enter does not destroy anything", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Delete run" }));
    await screen.findByRole("alertdialog");

    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("returns focus to the trigger when dismissed with Escape", async () => {
    const { onConfirm, user } = setup();
    const trigger = screen.getByRole("button", { name: "Delete run" });

    await user.click(trigger);
    await screen.findByRole("alertdialog");
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("runs the action when confirmed", async () => {
    const { onConfirm, user } = setup();
    await user.click(screen.getByRole("button", { name: "Delete run" }));
    const dialog = await screen.findByRole("alertdialog");

    await user.click(within(dialog).getByRole("button", { name: "Delete run" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
