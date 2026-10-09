import type { ReportEnvelope } from "@/native/sahay-nearby";
import { backoffMs, type ReportQueue } from "./queue";
import { verifyReceipt, type ServerKey } from "./envelope";

/**
 * Upload step of the delivery ladder (internet). Sends due envelopes from the local queue to POST /reports and,
 * on the Android app, also uploads reports other phones handed us through the Nearby relay.
 *
 * Outcomes per envelope (docs/api-contract.md section 2.2):
 *   200/202  delivered. The receipt is verified against the server key and kept.
 *   400/409/413/422  the server will never accept this envelope: mark "failed", do not retry.
 *   401/429/5xx/network  try again later with back-off.
 */
export interface RelayHooks {
  pendingForUpload(): Promise<{ envelopes: ReportEnvelope[] }>;
  markDelivered(opts: { reportId: string }): Promise<void>;
  relayReceipt(opts: {
    reportId: string;
    receipt: { server_time: string; signature: string };
  }): Promise<void>;
}

export interface FlushDeps {
  queue: ReportQueue;
  /** Needs the network when the token is missing or about to expire. Rejects when offline. */
  getToken: () => Promise<string>;
  apiBase: string;
  serverKey: () => Promise<ServerKey | null>;
  fetchFn?: typeof fetch;
  now?: () => number;
  relay?: RelayHooks | undefined;
  random?: () => number;
}

export interface FlushResult {
  sent: number;
  failed: number;
  retrying: number;
  relayed: number;
  /** true when no token could be obtained (offline): nothing was attempted */
  offline: boolean;
}

const PERMANENT = new Set([400, 409, 413, 422]);

interface UploadOutcome {
  kind: "sent" | "permanent" | "retry";
  receipt?: { server_time: string; signature: string } | undefined;
  error?: string | undefined;
}

async function upload(
  envelope: ReportEnvelope,
  token: string,
  apiBase: string,
  fetchFn: typeof fetch,
): Promise<UploadOutcome> {
  let response: Response;
  try {
    response = await fetchFn(`${apiBase.replace(/\/+$/, "")}/reports`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(envelope),
    });
  } catch {
    return { kind: "retry", error: "No connection" };
  }
  if (response.status === 200 || response.status === 202) {
    try {
      const body = (await response.json()) as {
        receipt?: { server_time: string; signature: string } | undefined;
      };
      return { kind: "sent", receipt: body.receipt };
    } catch {
      return { kind: "sent" };
    }
  }
  let message = `Server answered ${response.status}`;
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    if (body.error?.message) message = body.error.message;
  } catch {
    /* keep status message */
  }
  return PERMANENT.has(response.status)
    ? { kind: "permanent", error: message }
    : { kind: "retry", error: message };
}

export async function flushReports(deps: FlushDeps): Promise<FlushResult> {
  const now = deps.now ?? (() => Date.now());
  const fetchFn = deps.fetchFn ?? fetch.bind(globalThis);
  const result: FlushResult = {
    sent: 0,
    failed: 0,
    retrying: 0,
    relayed: 0,
    offline: false,
  };
  const due = await deps.queue.due(now());
  let relayPending: ReportEnvelope[] = [];
  if (deps.relay) {
    try {
      relayPending = (await deps.relay.pendingForUpload()).envelopes;
    } catch {
      relayPending = [];
    }
  }
  if (due.length === 0 && relayPending.length === 0) return result;

  let token: string;
  try {
    token = await deps.getToken();
  } catch {
    result.offline = true;
    return result;
  }
  const key = await deps.serverKey();
  const own = new Set((await deps.queue.all()).map((i) => i.report_id));

  for (const item of due) {
    const outcome = await upload(item.envelope, token, deps.apiBase, fetchFn);
    if (outcome.kind === "sent") {
      const verified =
        outcome.receipt && key
          ? await verifyReceipt(item.report_id, outcome.receipt, key)
          : false;
      await deps.queue.update(item.report_id, {
        state: "sent",
        attempts: item.attempts + 1,
        receipt: outcome.receipt,
        receipt_verified: verified,
        last_error: undefined,
      });
      await deps.relay
        ?.markDelivered({ reportId: item.report_id })
        .catch(() => {});
      result.sent += 1;
    } else if (outcome.kind === "permanent") {
      await deps.queue.update(item.report_id, {
        state: "failed",
        attempts: item.attempts + 1,
        last_error: outcome.error,
      });
      result.failed += 1;
    } else {
      await deps.queue.update(item.report_id, {
        attempts: item.attempts + 1,
        next_attempt_at: now() + backoffMs(item.attempts, deps.random),
        last_error: outcome.error,
      });
      result.retrying += 1;
    }
  }

  // Reports other phones gave us over Nearby. Our own are handled above (the relay engine lists them too).
  for (const envelope of relayPending) {
    if (own.has(envelope.report_id) || !deps.relay) continue;
    const outcome = await upload(envelope, token, deps.apiBase, fetchFn);
    if (outcome.kind === "retry") continue; // the relay engine keeps it; we try again next flush
    if (outcome.kind === "sent" && outcome.receipt) {
      await deps.relay
        .relayReceipt({
          reportId: envelope.report_id,
          receipt: outcome.receipt,
        })
        .catch(() => {});
    }
    await deps.relay
      .markDelivered({ reportId: envelope.report_id })
      .catch(() => {});
    result.relayed += 1;
  }
  return result;
}
