import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Sparkles } from "lucide-react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import {
  DefinitionWorkbench,
  type DefinitionAdapter,
  type DefinitionContent,
  type DefinitionSummary,
} from "./DefinitionWorkbench.tsx";
import type { AppConfig, ValidationResult } from "../lib/api.ts";

/**
 * The screen Agents and Skills share, driven through a fake adapter.
 *
 * The adapter is the seam: these tests never touch fetch, so what is being checked is the
 * screen's behaviour — the field a bad draft names, whether Save is reachable, what a read-only
 * file says and whether a delete can happen without a confirmation — and not the wire format,
 * which the server's own tests own.
 */

const CONFIG: AppConfig = {
  defaultCwd: "/work",
  starterPrompt: "Start your task.",
  permissionMode: "ask",
  templates: {
    agent: "---\nname: my-agent\ndescription: x\n---\n",
    skill: "---\nname: my-skill\ndescription: x\n---\n",
  },
};

vi.mock("../lib/api.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api.ts")>()),
  getConfig: () => Promise.resolve(CONFIG),
}));

const EDITABLE: DefinitionSummary = {
  id: "s1",
  name: "writing-style",
  description: "House style for prose that ships.",
  scope: "user",
  plugin: null,
  editable: true,
  readOnlyReason: null,
  valid: true,
  error: null,
};

const PLUGIN_READ_ONLY: DefinitionSummary = {
  id: "s2",
  name: "incident-drill",
  description: "Walks an on-call engineer through a practice incident.",
  scope: "plugin",
  plugin: "demo-pack",
  editable: false,
  readOnlyReason:
    "This skill belongs to the demo-pack plugin, which owns the file. Copy it to your user skills to make your own version.",
  valid: true,
  error: null,
};

const BODY = (name: string) => `---\nname: ${name}\ndescription: Something.\n---\n\n# ${name}\n`;

interface Fakes {
  update: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  validate: ReturnType<typeof vi.fn>;
}

function setup(options: { items?: DefinitionSummary[]; invalidFields?: ValidationResult["fields"] } = {}) {
  const items = options.items ?? [EDITABLE, PLUGIN_READ_ONLY];
  const fakes: Fakes = {
    update: vi.fn(() => Promise.resolve({ id: "s1" })),
    remove: vi.fn(() => Promise.resolve({ id: "s1" })),
    create: vi.fn(() => Promise.resolve({ id: "s3", scope: "user" as const })),
    // The fake server: the starting file is fine, anything the test types back is judged by
    // `invalidFields`, which is how "as you type" is exercised without a network.
    validate: vi.fn((content: string) =>
      Promise.resolve<ValidationResult>(
        content.includes("BROKEN")
          ? { valid: false, fields: options.invalidFields ?? [] }
          : { valid: true, fields: [] },
      ),
    ),
  };

  const adapter: DefinitionAdapter<DefinitionSummary, DefinitionContent> = {
    kind: "skill",
    title: "Skills",
    pageDescription: "Skills discovered on disk",
    noun: "skill",
    emptyIcon: Sparkles,
    emptyDescription: "Nothing on disk yet.",
    deleteWarning: "The whole folder goes.",
    listKey: ["skills"],
    detailKey: (id) => ["skills", id],
    list: () => Promise.resolve(items),
    get: (id) => {
      const item = items.find((i) => i.id === id)!;
      return Promise.resolve({ ...item, content: BODY(item.name) });
    },
    create: fakes.create,
    update: fakes.update,
    remove: fakes.remove,
    validate: fakes.validate,
    template: (config) => config.templates.skill,
  };

  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <DefinitionWorkbench adapter={adapter} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { ...fakes, user: userEvent.setup() };
}

/** Opens a file in the editor and returns the textarea. */
async function open(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole("button", { name: new RegExp(name) }));
  return await screen.findByLabelText("File contents");
}

