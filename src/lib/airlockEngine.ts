import {
  getGenerativeModel,
  InferenceMode,
  Schema,
  type FunctionDeclarationsTool,
  type InferenceSource,
  type Part,
} from "firebase/ai";
import { ai } from "./firebase";
import { measureNetworkBytes } from "./telemetry";
import {
  SessionVault,
  type VaultCategory,
  type VaultEntry,
} from "./vault";
import {
  runLocalGrep,
  runLocalOutline,
  runLocalReadChunk,
  type AirlockSource,
} from "./sources";

export interface NanoHardwareStatus {
  supportedInBrowser: boolean;
  availability: string;
  online: boolean;
  rttMs: number | null;
}

export interface ScrubStepTelemetry {
  inferenceSource: InferenceSource | "REGEX_ONLY" | "UNKNOWN";
  latencyMs: number;
  egressBytes: number;
  matchedRequests: number;
  regexRedactions: number;
  nanoNewEntities: number;
}

export interface AgentHop {
  hopNumber: number;
  toolName: string;
  sanitizedArgs: Record<string, unknown>;
  hydratedArgs: Record<string, unknown>;
  rawToolOutput: string;
  sanitizedToolOutput: string;
  canaryLeaks: string[];
  scrubTelemetry: ScrubStepTelemetry;
  sourceId?: string;
  matchedLines?: number[];
}

export interface AgentSessionReport {
  sanitizedQuery: string;
  queryScrub: ScrubStepTelemetry;
  hops: AgentHop[];
  sanitizedFinalAnswer: string;
  hydratedFinalAnswer: string;
  cloudModelUsed: string;
  cloudSource: "IN_CLOUD" | "ON_DEVICE_OFFLINE";
  totalCloudLatencyMs: number;
  totalCloudEgressBytes: number;
  totalLocalScrubCalls: number;
  totalLocalScrubRequests: number;
  totalRawBytesScanned: number;
  totalSanitizedBytesSent: number;
  compressionPct: number;
  canaryLeaksTotal: number;
  vaultEntries: VaultEntry[];
}

const piiExtractionSchema = Schema.object({
  properties: {
    entities: Schema.array({
      description:
        "Contextual sensitive spans NOT already replaced by [ALIAS_N] tokens.",
      items: Schema.object({
        properties: {
          text: Schema.string({
            description: "Exact verbatim substring from the input text.",
          }),
          category: Schema.enumString({
            enum: ["PERSON", "ORG", "SERVICE", "HOST", "PROJECT", "ACCOUNT"],
          }),
        },
      }),
    }),
  },
});

const agentTools: FunctionDeclarationsTool = {
  functionDeclarations: [
    {
      name: "list_sources",
      description:
        "List all available local browser tabs or files with opaque IDs, sanitized titles, and line counts. Always call this first.",
    },
    {
      name: "get_source_outline",
      description:
        "Extract headings, functions, and error lines from a specific sourceId.",
      parameters: Schema.object({
        properties: {
          sourceId: Schema.string({
            description: "Opaque source ID such as src_1.",
          }),
        },
      }),
    },
    {
      name: "grep_source",
      description:
        "Search lines inside a specific sourceId. You may include [ALIAS_N] placeholders in query; the local airlock hydrates them before searching.",
      parameters: Schema.object({
        properties: {
          sourceId: Schema.string({
            description: "Opaque source ID such as src_1.",
          }),
          query: Schema.string({
            description:
              "Keyword, error code, or [ALIAS_N] token to search locally.",
          }),
          maxMatches: Schema.integer({
            description: "Maximum matching line blocks to return (default 10).",
          }),
        },
        optionalProperties: ["maxMatches"],
      }),
    },
    {
      name: "read_source_chunk",
      description:
        "Read a targeted range of lines from a specific sourceId for deep code or log inspection.",
      parameters: Schema.object({
        properties: {
          sourceId: Schema.string({
            description: "Opaque source ID such as src_1.",
          }),
          startLine: Schema.integer({
            description: "1-based starting line number.",
          }),
          lineCount: Schema.integer({
            description: "Number of lines to read (1 to 60).",
          }),
        },
      }),
    },
  ],
};

