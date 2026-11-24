import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../src/index.css";
import { AirlockWorkspace } from "../src/components/AirlockWorkspace";
import { createSource, type AirlockSource } from "../src/lib/sources";

interface LaunchPayload {
  tabIds: number[];
  query: string;
}

function extractReadablePageText(): string {
  const clone = document.body.cloneNode(true) as HTMLElement;
  clone
    .querySelectorAll("script, style, noscript, svg, iframe")
    .forEach((el) => el.remove());
  const raw = clone.innerText || document.body.innerText || "";
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .slice(0, 80_000);
}

function ExtensionWorkspaceRoot() {
  const [sources, setSources] = useState<AirlockSource[]>([]);
  const [initialQuery, setInitialQuery] = useState("");
  const [extractError, setExtractError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const stored = await chrome.storage.session.get("airlock_launch");
        const launch = stored.airlock_launch as LaunchPayload | undefined;
        if (!launch || !Array.isArray(launch.tabIds)) {
          setLoading(false);
          return;
        }
        if (launch.query) setInitialQuery(launch.query);

        const loaded: AirlockSource[] = [];
        for (const tabId of launch.tabIds) {
          try {
            const tab = await chrome.tabs.get(tabId);
            const exec = await chrome.scripting.executeScript({
              target: { tabId },
              func: extractReadablePageText,
            });
            const text = String(exec[0]?.result ?? "");
            if (text.trim().length > 0) {
              loaded.push(
                createSource({
                  index: loaded.length + 1,
                  rawTitle: tab.title || tab.url || `Tab ${tabId}`,
                  rawUrl: tab.url,
                  tabId,
                  content: text,
                  kind: "tab",
                })
              );
            }
          } catch (tabErr: unknown) {
            console.warn(`[Airlock] Skipped tab ${tabId}:`, tabErr);
          }
        }
        setSources(loaded);
      } catch (err: unknown) {
        setExtractError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function handleJumpToSource(source: AirlockSource, queryHint?: string) {
    if (source.tabId === undefined) return;
    await chrome.tabs.update(source.tabId, { active: true });
    if (queryHint && queryHint.trim().length >= 3) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: source.tabId },
          args: [queryHint.trim()],
          func: (needle: string) => {
            const term = needle.toLowerCase();
            const walker = document.createTreeWalker(
              document.body,
              NodeFilter.SHOW_TEXT
            );
            let node: Node | null;
            while ((node = walker.nextNode())) {
              if (node.textContent?.toLowerCase().includes(term)) {
                const el = node.parentElement;
                if (el) {
                  el.scrollIntoView({ behavior: "smooth", block: "center" });
                  const prevOutline = el.style.outline;
                  const prevBg = el.style.backgroundColor;
                  el.style.outline = "3px solid #10b981";
                  el.style.backgroundColor = "rgba(16, 185, 129, 0.25)";
                  window.setTimeout(() => {
                    el.style.outline = prevOutline;
                    el.style.backgroundColor = prevBg;
                  }, 3200);
                }
                break;
              }
            }
          },
        });
      } catch {
        // Best-effort highlight
      }
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-300 flex items-center justify-center font-mono text-xs">
        Extracting live DOM text locally from selected Chrome tabs (0 bytes egress)...
      </div>
    );
  }

  return (
    <div>
      {extractError && (
        <div className="bg-red-950 text-red-200 px-6 py-3 font-mono text-xs border-b border-red-500/40">
          [TAB_EXTRACT_WARNING] {extractError}
        </div>
      )}
      <AirlockWorkspace
        surface="extension"
        initialSources={sources}
        initialQuery={initialQuery}
        onJumpToSource={(src, hint) => void handleJumpToSource(src, hint)}
      />
    </div>
  );
}

createRoot(document.getElementById("workspace-root")!).render(
  <StrictMode>
    <ExtensionWorkspaceRoot />
  </StrictMode>
);
