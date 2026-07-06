import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import {
  Outlet, RouterProvider, createRootRoute, createRoute, createRouter,
} from "@tanstack/react-router";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { KrakenMark } from "./components";
import { CampaignPage, ChatPage, Composer, DecisionsPage, HomePage, NewPage, RunPage, Sidebar } from "./pages";
import "./index.css";
import "highlight.js/styles/github.css";
import "./styles.css";

/** App shell: sessions sidebar → run spine → docked composer. No dashboard. */
function Layout() {
  const qc = useQueryClient();
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onmessage = () => {
      qc.invalidateQueries({ queryKey: ["state"] });
      qc.invalidateQueries({ queryKey: ["chat"] });
    };
    return () => es.close();
  }, [qc]);
  const [navOpen, setNavOpen] = useState(false);
  return (
    <div className="app">
      <div className="mobile-topbar">
        <button className="hamburger" aria-label="Sessions" onClick={() => setNavOpen(true)}>
          <svg width="18" height="18" viewBox="0 0 18 18"><path d="M2 4.5h14M2 9h14M2 13.5h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        </button>
        <KrakenMark size={18} />
        <span className="wordmark">Kraken</span>
      </div>
      <div className={`nav-backdrop ${navOpen ? "show" : ""}`} onClick={() => setNavOpen(false)} />
      <Sidebar open={navOpen} onNavigate={() => setNavOpen(false)} />
      <main className="spine">
        <div className="spine-scroll"><Outlet /></div>
        <Composer />
      </main>
    </div>
  );
}

const rootRoute = createRootRoute({ component: Layout });
const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: HomePage });
const runRoute = createRoute({ getParentRoute: () => rootRoute, path: "/run/$runId", component: RunPage });
const newRoute = createRoute({ getParentRoute: () => rootRoute, path: "/new", component: NewPage, validateSearch: (s: Record<string, unknown>) => ({ repo: typeof s.repo === "string" ? s.repo : undefined }) });
const chatRoute = createRoute({ getParentRoute: () => rootRoute, path: "/chat", component: ChatPage, validateSearch: (s: Record<string, unknown>) => ({ repo: typeof s.repo === "string" ? s.repo : "" }) });
const campaignRoute = createRoute({ getParentRoute: () => rootRoute, path: "/campaign", component: CampaignPage, validateSearch: (s: Record<string, unknown>) => ({ id: typeof s.id === "string" ? s.id : "" }) });
const decisionsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/decisions", component: DecisionsPage });
const router = createRouter({ routeTree: rootRoute.addChildren([homeRoute, runRoute, newRoute, chatRoute, campaignRoute, decisionsRoute]) });

declare module "@tanstack/react-router" {
  interface Register { router: typeof router; }
}

const queryClient = new QueryClient();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
