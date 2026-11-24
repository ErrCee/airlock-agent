# Airlock Agent

**A Bidirectional Agentic Privacy Airlock built with Firebase AI Logic (`firebase/ai`), pairing on-device Gemini Nano 4 tool middleware with Cloud Gemini multi-turn function calling.**

Airlock Agent lets frontier cloud models (`gemini-4-hydrogen` / `gemini-4-argon`) debug private production logs, inspect authenticated browser tabs, and write concrete code patches—**without raw secrets, PII, internal hostnames, or private DOM text ever crossing the network.**

---

## Why This Exists

Modern engineering workflows hit a structural impasse between privacy, reach, and reasoning depth:

1. **Tool-output leakage is the #1 enterprise agent risk.** Cyberhaven (Feb 2026) found **39.7%** of data movements into AI tools contain sensitive data. IBM's *Cost of a Data Breach* (July 2026) linked shadow AI to **43%** of breach incidents, adding **$670,000** in average breach cost. SailPoint's survey of 353 IT security leaders found **31%–33%** saw AI agents share sensitive data and **23%** saw agents expose credentials via tool outputs, while Gartner (2026) reports **54%** of organizations have no mechanism restricting what agents read.
2. **Cloud web fetchers cannot reach private context.** Server-side URL fetchers (including `urlContext`) fail on authenticated SaaS tabs (private GitHub PRs, Gmail, Jira, Confluence), `localhost`, paywalled pages, and local `.log`/`.har` files.
3. **Stateless PII redactors collapse in multi-turn agent loops.** The *PII-TRACE* multi-turn benchmark (Aug 2026, evaluating 1,922 multi-turn documents across 12 detectors) showed single-pass filters suffer severe cross-turn entity drift—OpenAI's 1.5B Privacy Filter dropped from **47.4%** to **18.2%** consistency across 6–10 mentions, and GLiNER2-PII dropped from **64.1%** to **7.3%**.
4. **Regex alone misses contextual secrets, and local-only LLMs hit a reasoning ceiling.** Regex catches JWTs and emails, not *"Arjun Mehta confirmed ProjectKestrel's ledger-reconciler deadlocked for MeridianCapitalCorp."* Conversely, a local 2B–4B model cannot reliably perform deep multi-file root-cause analysis or synthesize production TypeScript/SQL patches across several large sources.

### Why Hybrid AI Is Structurally Required

| Capability | Cloud-Only Agent | Local-Only (Nano 4) | Regex-Only Proxy | **Airlock Agent (Hybrid)** |
| :--- | :---: | :---: | :---: | :---: |
| Reads private auth tabs, `localhost`, & local files | No | Yes | Yes | **Yes** |
| Catches contextual PII (names, orgs, services, codenames) | Leaks on byte 1 | Yes | No | **Yes (`ONLY_ON_DEVICE` Nano 4)** |
| Cross-turn entity consistency (`[SERVICE_1]` stays stable) | N/A | Prone to drift | Partial | **Yes (Vault-First pass)** |
| Deep multi-hop RCA & syntax-safe code generation | Yes | Weak on complex code | N/A | **Yes (Cloud Gemini + `<1ms` hydration)** |
| Works completely offline | No | Yes | N/A | **Yes (graceful local Nano fallback)** |

---

## Architecture: The Bidirectional Agentic Airlock

Instead of dumping entire tabs or files into a prompt, Cloud Gemini acts as a surgical planner calling local tools (`list_sources`, `get_source_outline`, `grep_source`, `read_source_chunk`). Every boundary between the browser and Google's API passes through a stateful local middleware:

