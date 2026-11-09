import "@fontsource-variable/geist/wght.css";
import "@fontsource-variable/geist-mono/wght.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/ui.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { Layout } from "./components/Layout";
import { Loading } from "./components/States";
import { HomePage } from "./pages/HomePage";
import { RunPage } from "./pages/RunPage";
import { RunsPage } from "./pages/RunsPage";
import { NotFoundPage, PageError } from "./pages/SimplePages";

// The wallet and chain pages load their code (wagmi, viem) only when opened.
const router = createBrowserRouter([
  {
    element: <Layout />,
    // Shown while a lazy page loads on a direct visit (before the layout can render).
    hydrateFallbackElement: <Loading label="Loading…" />,
    errorElement: <PageError />,
    children: [
      {
        // Inside the layout, so that a failing page keeps the header and the footer.
        errorElement: <PageError />,
        children: [
      { path: "/", element: <HomePage /> },
      { path: "/runs", element: <RunsPage /> },
      { path: "/run/:runId", element: <RunPage /> },
      { path: "/new", lazy: () => import("./pages/NewRunPage").then((m) => ({ Component: m.NewRunPage })) },
      { path: "/oracle", lazy: () => import("./pages/OraclePage").then((m) => ({ Component: m.OraclePage })) },
      { path: "/dryrun", lazy: () => import("./pages/DryRunPage").then((m) => ({ Component: m.DryRunPage })) },
      { path: "/dryrun/:runId", lazy: () => import("./pages/DryRunReportPage").then((m) => ({ Component: m.DryRunReportPage })) },
      { path: "/clone", lazy: () => import("./pages/ClonePage").then((m) => ({ Component: m.ClonePage })) },
      { path: "/rewind", lazy: () => import("./pages/RewindPage").then((m) => ({ Component: m.RewindPage })) },
      { path: "/calibration", lazy: () => import("./pages/CalibrationPage").then((m) => ({ Component: m.CalibrationPage })) },
      { path: "/docs", lazy: () => import("./pages/DocsPage").then((m) => ({ Component: m.DocsPage })) },
      { path: "/account", lazy: () => import("./pages/AccountPage").then((m) => ({ Component: m.AccountPage })) },
      { path: "/admin", lazy: () => import("./pages/AdminPage").then((m) => ({ Component: m.AdminPage })) },
      { path: "/trust", lazy: () => import("./pages/TrustPage").then((m) => ({ Component: m.TrustPage })) },
      { path: "/token", lazy: () => import("./pages/TokenPage").then((m) => ({ Component: m.TokenPage })) },
      { path: "/check/:address?", lazy: () => import("./pages/CheckPage").then((m) => ({ Component: m.CheckPage })) },
      { path: "/tools", lazy: () => import("./pages/tools/ToolsPage").then((m) => ({ Component: m.ToolsPage })) },
      { path: "/tools/swap", lazy: () => import("./pages/tools/SwapTool").then((m) => ({ Component: m.SwapTool })) },
      { path: "/tools/impermanent-loss", lazy: () => import("./pages/tools/ImpermanentLossTool").then((m) => ({ Component: m.ImpermanentLossTool })) },
      { path: "/tools/market-cap", lazy: () => import("./pages/tools/MarketCapTool").then((m) => ({ Component: m.MarketCapTool })) },
      { path: "/tools/units", lazy: () => import("./pages/tools/UnitsTool").then((m) => ({ Component: m.UnitsTool })) },
      { path: "/tools/quiz", lazy: () => import("./pages/tools/QuizTool").then((m) => ({ Component: m.QuizTool })) },
      { path: "/tools/checklist", lazy: () => import("./pages/tools/ChecklistTool").then((m) => ({ Component: m.ChecklistTool })) },
      { path: "/tools/glossary", lazy: () => import("./pages/tools/GlossaryTool").then((m) => ({ Component: m.GlossaryTool })) },
      { path: "*", element: <NotFoundPage /> },
        ],
      },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
