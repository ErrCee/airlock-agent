import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../src/index.css";

interface TabItem {
  id: number;
  title: string;
  url: string;
  selected: boolean;
}

function PopupApp() {
  const [tabs, setTabs] = useState<TabItem[]>([]);
  const [query, setQuery] = useState(
    "Cross-reference these private tabs, flag contradictions or root causes, and propose a concrete fix."
  );
  const [warmNote, setWarmNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    chrome.tabs
      .query({ currentWindow: true })
      .then((list) => {
        const inspectable: TabItem[] = list
          .filter(
            (t): t is chrome.tabs.Tab & { id: number; url: string } =>
              typeof t.id === "number" &&
              typeof t.url === "string" &&
              !t.url.startsWith("chrome://") &&
              !t.url.startsWith("chrome-extension://")
          )
          .map((t) => ({
            id: t.id,
            title: t.title || t.url,
            url: t.url,
            selected: true,
          }));
        setTabs(inspectable);
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err))
      );
  }, []);

  function toggleTab(id: number) {
    setTabs((prev) =>
      prev.map((t) => (t.id === id ? { ...t, selected: !t.selected } : t))
    );
  }

  async function handleWarmUpNano() {
    setError(null);
    setWarmNote("Probing Chrome Prompt API...");
    try {
      const lm = (window as unknown as {
        LanguageModel?: {
          create: (opts: Record<string, unknown>) => Promise<{ destroy?: () => void }>;
        };
      }).LanguageModel;

      if (!lm) {
        throw new Error(
          "window.LanguageModel unavailable. Use Google Chrome v139+ with Prompt API enabled."
        );
      }

      const session = await lm.create({
        expectedInputs: [{ type: "text" }],
        monitor(m: EventTarget) {
          m.addEventListener("downloadprogress", (e: Event) => {
            const loaded = (e as unknown as { loaded?: number }).loaded ?? 0;
            setWarmNote(`Downloading Nano 4: ${Math.round(loaded * 100)}%`);
          });
        },
      });
      session.destroy?.();
      setWarmNote("Gemini Nano 4 ready locally.");
    } catch (err: unknown) {
      setWarmNote(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleLaunchWorkspace() {
    const selectedIds = tabs.filter((t) => t.selected).map((t) => t.id);
    if (selectedIds.length === 0) {
      setError("Select at least one open tab.");
      return;
    }

    await chrome.storage.session.set({
      airlock_launch: {
        tabIds: selectedIds,
        query: query.trim(),
        launchedAt: Date.now(),
      },
    });

    await chrome.tabs.create({
      url: chrome.runtime.getURL("extension/workspace.html"),
    });
    window.close();
  }

  const selectedCount = tabs.filter((t) => t.selected).length;

  return (
    <div className="p-4 space-y-3.5 text-xs font-sans">
      <div className="border-b border-slate-800 pb-2.5">
        <h1 className="text-sm font-bold text-white">Airlock Agent</h1>
        <p className="text-[11px] text-slate-400">
          Select open private/localhost tabs to mount behind the local Nano 4
          privacy airlock.
        </p>
      </div>

      {error && (
        <div className="rounded border border-red-500/50 bg-red-950/60 p-2 font-mono text-[11px] text-red-200">
          {error}
        </div>
      )}

      {warmNote && (
        <div className="rounded border border-emerald-500/40 bg-emerald-950/40 p-2 font-mono text-[11px] text-emerald-200">
          {warmNote}
        </div>
      )}

      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-[11px] font-semibold text-slate-400">
          <span>Inspectable Tabs ({selectedCount}/{tabs.length})</span>
          <button
            type="button"
            onClick={() =>
              setTabs((prev) =>
                prev.map((t) => ({ ...t, selected: selectedCount < prev.length }))
              )
            }
            className="text-emerald-400 hover:underline"
          >
            {selectedCount < tabs.length ? "Select All" : "Deselect All"}
          </button>
        </div>

        <div className="max-h-44 overflow-y-auto space-y-1 rounded-lg border border-slate-800 bg-slate-900 p-2">
          {tabs.length === 0 ? (
            <p className="text-slate-500 p-2 text-center">
              No inspectable web or localhost tabs found in this window.
            </p>
          ) : (
            tabs.map((tab) => (
              <label
                key={tab.id}
                className="flex items-start gap-2 rounded p-1.5 hover:bg-slate-800 cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={tab.selected}
                  onChange={() => toggleTab(tab.id)}
                  className="mt-0.5"
                />
                <div className="min-w-0">
                  <div className="truncate font-medium text-slate-100">
                    {tab.title}
                  </div>
                  <div className="truncate font-mono text-[10px] text-slate-500">
                    {tab.url}
                  </div>
                </div>
              </label>
            ))
          )}
        </div>
      </div>

      <div>
        <label className="mb-1 block text-[11px] font-semibold text-slate-400">
          Objective
        </label>
        <textarea
          rows={2}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full rounded border border-slate-700 bg-slate-900 p-2 text-xs text-slate-100"
        />
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={handleWarmUpNano}
          className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-[11px] font-semibold text-slate-200 hover:bg-slate-800"
        >
          Warm Nano 4
        </button>
        <button
          type="button"
          disabled={selectedCount === 0}
          onClick={handleLaunchWorkspace}
          className="flex-1 rounded-lg bg-emerald-600 py-2 font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
        >
          Open Airlock Workspace ({selectedCount})
        </button>
      </div>
    </div>
  );
}

createRoot(document.getElementById("popup-root")!).render(
  <StrictMode>
    <PopupApp />
  </StrictMode>
);