describe("DefinitionWorkbench", () => {
  it("marks the scope of every file in the list", async () => {
    setup();
    const list = await screen.findByRole("region", { name: "Skills" });
    expect(await within(list).findByText("User")).toBeInTheDocument();
    expect(within(list).getByText("demo-pack plugin")).toBeInTheDocument();
  });

  it("names the bad field while the user is still typing, and will not save until it is fixed", async () => {
    const { user, update, validate } = setup({
      invalidFields: [
        { field: "name", message: "`name` must match ^[a-z0-9][a-z0-9-]*$ (lowercase letters, digits, dashes)" },
      ],
    });

    const editor = await open(user, "writing-style");
    await user.clear(editor);
    await user.type(editor, "BROKEN");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("name");
    expect(alert).toHaveTextContent("must match");
    // The error is tied to the editor, not merely near it.
    expect(editor).toHaveAttribute("aria-describedby", alert.id);
    expect(editor).toHaveAttribute("aria-invalid", "true");

    const saveButton = screen.getByRole("button", { name: "Save" });
    expect(saveButton).toBeDisabled();
    // A disabled control says why — never a dead end.
    expect(saveButton).toHaveAttribute("title", "Fix the 1 problem above first.");
    expect(update).not.toHaveBeenCalled();
    expect(validate).toHaveBeenCalled();
  });

  it("saves a valid edit through the adapter", async () => {
    const { user, update } = setup();

    const editor = await open(user, "writing-style");
    await user.type(editor, "\nOne more line.\n");

    const saveButton = await screen.findByRole("button", { name: "Save" });
    await waitFor(() => expect(saveButton).toBeEnabled());
    await user.click(saveButton);

    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(update.mock.calls[0][1]).toContain("One more line.");
  });

  it("will not delete without a confirmation", async () => {
    const { user, remove } = setup();
    await open(user, "writing-style");

    await user.click(screen.getByRole("button", { name: "Delete writing-style" }));
    const dialog = await screen.findByRole("alertdialog");
    // The confirmation names what actually goes, which for a skill is more than one file.
    expect(dialog).toHaveTextContent("The whole folder goes.");
    expect(remove).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(remove).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Delete writing-style" }));
    await screen.findByRole("alertdialog");
    await user.click(screen.getByRole("button", { name: "Delete skill" }));
    await waitFor(() => expect(remove).toHaveBeenCalledOnce());
  });

  it("explains a plugin file rather than only disabling it", async () => {
    const { user } = setup();
    const editor = await open(user, "incident-drill");

    expect(editor).toHaveAttribute("readonly");
    expect(screen.getByText(PLUGIN_READ_ONLY.readOnlyReason!)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Delete/ })).not.toBeInTheDocument();
    // The sentence tells the user to copy it; the screen makes that an action.
    expect(screen.getByRole("button", { name: "Copy to my skills" })).toBeInTheDocument();
  });

  it("asks before throwing away unsaved edits", async () => {
    const { user } = setup();
    const editor = await open(user, "writing-style");
    await user.type(editor, "edited");

    await user.click(screen.getByRole("button", { name: /incident-drill/ }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Discard your unsaved changes?");
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    // Still on the file that has the edits.
    expect(await screen.findByRole("heading", { level: 2, name: "writing-style" })).toBeInTheDocument();
  });

  it("creates a new file from the template, in the scope the user picked", async () => {
    const { user, create } = setup();

    // Two offer it: the page header, and the empty right-hand pane. Either starts the same draft.
    await user.click((await screen.findAllByRole("button", { name: "New skill" }))[0]);
    const editor = await screen.findByLabelText("File contents");
    await waitFor(() => expect(editor).toHaveValue(CONFIG.templates.skill));

    await user.selectOptions(screen.getByLabelText("Save to"), "project");
    await user.click(screen.getByRole("button", { name: "Create skill" }));

    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create.mock.calls[0][1]).toBe("project");
  });

  it("offers something to do when there is nothing on disk", async () => {
    setup({ items: [] });
    expect(await screen.findByText("No skills found")).toBeInTheDocument();
    expect(screen.getByText("Nothing on disk yet.")).toBeInTheDocument();
  });
});
