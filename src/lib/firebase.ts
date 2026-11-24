import { initializeApp, type FirebaseApp } from "firebase/app";
import { getAI, GoogleAIBackend, type AI } from "firebase/ai";
import {
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
  type AppCheck,
} from "firebase/app-check";
import { getFirestore, type Firestore } from "firebase/firestore";
import {
  getRemoteConfig,
  fetchAndActivate,
  getString,
  getNumber,
  type RemoteConfig,
} from "firebase/remote-config";

declare global {
  interface Window {
    FIREBASE_APPCHECK_DEBUG_TOKEN?: boolean | string;
  }
}

function requireEnv(key: keyof ImportMetaEnv): string {
  const value = import.meta.env[key];
  if (!value || value.trim() === "") {
    throw new Error(
      `[FATAL_CONFIG_ERROR] Missing required environment variable "${String(
        key
      )}". Copy .env.example to .env.local and provide real Firebase credentials.`
    );
  }
  return value.trim();
}

const firebaseConfig = {
  apiKey: requireEnv("VITE_FIREBASE_API_KEY"),
  authDomain: requireEnv("VITE_FIREBASE_AUTH_DOMAIN"),
  projectId: requireEnv("VITE_FIREBASE_PROJECT_ID"),
  appId: requireEnv("VITE_FIREBASE_APP_ID"),
};

export const firebaseApp: FirebaseApp = initializeApp(firebaseConfig);

export let appCheck: AppCheck | null = null;
export let appCheckStatus:
  | "ENFORCED"
  | "EXT_DEBUG_TOKEN"
  | "DEBUG_TOKEN_ONLY"
  | "NOT_CONFIGURED" = "NOT_CONFIGURED";

if (typeof window !== "undefined") {
  const isExtension = window.location.protocol === "chrome-extension:";
  const debugToken = import.meta.env.VITE_APPCHECK_DEBUG_TOKEN?.trim();
  const siteKey = import.meta.env.VITE_RECAPTCHA_ENTERPRISE_SITE_KEY?.trim();

  if (debugToken) {
    window.FIREBASE_APPCHECK_DEBUG_TOKEN =
      debugToken === "true" ? true : debugToken;
  }

  // Inside chrome-extension:// MV3 CSP blocks external reCAPTCHA scripts;
  // DebugProvider takes over cleanly when FIREBASE_APPCHECK_DEBUG_TOKEN is set.
  if (navigator.onLine) {
    if (isExtension && debugToken) {
      appCheck = initializeAppCheck(firebaseApp, {
        provider: new ReCaptchaEnterpriseProvider(
          siteKey || "extension-debug-provider"
        ),
        isTokenAutoRefreshEnabled: true,
      });
      appCheckStatus = "EXT_DEBUG_TOKEN";
    } else if (!isExtension && siteKey) {
      appCheck = initializeAppCheck(firebaseApp, {
        provider: new ReCaptchaEnterpriseProvider(siteKey),
        isTokenAutoRefreshEnabled: true,
      });
      appCheckStatus = "ENFORCED";
    } else if (debugToken) {
      appCheckStatus = "DEBUG_TOKEN_ONLY";
    }
  }
}

export const ai: AI = getAI(firebaseApp, {
  backend: new GoogleAIBackend(),
});

export const db: Firestore = getFirestore(firebaseApp);

export const remoteConfig: RemoteConfig = getRemoteConfig(firebaseApp);
remoteConfig.settings.minimumFetchIntervalMillis = 60_000;
remoteConfig.defaultConfig = {
  cloud_agent_model: "gemini-4-hydrogen",
  airlock_fallback_model: "gemini-4-hydrogen",
  max_agent_hops: 6,
  high_rtt_threshold_ms: 400,
};

export interface LiveRuntimeConfig {
  cloudAgentModel: string;
  airlockFallbackModel: string;
  maxAgentHops: number;
  highRttThresholdMs: number;
  remoteConfigSynced: boolean;
}

export async function loadRuntimeConfig(): Promise<LiveRuntimeConfig> {
  let remoteConfigSynced = false;
  if (navigator.onLine) {
    const timeout = new Promise<boolean>((resolve) =>
      setTimeout(() => resolve(false), 3000)
    );
    try {
      remoteConfigSynced = await Promise.race([
        fetchAndActivate(remoteConfig),
        timeout,
      ]);
    } catch {
      remoteConfigSynced = false;
    }
  }

  return {
    cloudAgentModel: getString(remoteConfig, "cloud_agent_model"),
    airlockFallbackModel: getString(remoteConfig, "airlock_fallback_model"),
    maxAgentHops: Math.max(1, Math.min(10, getNumber(remoteConfig, "max_agent_hops"))),
    highRttThresholdMs: getNumber(remoteConfig, "high_rtt_threshold_ms"),
    remoteConfigSynced,
  };
}
