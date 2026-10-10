import type { ReportEnvelope } from "@/native/sahay-nearby";

/**
 * Offline report queue in IndexedDB. It only ever holds sealed envelopes (see envelope.ts): the report plaintext is
 * encrypted to the server key before it is stored, so there is nothing readable on disk, even in the browser.
 * Items are kept after delivery (state "sent") so "My reports" can show history; the receipt is kept as proof.
 */
export type QueueState = "queued" | "sent" | "failed";

export interface QueueItem {
  report_id: string;
  envelope: ReportEnvelope;
  category: string;
  created_at: string;
  state: QueueState;
  attempts: number;
  /** epoch ms: do not retry before this time */
  next_attempt_at: number;
  last_error?: string | undefined;
  receipt?: { server_time: string; signature: string } | undefined;
  receipt_verified?: boolean;
  /** how the receipt reached us: straight from the server, or back through nearby phones */
  via?: "internet" | "relay";
  /** epoch ms: a compact SMS announcing this report was sent to the gateway (no text, only position and type) */
  sms_sent_at?: number | undefined;
  /** latest signed status that came back over the relay while we were offline */
  relay_status?: { status: string; message: string } | undefined;
}

const DB_NAME = "sahay-reports";
const STORE = "reports";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

export class ReportQueue {
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(private readonly factory: IDBFactory = indexedDB) {}

  private db(): Promise<IDBDatabase> {
    this.dbPromise ??= new Promise((resolve, reject) => {
      const open = this.factory.open(DB_NAME, 1);
      open.onupgradeneeded = () => {
        open.result.createObjectStore(STORE, { keyPath: "report_id" });
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () =>
        reject(open.error ?? new Error("Cannot open IndexedDB"));
    });
    return this.dbPromise;
  }

  private async store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    return (await this.db()).transaction(STORE, mode).objectStore(STORE);
  }

  async put(item: QueueItem): Promise<void> {
    await request((await this.store("readwrite")).put(item));
  }

  async get(reportId: string): Promise<QueueItem | undefined> {
    return (await request((await this.store("readonly")).get(reportId))) as
      QueueItem | undefined;
  }

  /** Newest first. */
  async all(): Promise<QueueItem[]> {
    const rows = (await request(
      (await this.store("readonly")).getAll(),
    )) as QueueItem[];
    return rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  /** Read-modify-write inside one transaction so two flushes cannot overwrite each other. */
  async update(
    reportId: string,
    patch: Partial<QueueItem>,
  ): Promise<QueueItem | undefined> {
    const store = await this.store("readwrite");
    const current = (await request(store.get(reportId))) as
      QueueItem | undefined;
    if (!current) return undefined;
    const next = { ...current, ...patch, report_id: current.report_id };
    await request(store.put(next));
    return next;
  }

  async due(now: number): Promise<QueueItem[]> {
    return (await this.all()).filter(
      (i) => i.state === "queued" && i.next_attempt_at <= now,
    );
  }
}

/** 5 s, 15 s, 45 s, 2 min, 5 min, then every 5 min. A little jitter so phones do not retry in lockstep. */
export function backoffMs(
  attempts: number,
  random: () => number = Math.random,
): number {
  const base =
    [5_000, 15_000, 45_000, 120_000, 300_000][Math.min(attempts, 4)] ?? 300_000;
  return Math.round(base * (0.85 + random() * 0.3));
}
