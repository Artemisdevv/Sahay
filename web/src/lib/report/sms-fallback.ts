import type { QueueItem, ReportQueue } from "./queue";
import type { SahaySmsPlugin } from "@/native/sahay-sms";

/**
 * Last rung of the delivery ladder (api-contract.md section 6): internet -> Nearby relay -> SMS -> store and retry.
 *
 * A report that is still queued after a grace period, with no internet, is announced by one compact SMS to the
 * gateway: report id, device id, position, category and time. No text, no audio, no name. The sealed report stays in
 * the queue and still goes out over the internet or a relay later, so the response centre gets the full message when
 * there is a connection. The SMS line is kept in memory only: the queue never holds a readable position.
 */
const CODES: Record<string, string> = {
  accident: "AC",
  fire: "FI",
  medical: "ME",
  crime: "CR",
  flood: "FL",
  other: "OT",
};

export interface SmsLineInput {
  reportId: string;
  deviceId: string;
  lat: number;
  lng: number;
  category: string;
  sos: boolean;
  /** epoch seconds */
  ts: number;
}

/** `SAHAY1|<report id 8>|<device id 8>|<lat 5dp>,<lng 5dp>|<code>|<ts>`: GSM-7 only, well under 160 characters. */
export function buildSmsLine(i: SmsLineInput): string {
  const id8 = (v: string) => v.replace(/-/g, "").slice(0, 8).toLowerCase();
  const code = i.sos ? "SO" : (CODES[i.category] ?? "OT");
  return `SAHAY1|${id8(i.reportId)}|${id8(i.deviceId)}|${i.lat.toFixed(5)},${i.lng.toFixed(5)}|${code}|${Math.floor(i.ts)}`;
}

/** An SOS has no time to lose; a normal report waits longer when a nearby phone is already carrying it. */
export function smsDelayMs(sos: boolean, nearbyPeers: number): number {
  if (sos) return 20_000;
  return nearbyPeers > 0 ? 180_000 : 45_000;
}

export interface SmsDeps {
  queue: Pick<ReportQueue, "all" | "update">;
  lines: Map<string, { line: string; sos: boolean }>;
  gatewayNumber: () => string | null;
  nearbyPeers: () => number;
  online: () => boolean;
  sms: Pick<SahaySmsPlugin, "send">;
  now?: () => number;
}

/** One pass: send the SMS for every queued report that has waited long enough. Returns the report ids texted. */
export async function runSmsFallback(deps: SmsDeps): Promise<string[]> {
  const gateway = deps.gatewayNumber();
  if (!gateway) return [];
  const now = (deps.now ?? Date.now)();
  const texted: string[] = [];
  for (const item of await deps.queue.all()) {
    if (item.state !== "queued" || item.sms_sent_at) continue;
    // Offline means the radio says so, or an upload already failed (Wi-Fi with no internet looks "online").
    if (deps.online() && item.attempts < 1) continue;
    const entry = deps.lines.get(item.report_id);
    if (!entry) continue;
    const waited = now - Date.parse(item.created_at);
    if (waited < smsDelayMs(entry.sos, deps.nearbyPeers())) continue;
    try {
      const { sent } = await deps.sms.send({ to: gateway, body: entry.line });
      if (sent) {
        await deps.queue.update(item.report_id, {
          sms_sent_at: now,
        } as Partial<QueueItem>);
        texted.push(item.report_id);
      }
    } catch {
      /* permission refused or no SIM: the sealed report is still queued for internet or relay */
    }
  }
  return texted;
}
