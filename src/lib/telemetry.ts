import {
  addDoc,
  collection,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
} from "firebase/firestore";
import { db } from "./firebase";

export interface StoredAirlockRun {
  id: string;
  surface: "web" | "extension";
  sourceCount: number;
  totalHops: number;
  vaultEntityCount: number;
  canaryLeaks: number;
  localScrubCalls: number;
  localScrubRequests: number;
  cloudModel: string;
  totalLatencyMs: number;
  compressionPct: number;
}

/**
 * Clears PerformanceResourceTiming right before each serialized operation so
 * Chrome's 250-entry buffer cap never silently masks real cloud requests.
 */
export async function measureNetworkBytes<T>(
  operation: () => Promise<T>
): Promise<{ result: T; egressBytes: number; matchedRequests: number }> {
  if (typeof performance.clearResourceTimings === "function") {
    performance.clearResourceTimings();
  }
  const result = await operation();
  const entries = performance.getEntriesByType(
    "resource"
  ) as PerformanceResourceTiming[];

  const aiEntries = entries.filter(
    (entry) =>
      entry.name.includes("googleapis.com") ||
      entry.name.includes("firebase") ||
      entry.name.includes("generativelanguage")
  );

  const egressBytes = aiEntries.reduce(
    (sum, entry) => sum + (entry.transferSize || entry.encodedBodySize || 0),
    0
  );

  return { result, egressBytes, matchedRequests: aiEntries.length };
}

export async function logAirlockRunToFirestore(
  payload: Omit<StoredAirlockRun, "id">
): Promise<string> {
  if (!navigator.onLine) {
    throw new Error(
      "[OFFLINE_PERSISTENCE_SKIPPED] Offline; skipping remote Firestore audit write."
    );
  }
  const ref = await addDoc(collection(db, "airlock_runs"), {
    ...payload,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export async function fetchRecentAirlockRuns(
  maxCount = 8
): Promise<StoredAirlockRun[]> {
  if (!navigator.onLine) return [];
  const q = query(
    collection(db, "airlock_runs"),
    orderBy("createdAt", "desc"),
    limit(maxCount)
  );
  const snap = await getDocs(q);
  return snap.docs.map((doc) => ({
    id: doc.id,
    ...(doc.data() as Omit<StoredAirlockRun, "id">),
  }));
}