```text
User Objective (raw)
   │
   ▼ [1. Outbound Airlock: SessionVault -> Regex -> On-Device Nano 4 -> Canary Gate]
Sanitized Objective ──► Cloud Gemini Orchestrator (gemini-4-hydrogen / gemini-4-argon)
                             │
                             │  Calls surgical tool via Function Calling:
                             │  grep_source(sourceId="src_1", query="[SERVICE_1] 502")
                             ▼
             [2. Inbound Arg Hydration: Deterministic SessionVault (< 1 ms)]
             Rewrites query -> "ledger-reconciler 502" strictly in browser RAM
                             │
                             ▼
             [3. Local Tool Execution (Zero Network)]
             Runs against live authenticated Chrome tab DOM or in-memory local files
                             │
                             ▼
             [4. Outbound Tool-Result Airlock (3-Pass Middleware)]
             • Pass 1: Re-applies existing SessionVault aliases (prevents entity drift)
                       + high-precision regex (JWT, Bearer, API keys, DB URLs, IPs, emails)
             • Pass 2: On-device Gemini Nano 4 (ONLY_ON_DEVICE) extracts new contextual
                       entities (PERSON, ORG, SERVICE, HOST, PROJECT, ACCOUNT) at 0 net req
             • Pass 3: Fail-loud Canary Leak Gate aborts if ANY raw vault token survives
                             │
                             ▼ (Loops 1..N hops until Cloud Gemini has sufficient evidence)
             [5. Cloud Synthesis (RCA / Code Patch using [ALIAS_N] placeholders)]
                             │
                             ▼
             [6. Lossless Local Re-hydration: Deterministic SessionVault (< 1 ms)]
             Restores real hostnames, services, and code identifiers with zero LLM corruption
                             │
                             ▼
             Concrete Answer + Clickable Tab Citations + Wire Audit Inspector
```

### Key Architectural Decisions

* **Deterministic Inbound Re-hydration (`< 1 ms`):** Gemini Nano 4 runs strictly on the *outbound* semantic scrubbing boundary. Final code diffs, SQL queries, and stack-trace RCAs are re-hydrated deterministically from `SessionVault` (`Map<string, VaultEntry>`) rather than passed through a small LLM, preventing dropped braces, broken indentation, or hallucinated edits.
* **Vault-First Anti-Drift Scrubbing:** Before invoking Nano 4 on any tool output, `SessionVault.scrubDeterministic()` replaces all previously registered values longest-first. If `ledger-reconciler` becomes `[SERVICE_1]` in Hop 1, it stays `[SERVICE_1]` across every subsequent tab, log file, and final code patch.
* **Fail-Loud Canary Gate:** Before any sanitized query or tool payload leaves the browser, `vault.findCanaryLeaks()` scans the exact outbound string for every registered secret (`>= 4` chars). Any match throws `[AIRLOCK_CANARY_BREACH]` and aborts the cloud call immediately.
* **Zero-Sidebar, Zero-Timeout Chrome MV3 Runtime:** Rather than running inside a cramped sidebar or an MV3 service worker (which Chrome terminates after ~30 seconds of idle/CPU inference), the extension toolbar popover (`extension/popup.html`) launches a dedicated full-screen `extension/workspace.html` tab. All `firebase/ai`, `window.LanguageModel`, Remote Config, and Firestore calls execute in a persistent `chrome-extension://` DOM context.
* **Accurate Network Egress Proof:** `measureNetworkBytes()` clears Chrome's `PerformanceResourceTiming` buffer before each serialized inference step (preventing Chrome's 250-entry cap from masking requests) and counts both matched Google/Firebase network requests and bytes transferred.

---

## Dual Surfaces

Both surfaces share the exact same React observatory UI (`src/components/AirlockWorkspace.tsx`) and inference engine (`src/lib/airlockEngine.ts`):

1. **Chrome MV3 Extension (`./dist-extension`):**
   * Select any combination of open authenticated tabs (private GitHub PRs, Gmail, Google Docs, Jira, `localhost`) from the toolbar popover.
   * Extracts clean readable DOM text locally with `0 bytes` egress and mounts each tab as an opaque source (`src_1`, `src_2`, ...).
   * Clicking **Jump Tab** on any source or agent tool hop focuses the original tab, scrolls to the matched snippet, and highlights it live.
2. **Hosted Firebase Web App (`./dist`):**
   * Zero-install experience for immediate evaluation: drag-and-drop local `.log`, `.har`, `.ts`, `.py`, `.md`, `.json`, `.sql`, or `.yaml` files directly into browser memory (`FileReader`), paste raw snippets, or click **Load Sample Pack** (a 3-file production incident spanning `prod-gateway-incident.log`, `reconciler-pool.ts`, and `slack-warroom-notes.md` with embedded JWTs, DB credentials, internal hostnames, and a real connection-pool leak bug).

