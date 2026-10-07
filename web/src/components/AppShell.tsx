import { Outlet } from "react-router-dom";
import { ConnectionContext, useEventStreamConnection } from "../hooks/useEventStream.ts";
import { Sidebar } from "./Sidebar.tsx";
import { StatusBar } from "./StatusBar.tsx";

/**
 * Sidebar · content · status bar.
 *
 * The one SSE connection for the app is opened here and published on a context, so every
 * screen and the status bar read the same connection rather than each opening their own.
 *
 * `h-dvh` with `min-h-0` on the scrolling child is deliberate: the status bar must stay pinned
 * at the bottom of the viewport on every screen, which means the content area scrolls, not
 * the page.
 */
export function AppShell() {
  const connection = useEventStreamConnection();

  return (
    <ConnectionContext.Provider value={connection}>
      <div className="flex h-dvh flex-col overflow-hidden bg-bg text-fg">
        <a href="#main" className="skip-link rounded-md bg-surface-raised px-3 py-2 text-sm text-fg">
          Skip to content
        </a>
        <div className="flex min-h-0 flex-1">
          <Sidebar />
          <main id="main" tabIndex={-1} className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <Outlet />
          </main>
        </div>
        <StatusBar />
      </div>
    </ConnectionContext.Provider>
  );
}
