import { useEffect, useState, type ChangeEvent } from "react";
import { InferenceMode } from "firebase/ai";
import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Database,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  Lock,
  Play,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  Wifi,
  WifiOff,
} from "lucide-react";
import {
  checkLocalNanoHardware,
  runAgenticAirlockSession,
  type AgentHop,
  type AgentSessionReport,
  type NanoHardwareStatus,
} from "../lib/airlockEngine";
import {
  appCheckStatus,
  loadRuntimeConfig,
  type LiveRuntimeConfig,
} from "../lib/firebase";
import {
  buildSampleIncidentSources,
  createSource,
  type AirlockSource,
} from "../lib/sources";
import {
  fetchRecentAirlockRuns,
  logAirlockRunToFirestore,
  type StoredAirlockRun,
} from "../lib/telemetry";

interface AirlockWorkspaceProps {
  surface: "web" | "extension";
  initialSources?: AirlockSource[];
  initialQuery?: string;
  onJumpToSource?: (source: AirlockSource, queryHint?: string) => void;
}

export function AirlockWorkspace({
  surface,
  initialSources = [],
  initialQuery = "",
  onJumpToSource,
}: AirlockWorkspaceProps) {
  const [sources, setSources] = useState<AirlockSource[]>(initialSources);
  const [query, setQuery] = useState(
    initialQuery ||
      "Perform a root-cause analysis across these sources, identify any contradictions or bugs, and write a concrete code fix."
  );
  const [airlockMode, setAirlockMode] = useState<InferenceMode>(
    InferenceMode.ONLY_ON_DEVICE
  );
  const [forceOfflineLocal, setForceOfflineLocal] = useState(false);

  const [hardware, setHardware] = useState<NanoHardwareStatus | null>(null);
  const [runtimeCfg, setRuntimeCfg] = useState<LiveRuntimeConfig | null>(null);

  const [running, setRunning] = useState(false);
  const [liveStatus, setLiveStatus] = useState("Ready");
  const [liveHops, setLiveHops] = useState<AgentHop[]>([]);
  const [report, setReport] = useState<AgentSessionReport | null>(null);
  const [viewMode, setViewMode] = useState<"HYDRATED" | "SANITIZED_CLOUD">(
    "HYDRATED"
  );
  const [revealVault, setRevealVault] = useState(false);
  const [loudError, setLoudError] = useState<string | null>(null);

  const [lastDocId, setLastDocId] = useState<string | null>(null);
  const [runs, setRuns] = useState<StoredAirlockRun[]>([]);

  // Paste raw snippet modal-free quick-add
  const [pasteTitle, setPasteTitle] = useState("");
  const [pasteBody, setPasteBody] = useState("");
  const [showPasteBox, setShowPasteBox] = useState(false);

  useEffect(() => {
    if (initialSources.length > 0) {
      setSources(initialSources);
    }
  }, [initialSources]);

  useEffect(() => {
    if (initialQuery) {
      setQuery(initialQuery);
    }
  }, [initialQuery]);

  async function refreshTelemetry() {
    const hw = await checkLocalNanoHardware();
    setHardware(hw);
    try {
      const cfg = await loadRuntimeConfig();
      setRuntimeCfg(cfg);
    } catch (err: unknown) {
      setLoudError(
        `[REMOTE_CONFIG_ERROR] ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    try {
      setRuns(await fetchRecentAirlockRuns(6));
    } catch {
      // Firestore offline or rules not deployed yet
    }
  }

  useEffect(() => {
    void refreshTelemetry();
    const onNet = () => void checkLocalNanoHardware().then(setHardware);
    window.addEventListener("online", onNet);
    window.addEventListener("offline", onNet);
    return () => {
      window.removeEventListener("online", onNet);
      window.removeEventListener("offline", onNet);
    };
  }, []);

  async function handleFileUpload(e: ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const added: AirlockSource[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const text = await f.text();
      added.push(
        createSource({
          index: sources.length + added.length + 1,
          rawTitle: f.name,
          content: text,
          kind: "file",
        })
      );
    }
    setSources((prev) => [...prev, ...added]);
    e.target.value = "";
  }

  function handleAddPastedSnippet() {
    if (!pasteBody.trim()) return;
    const next = createSource({
      index: sources.length + 1,
      rawTitle: pasteTitle.trim() || `snippet-${sources.length + 1}.txt`,
      content: pasteBody,
      kind: "file",
    });
    setSources((prev) => [...prev, next]);
    setPasteTitle("");
    setPasteBody("");
    setShowPasteBox(false);
  }

  function handleRemoveSource(id: string) {
    setSources((prev) => prev.filter((s) => s.id !== id));
  }

  async function handleRunAgent() {
    setLoudError(null);
    setLiveHops([]);
    setReport(null);
    setLastDocId(null);
    setRunning(true);

    try {
      const cfg = runtimeCfg ?? (await loadRuntimeConfig());
      setRuntimeCfg(cfg);

      const sessionReport = await runAgenticAirlockSession({
        rawQuery: query,
        sources,
        airlockMode,
        cloudAgentModel: cfg.cloudAgentModel,
        airlockFallbackModel: cfg.airlockFallbackModel,
        maxHops: cfg.maxAgentHops,
        forceOfflineLocal,
        onStatus: setLiveStatus,
        onHop: (hop) => setLiveHops((prev) => [...prev, hop]),
      });

      setReport(sessionReport);
      setViewMode("HYDRATED");
      setLiveStatus("Complete — 0 raw tokens leaked");
      setHardware(await checkLocalNanoHardware());

      if (navigator.onLine) {
        try {
          const docId = await logAirlockRunToFirestore({
            surface,
            sourceCount: sources.length,
            totalHops: sessionReport.hops.length,
            vaultEntityCount: sessionReport.vaultEntries.length,
            canaryLeaks: sessionReport.canaryLeaksTotal,
            localScrubCalls: sessionReport.totalLocalScrubCalls,
            localScrubRequests: sessionReport.totalLocalScrubRequests,
            cloudModel: sessionReport.cloudModelUsed,
            totalLatencyMs: sessionReport.totalCloudLatencyMs,
            compressionPct: sessionReport.compressionPct,
          });
          setLastDocId(docId);
          setRuns(await fetchRecentAirlockRuns(6));
        } catch {
          // Non-fatal if Firestore rules not deployed yet
        }
      }
    } catch (err: unknown) {
      setLoudError(
        err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      );
      setLiveStatus("Halted (Fail-Loud)");
    } finally {
      setRunning(false);
    }
  }

  const totalRawKb = (
    sources.reduce((s, item) => s + item.byteSize, 0) / 1024
  ).toFixed(1);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-5 md:p-7 font-sans">
      <div className="mx-auto max-w-[1440px] space-y-5">
        {/* Header Telemetry */}
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-emerald-500/40 bg-emerald-500/15 text-emerald-400">
              <Lock className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-bold tracking-tight text-white">
                  Airlock Agent
                </h1>
                <span className="rounded bg-slate-800 px-2 py-0.5 font-mono text-[10px] uppercase text-emerald-300">
                  {surface === "extension"
                    ? "Chrome MV3 Private-Tab Runtime"
                    : "Web Local-File Runtime"}
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Bidirectional Agentic Privacy Airlock: On-Device Gemini Nano 4
                Tool Middleware + Cloud Gemini Function Calling
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
            <span className="inline-flex items-center gap-1.5 rounded-md border border-slate-800 bg-slate-900 px-2.5 py-1.5">
              <Cpu className="h-3.5 w-3.5 text-emerald-400" />
              Nano 4: {hardware?.availability ?? "probing..."}
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-md border border-slate-800 bg-slate-900 px-2.5 py-1.5">
              {hardware?.online ? (
                <Wifi className="h-3.5 w-3.5 text-sky-400" />
              ) : (
                <WifiOff className="h-3.5 w-3.5 text-amber-400" />
              )}
              {hardware?.online
                ? `ONLINE (${hardware.rttMs ?? "?"}ms RTT)`
                : "OFFLINE"}
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-md border border-slate-800 bg-slate-900 px-2.5 py-1.5">
              <ShieldCheck className="h-3.5 w-3.5 text-indigo-400" />
              App Check: {appCheckStatus}
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-md border border-slate-800 bg-slate-900 px-2.5 py-1.5 text-slate-300">
              Cloud: {runtimeCfg?.cloudAgentModel ?? "gemini-4-hydrogen"}
            </span>
            <button
              type="button"
              onClick={() => void refreshTelemetry()}
              className="rounded-md border border-slate-700 bg-slate-800 p-1.5 hover:bg-slate-700"
              title="Refresh hardware & Remote Config"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>
        </header>

        {/* Fail-Loud Error Banner */}
        {loudError && (
          <div className="flex items-start gap-3 rounded-lg border border-red-500/50 bg-red-950/60 p-4 font-mono text-xs text-red-200">
            <AlertTriangle className="h-4 w-4 shrink-0 text-red-400 mt-0.5" />
            <div className="break-words">{loudError}</div>
          </div>
        )}

        {/* Agent Command Bar */}
        <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 space-y-3">
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">
            <div className="lg:col-span-6">
              <label className="mb-1 block text-xs font-semibold text-slate-400">
                Agent Objective (Scrubbed Locally Before Cloud Planning)
              </label>
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Ask the agent to debug logs, audit private tabs, or write a code fix..."
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none"
              />
            </div>

            <div className="lg:col-span-3">
              <label className="mb-1 block text-xs font-semibold text-slate-400">
                Airlock Scrubber Mode (Outbound Gate)
              </label>
              <select
                value={airlockMode}
                onChange={(e) => setAirlockMode(e.target.value as InferenceMode)}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
              >
                <option value={InferenceMode.ONLY_ON_DEVICE}>
                  ONLY_ON_DEVICE (Strict Zero-Trust)
                </option>
                <option value={InferenceMode.PREFER_ON_DEVICE}>
                  PREFER_ON_DEVICE (Demo Fallback)
                </option>
              </select>
            </div>

            <div className="lg:col-span-3 flex items-end gap-2">
              <label className="flex items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-950 px-2.5 py-2 text-xs text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={forceOfflineLocal}
                  onChange={(e) => setForceOfflineLocal(e.target.checked)}
                />
                Local-Only
              </label>
              <button
                type="button"
                disabled={running || sources.length === 0 || !query.trim()}
                onClick={handleRunAgent}
                className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
              >
                <Play className="h-4 w-4" />
                {running ? "Running..." : "Run Airlock Agent"}
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono text-slate-400 pt-1 border-t border-slate-800/70">
            <span>Status: {liveStatus}</span>
            <span>
              Local Corpus: {sources.length} source(s) ({totalRawKb} KB raw in
              browser memory)
            </span>
          </div>
        </section>

        {/* Main 3-Column Observatory */}
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-12">
          {/* COLUMN 1: Local Sources + Bijective Session Vault */}
          <div className="xl:col-span-3 space-y-4">
            <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-bold text-white">
                  1. Local Private Sources
                </h2>
                <span className="font-mono text-[11px] text-slate-400">
                  {sources.length} loaded
                </span>
              </div>

              <div className="flex flex-wrap gap-2">
                <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-700">
                  <Upload className="h-3.5 w-3.5" />
                  Add Files
                  <input
                    type="file"
                    multiple
                    accept=".log,.txt,.md,.json,.ts,.tsx,.js,.jsx,.py,.go,.yaml,.yml,.har,.csv,.sql,.env"
                    onChange={handleFileUpload}
                    className="hidden"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => setShowPasteBox((v) => !v)}
                  className="rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-700"
                >
                  Paste Snippet
                </button>
                <button
                  type="button"
                  onClick={() => setSources(buildSampleIncidentSources())}
                  className="rounded-lg border border-indigo-500/40 bg-indigo-500/15 px-2.5 py-1.5 text-xs font-semibold text-indigo-300 hover:bg-indigo-500/25"
                >
                  Load Sample Pack
                </button>
              </div>

              {showPasteBox && (
                <div className="space-y-2 rounded-lg border border-slate-800 bg-slate-950 p-2.5">
                  <input
                    type="text"
                    value={pasteTitle}
                    onChange={(e) => setPasteTitle(e.target.value)}
                    placeholder="Filename (e.g. error.log)"
                    className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs"
                  />
                  <textarea
                    rows={4}
                    value={pasteBody}
                    onChange={(e) => setPasteBody(e.target.value)}
                    placeholder="Paste raw private log, code, or doc..."
                    className="w-full rounded border border-slate-700 bg-slate-900 p-2 font-mono text-xs"
                  />
                  <button
                    type="button"
                    onClick={handleAddPastedSnippet}
                    className="w-full rounded bg-emerald-600 py-1 text-xs font-semibold text-white hover:bg-emerald-500"
                  >
                    Add to Local Memory
                  </button>
                </div>
              )}

              {sources.length === 0 ? (
                <div className="rounded-lg border border-dashed border-slate-800 p-5 text-center text-xs text-slate-500">
                  Drop any local <code>.log</code>, <code>.har</code>,{" "}
                  <code>.ts</code>, <code>.py</code>, or <code>.md</code> files,
                  or click <strong>Load Sample Pack</strong>.
                </div>
              ) : (
                <ul className="space-y-2 max-h-[260px] overflow-y-auto pr-1">
                  {sources.map((src) => (
                    <li
                      key={src.id}
                      className="flex items-start justify-between gap-2 rounded-lg border border-slate-800 bg-slate-950 p-2.5 text-xs"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 font-mono font-semibold text-emerald-300">
                          <FileText className="h-3.5 w-3.5 shrink-0" />
                          <span>{src.id}</span>
                          <span className="truncate text-slate-200 font-sans">
                            {src.rawTitle}
                          </span>
                        </div>
                        <div className="mt-0.5 font-mono text-[10px] text-slate-500">
                          {src.lines.length} lines &bull;{" "}
                          {(src.byteSize / 1024).toFixed(1)} KB &bull;{" "}
                          {src.kind.toUpperCase()}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {src.tabId !== undefined && onJumpToSource && (
                          <button
                            type="button"
                            onClick={() => onJumpToSource(src)}
                            title="Jump to browser tab"
                            className="rounded p-1 text-sky-400 hover:bg-slate-800"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleRemoveSource(src.id)}
                          title="Remove source"
                          className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-rose-400"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Bijective Session Vault */}
            <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-bold text-white">
                  Local Bijective Vault
                </h2>
                <button
                  type="button"
                  onClick={() => setRevealVault((v) => !v)}
                  className="inline-flex items-center gap-1 rounded bg-slate-800 px-2 py-1 font-mono text-[10px] text-slate-300 hover:bg-slate-700"
                >
                  {revealVault ? (
                    <>
                      <EyeOff className="h-3 w-3" /> Mask
                    </>
                  ) : (
                    <>
                      <Eye className="h-3 w-3" /> Reveal
                    </>
                  )}
                </button>
              </div>
              <p className="text-[11px] text-slate-400">
                Stays strictly in browser RAM. Guarantees consistent aliases
                across hops and lossless local re-hydration.
              </p>

              {!report || report.vaultEntries.length === 0 ? (
                <p className="font-mono text-[11px] text-slate-500">
                  Run the agent to inspect captured secrets and contextual PII.
                </p>
              ) : (
                <div className="max-h-[260px] overflow-y-auto space-y-1.5 font-mono text-[11px]">
                  {report.vaultEntries.map((entry) => (
                    <div
                      key={entry.alias}
                      className="flex items-center justify-between gap-2 rounded border border-slate-800 bg-slate-950 px-2.5 py-1.5"
                    >
                      <span className="font-bold text-emerald-300 shrink-0">
                        {entry.alias}
                      </span>
                      <span className="truncate text-slate-300">
                        {revealVault
                          ? entry.raw
                          : `${entry.raw.slice(0, 3)}••••••`}
                      </span>
                      <span
                        className={
                          entry.source === "nano"
                            ? "rounded bg-indigo-500/20 px-1.5 py-0.5 text-[9px] text-indigo-300 shrink-0"
                            : "rounded bg-slate-800 px-1.5 py-0.5 text-[9px] text-slate-400 shrink-0"
                        }
                      >
                        {entry.source}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* COLUMN 2: Live Agentic Hop & Wire Airlock Inspector */}
          <div className="xl:col-span-5 rounded-xl border border-slate-800 bg-slate-900/60 p-4 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-bold text-white">
                2. Live Wire Airlock Inspector (Tool Hops)
              </h2>
              {report && (
                <span className="rounded bg-emerald-500/20 px-2 py-0.5 font-mono text-[11px] font-bold text-emerald-300">
                  Canary Leaks: {report.canaryLeaksTotal} | Wire Reduction:{" "}
                  {report.compressionPct}%
                </span>
              )}
            </div>

            {report && (
              <div className="rounded-lg border border-slate-800 bg-slate-950 p-3 font-mono text-[11px] space-y-1">
                <div className="flex justify-between text-slate-400">
                  <span>OUTBOUND SANITIZED QUERY</span>
                  <span className="text-emerald-300">
                    {report.queryScrub.inferenceSource} •{" "}
                    {report.queryScrub.matchedRequests} req /{" "}
                    {report.queryScrub.egressBytes} B
                  </span>
                </div>
                <div className="text-slate-200">{report.sanitizedQuery}</div>
              </div>
            )}

            {liveHops.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-800 p-8 text-center font-mono text-xs text-slate-500">
                Each Cloud Gemini tool call appears here in real time, showing
                inbound argument hydration, local tool output, and the exact
                sanitized payload verified before crossing the wire.
              </div>
            ) : (
              <div className="space-y-3 max-h-[620px] overflow-y-auto pr-1">
                {liveHops.map((hop) => {
                  const linkedSource = hop.sourceId
                    ? sources.find((s) => s.id === hop.sourceId)
                    : undefined;
                  return (
                    <div
                      key={hop.hopNumber}
                      className="rounded-lg border border-slate-800 bg-slate-950 p-3 font-mono text-[11px] space-y-2"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-2">
                        <span className="font-bold text-sky-300">
                          Hop #{hop.hopNumber}: {hop.toolName}()
                        </span>
                        <div className="flex items-center gap-1.5">
                          <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-300">
                            Scrub: {hop.scrubTelemetry.inferenceSource} (
                            {hop.scrubTelemetry.matchedRequests} req /{" "}
                            {hop.scrubTelemetry.egressBytes} B)
                          </span>
                          {linkedSource?.tabId !== undefined &&
                            onJumpToSource && (
                              <button
                                type="button"
                                onClick={() =>
                                  onJumpToSource(
                                    linkedSource,
                                    String(hop.hydratedArgs.query ?? "")
                                  )
                                }
                                className="inline-flex items-center gap-1 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-sky-300 hover:bg-slate-700"
                              >
                                <ExternalLink className="h-3 w-3" />
                                Jump Tab
                              </button>
                            )}
                        </div>
                      </div>

                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <div className="rounded border border-slate-800 bg-slate-900/70 p-2">
                          <div className="text-[10px] text-slate-400">
                            Cloud Args (Sanitized)
                          </div>
                          <div className="text-slate-200 break-all">
                            {JSON.stringify(hop.sanitizedArgs)}
                          </div>
                        </div>
                        <div className="rounded border border-indigo-500/30 bg-indigo-950/20 p-2">
                          <div className="text-[10px] text-indigo-300">
                            Local Exec Args (Hydrated)
                          </div>
                          <div className="text-indigo-100 break-all">
                            {JSON.stringify(hop.hydratedArgs)}
                          </div>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <div className="rounded border border-rose-500/30 bg-rose-950/15 p-2">
                          <div className="mb-1 text-[10px] font-bold text-rose-300">
                            RAW LOCAL TOOL OUTPUT (STAYS ON DEVICE)
                          </div>
                          <pre className="max-h-36 overflow-auto whitespace-pre-wrap text-[10.5px] text-rose-100/90">
                            {hop.rawToolOutput}
                          </pre>
                        </div>
                        <div className="rounded border border-emerald-500/35 bg-emerald-950/15 p-2">
                          <div className="mb-1 text-[10px] font-bold text-emerald-300">
                            WIRE PAYLOAD SENT TO CLOUD (0 LEAKS)
                          </div>
                          <pre className="max-h-36 overflow-auto whitespace-pre-wrap text-[10.5px] text-emerald-100/95">
                            {hop.sanitizedToolOutput}
                          </pre>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* COLUMN 3: Final Re-hydrated Output */}
          <div className="xl:col-span-4 rounded-xl border border-slate-800 bg-slate-900/60 p-4 space-y-4 flex flex-col">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-bold text-white flex items-center gap-1.5">
                <Sparkles className="h-4 w-4 text-indigo-400" />
                3. Final Output
              </h2>
              <div className="inline-flex rounded-lg border border-slate-700 bg-slate-950 p-0.5 font-mono text-[11px]">
                <button
                  type="button"
                  onClick={() => setViewMode("HYDRATED")}
                  className={
                    viewMode === "HYDRATED"
                      ? "rounded-md bg-emerald-600 px-2.5 py-1 font-semibold text-white"
                      : "px-2.5 py-1 text-slate-400 hover:text-slate-200"
                  }
                >
                  Re-hydrated (Local)
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode("SANITIZED_CLOUD")}
                  className={
                    viewMode === "SANITIZED_CLOUD"
                      ? "rounded-md bg-indigo-600 px-2.5 py-1 font-semibold text-white"
                      : "px-2.5 py-1 text-slate-400 hover:text-slate-200"
                  }
                >
                  What Cloud Saw
                </button>
              </div>
            </div>

            {report ? (
              <>
                <div className="grid grid-cols-3 gap-2 font-mono text-[11px]">
                  <div className="rounded border border-slate-800 bg-slate-950 p-2">
                    <div className="text-[10px] text-slate-500">Orchestrator</div>
                    <div className="font-bold text-indigo-300 truncate">
                      {report.cloudSource}
                    </div>
                  </div>
                  <div className="rounded border border-slate-800 bg-slate-950 p-2">
                    <div className="text-[10px] text-slate-500">Local Scrubs</div>
                    <div className="font-bold text-emerald-300">
                      {report.totalLocalScrubCalls} ({report.totalLocalScrubRequests}{" "}
                      net req)
                    </div>
                  </div>
                  <div className="rounded border border-slate-800 bg-slate-950 p-2">
                    <div className="text-[10px] text-slate-500">Vault Keys</div>
                    <div className="font-bold text-amber-300">
                      {report.vaultEntries.length} entities
                    </div>
                  </div>
                </div>

                <div className="flex-1 rounded-lg border border-slate-800 bg-slate-950 p-4 overflow-y-auto max-h-[520px]">
                  <pre className="whitespace-pre-wrap font-sans text-xs leading-relaxed text-slate-200">
                    {viewMode === "HYDRATED"
                      ? report.hydratedFinalAnswer
                      : report.sanitizedFinalAnswer}
                  </pre>
                </div>

                {lastDocId && (
                  <p className="inline-flex items-center gap-1.5 font-mono text-[11px] text-emerald-400">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Zero-PII audit logged: airlock_runs/{lastDocId}
                  </p>
                )}
              </>
            ) : (
              <div className="flex-1 rounded-lg border border-dashed border-slate-800 p-8 text-center font-mono text-xs text-slate-500 flex items-center justify-center">
                Toggle between &ldquo;Re-hydrated (Local)&rdquo; and &ldquo;What
                Cloud Saw&rdquo; after running to prove the cloud never received
                your real secrets, hostnames, or identities.
              </div>
            )}
          </div>
        </div>

        {/* Zero-PII Cloud Firestore Audit Ledger */}
        <section className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-bold text-slate-200">
            <Database className="h-4 w-4 text-emerald-400" />
            Cloud Firestore Zero-PII Telemetry Ledger (Live)
          </div>
          {runs.length === 0 ? (
            <p className="font-mono text-xs text-slate-500">
              No runs logged yet (or offline). Only aggregate counts &mdash;
              zero raw prompts or entities &mdash; are persisted to Firestore.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left font-mono text-xs">
                <thead className="border-b border-slate-800 text-slate-400">
                  <tr>
                    <th className="py-2 pr-4">Surface</th>
                    <th className="py-2 pr-4">Sources</th>
                    <th className="py-2 pr-4">Tool Hops</th>
                    <th className="py-2 pr-4">Vault Entities</th>
                    <th className="py-2 pr-4">Local Scrub Net Req</th>
                    <th className="py-2 pr-4">Canary Leaks</th>
                    <th className="py-2 pr-4">Cloud Model</th>
                    <th className="py-2">Wire Reduction</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70 text-slate-300">
                  {runs.map((r) => (
                    <tr key={r.id}>
                      <td className="py-2 pr-4 uppercase">{r.surface}</td>
                      <td className="py-2 pr-4">{r.sourceCount}</td>
                      <td className="py-2 pr-4">{r.totalHops}</td>
                      <td className="py-2 pr-4 text-amber-300">
                        {r.vaultEntityCount}
                      </td>
                      <td className="py-2 pr-4 text-emerald-300">
                        {r.localScrubRequests}
                      </td>
                      <td className="py-2 pr-4 text-emerald-400 font-bold">
                        {r.canaryLeaks}
                      </td>
                      <td className="py-2 pr-4 text-indigo-300">
                        {r.cloudModel}
                      </td>
                      <td className="py-2">{r.compressionPct}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