export async function checkLocalNanoHardware(): Promise<NanoHardwareStatus> {
  const nav = navigator as Navigator & {
    connection?: { rtt?: number };
  };
  const rttMs =
    typeof nav.connection?.rtt === "number" ? nav.connection.rtt : null;

  const lm = (window as unknown as {
    LanguageModel?: {
      availability: (opts?: Record<string, unknown>) => Promise<string>;
    };
  }).LanguageModel;

  if (!lm || typeof lm.availability !== "function") {
    return {
      supportedInBrowser: false,
      availability: "unavailable (requires Google Chrome v139+ Prompt API)",
      online: navigator.onLine,
      rttMs,
    };
  }

  const availability = await lm.availability({
    expectedInputs: [{ type: "text" }],
  });

  return {
    supportedInBrowser:
      availability === "available" ||
      availability === "downloadable" ||
      availability === "downloading",
    availability,
    online: navigator.onLine,
    rttMs,
  };
}

/**
 * Outbound Privacy Airlock:
 * 1. Deterministic Vault-First + Regex scrub (prevents cross-turn drift & catches secrets)
 * 2. On-device Gemini Nano 4 semantic PII/entity detector (catches people, orgs, projects, services)
 * 3. Fail-loud Canary Leak assertion before returning outbound-safe text
 */
export async function scrubOutboundWithAirlock(params: {
  rawText: string;
  vault: SessionVault;
  airlockMode: InferenceMode;
  cloudFallbackModel: string;
}): Promise<{
  sanitized: string;
  telemetry: ScrubStepTelemetry;
  canaryLeaks: string[];
}> {
  const { rawText, vault, airlockMode, cloudFallbackModel } = params;
  const trimmed = rawText.slice(0, 6000);

  // Pass 1: Deterministic Vault + Regex
  const det = vault.scrubDeterministic(trimmed);

  // Skip LLM call on trivial empty/short outputs
  if (det.sanitized.trim().length < 12) {
    return {
      sanitized: det.sanitized,
      canaryLeaks: vault.findCanaryLeaks(det.sanitized),
      telemetry: {
        inferenceSource: "REGEX_ONLY",
        latencyMs: 0,
        egressBytes: 0,
        matchedRequests: 0,
        regexRedactions: det.redactionsApplied,
        nanoNewEntities: 0,
      },
    };
  }

  // Pass 2: Semantic Entity Extraction via Firebase AI Logic (default ONLY_ON_DEVICE)
  const model = getGenerativeModel(ai, {
    mode: airlockMode,
    inCloudParams: {
      model: cloudFallbackModel,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: piiExtractionSchema,
      },
    },
    onDeviceParams: {
      createOptions: {
        expectedInputs: [{ type: "text" }],
        expectedOutputs: [{ type: "text", languages: ["en"] }],
      },
      promptOptions: {
        responseConstraint: piiExtractionSchema,
      },
    },
  });

  const prompt = [
    "Identify sensitive contextual entities in the text below that are NOT already replaced with [TAG_N] placeholders.",
    "Extract ONLY: real human names (PERSON), private company/client names (ORG), internal service/repo names (SERVICE), internal hostnames (HOST), codenames/projects (PROJECT), and customer/account IDs (ACCOUNT).",
    "Do NOT extract programming keywords, HTTP status codes, library names (React, Pool, pg, Error), or generic English words.",
    "Return exact verbatim substrings from the text.",
    "",
    "TEXT:",
    det.sanitized,
  ].join("\n");

  const t0 = performance.now();
  const { result, egressBytes, matchedRequests } = await measureNetworkBytes(
    () => model.generateContent(prompt)
  );
  const latencyMs = Math.round(performance.now() - t0);

  let parsedEntities: Array<{ text: string; category: VaultCategory }> = [];
  const rawJson = result.response.text();
  try {
    const parsed = JSON.parse(rawJson) as {
      entities?: Array<{ text: string; category: VaultCategory }>;
    };
    if (Array.isArray(parsed.entities)) {
      parsedEntities = parsed.entities;
    }
  } catch {
    throw new Error(
      `[AIRLOCK_SCHEMA_ERROR] Local sanitizer returned non-JSON output: ${rawJson.slice(
        0,
        160
      )}`
    );
  }

  const applied = vault.applySemanticEntities(det.sanitized, parsedEntities);
  const canaryLeaks = vault.findCanaryLeaks(applied.sanitized);

  if (canaryLeaks.length > 0) {
    throw new Error(
      `[AIRLOCK_CANARY_BREACH] Blocked outbound transmission! Detected raw vault values: ${canaryLeaks.join(
        ", "
      )}`
    );
  }

  return {
    sanitized: applied.sanitized,
    canaryLeaks,
    telemetry: {
      inferenceSource: result.response.inferenceSource ?? "UNKNOWN",
      latencyMs,
      egressBytes,
      matchedRequests,
      regexRedactions: det.redactionsApplied,
      nanoNewEntities: applied.newEntitiesAdded,
    },
  };
}

