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
  Camera,
  X,
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
import { IncidentMap, Shell, type ShellTab } from "./dispatch-shell";
import {
  defaultProfile,
  type EmergencyProfile,
  type IncidentType,
} from "@/lib/dispatch";
import { useVoiceCapture } from "@/hooks/use-voice-capture";
import {
  fetchStatus,
  listReports,
  NotReadyError,
  PayloadError,
  retryFailedNow,
  setRelayEnabled,
  submitReport,
  type ReportStatus,
} from "@/lib/report/service";
import type { Category } from "@/lib/report/envelope";
import { warmLocation } from "@/lib/report/location";
import {
  getRelayState,
  isRelayEnabled,
  relaySupported,
  watchRelay,
  type RelayState,
} from "@/lib/report/relay";
import type { QueueItem } from "@/lib/report/queue";

const tabs: ShellTab[] = [
  { id: "help", label: "Get help", icon: Mic },
  { id: "reports", label: "My reports", icon: ClipboardList },
  { id: "map", label: "Map", icon: MapPin },
  { id: "details", label: "My details", icon: UserRound },
];

const choices: { id: IncidentType; label: string; icon: typeof HeartPulse }[] =
  [
    { id: "medical", label: "Medical", icon: HeartPulse },
    { id: "fire", label: "Fire", icon: Flame },
    { id: "rescue", label: "Rescue", icon: LifeBuoy },
    { id: "other", label: "Other", icon: MessageSquare },
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

const CATEGORY_FOR: Record<IncidentType, Category> = {
  medical: "medical",
  fire: "fire",
  rescue: "accident",
  other: "other",
};
const LANGUAGE_CODES: Record<string, string> = {
  english: "en",
  malayalam: "ml",
  hindi: "hi",
  tamil: "ta",
};
const HELP_ARRANGED = new Set([
  "dispatched",
  "en_route",
  "on_scene",
  "resolved",
]);
const NICE_CATEGORY: Record<string, string> = {
  medical: "Medical",
  fire: "Fire or smoke",
  accident: "Accident or trapped",
  crime: "Crime",
  flood: "Flood",
  other: "Something else",
};
const whenText = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
type ScenePhoto = { file: File; url: string };

// An SOS may carry no message at all. The server needs audio or text, so it gets this line.
const SOS_TEXT = "SOS: the sender needs urgent help and could not describe it.";
const SOS_HOLD_MS = 2000;

const fmt = (s: number) =>
  `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

export function CitizenPortal() {
  const [tab, setTab] = useState("help");
  const [current, setCurrent] = useState<QueueItem | null>(null);
  const [status, setStatus] = useState<ReportStatus | null>(null);
  const [sending, setSending] = useState(false);
  const [approx, setApprox] = useState(false);
  const [picked, setPicked] = useState<IncidentType | null>(null);
  const [note, setNote] = useState("");
  const [location, setLocation] = useState("Kochi, Kerala");
  const [profile, setProfile] = useState<EmergencyProfile>(defaultProfile);
  const [draft, setDraft] = useState<EmergencyProfile>(defaultProfile);
  const [profileOpen, setProfileOpen] = useState(false);
  const [consent, setConsent] = useState(true);
  const [reports, setReports] = useState<QueueItem[]>([]);
  const [photoChoiceOpen, setPhotoChoiceOpen] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [photos, setPhotos] = useState<ScenePhoto[]>([]);
  const photoInput = useRef<HTMLInputElement>(null);
  const cameraVideo = useRef<HTMLVideoElement>(null);
  const cameraStream = useRef<MediaStream | null>(null);
  const photoUrls = useRef<string[]>([]);
  const [relay, setRelay] = useState<RelayState>(getRelayState());
  const [relayOn, setRelayOn] = useState(true);
  useEffect(() => {
    setRelayOn(isRelayEnabled());
    return watchRelay(setRelay);
  }, []);
  const voice = useVoiceCapture();
  // Follow the position while this screen is open so sending does not wait for a GPS fix.
  useEffect(() => warmLocation(), []);
  const [canUseCamera, setCanUseCamera] = useState(false);

  // Follow the report we just sent: local queue state every 3 s, server status once it is delivered.
  const currentId = current?.report_id;
  useEffect(() => {
    if (!currentId) return;
    let alive = true;
    const tick = async () => {
      const row = (await listReports()).find((r) => r.report_id === currentId);
      if (!alive || !row) return;
      setCurrent(row);
      if (row.state === "sent") {
        const st = await fetchStatus(currentId);
        if (alive && st) setStatus(st);
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [currentId]);

  useEffect(() => {
    if (tab !== "reports") return;
    let alive = true;
    const load = () =>
      void listReports().then((rows) => alive && setReports(rows));
    load();
    const timer = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [tab]);

  useEffect(() => {
    if (cameraOpen && cameraVideo.current && cameraStream.current) {
      cameraVideo.current.srcObject = cameraStream.current;
      void cameraVideo.current.play().catch(() => undefined);
    }
  }, [cameraOpen]);

  useEffect(() => {
    setCanUseCamera(
      typeof navigator !== "undefined" &&
        typeof navigator.mediaDevices?.getUserMedia === "function",
    );
  }, []);

  useEffect(
    () => () => {
      photoUrls.current.forEach((url) => URL.revokeObjectURL(url));
      cameraStream.current?.getTracks().forEach((track) => track.stop());
    },
    [],
  );

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

  function attachPhotos(files: Iterable<File> | null) {
    if (!files) return;
    const next: ScenePhoto[] = [];
    for (const file of files) {
      if (!file.type.startsWith("image/") || file.size > 10 * 1024 * 1024) {
        toast.error("Choose an image smaller than 10 MB.");
        continue;
      }
      if (photos.length + next.length >= 3) {
        toast.error("You can attach up to 3 photos.");
        break;
      }
      const url = URL.createObjectURL(file);
      photoUrls.current.push(url);
      next.push({ file, url });
    }
    setPhotos((current) => [...current, ...next].slice(0, 3));
    if (photoInput.current) photoInput.current.value = "";
  }

  async function openCamera() {
    if (!canUseCamera) {
      toast.error(
        "Camera capture isn’t available here. You can still upload an image.",
      );
      return;
    }
    try {
      cameraStream.current = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      setPhotoChoiceOpen(false);
      setCameraOpen(true);
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        toast.error("Camera access was denied. You can still upload an image.");
      } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        toast.error(
          "No camera is available on this device. You can still upload an image.",
        );
      } else {
        toast.error("Couldn’t open the camera. You can still upload an image.");
      }
      cameraStream.current?.getTracks().forEach((track) => track.stop());
      cameraStream.current = null;
    }
  }

  function closeCamera() {
    cameraStream.current?.getTracks().forEach((track) => track.stop());
    cameraStream.current = null;
    setCameraOpen(false);
  }

  function capturePhoto() {
    const video = cameraVideo.current;
    if (!video?.videoWidth || !video.videoHeight) {
      toast.error("Camera is still starting. Try again in a moment.");
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) {
      toast.error(
        "Couldn’t capture the photo. You can upload an image instead.",
      );
      return;
    }
    context.drawImage(video, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          toast.error(
            "Couldn’t capture the photo. Try again or upload an image.",
          );
          return;
        }
        attachPhotos([
          new File([blob], `scene-${Date.now()}.jpg`, { type: "image/jpeg" }),
        ]);
        closeCamera();
      },
      "image/jpeg",
      0.9,
    );
  }

  function removePhoto(photo: ScenePhoto) {
    URL.revokeObjectURL(photo.url);
    photoUrls.current = photoUrls.current.filter((url) => url !== photo.url);
    setPhotos((current) => current.filter((item) => item.url !== photo.url));
  }

  // A category alone is not a report: the response team needs a message. The buttons only label it.
  const hasReport = !!voice.clip || note.trim().length >= 5;

  async function send(kind: "report" | "sos" = "report") {
    if (sending || (kind === "report" && !hasReport)) return;
    setSending(true);
    try {
      const language =
        LANGUAGE_CODES[profile.language.trim().toLowerCase()] ?? "en";
      const { item, approximateLocation } = await submitReport({
        kind,
        category: CATEGORY_FOR[picked ?? "other"],
        language,
        ...(voice.clip
          ? { audio: { blob: voice.clip.blob, seconds: voice.clip.seconds } }
          : {}),
        ...(note.trim()
          ? { text: note }
          : kind === "sos" && !voice.clip
            ? { text: SOS_TEXT }
            : {}),
        ...(consent
          ? {
              reporter: { name: profile.fullName },
              emergency_contact: {
                name: profile.contactName,
                phone: profile.phone,
              },
            }
          : {}),
      });
      setApprox(approximateLocation);
      setStatus(null);
      setCurrent(item);
    } catch (e) {
      if (e instanceof NotReadyError || e instanceof PayloadError) {
        toast.error(e.message);
      } else {
        toast.error("Could not save the report. Try again, or call 112.");
      }
    } finally {
      setSending(false);
    }
  }

  function startOver() {
    setCurrent(null);
    setStatus(null);
    setPicked(null);
    setNote("");
    voice.reset();
    photos.forEach(removePhoto);
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
      {tab === "help" && !current && (
        <section className="cz-help" aria-labelledby="help-title">
          <h1 id="help-title">Do you need help?</h1>
          <p className="cz-lead">Hold the button and say what happened.</p>

          <MicButton voice={voice} />
          {relaySupported() && relayOn && (
            <p className="cz-hint cz-nearby" role="status">
              {relay.nearby > 0
                ? `${relay.nearby} nearby ${relay.nearby === 1 ? "phone" : "phones"} can pass your message on.`
                : relay.running
                  ? "Looking for nearby phones."
                  : "Nearby sharing is starting."}
            </p>
          )}

          <div className="cz-photo-actions">
            <Button
              variant="outline"
              className="cz-secondary"
              onClick={() => setPhotoChoiceOpen(true)}
            >
              <Camera /> Add a photo (optional)
            </Button>
            <input
              ref={photoInput}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(event) => attachPhotos(event.target.files)}
            />
            {photos.length > 0 && (
              <div className="cz-photo-preview" aria-label="Photo attachments">
                {photos.map((photo) => (
                  <div className="cz-photo-item" key={photo.url}>
                    <img src={photo.url} alt="Attached scene" />
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${photo.file.name}`}
                      onClick={() => removePhoto(photo)}
                    >
                      <X size={16} />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {voice.state === "ready" && voice.clip && (
            <div className="cz-clip">
              <p>Your message ({fmt(voice.clip.seconds)})</p>
              <ClipPlayer url={voice.clip.url} />
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
              The microphone is blocked. Allow it for Sahay in your phone or
              browser settings, or choose what is happening below.
            </p>
          )}
          {voice.state === "unsupported" && (
            <p className="cz-warn" role="alert">
              This phone cannot record here. Choose what is happening below.
            </p>
          )}
          {voice.state === "unavailable" && (
            <p className="cz-warn" role="alert">
              No microphone is available. Connect or enable a microphone, or
              choose what is happening below.
            </p>
          )}

          <h2 className="cz-sub">What is happening? (optional)</h2>
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

          <Button
            className="cz-send"
            disabled={!hasReport || sending}
            onClick={() => void send()}
          >
            {sending ? "Saving..." : "Send help request"}
          </Button>
          {!hasReport && (
            <p className="cz-hint">Record a message or type one to send.</p>
          )}

          <SosButton disabled={sending} onTrigger={() => void send("sos")} />
          <p className="cz-hint">
            Cannot talk or type? Hold SOS for 2 seconds. Your location goes to
            the response centre.
          </p>

          <a href="tel:112" className="cz-call">
            <Phone />
            Call 112 now
          </a>
          <p className="cz-hint">
            In danger? Call first. This demo does not contact real services.
          </p>
        </section>
      )}

      {tab === "help" && current && (
        <Progress
          item={current}
          status={status}
          approximate={approx}
          nearby={relay.nearby}
          onDone={startOver}
          onRetry={() => void retryFailedNow(current.report_id)}
        />
      )}

      {tab === "reports" && (
        <section className="cz-page" aria-labelledby="reports-title">
          <h1 id="reports-title">My reports</h1>
          {reports.length === 0 ? (
            <p className="cz-lead">
              Nothing yet. When you ask for help, it will show here.
            </p>
          ) : (
            <ul className="cz-list">
              {reports.map((r) => (
                <li key={r.report_id}>
                  <div>
                    <strong>{NICE_CATEGORY[r.category] ?? "Report"}</strong>
                    <small>{whenText(r.created_at)}</small>
                  </div>
                  <span
                    className={`cz-status ${r.state === "sent" ? "ok" : r.state === "failed" ? "bad" : "wait"}`}
                  >
                    {r.state === "sent"
                      ? "Sent"
                      : r.state === "failed"
                        ? "Not accepted"
                        : "Waiting to send"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {tab === "map" && (
        <section className="cz-page" aria-labelledby="map-title">
          <h1 id="map-title">Response map</h1>
          <p className="cz-lead">
            Confirmed incidents near you, by area. No names or messages are
            shown.
          </p>
          <IncidentMap role="civilian" className="admin-map" />
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
          {relaySupported() && (
            <label className="cz-consent">
              <span>
                Help nearby phones pass on messages
                <small>
                  {relayOn
                    ? "On. Your phone can carry sealed messages for others when they have no signal. You cannot read them."
                    : "Off. Your own message can only be sent when you have signal."}
                </small>
              </span>
              <Switch
                checked={relayOn}
                onCheckedChange={(on) => {
                  setRelayOn(on);
                  void setRelayEnabled(on);
                }}
                aria-label="Help nearby phones pass on messages"
              />
            </label>
          )}
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
      <Dialog open={photoChoiceOpen} onOpenChange={setPhotoChoiceOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>Add a scene photo</DialogTitle>
            <DialogDescription>
              Take a photo now or upload an image from this device.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Button
              variant="outline"
              onClick={() => void openCamera()}
              disabled={!canUseCamera}
            >
              <Camera /> Take photo
            </Button>
            {!canUseCamera && (
              <p className="cz-hint">
                Camera capture isn’t available in this browser. Image upload is
                still available.
              </p>
            )}
            <Button
              onClick={() => {
                setPhotoChoiceOpen(false);
                photoInput.current?.click();
              }}
            >
              Upload image
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={cameraOpen}
        onOpenChange={(open) => {
          if (!open) closeCamera();
        }}
      >
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>Take a scene photo</DialogTitle>
            <DialogDescription>
              Position the camera, then capture to add the photo to your report.
            </DialogDescription>
          </DialogHeader>
          <video
            ref={cameraVideo}
            autoPlay
            playsInline
            muted
            className="w-full rounded-md bg-black"
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={closeCamera}>
              Cancel
            </Button>
            <Button onClick={capturePhoto}>
              <Camera /> Capture photo
            </Button>
          </div>
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

function Progress({
  item,
  status,
  approximate,
  nearby,
  onDone,
  onRetry,
}: {
  item: QueueItem;
  status: ReportStatus | null;
  approximate: boolean;
  nearby: number;
  onDone: () => void;
  onRetry: () => void;
}) {
  const failed = item.state === "failed";
  // k = number of finished steps: 1 saved, 2 sent, 3 a team is arranged
  const k =
    item.state === "sent"
      ? (status ?? item.relay_status) &&
        HELP_ARRANGED.has((status ?? item.relay_status)?.status ?? "")
        ? 3
        : 2
      : 1;
  const title = failed
    ? "We could not send this"
    : k === 3
      ? "Help is on the way"
      : item.state === "sent"
        ? "Your request was sent"
        : "Saved on your phone";
  const serverStatus = status ?? item.relay_status ?? null;
  const viaRelay = item.via === "relay";
  const lead = failed
    ? "The response centre did not accept this report. Call 112 now."
    : serverStatus?.message
      ? serverStatus.message
      : item.state === "sent"
        ? viaRelay
          ? "A nearby phone passed it on and the response centre has it. A team is being arranged."
          : "The response centre has it. A team is being arranged."
        : nearby > 0
          ? "A nearby phone can pass it on. You do not need to do anything."
          : "It will be sent as soon as there is a connection or a nearby phone. You do not need to do anything.";
  const labels = [
    "Saved on your phone",
    viaRelay
      ? "Delivered through a nearby phone"
      : "Sent to the response centre",
    k === 3 ? "A team is on the way" : "A team is being arranged",
  ];
  return (
    <section className="cz-help" aria-live="polite">
      <h1>{title}</h1>
      <p className="cz-lead">{lead}</p>
      {approximate && !failed && (
        <p className="cz-warn" role="status">
          We could not find your exact position. Tell the team where you are if
          they call.
        </p>
      )}
      {!failed && (
        <ol className="cz-steps">
          {labels.map((label, i) => (
            <li key={label} className={k > i ? "done" : k === i ? "now" : ""}>
              <span className="cz-step-mark" aria-hidden>
                {k > i ? (
                  <Check />
                ) : k === i ? (
                  <LoaderCircle className="animate-spin" />
                ) : null}
              </span>
              {label}
            </li>
          ))}
        </ol>
      )}
      {failed && (
        <Button variant="outline" className="cz-secondary" onClick={onRetry}>
          Try sending again
        </Button>
      )}
      <a href="tel:112" className="cz-call">
        <Phone />
        Call 112 now
      </a>
      <Button variant="outline" className="cz-secondary" onClick={onDone}>
        Done
      </Button>
    </section>
  );
}

/** Play button for the recorded message. The native audio bar shows a nonsense length for browser recordings (no duration header). */
function ClipPlayer({ url }: { url: string }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  return (
    <>
      <audio
        ref={audio}
        src={url}
        onEnded={() => setPlaying(false)}
        onPause={() => setPlaying(false)}
        onPlay={() => setPlaying(true)}
      />
      <Button
        variant="outline"
        className="cz-secondary"
        onClick={() => {
          const el = audio.current;
          if (!el) return;
          if (playing) {
            el.pause();
            el.currentTime = 0;
          } else {
            void el.play();
          }
        }}
      >
        {playing ? "Stop playing" : "Play my message"}
      </Button>
    </>
  );
}

/**
 * SOS: hold for 2 seconds (a fill shows the progress, so it cannot be set off by a tap in a pocket).
 * Works with a finger or with Space/Enter held down. Letting go early cancels.
 */
export function SosButton({
  disabled,
  onTrigger,
}: {
  disabled: boolean;
  onTrigger: () => void;
}) {
  const [progress, setProgress] = useState(0);
  const timer = useRef<number | null>(null);
  const startedAt = useRef(0);

  const cancel = () => {
    if (timer.current !== null) window.clearInterval(timer.current);
    timer.current = null;
    setProgress(0);
  };
  const begin = () => {
    if (disabled || timer.current !== null) return;
    startedAt.current = performance.now();
    timer.current = window.setInterval(() => {
      const p = Math.min(
        1,
        (performance.now() - startedAt.current) / SOS_HOLD_MS,
      );
      setProgress(p);
      if (p >= 1) {
        cancel();
        navigator.vibrate?.(250);
        onTrigger();
      }
    }, 40);
  };
  useEffect(() => cancel, []);

  return (
    <button
      type="button"
      className="cz-sos"
      disabled={disabled}
      aria-label="SOS. Hold for 2 seconds to send your location to the response centre"
      style={{ ["--sos-progress" as string]: `${Math.round(progress * 100)}%` }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        begin();
      }}
      onPointerUp={cancel}
      onPointerCancel={cancel}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if ((e.key === " " || e.key === "Enter") && !e.repeat) {
          e.preventDefault();
          begin();
        }
      }}
      onKeyUp={cancel}
    >
      <span>{progress > 0 ? "Keep holding..." : "SOS"}</span>
    </button>
  );
}
