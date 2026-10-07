import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ThemeContext } from "../hooks/themeContext.ts";
import { useTheme } from "../hooks/useTheme.ts";
import { NAV_AREAS, Sidebar } from "./Sidebar.tsx";

function Harness({ initial = "/agents" }: { initial?: string }) {
  const theme = useTheme();
  return (
    <ThemeContext.Provider value={theme}>
      <MemoryRouter initialEntries={[initial]}>
        <Sidebar />
        <Routes>
          {NAV_AREAS.map((area) => (
            <Route key={area.to} path={area.to} element={<h1>{area.label} screen</h1>} />
          ))}
        </Routes>
      </MemoryRouter>
    </ThemeContext.Provider>
  );
}

describe("Sidebar", () => {
  it("offers the four areas the plan fixed, in order", () => {
    render(<Harness />);
    const links = within(screen.getByRole("navigation", { name: "Main" })).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["Agents", "Skills", "Tasks", "Schedule"]);
  });

  it("is navigable with the keyboard alone", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    // Tab from the document start: Agents is the first focusable thing in the nav.
    await user.tab();
    expect(screen.getByRole("link", { name: "Agents" })).toHaveFocus();

    await user.tab();
    await user.tab();
    const tasks = screen.getByRole("link", { name: "Tasks" });
    expect(tasks).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(screen.getByRole("heading", { name: "Tasks screen" })).toBeInTheDocument();
  });

  it("marks the current area so a stranger can tell where they are", () => {
    render(<Harness initial="/schedule" />);
    expect(screen.getByRole("link", { name: "Schedule" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Agents" })).not.toHaveAttribute("aria-current");
  });

  it("exposes all three theme choices, not a two-state toggle", () => {
    render(<Harness />);
    const group = screen.getByRole("radiogroup", { name: "Colour theme" });
    expect(within(group).getAllByRole("radio")).toHaveLength(3);
    // Default preference follows the OS.
    expect(within(group).getByRole("radio", { name: /^System/ })).toBeChecked();
  });
});
