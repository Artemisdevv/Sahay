import { useEffect, useRef, useState } from "react";
import {
  HeartPulse,
  Flame,
  LifeBuoy,
  MessageSquare,
  Mic,
  Square,
  ClipboardList,
  UserRound,
  Phone,
  Check,
  LoaderCircle,
  Pencil,
  LocateFixed,
  MapPin,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { Shell, type ShellTab } from "./dispatch-shell";
import {
  defaultProfile,
  type EmergencyProfile,
  type IncidentType,
} from "@/lib/dispatch";
import { useVoiceCapture } from "@/hooks/use-voice-capture";

const tabs: ShellTab[] = [
  { id: "help", label: "Get help", icon: Mic },
  { id: "reports", label: "My reports", icon: ClipboardList },
  { id: "details", label: "My details", icon: UserRound },
];

const choices: { id: IncidentType; label: string; icon: typeof HeartPulse }[] =
  [
    { id: "medical", label: "Medical", icon: HeartPulse },
    { id: "fire", label: "Fire or smoke", icon: Flame },
    { id: "rescue", label: "Someone is trapped", icon: LifeBuoy },
    { id: "other", label: "Something else", icon: MessageSquare },
  ];
const choiceLabel = (id: IncidentType) =>
  choices.find((c) => c.id === id)?.label ?? "Help";

const profileFields = [
  ["fullName", "Full name"],
  ["age", "Age"],
  ["bloodGroup", "Blood group"],
  ["language", "Language you speak"],
  ["contactName", "Emergency contact name"],
  ["phone", "Emergency contact phone"],
  ["conditions", "Health conditions"],
  ["allergies", "Allergies"],
  ["medications", "Medicines you take"],
  ["address", "Home address"],
  ["access", "How to get in (gate, floor)"],
  ["mobility", "Trouble walking or moving"],
] as const;

type Report = {
  id: string;
  name: string;
  when: string;
  status: "Resolved" | "In progress";
};

const fmt = (s: number) =>
  `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

export function CitizenPortal() {
  const [tab, setTab] = useState("help");
  const [step, setStep] = useState(-1); // -1 = not sent, 0..2 = progress, 3 = done
  const [picked, setPicked] = useState<IncidentType | null>(null);
  const [note, setNote] = useState("");
  const [location, setLocation] = useState("Kochi, Kerala");
  const [profile, setProfile] = useState<EmergencyProfile>(defaultProfile);
  const [draft, setDraft] = useState<EmergencyProfile>(defaultProfile);
  const [profileOpen, setProfileOpen] = useState(false);
  const [consent, setConsent] = useState(true);
  const [reports, setReports] = useState<Report[]>([
    {
      id: "REQ-1048",
      name: "Medical",
      when: "7 Oct 2026, 2:32 pm",
      status: "Resolved",
    },
    {
      id: "REQ-1036",
      name: "Something else",
      when: "28 Sep 2026, 9:18 am",
      status: "Resolved",
    },
  ]);
  const voice = useVoiceCapture();

  useEffect(() => {
    if (step < 0 || step >= 3) return;
    const timer = setTimeout(() => setStep((s) => s + 1), 1600);
    return () => clearTimeout(timer);
  }, [step]);

  function updateLocation() {
    if (!navigator.geolocation) {
      toast.error(
        "This phone cannot share its location. Type your address in My details.",
      );
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setLocation(
          `${p.coords.latitude.toFixed(4)}, ${p.coords.longitude.toFixed(4)}`,
        );
        toast.success("Location updated");
      },
      () => toast.error("Location is off. Turn it on in phone settings."),
      { timeout: 8000 },
    );
  }

  const hasReport = !!voice.clip || !!picked || note.trim().length >= 5;

  function send() {
    if (!hasReport) return;
    const type = picked ?? "other";
    setReports((r) => [
      {
        id: `REQ-${1050 + r.length}`,
        name: choiceLabel(type),
        when: "Just now",
        status: "In progress",
      },
      ...r,
    ]);
    setStep(0);
    // F-03 hook: voice.clip.blob + location + picked + note go to the signed, encrypted report queue here.
  }

  function startOver() {
    setStep(-1);
    setPicked(null);
    setNote("");
    voice.reset();
  }

  function saveProfile() {
    if (
      !draft.fullName.trim() ||
      !draft.age ||
      Number(draft.age) < 1 ||
      Number(draft.age) > 120
    ) {
      toast.error("Enter your name and your age (1 to 120).");
      return;
    }
    setProfile(draft);
    setProfileOpen(false);
    toast.success("Details saved on this phone");
  }

  return (
    <Shell
      title={tabs.find((t) => t.id === tab)?.label ?? "Sahay"}
      tabs={tabs}
      activeTab={tab}
      onTab={setTab}
    >
      {tab === "help" && step < 0 && (
        <section className="cz-help" aria-labelledby="help-title">
          <h1 id="help-title">Do you need help?</h1>
          <p className="cz-lead">Hold the button and say what happened.</p>

          <MicButton voice={voice} />

          {voice.state === "ready" && voice.clip && (
            <div className="cz-clip">
              <p>Your message ({fmt(voice.clip.seconds)})</p>
              <audio controls src={voice.clip.url} />
              <Button
                variant="outline"
                className="cz-secondary"
                onClick={voice.reset}
              >
                Record again
              </Button>
            </div>
          )}
          {voice.state === "denied" && (
            <p className="cz-warn" role="alert">
              The microphone is off. Allow it in phone settings, or choose what
              is happening below.
            </p>
          )}
          {voice.state === "unsupported" && (
            <p className="cz-warn" role="alert">
              This phone cannot record here. Choose what is happening below.
            </p>
          )}

          <h2 className="cz-sub">Or tap what is happening</h2>
          <div className="cz-choices">
            {choices.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`cz-choice ${picked === c.id ? "selected" : ""}`}
                aria-pressed={picked === c.id}
                onClick={() => setPicked(picked === c.id ? null : c.id)}
              >
                <c.icon />
                {c.label}
              </button>
            ))}
          </div>

          <details className="cz-type">
            <summary>Type a message instead</summary>
            <textarea
              aria-label="Your message"
              placeholder="Say what happened and where you are"
              value={note}
              maxLength={1000}
              onChange={(e) => setNote(e.target.value)}
            />
          </details>

          <div className="cz-where">
            <MapPin />
            <span>
              Your location: <strong>{location}</strong>
            </span>
            <button type="button" onClick={updateLocation}>
              <LocateFixed />
              Update
            </button>
          </div>

          <Button className="cz-send" disabled={!hasReport} onClick={send}>
            Send help request
          </Button>
          {!hasReport && (
            <p className="cz-hint">
              Record a message or tap what is happening to send.
            </p>
          )}

          <a href="tel:112" className="cz-call">
            <Phone />
            Call 112 now
          </a>
          <p className="cz-hint">
            In danger? Call first. This demo does not contact real services.
          </p>
        </section>
      )}

      {tab === "help" && step >= 0 && (
        <section className="cz-help" aria-live="polite">
          <h1>{step >= 2 ? "Help is on the way" : "We are working on it"}</h1>
          <p className="cz-lead">Demo only. No real services are contacted.</p>
          <ol className="cz-steps">
            {[
              "We got your request",
              "We are finding the nearest help",
              "A team has been told to go to you",
            ].map((label, i) => (
              <li
                key={label}
                className={step > i ? "done" : step === i ? "now" : ""}
              >
                <span className="cz-step-mark" aria-hidden>
                  {step > i ? (
                    <Check />
                  ) : step === i ? (
                    <LoaderCircle className="animate-spin" />
                  ) : null}
                </span>
                {label}
              </li>
            ))}
          </ol>
          <a href="tel:112" className="cz-call">
            <Phone />
            Call 112 now
          </a>
          <Button
            variant="outline"
            className="cz-secondary"
            onClick={startOver}
          >
            Done
          </Button>
        </section>
      )}

      {tab === "reports" && (
        <section className="cz-page" aria-labelledby="reports-title">
          <h1 id="reports-title">My reports</h1>
          <ul className="cz-list">
            {reports.map((r) => (
              <li key={r.id}>
                <div>
                  <strong>{r.name}</strong>
                  <small>{r.when}</small>
                </div>
                <span
                  className={`cz-status ${r.status === "Resolved" ? "ok" : "wait"}`}
                >
                  {r.status}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {tab === "details" && (
        <section className="cz-page" aria-labelledby="details-title">
          <h1 id="details-title">My details</h1>
          <p className="cz-lead">
            Kept on this phone. Shared with the response team only if you allow
            it.
          </p>
          <dl className="cz-facts">
            <div>
              <dt>Name</dt>
              <dd>{profile.fullName}</dd>
            </div>
            <div>
              <dt>Age</dt>
              <dd>{profile.age}</dd>
            </div>
            <div>
              <dt>Blood group</dt>
              <dd>{profile.bloodGroup}</dd>
            </div>
            <div>
              <dt>Health conditions</dt>
              <dd>{profile.conditions}</dd>
            </div>
            <div>
              <dt>Allergies</dt>
              <dd>{profile.allergies}</dd>
            </div>
            <div>
              <dt>Emergency contact</dt>
              <dd>
                {profile.contactName} {profile.phone}
              </dd>
            </div>
          </dl>
          <Button
            variant="outline"
            className="cz-secondary"
            onClick={() => {
              setDraft(profile);
              setProfileOpen(true);
            }}
          >
            <Pencil />
            Change my details
          </Button>
          <label className="cz-consent">
            <span>
              Share my health details with the response team
              <small>
                {consent
                  ? "On. They can see them when you ask for help."
                  : "Off. They will not see them."}
              </small>
            </span>
            <Switch
              checked={consent}
              onCheckedChange={setConsent}
              aria-label="Share my health details"
            />
          </label>
        </section>
      )}

      <Dialog open={profileOpen} onOpenChange={setProfileOpen}>
        <DialogContent className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle>My details</DialogTitle>
            <DialogDescription>Saved on this phone only.</DialogDescription>
          </DialogHeader>
          <div className="cz-form">
            {profileFields.map(([key, label]) => (
              <label key={key}>
                {label}
                <input
                  value={draft[key]}
                  maxLength={300}
                  inputMode={key === "age" ? "numeric" : undefined}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, [key]: e.target.value }))
                  }
                />
              </label>
            ))}
          </div>
          <Button className="cz-send" onClick={saveProfile}>
            Save
          </Button>
        </DialogContent>
      </Dialog>
    </Shell>
  );
}

/**
 * The one big control of the app. Hold to record, or tap once to start and tap again to stop
 * (some people cannot hold a button steady). Keyboard: Space or Enter toggles.
 */
function MicButton({ voice }: { voice: ReturnType<typeof useVoiceCapture> }) {
  const downAt = useRef(0);
  const sticky = useRef(false);
  const recording = voice.state === "recording";
  const disabled = voice.state === "unsupported";

  function onDown(e: React.PointerEvent) {
    if (disabled) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (recording && sticky.current) return; // second tap will stop on release
    downAt.current = Date.now();
    sticky.current = false;
    void voice.start();
  }
  function onUp() {
    if (disabled) return;
    if (recording && sticky.current) {
      sticky.current = false;
      voice.stop();
      return;
    }
    if (Date.now() - downAt.current < 450) {
      sticky.current = true; // quick tap: keep recording until the next tap
      return;
    }
    voice.stop();
  }
  function onKey(e: React.KeyboardEvent) {
    if (e.key !== " " && e.key !== "Enter") return;
    e.preventDefault();
    if (e.repeat) return;
    if (recording) voice.stop();
    else void voice.start();
  }

  return (
    <div className="cz-mic-wrap">
      <button
        type="button"
        className={`cz-mic ${recording ? "recording" : ""}`}
        aria-label={
          recording
            ? "Stop recording"
            : "Record a message. Hold, or tap to start and tap to stop"
        }
        disabled={disabled}
        onPointerDown={onDown}
        onPointerUp={onUp}
        onPointerCancel={() => recording && !sticky.current && voice.stop()}
        onKeyDown={onKey}
        onContextMenu={(e) => e.preventDefault()}
      >
        {recording ? <Square /> : <Mic />}
      </button>
      <p className="cz-mic-label" aria-live="polite">
        {recording
          ? `Recording ${fmt(voice.seconds)}. Let go, or tap, to stop.`
          : voice.state === "ready"
            ? "Message saved. Check it below."
            : "Hold to talk"}
      </p>
    </div>
  );
}
