import { useCallback, useEffect, useState } from "react";
import type { AppSettings } from "../../shared/types";

export type UpdateSettings = (patch: Partial<AppSettings> | ((current: AppSettings) => AppSettings)) => void;

export function useLocalPreferences(): { settings: AppSettings; updateSettings: UpdateSettings; loaded: boolean } {
  const [settings, setSettings] = useState<AppSettings>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    window.hl.getSettings().then((stored) => {
      if (!active) return;
      setSettings(stored);
      setLoaded(true);
    });
    return () => {
      active = false;
    };
  }, []);

  const updateSettings = useCallback<UpdateSettings>((patch) => {
    setSettings((current) => {
      const next = typeof patch === "function" ? patch(current) : mergeSettings(current, patch);
      void window.hl.saveSettings(next);
      return next;
    });
  }, []);

  return { settings, updateSettings, loaded };
}

function mergeSettings(current: AppSettings, patch: Partial<AppSettings>): AppSettings {
  return {
    ...current,
    ...patch,
    commenter: patch.commenter ? { ...current.commenter, ...patch.commenter } : current.commenter
  };
}
