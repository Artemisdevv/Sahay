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
type ScenePhoto = { file: File; url: string };

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
  const [photoChoiceOpen, setPhotoChoiceOpen] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [photos, setPhotos] = useState<ScenePhoto[]>([]);
  const photoInput = useRef<HTMLInputElement>(null);
  const cameraVideo = useRef<HTMLVideoElement>(null);
  const cameraStream = useRef<MediaStream | null>(null);
  const photoUrls = useRef<string[]>([]);
  const voice = useVoiceCapture();
  const canUseCamera =
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function";

  useEffect(() => {
    if (step < 0 || step >= 3) return;
    const timer = setTimeout(() => setStep((s) => s + 1), 1600);
    return () => clearTimeout(timer);
  }, [step]);

  useEffect(() => {
    if (cameraOpen && cameraVideo.current && cameraStream.current) {
      cameraVideo.current.srcObject = cameraStream.current;
      void cameraVideo.current.play().catch(() => undefined);
    }
  }, [cameraOpen]);

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
      {tab === "help" && step < 0 && (
        <section className="cz-help" aria-labelledby="help-title">
          <h1 id="help-title">Do you need help?</h1>
          <p className="cz-lead">Hold the button and say what happened.</p>

          <MicButton voice={voice} />

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
              Microphone access was denied. Allow it in browser settings, or
              choose what is happening below.
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