function hydrateArgsObject(
  args: Record<string, unknown>,
  vault: SessionVault
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = typeof v === "string" ? vault.hydrate(v) : v;
  }
  return out;
}

/**
 * Full Bidirectional Agentic Airlock Runtime:
 * - Scrubs user query + source catalog locally
 * - Cloud Gemini calls surgical local tools across tabs/files
 * - Tool arguments hydrate locally; tool outputs scrub locally through Nano 4 + Vault
 * - Offline mode degrades cleanly to local Gemini Nano 4 synthesis
 * - Final output re-hydrates deterministically in <1ms with zero syntax corruption
 */
export async function runAgenticAirlockSession(params: {
  rawQuery: string;
  sources: AirlockSource[];
  airlockMode: InferenceMode;
  cloudAgentModel: string;
  airlockFallbackModel: string;
  maxHops: number;
  forceOfflineLocal: boolean;
  onStatus?: (msg: string) => void;
  onHop?: (hop: AgentHop) => void;
}): Promise<AgentSessionReport> {
  const {
    rawQuery,
    sources,
    airlockMode,
    cloudAgentModel,
    airlockFallbackModel,
    maxHops,
    forceOfflineLocal,
    onStatus,
    onHop,
  } = params;

  if (sources.length === 0) {
    throw new Error(
      "[NO_SOURCES] Add at least one local file or select at least one browser tab."
    );
  }

  const vault = new SessionVault();
  const sourceMap = new Map<string, AirlockSource>(
    sources.map((s) => [s.id, s])
  );

  let totalLocalScrubCalls = 0;
  let totalLocalScrubRequests = 0;
  let totalRawBytesScanned = 0;
  let totalSanitizedBytesSent = 0;
  let totalCloudLatencyMs = 0;
  let totalCloudEgressBytes = 0;
  let canaryLeaksTotal = 0;

  // 1. Scrub User Query Outbound
  onStatus?.("Airlock: Scrubbing user query locally...");
  const queryRes = await scrubOutboundWithAirlock({
    rawText: rawQuery,
    vault,
    airlockMode,
    cloudFallbackModel: airlockFallbackModel,
  });
  totalLocalScrubCalls += 1;
  totalLocalScrubRequests += queryRes.telemetry.matchedRequests;
  canaryLeaksTotal += queryRes.canaryLeaks.length;

  // 2. Offline / Local-Only Degradation Path
  if (!navigator.onLine || forceOfflineLocal) {
    onStatus?.("Offline / Local-Only Mode: Running local Gemini Nano 4 synthesis...");
    const localExcerpts = sources
      .map((s) => {
        const g = runLocalGrep(s, rawQuery, 6);
        const content =
          g.matchCount > 0 ? g.excerpt : runLocalOutline(s).slice(0, 1200);
        return `### ${s.id} (${s.rawTitle})\n${content}`;
      })
      .join("\n\n")
      .slice(0, 5000);

    const localModel = getGenerativeModel(ai, {
      mode: InferenceMode.ONLY_ON_DEVICE,
      onDeviceParams: {
        createOptions: {
          expectedInputs: [{ type: "text" }],
          expectedOutputs: [{ type: "text", languages: ["en"] }],
        },
      },
    });

    const t0 = performance.now();
    const { result } = await measureNetworkBytes(() =>
      localModel.generateContent(
        `You are an offline local engineering assistant. Answer the user's question concisely using ONLY these local excerpts. Cite source IDs like [src_1].\n\nQuestion: ${rawQuery}\n\nExcerpts:\n${localExcerpts}`
      )
    );
    const localLatency = Math.round(performance.now() - t0);
    const answer = result.response.text();

    return {
      sanitizedQuery: queryRes.sanitized,
      queryScrub: queryRes.telemetry,
      hops: [],
      sanitizedFinalAnswer: answer,
      hydratedFinalAnswer: answer,
      cloudModelUsed: "gemini-nano-4 (offline)",
      cloudSource: "ON_DEVICE_OFFLINE",
      totalCloudLatencyMs: localLatency,
      totalCloudEgressBytes: 0,
      totalLocalScrubCalls,
      totalLocalScrubRequests,
      totalRawBytesScanned: new TextEncoder().encode(localExcerpts).length,
      totalSanitizedBytesSent: 0,
      compressionPct: 100,
      canaryLeaksTotal: 0,
      vaultEntries: vault.entries(),
    };
  }

  // 3. Cloud Agentic Orchestrator (Multi-Turn Function Calling)
  const systemInstruction = [
    "You are Airlock Agent, a Principal SRE and Staff Software Engineer operating behind a Zero-Trust Privacy Airlock.",
    "All sensitive entities in tool outputs are replaced with stable opaque placeholders like [PERSON_1], [ORG_1], [SERVICE_1], [HOST_1], [SECRET_1], [AMOUNT_1].",
    "Rules:",
    "1. Call list_sources first to discover available local files/tabs.",
    "2. Use get_source_outline, grep_source, and read_source_chunk surgically to gather exact evidence across sources.",
    "3. NEVER invent values for placeholders — preserve every [ALIAS_N] token verbatim in your final RCA, explanation, and code patches so the user's browser can deterministically re-hydrate them locally.",
    "4. Always cite exact source IDs and line numbers like [src_1:L14] in your final answer.",
  ].join("\n");

  const cloudModel = getGenerativeModel(ai, {
    model: cloudAgentModel,
    systemInstruction,
    tools: [agentTools],
  });

  const chat = cloudModel.startChat();
  const hops: AgentHop[] = [];

  onStatus?.(`Cloud Agent (${cloudAgentModel}): Planning tool calls...`);
  const enc = new TextEncoder();
  totalSanitizedBytesSent += enc.encode(queryRes.sanitized).length;

  let t0 = performance.now();
  let turn = await measureNetworkBytes(() =>
    chat.sendMessage(queryRes.sanitized)
  );
  totalCloudLatencyMs += Math.round(performance.now() - t0);
  totalCloudEgressBytes += turn.egressBytes;

  for (let hopIdx = 0; hopIdx < maxHops; hopIdx++) {
    const calls = turn.result.response.functionCalls();
    if (!calls || calls.length === 0) {
      break;
    }

    const fnResponseParts: Part[] = [];

    for (const call of calls) {
      const sanitizedArgs = (call.args ?? {}) as Record<string, unknown>;
      const hydratedArgs = hydrateArgsObject(sanitizedArgs, vault);
      const hopNum = hops.length + 1;

      onStatus?.(
        `Hop ${hopNum}: Executing local tool ${call.name}() & scrubbing via Airlock...`
      );

      let rawToolOutput = "";
      let sourceId: string | undefined;
      let matchedLines: number[] | undefined;

      if (call.name === "list_sources") {
        rawToolOutput = sources
          .map(
            (s) =>
              `${s.id} | kind=${s.kind} | lines=${s.lines.length} | bytes=${s.byteSize} | title=${s.rawTitle}`
          )
          .join("\n");
      } else if (call.name === "get_source_outline") {
        sourceId = String(hydratedArgs.sourceId ?? "");
        const src = sourceMap.get(sourceId);
        rawToolOutput = src
          ? runLocalOutline(src)
          : `Unknown sourceId "${sourceId}". Call list_sources first.`;
      } else if (call.name === "grep_source") {
        sourceId = String(hydratedArgs.sourceId ?? "");
        const src = sourceMap.get(sourceId);
        const q = String(hydratedArgs.query ?? "");
        const maxM = Number(hydratedArgs.maxMatches ?? 10);
        if (!src) {
          rawToolOutput = `Unknown sourceId "${sourceId}".`;
        } else {
          const g = runLocalGrep(src, q, maxM);
          matchedLines = g.matchedLines;
          rawToolOutput = g.excerpt;
        }
      } else if (call.name === "read_source_chunk") {
        sourceId = String(hydratedArgs.sourceId ?? "");
        const src = sourceMap.get(sourceId);
        const startLine = Number(hydratedArgs.startLine ?? 1);
        const lineCount = Number(hydratedArgs.lineCount ?? 35);
        rawToolOutput = src
          ? runLocalReadChunk(src, startLine, lineCount)
          : `Unknown sourceId "${sourceId}".`;
      } else {
        rawToolOutput = `Unsupported tool "${call.name}".`;
      }

      // Outbound Airlock Scrub on raw tool result
      const scrubRes = await scrubOutboundWithAirlock({
        rawText: rawToolOutput,
        vault,
        airlockMode,
        cloudFallbackModel: airlockFallbackModel,
      });

      totalLocalScrubCalls += 1;
      totalLocalScrubRequests += scrubRes.telemetry.matchedRequests;
      canaryLeaksTotal += scrubRes.canaryLeaks.length;

      totalRawBytesScanned += enc.encode(rawToolOutput).length;
      totalSanitizedBytesSent += enc.encode(scrubRes.sanitized).length;

      const hopRecord: AgentHop = {
        hopNumber: hopNum,
        toolName: call.name,
        sanitizedArgs,
        hydratedArgs,
        rawToolOutput,
        sanitizedToolOutput: scrubRes.sanitized,
        canaryLeaks: scrubRes.canaryLeaks,
        scrubTelemetry: scrubRes.telemetry,
        sourceId,
        matchedLines,
      };
      hops.push(hopRecord);
      onHop?.(hopRecord);

      fnResponseParts.push({
        functionResponse: {
          name: call.name,
          response: {
            sourceId: sourceId ?? "catalog",
            sanitizedOutput: scrubRes.sanitized,
          },
        },
      });
    }

    onStatus?.(
      `Cloud Agent (${cloudAgentModel}): Synthesizing sanitized tool outputs...`
    );
    t0 = performance.now();
    turn = await measureNetworkBytes(() => chat.sendMessage(fnResponseParts));
    totalCloudLatencyMs += Math.round(performance.now() - t0);
    totalCloudEgressBytes += turn.egressBytes;
  }

  const sanitizedFinalAnswer = turn.result.response.text();
  const hydratedFinalAnswer = vault.hydrate(sanitizedFinalAnswer);

  const totalCorpusBytes = sources.reduce((sum, s) => sum + s.byteSize, 0);
  const compressionPct =
    totalCorpusBytes > 0
      ? Math.max(
          0,
          Math.round((1 - totalSanitizedBytesSent / totalCorpusBytes) * 100)
        )
      : 0;

  return {
    sanitizedQuery: queryRes.sanitized,
    queryScrub: queryRes.telemetry,
    hops,
    sanitizedFinalAnswer,
    hydratedFinalAnswer,
    cloudModelUsed: cloudAgentModel,
    cloudSource: "IN_CLOUD",
    totalCloudLatencyMs,
    totalCloudEgressBytes,
    totalLocalScrubCalls,
    totalLocalScrubRequests,
    totalRawBytesScanned,
    totalSanitizedBytesSent,
    compressionPct,
    canaryLeaksTotal,
    vaultEntries: vault.entries(),
  };
}