---

## Firebase Integration

| Firebase Service | Role in Airlock Agent |
| :--- | :--- |
| **Firebase AI Logic (`firebase/ai`)** | Unified client SDK (`GoogleAIBackend`) driving both **on-device Gemini Nano 4** (`InferenceMode.ONLY_ON_DEVICE` / `PREFER_ON_DEVICE` with structured `Schema.object` constraints) and **Cloud Gemini** multi-turn `FunctionDeclarationsTool` orchestration—requiring zero custom backend proxy. |
| **Firebase Remote Config** | Live-tunes `cloud_agent_model` (default `gemini-4-hydrogen`, hot-swappable to `gemini-4-argon`), `airlock_fallback_model`, `max_agent_hops`, and `high_rtt_threshold_ms` without redeploying the web app or Chrome extension. |
| **Firebase App Check** | Protects cloud Gemini endpoints with `ReCaptchaEnterpriseProvider` on Web Hosting and automatically switches to Firebase's Debug Provider inside `chrome-extension://` (where MV3 CSP restricts external reCAPTCHA scripts). |
| **Cloud Firestore** | Append-only `airlock_runs` audit ledger enforced by strict `firestore.rules`—stores **only** aggregate numeric telemetry (`sourceCount`, `totalHops`, `vaultEntityCount`, `canaryLeaks`, `localScrubRequests`, `compressionPct`) and blocks updates, deletes, and arbitrary fields. |
| **Firebase Hosting** | Serves the static Vite web bundle (`./dist`) with zero backend server RAM footprint; all on-device Nano compute runs locally on the user's Chrome client. |

---

## Project Structure

```text
airlock-agent/
├── src/
│   ├── lib/
│   │   ├── firebase.ts              # Fail-loud env validation, getAI(), MV3-safe App Check, Remote Config
│   │   ├── vault.ts                 # Stateful Bijective SessionVault, secret regexes, Canary Leak Gate
│   │   ├── sources.ts               # Local source model + surgical tools (outline, grep, read_chunk)
│   │   ├── airlockEngine.ts         # Outbound Nano 4 scrubber + Cloud Gemini Function Calling loop
│   │   └── telemetry.ts             # Buffer-safe PerformanceResourceTiming counter + Firestore audit log
│   ├── components/
│   │   └── AirlockWorkspace.tsx     # 3-pane Observatory (Sources/Vault | Wire Inspector | Final Output)
│   └── App.tsx                      # Hosted Web App entry
├── extension/
│   ├── public/manifest.json         # MV3 manifest (tabs, scripting, storage)
│   ├── popup.html / popup.tsx       # Compact tab selector + Nano 4 user-gesture warm-up button
│   └── workspace.html / workspace.tsx # Persistent full-screen extension tab + Jump-to-Tab highlighter
├── firebase.json                    # Firebase Hosting + Firestore config
├── firestore.rules                  # Strict zero-PII append-only rules for airlock_runs
├── remoteconfig.template.json       # Remote Config defaults
├── vite.config.ts                   # Web build -> ./dist
└── vite.extension.config.ts         # Chrome MV3 build -> ./dist-extension
```

---

## Quick Start

### 1. Prerequisites
* **Node.js 20+** and **Firebase CLI** (`npx -y firebase-tools@latest`).
* **Google Chrome Desktop v139+** (official Chrome binary—Chromium/Brave do not bundle the Gemini Nano runtime).
* Enable Chrome's Built-in Prompt API:
  1. Open `chrome://flags/#prompt-api-for-gemini-nano` (or `#prompt-api-for-gemini-nano-multimodal-input`) $\rightarrow$ **Enabled**.
  2. *(Optional, for laptops under 16 GB RAM or without >4 GB dedicated VRAM)* Open `chrome://flags/#optimization-guide-on-device-model` $\rightarrow$ **Enabled BypassPerfRequirement**.
  3. Relaunch Chrome. Click **Warm Nano 4** in the extension popup (or run `await LanguageModel.create({ expectedInputs: [{ type: "text" }] })` in DevTools Console) once to download model weights locally.

