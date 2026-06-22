import type { ReactNode } from "react";

export type PrimaryTab = "commenter" | "preflight";

export function AppShell({
  tab,
  onTabChange,
  children
}: {
  tab: PrimaryTab;
  onTabChange: (tab: PrimaryTab) => void;
  children: ReactNode;
}) {
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <img src="./brand/hl-logo-horizontal.svg" alt="Houlihan Lokey" className="brand-logo" />
          <div>
            <h1>HL Intelligence</h1>
            <p>Processed locally. No documents are uploaded by HL Intelligence.</p>
          </div>
        </div>
        <nav className="tabs" aria-label="Primary">
          <button className={tab === "commenter" ? "active" : ""} onClick={() => onTabChange("commenter")}>
            Commenter
          </button>
          <button className={tab === "preflight" ? "active" : ""} onClick={() => onTabChange("preflight")}>
            LLM Preflight
          </button>
        </nav>
      </header>
      <main>{children}</main>
    </div>
  );
}
