import { useState } from "react";
import { AppShell, type PrimaryTab } from "./components/AppShell";
import { useLocalPreferences } from "./hooks/useLocalPreferences";
import { Commenter } from "./commenter/Commenter";
import { Preflight } from "./preflight/Preflight";

export default function App() {
  const [tab, setTab] = useState<PrimaryTab>("commenter");
  const { settings, updateSettings, loaded } = useLocalPreferences();

  return (
    <AppShell tab={tab} onTabChange={setTab}>
      {tab === "commenter" ? (
        <Commenter settings={settings} updateSettings={updateSettings} loaded={loaded} />
      ) : (
        <Preflight settings={settings} updateSettings={updateSettings} loaded={loaded} />
      )}
    </AppShell>
  );
}