### 2. Configure & Provision Firebase
```bash
cp .env.example .env.local
# Populate VITE_FIREBASE_API_KEY, VITE_FIREBASE_AUTH_DOMAIN,
# VITE_FIREBASE_PROJECT_ID, and VITE_FIREBASE_APP_ID from Firebase Console.

npx -y firebase-tools@latest login
npx -y firebase-tools@latest use --add
npx -y firebase-tools@latest init ailogic
npx -y firebase-tools@latest deploy --only firestore:rules
```

> **App Check Debug Token (Local & Chrome Extension):** Keep `VITE_APPCHECK_DEBUG_TOKEN=true` in `.env.local` during local development, copy the UUID printed in Chrome DevTools Console on first load, and register it under **Firebase Console > App Check > Apps > Manage debug tokens**. For the unpacked Chrome Extension (`chrome-extension://`), paste that registered UUID directly into `VITE_APPCHECK_DEBUG_TOKEN` before running `npm run build`.

### 3. Run Locally, Build Dual Targets, & Deploy
```bash
# Development server (Web App at http://localhost:5173)
npm run dev

# Typecheck + build BOTH ./dist (Web) and ./dist-extension (Chrome MV3)
npm run build

# Deploy Web App + Zero-PII Firestore Rules to Firebase Hosting
npx -y firebase-tools@latest deploy --only hosting,firestore:rules
```

To install the Chrome Extension locally:
1. Open `chrome://extensions` and toggle **Developer mode** on.
2. Click **Load unpacked** and select `./dist-extension`.
3. Open any private or `localhost` tabs, click the **Airlock Agent** toolbar icon, select tabs, and click **Open Airlock Workspace**.

---

## Verification Checklist

1. **Zero-Egress Local Scrubbing:** Open Chrome DevTools (**Network** tab filtered to `googleapis.com|firebase`). Load the sample incident pack (or drop your own `.log`/`.ts` files), ensure Airlock Scrubber Mode is `ONLY_ON_DEVICE`, and click **Run Airlock Agent**. Confirm every hop badge reads `Scrub: ON_DEVICE (0 req / 0 B)` and `Canary Leaks: 0`.
2. **Wire Airlock Audit:** In Column 2 (**Live Wire Airlock Inspector**), compare **RAW LOCAL TOOL OUTPUT** (red) against **WIRE PAYLOAD SENT TO CLOUD** (green) on each hop. Verify JWTs, PostgreSQL connection strings, API keys, emails, internal hostnames, people, and project names are replaced with `[SECRET_N]`, `[TOKEN_N]`, `[HOST_N]`, `[PERSON_N]`, `[ORG_N]`, and `[SERVICE_N]`.
3. **Lossless Local Re-hydration:** In Column 3 (**Final Output**), flip between **What Cloud Saw** (opaque placeholders only) and **Re-hydrated (Local)** (full original hostnames, service names, and runnable code fix restored client-side).
4. **Offline Failover:** Switch DevTools Network to **Offline** (or toggle **Local-Only**) and click **Run Airlock Agent**. Confirm execution degrades cleanly to `ON_DEVICE_OFFLINE` with `0` outbound cloud requests.

---

## Security Model & Scope Notes

* **Ephemeral RAM Vault:** `SessionVault` lives solely in the active page/tab's JavaScript memory and is discarded when the tab closes; raw values are never written to `localStorage`, `chrome.storage`, or Cloud Firestore.
* **Defense-in-Depth Boundary:** Deterministic regexes cover structured high-entropy credentials, while on-device Gemini Nano 4 covers unstructured contextual entities. Because small language models are probabilistic, the **Live Wire Airlock Inspector** surfaces exact outbound payloads for human verification, and the **Canary Leak Gate** enforces strict non-leakage for every entity registered in the session vault.

## License

Licensed under the [Apache License 2.0](./LICENSE).