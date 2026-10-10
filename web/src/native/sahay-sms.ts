import { WebPlugin, registerPlugin } from "@capacitor/core";

/** Types follow docs/api-contract.md section 6. Android only: a browser cannot send a silent SMS. */
export interface SahaySmsPlugin {
  /** Silent SMS via SmsManager. Asks for SEND_SMS on first use. `sent` is true only when the radio reports it sent. */
  send(opts: { to: string; body: string }): Promise<{ sent: boolean }>;
  canSend(): Promise<{ available: boolean; granted: boolean }>;
  /** ACTION_DIAL only: opens the dialer with the number prefilled. Never places a call. */
  openDialer(opts: { number: string }): Promise<void>;
}

class SahaySmsWeb extends WebPlugin implements SahaySmsPlugin {
  send = () => Promise.resolve({ sent: false });
  canSend = async () => ({ available: false, granted: false });
  openDialer = async ({ number }: { number: string }) => {
    window.location.href = `tel:${number}`;
  };
}

export const SahaySms = registerPlugin<SahaySmsPlugin>("SahaySms", {
  web: () => new SahaySmsWeb(),
});
