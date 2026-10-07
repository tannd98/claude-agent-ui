import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NewTaskDialog } from "./NewTaskDialog.tsx";

/**
 * The permission opt-in is the one control in this app with a real blast radius, so its
 * behaviour is pinned rather than left to a reviewer's eye: `ask` preselected whatever the
 * server's configured default says, never nudged, and never committed until the explanation
 * has actually been read.
 */

const AGENTS = [
  { id: "a1", name: "release-notes", runName: "release-notes", valid: true },
  { id: "a2", name: "broken-agent", runName: "broken-agent", valid: false },
];

const CONFIG = {
  defaultCwd: "/home/sam/code/acme-web",
  starterPrompt: "Summarise what changed.",
  // The server returns a configured permission mode; the task form must ignore it. A queued
  // task has nobody there to answer, so it never inherits a global bypass.
  permissionMode: "bypassPermissions",
};

function mockFetch(onCreate?: (body: unknown) => void) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/agents") return json(AGENTS);
    if (url === "/api/config") return json(CONFIG);
    if (url === "/api/tasks" && init?.method === "POST") {
      onCreate?.(JSON.parse(String(init.body)));
      return json({ id: "t-new", title: "Created" }, 201);
    }
    throw new Error(`unexpected request: ${url}`);
  });
}

const json = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

function setup(onCreate?: (body: unknown) => void) {
  const fetchMock = mockFetch(onCreate);
  vi.stubGlobal("fetch", fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <NewTaskDialog open onOpenChange={() => {}} onCreated={() => {}} />
    </QueryClientProvider>,
  );
  return { user: userEvent.setup() };
}

/**
 * The permission control is the shared PermissionModeField, not a second implementation — the
 * wording in it is the one sentence the CEO's decision names verbatim. These tests assert the
 * behaviour this dialog is responsible for: that `ask` wins regardless of what the server's
 * configured mode says, and that what crosses the wire is the one accepted literal.
 */
const askOption = (opts?: { hidden?: boolean }) => screen.getByRole("radio", { name: /Ask before each tool/, ...opts });
const bypassOption = (opts?: { hidden?: boolean }) =>
  screen.getByRole("radio", { name: /Bypass permission prompts/, ...opts });

describe("NewTaskDialog — the permission opt-in", () => {
  it("preselects ask even when the server's configured mode is a bypass", async () => {
    setup();
    await screen.findByRole("option", { name: "release-notes" });

    expect(askOption()).toBeChecked();
    expect(bypassOption()).not.toBeChecked();
  });

  it("does not commit until the explanation has been read", async () => {
    const { user } = setup();
    await screen.findByRole("option", { name: "release-notes" });

    await user.click(bypassOption());

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Let this task use tools without asking?");
    // Names the real directory, so the decision is about this task rather than a setting.
    expect(dialog).toHaveTextContent("/home/sam/code/acme-web");
    // Still on `ask` while the question is open. Queried with `hidden` because Radix aria-hides
    // the form behind the alert — the control is in the DOM, outside the accessibility tree.
    expect(askOption({ hidden: true })).toBeChecked();
  });

  it("stays on ask when the user keeps asking", async () => {
    const { user } = setup();
    await screen.findByRole("option", { name: "release-notes" });

    await user.click(bypassOption());
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Keep asking me" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(askOption()).toBeChecked();
    expect(bypassOption()).not.toBeChecked();
  });

  it("focuses the safe option, so a stray Enter cannot turn it on", async () => {
    const { user } = setup();
    await screen.findByRole("option", { name: "release-notes" });

    await user.click(bypassOption());
    await screen.findByRole("alertdialog");

    expect(screen.getByRole("button", { name: "Keep asking me" })).toHaveFocus();
  });

  it("switches only after an explicit confirmation", async () => {
    const { user } = setup();
    await screen.findByRole("option", { name: "release-notes" });

    await user.click(bypassOption());
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Bypass permission prompts" }));

    await waitFor(() => expect(bypassOption()).toBeChecked());
    expect(askOption()).not.toBeChecked();
  });

  it("sends the one accepted literal, never an alias", async () => {
    const bodies: unknown[] = [];
    const { user } = setup((body) => bodies.push(body));
    await screen.findByRole("option", { name: "release-notes" });

    await user.selectOptions(screen.getByLabelText("Agent"), "a1");
    await user.click(bypassOption());
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Bypass permission prompts" }),
    );
    await waitFor(() => expect(bypassOption()).toBeChecked());
    await user.click(screen.getByRole("button", { name: "Add to queue" }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ agentId: "a1", permissionMode: "bypassPermissions", unattended: true });
  });

  it("defaults to ask when the user never touches it", async () => {
    const bodies: unknown[] = [];
    const { user } = setup((body) => bodies.push(body));
    await screen.findByRole("option", { name: "release-notes" });

    await user.selectOptions(screen.getByLabelText("Agent"), "a1");
    await user.click(screen.getByRole("button", { name: "Add to queue" }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ permissionMode: "ask" });
  });
});

describe("NewTaskDialog — the rest of the form", () => {
  it("keeps unattended and the permission mode as two separate controls", async () => {
    setup();
    await screen.findByRole("option", { name: "release-notes" });

    const unattended = screen.getByRole("switch", { name: "Run unattended" });
    expect(unattended).toBeChecked();
    // Two controls, two roles, two concerns. The helper says what unattended does — questions —
    // and never claims it covers tool permissions.
    expect(screen.getByText(/will not stop to ask you questions/)).toBeInTheDocument();
    expect(askOption()).toBeChecked();
  });

  it("shows the configured defaults filled in rather than applying them after submit", async () => {
    setup();
    await screen.findByRole("option", { name: "release-notes" });

    await waitFor(() => expect(screen.getByLabelText("Working directory")).toHaveValue("/home/sam/code/acme-web"));
    expect(screen.getByLabelText("Prompt")).toHaveValue("Summarise what changed.");
  });

  it("offers no agent whose frontmatter does not parse", async () => {
    setup();
    await screen.findByRole("option", { name: "release-notes" });

    expect(screen.queryByRole("option", { name: "broken-agent" })).not.toBeInTheDocument();
  });

  it("says why submitting is unavailable instead of being a dead end", async () => {
    setup();
    await screen.findByRole("option", { name: "release-notes" });

    const submit = screen.getByRole("button", { name: "Add to queue" });
    expect(submit).toBeDisabled();
    expect(submit).toHaveAttribute("title", "Choose an agent first.");
  });
});
