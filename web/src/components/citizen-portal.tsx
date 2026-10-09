import { useEffect, useRef, useState } from "react";
import {
  HeartPulse,
  Flame,
  LifeBuoy,
  MessageSquare,
  MapPin,
  LocateFixed,
  ShieldCheck,
  ArrowUpRight,
  ChevronRight,
  ChevronDown,
  Paperclip,
  Mic,
  Camera,
  Plus,
  Code2,
  LockKeyhole,
  Phone,
  Clock3,
  Activity,
  Network,
  Database,
  Bot,
  Check,
  AlertTriangle,
  Send,
  X,
  Pencil,
  Users,
  Radio,
  LoaderCircle,
  FileAudio,
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
import { Shell, Badge, ZoneMap } from "./dispatch-shell";
import {
  buildPayload,
  defaultProfile,
  detectPriority,
  recipients,
  type EmergencyProfile,
  type IncidentType,
} from "@/lib/dispatch";
const incidentTypes = [
  { id: "medical", label: "Medical emergency", icon: HeartPulse },
  { id: "fire", label: "Fire / hazard", icon: Flame },
  { id: "rescue", label: "Rescue / trapped", icon: LifeBuoy },
  { id: "other", label: "General assistance", icon: MessageSquare },
] as const;
const profileFields = [
  ["fullName", "Full name"],
  ["bloodGroup", "Blood group"],
  ["age", "Age"],
  ["language", "Primary language"],
  ["contactName", "Emergency contact name"],
  ["relation", "Relationship"],
  ["phone", "Emergency contact phone"],
  ["conditions", "Chronic conditions"],
  ["allergies", "Known allergies"],
  ["medications", "Current medications"],
  ["devices", "Implanted devices"],
  ["address", "Home address"],
  ["access", "Entry instructions / gate code"],
  ["mobility", "Mobility issues"],
] as const;
type Media = { name: string; url: string; type: string };
type RecordedAudio = { file: File; url: string };
export function CitizenPortal() {
  const [type, setType] = useState<IncidentType>("medical");
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState("Kochi, Kerala");
  const [landmark, setLandmark] = useState("");
  const [hazards, setHazards] = useState("");
  const [people, setPeople] = useState(1);
  const [profile, setProfile] = useState<EmergencyProfile>(defaultProfile);
  const [draft, setDraft] = useState<EmergencyProfile>(defaultProfile);
  const [consent, setConsent] = useState(true);
  const [profileOpen, setProfileOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [media, setMedia] = useState<Media[]>([]);
  const [photoChoiceOpen, setPhotoChoiceOpen] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [audioPreview, setAudioPreview] = useState<RecordedAudio | null>(null);
  const [audioPreviewOpen, setAudioPreviewOpen] = useState(false);
  const [step, setStep] = useState(-1);
  const [error, setError] = useState("");
  const [dispatchedPayload, setDispatchedPayload] = useState<ReturnType<
    typeof buildPayload
  > | null>(null);
  const [history, setHistory] = useState([
    {
      id: "REQ-1048",
      name: "Medical assistance",
      detail: "Triage & EMS coordination",
      date: "Oct 07, 2026",
      time: "14:32",
      status: "Resolved",
    },
    {
      id: "REQ-1036",
      name: "General assistance",
      detail: "Community response team",
      date: "Sep 28, 2026",
      time: "09:18",
      status: "Resolved",
    },
  ]);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLVideoElement>(null);
  const cameraStream = useRef<MediaStream | null>(null);
  const recorderStream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const audioChunks = useRef<Blob[]>([]);
  const recordingFailed = useRef(false);
  const urls = useRef<string[]>([]);
  const canUseCamera =
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function";
  useEffect(() => {
    return () => {
      urls.current.forEach((url) => URL.revokeObjectURL(url));
      cameraStream.current?.getTracks().forEach((track) => track.stop());
      recorderStream.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);
  useEffect(() => {
    if (cameraOpen && cameraRef.current && cameraStream.current) {
      cameraRef.current.srcObject = cameraStream.current;
      void cameraRef.current.play().catch(() => undefined);
    }
  }, [cameraOpen]);
  useEffect(() => {
    if (step < 0 || step >= 3) return;
    const timer = setTimeout(() => setStep((s) => s + 1), 1500);
    return () => clearTimeout(timer);
  }, [step]);
  const priority = detectPriority(description, type);
  const payload = buildPayload(profile, consent, {
    type,
    description,
    location,
    landmark,
    hazards,
    people,
    media: media.map((m) => m.name),
  });
  async function saveProfile() {
    if (
      !draft.fullName.trim() ||
      !draft.age ||
      Number(draft.age) < 1 ||
      Number(draft.age) > 120
    ) {
      toast.error("Enter a name and a valid age (1–120).");
      return;
    }
    setSaving(true);
    // Keep sensitive profile data local until it can be included in the encrypted report.
    setSaving(false);
    setProfile(draft);
    setProfileOpen(false);
    toast.success("Emergency profile saved on this device");
  }
  async function changeConsent(value: boolean) {
    setConsent(value);
    toast(value ? "Consent enabled for this report" : "Consent disabled");
  }
  function attach(files: Iterable<File> | null) {
    if (!files) return;
    const next: Media[] = [];
    for (const file of files) {
      if (!/^(image|audio)\//.test(file.type) || file.size > 10 * 1024 * 1024) {
        toast.error("Use an image or audio file smaller than 10 MB.");
        continue;
      }
      const url = URL.createObjectURL(file);
      urls.current.push(url);
      next.push({ name: file.name, url, type: file.type });
    }
    setMedia((previous) => [...previous, ...next].slice(0, 3));
  }
  async function startAudioRecording() {
    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      toast.error(
        "Audio recording isn’t available in this browser. Try a supported browser or attach an image instead.",
      );
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recorderStream.current = stream;
      const supportedType = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4",
      ].find((mime) => MediaRecorder.isTypeSupported(mime));
      const activeRecorder = supportedType
        ? new MediaRecorder(stream, { mimeType: supportedType })
        : new MediaRecorder(stream);
      recorder.current = activeRecorder;
      audioChunks.current = [];
      recordingFailed.current = false;
      activeRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunks.current.push(event.data);
      };
      activeRecorder.onerror = () => {
        recordingFailed.current = true;
        stream.getTracks().forEach((track) => track.stop());
        recorderStream.current = null;
        recorder.current = null;
        setIsRecording(false);
        toast.error(
          "The audio recording stopped unexpectedly. Please try again.",
        );
      };
      activeRecorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        recorderStream.current = null;
        recorder.current = null;
        setIsRecording(false);
        if (recordingFailed.current) return;
        const blob = new Blob(audioChunks.current, {
          type: activeRecorder.mimeType || "audio/webm",
        });
        if (blob.size === 0) {
          toast.error("No audio was captured. Please record the note again.");
          return;
        }
        if (blob.size > 10 * 1024 * 1024) {
          toast.error(
            "That recording is over the 10 MB attachment limit. Please record a shorter note.",
          );
          return;
        }
        const extension = blob.type.includes("mp4") ? "m4a" : "webm";
        const file = new File([blob], `audio-note-${Date.now()}.${extension}`, {
          type: blob.type,
        });
        const url = URL.createObjectURL(file);
        urls.current.push(url);
        setAudioPreview({ file, url });
        setAudioPreviewOpen(true);
      };
      activeRecorder.start();
      setIsRecording(true);
      toast.success("Recording started. Stop when your audio note is ready.");
    } catch (error) {
      recorderStream.current?.getTracks().forEach((track) => track.stop());
      recorderStream.current = null;
      recorder.current = null;
      setIsRecording(false);
      const name = error instanceof DOMException ? error.name : "";
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        toast.error(
          "Microphone access was denied. Allow microphone access in your browser settings, then try again.",
        );
      } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        toast.error("No microphone is available on this device.");
      } else {
        toast.error(
          "Couldn’t start audio recording. Check microphone access and try again.",
        );
      }
    }
  }
  function stopAudioRecording() {
    if (recorder.current?.state === "recording") recorder.current.stop();
  }
  async function openCamera() {
    if (!canUseCamera) {
      toast.error(
        "Camera capture isn’t available here. Choose image upload to attach a photo.",
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
        toast.error(
          "Camera access was denied. You can still upload an image instead.",
        );
      } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        toast.error(
          "No camera is available on this device. You can still upload an image.",
        );
      } else {
        toast.error(
          "Couldn’t open the camera. You can still upload an image instead.",
        );
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
    const video = cameraRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) {
      toast.error("Camera is still starting. Please try again in a moment.");
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) {
      toast.error(
        "Couldn’t capture the photo. Please upload an image instead.",
      );
      return;
    }
    context.drawImage(video, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          toast.error(
            "Couldn’t capture the photo. Please try again or upload an image.",
          );
          return;
        }
        attach([
          new File([blob], `photo-${Date.now()}.jpg`, { type: "image/jpeg" }),
        ]);
        closeCamera();
      },
      "image/jpeg",
      0.9,
    );
  }
  function submit() {
    if (description.trim().length < 10) {
      setError("Describe what happened in at least 10 characters.");
      return;
    }
    if (!location.trim()) {
      setError("Add the incident location before dispatch.");
      return;
    }
    setError("");
    setDispatchedPayload(payload);
    setStep(0);
    setHistory((h) => [
      {
        id: `REQ-${1050 + h.length}`,
        name: incidentTypes.find((t) => t.id === type)?.label ?? "Assistance",
        detail: "Autonomous response simulation",
        date: "Just now",
        time: "",
        status: "In progress",
      },
      ...h,
    ]);
    toast("Dispatch simulation started", {
      description: "No real emergency services will be contacted.",
    });
  }
  function gps() {
    if (!navigator.geolocation) {
      toast.error("Location is unavailable. Enter your address manually.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setLocation(
          `${p.coords.latitude.toFixed(5)}, ${p.coords.longitude.toFixed(5)}`,
        );
        toast.success("Current GPS location applied");
      },
      () => toast.error("Location access denied. Enter your address manually."),
      { timeout: 8000 },
    );
  }
  return (
    <Shell title="Citizen portal">
      <div className="page-heading">
        <div>
          <div className="eyebrow">Citizen response workspace</div>
          <h1>
            Good morning, Alex<span className="text-primary">.</span>
          </h1>
          <p className="subtitle">
            Your safety, connected. Get the right response, when it matters.
          </p>
        </div>
        <div className="page-heading-actions">
          <Badge tone="green">
            <span className="dot" />
            Network connected
          </Badge>
        </div>
      </div>
      <div className="emergency-call-banner">
        <a href="tel:112" className="emergency-call-button">
          <Phone size={28} />
          <span>Emergency Call</span>
          <span className="emergency-number">112</span>
          <ArrowUpRight size={20} />
        </a>
        <p className="emergency-call-hint">
          Connects directly to emergency services
        </p>
      </div>
      <div className="status-strip">
        <div className="status-cell">
          <div className="status-label">
            <MapPin />
            Current location
          </div>
          <div className="status-value">
            Kochi, Kerala<Badge tone="green">GPS ready</Badge>
          </div>
        </div>
        <div className="status-cell">
          <div className="status-label">
            <Network />
            Coordinator agents
          </div>
          <div className="status-value">
            <span className="dot" />4 agents online
            <small>All operational</small>
          </div>
        </div>
        <div className="status-cell">
          <div className="status-label">
            <ShieldCheck />
            Emergency profile
          </div>
          <div className="status-value">
            {consent ? "Context ready" : "Sharing disabled"}
            <Check size={13} className="text-primary" />
          </div>
        </div>
        <div className="status-cell">
          <div className="status-label">
            <Clock3 />
            Avg. response time
          </div>
          <div className="status-value">
            &lt; 2 minutes<small>In your area</small>
          </div>
        </div>
      </div>
      <div className="content-grid">
        <div>
          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>
                  <Radio className="text-primary" />
                  {step < 0 ? "Report an incident" : "Agent action telemetry"}
                </h2>
                <p>
                  {step < 0
                    ? "Share what’s happening. Our agents will coordinate the response."
                    : "Your request is being coordinated across the response network."}
                </p>
              </div>
              <Badge tone={step < 0 ? "green" : "amber"}>
                {step < 0 ? (
                  <>
                    <LockKeyhole size={10} />
                    Secure channel
                  </>
                ) : (
                  "Simulation in progress"
                )}
              </Badge>
            </div>
            {step < 0 ? (
              <>
                <div className="panel-body">
                  <div className="section-label">
                    <span>
                      What type of help do you need?{" "}
                      <span className="required">*</span>
                    </span>
                  </div>
                  <div className="incident-types">
                    {incidentTypes.map((t) => (
                      <Button
                        key={t.id}
                        variant="outline"
                        className={`incident-choice ${type === t.id ? "selected" : ""}`}
                        onClick={() => setType(t.id)}
                        aria-pressed={type === t.id}
                      >
                        <t.icon />
                        {t.label}
                      </Button>
                    ))}
                  </div>
                  <div className="section-label">
                    <span>
                      Incident location <span className="required">*</span>
                    </span>
                    <Button
                      variant="link"
                      size="sm"
                      className="h-auto p-0 text-[10px]"
                      onClick={gps}
                    >
                      <LocateFixed size={11} />
                      Use current location
                    </Button>
                  </div>
                  <label className="field">
                    <span className="location-input">
                      <MapPin />
                      <input
                        aria-label="Incident location"
                        value={location}
                        onChange={(e) => setLocation(e.target.value)}
                        maxLength={300}
                      />
                      <Badge tone="green">
                        {location.startsWith("124")
                          ? "Demo address"
                          : "Location set"}
                      </Badge>
                    </span>
                  </label>
                  <label className="field">
                    <input
                      aria-label="Landmark, floor or apartment"
                      placeholder="Landmark, floor, apartment, or entry instructions (optional)"
                      value={landmark}
                      onChange={(e) => setLandmark(e.target.value)}
                      maxLength={300}
                    />
                  </label>
                  <label className="field">
                    <span className="section-label mb-0">
                      <span>
                        Tell us what’s happening{" "}
                        <span className="required">*</span>
                      </span>
                      {priority !== "Pending assessment" ? (
                        <Badge
                          tone={
                            priority === "Critical"
                              ? "rose"
                              : priority === "High"
                                ? "amber"
                                : "green"
                          }
                        >
                          {priority} priority
                        </Badge>
                      ) : (
                        <small>Agent-assisted triage</small>
                      )}
                    </span>
                    <textarea
                      placeholder="Describe the incident, symptoms, or situation. Include any details that can help our response teams."
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      maxLength={3000}
                    />
                  </label>
                  <div className="quick-chips">
                    {[
                      "Unconscious",
                      "Severe Bleeding",
                      "Smoke Visible",
                      "Trapped Inside",
                    ].map((chip) => (
                      <Button
                        key={chip}
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          setDescription((d) =>
                            d
                              ? `${d}. ${chip}`
                              : `${chip} at the incident location.`,
                          )
                        }
                      >
                        <Plus size={10} />
                        {chip}
                      </Button>
                    ))}
                  </div>
                  <div className="field-row wide">
                    <label className="field">
                      Hazards & building notes
                      <input
                        placeholder="Gas, oxygen tanks, pets, flammable materials…"
                        value={hazards}
                        onChange={(e) => setHazards(e.target.value)}
                        maxLength={500}
                      />
                    </label>
                    <label className="field">
                      People affected
                      <input
                        type="number"
                        min={1}
                        max={999}
                        value={people}
                        onChange={(e) =>
                          setPeople(
                            Math.min(999, Math.max(1, Number(e.target.value))),
                          )
                        }
                      />
                    </label>
                  </div>
                  <div className="section-label">
                    <span>Scene attachments</span>
                    <small>Optional · Images or audio up to 10 MB</small>
                  </div>
                  <div className="attachment-zone">
                    <div className="flex items-center gap-2">
                      <Paperclip size={15} className="text-muted-foreground" />
                      <p>Add context for the response team</p>
                    </div>
                    <div className="attachment-actions">
                      <Button
                        variant="outline"
                        onClick={() => setPhotoChoiceOpen(true)}
                      >
                        <Plus size={12} />
                        Add photo
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => void startAudioRecording()}
                      >
                        <Mic size={12} />
                        Audio note
                      </Button>
                    </div>
                    <input
                      ref={fileRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => attach(e.target.files)}
                    />
                  </div>
                  {media.map((m, i) => (
                    <div className="attachment-preview" key={m.url}>
                      {m.type.startsWith("image") ? (
                        <img src={m.url} alt="Attached scene" />
                      ) : (
                        <FileAudio size={20} />
                      )}
                      <span className="text-[10px] truncate flex-1">
                        {m.name}
                      </span>
                      {m.type.startsWith("audio") && (
                        <audio controls src={m.url} className="w-40 h-8" />
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove ${m.name}`}
                        onClick={() =>
                          setMedia((ms) => ms.filter((_, index) => index !== i))
                        }
                      >
                        <X size={12} />
                      </Button>
                    </div>
                  ))}
                  <details className="payload">
                    <summary>
                      <span>
                        <Code2 size={13} />
                        Agent Context Payload Preview
                      </span>
                      <span>
                        Structured JSON
                        <ChevronDown size={12} />
                      </span>
                    </summary>
                    <pre>{JSON.stringify(payload, null, 2)}</pre>
                  </details>
                  {error && (
                    <p className="error-text" role="alert">
                      {error}
                    </p>
                  )}
                </div>
                <div className="form-bottom">
                  <small>
                    <LockKeyhole size={11} />
                    Encrypted context · Consent-controlled sharing
                  </small>
                  <Button onClick={submit}>
                    <Send size={13} />
                    Dispatch Autonomous Agents
                    <ChevronRight size={13} />
                  </Button>
                </div>
              </>
            ) : (
              <div className="telemetry">
                <div className="telemetry-intro">
                  <ShieldCheck />
                  <div>
                    <h3>
                      {step === 3
                        ? "Response team assigned"
                        : "Coordinating your response"}
                    </h3>
                    <p>
                      Request received · {dispatchedPayload?.incident.priority}{" "}
                      priority · Demo dispatch
                    </p>
                  </div>
                </div>
                {[
                  {
                    title: "Context Ingestion",
                    desc: consent
                      ? "Static emergency profile combined with incident context for vector memory lookup."
                      : "Incident context ingested. Medical profile excluded by your consent preference.",
                  },
                  {
                    title: "Multi-Agent Review",
                    desc: "TriageAgent-01 → DispatchRouter-v2 → Response alert. Resource availability reviewed.",
                  },
                  {
                    title: "Dispatch Confirmation",
                    desc: `Simulated payload transmitted to ${recipients(type)}.`,
                  },
                ].map((s, i) => (
                  <div className="telemetry-step" key={s.title}>
                    <div className={`step-index ${step > i ? "done" : ""}`}>
                      {step > i ? (
                        <Check />
                      ) : step === i ? (
                        <LoaderCircle className="animate-spin" />
                      ) : (
                        i + 1
                      )}
                    </div>
                    <div>
                      <strong>{s.title}</strong>
                      <p>{step >= i ? s.desc : "Waiting for upstream agent"}</p>
                    </div>
                  </div>
                ))}
                {step === 3 && (
                  <div className="eta-banner">
                    <div>
                      <strong>6 min</strong>
                      <small>Simulated estimated arrival</small>
                    </div>
                    <div className="text-right text-[11px]">
                      <strong className="text-[12px]">
                        {type === "medical"
                          ? "Ambulance #12"
                          : type === "fire"
                            ? "Engine 3"
                            : "Response Unit #04"}
                      </strong>
                      <small>Assigned · En route</small>
                    </div>
                  </div>
                )}
                <div className="flex gap-2 flex-wrap">
                  <Button variant="destructive" asChild>
                    <a href="tel:112">
                      <Phone />
                      Call 112 / 911 Direct
                    </a>
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setStep(-1);
                      setDescription("");
                    }}
                  >
                    New incident
                  </Button>
                </div>
                <details className="payload">
                  <summary>
                    <span>
                      <Code2 size={13} />
                      Submitted context
                    </span>
                    <ChevronDown size={12} />
                  </summary>
                  <pre>{JSON.stringify(dispatchedPayload, null, 2)}</pre>
                </details>
              </div>
            )}
          </section>
          <div className="disclaimer">
            <AlertTriangle />
            Immediate danger? Don’t wait for a digital response.{" "}
            <a href="tel:112">
              Call 112 / 911 directly
              <ArrowUpRight size={10} className="inline" />
            </a>
          </div>
          <section className="panel history">
            <div className="panel-head compact-head">
              <h2>
                Recent requests <Badge>{history.length}</Badge>
              </h2>
              <Badge>Past 30 days</Badge>
            </div>
            <table className="history-table">
              <thead>
                <tr>
                  <th>REQUEST</th>
                  <th>DATE & TIME</th>
                  <th>REQUEST ID</th>
                  <th>STATUS</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <td>
                      <div className="table-icon">
                        {h.name.toLowerCase().includes("medical") ? (
                          <HeartPulse />
                        ) : (
                          <MessageSquare />
                        )}
                        <div>
                          <strong>{h.name}</strong>
                          <small>{h.detail}</small>
                        </div>
                      </div>
                    </td>
                    <td>
                      {h.date}
                      <small>{h.time}</small>
                    </td>
                    <td className="mono">{h.id}</td>
                    <td>
                      <Badge tone={h.status === "Resolved" ? "green" : "amber"}>
                        {h.status === "Resolved" && <Check size={9} />}
                        {h.status}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
        <aside className="right-stack">
          <section className="panel">
            <div className="panel-head compact-head">
              <h2>
                <ShieldCheck className="text-primary" />
                Emergency profile
              </h2>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Edit emergency profile"
                onClick={() => {
                  setDraft(profile);
                  setProfileOpen(true);
                }}
              >
                <Pencil size={13} />
              </Button>
            </div>
            <div className="compact-body">
              <div className="profile-top">
                <div className="avatar">AM</div>
                <div>
                  <strong>{profile.fullName}</strong>
                  <small>Personal emergency context</small>
                </div>
              </div>
              <div className="profile-summary">
                <div>
                  <small>BLOOD GROUP</small>
                  <strong>{profile.bloodGroup}</strong>
                </div>
                <div>
                  <small>AGE / LANGUAGE</small>
                  <strong>
                    {profile.age} yrs · {profile.language}
                  </strong>
                </div>
                <div>
                  <small>CONDITIONS</small>
                  <strong>{profile.conditions}</strong>
                </div>
                <div>
                  <small>EMERGENCY CONTACT</small>
                  <strong>{profile.contactName}</strong>
                </div>
              </div>
              <div className="medical-note">
                <AlertTriangle />
                Known allergy: {profile.allergies}
              </div>
              <Button
                variant="outline"
                size="sm"
                className="w-full text-[10px]"
                onClick={() => {
                  setDraft(profile);
                  setProfileOpen(true);
                }}
              >
                Medical & Emergency Profile
                <ArrowUpRight size={11} />
              </Button>
              <div className="consent-row">
                <span>Share with response agents</span>
                <Switch
                  checked={consent}
                  onCheckedChange={changeConsent}
                  aria-label="Share medical profile with agents"
                />
              </div>
              <div className="profile-ready">
                {consent ? (
                  <>
                    <ShieldCheck size={12} />
                    Profile Ready for Agent Context Injection
                  </>
                ) : (
                  <>
                    <LockKeyhole size={12} />
                    Medical context sharing disabled
                  </>
                )}
              </div>
            </div>
          </section>
          <section className="panel">
            <div className="panel-head compact-head">
              <h2>
                <Network />
                Your coordinator agents
              </h2>
              <Badge tone="green">4 online</Badge>
            </div>
            <div className="compact-body">
              {[
                {
                  name: "TriageAgent-01",
                  detail: "Incident assessment & prioritization",
                  icon: HeartPulse,
                },
                {
                  name: "DispatchRouter-v2",
                  detail: "Optimal unit & resource routing",
                  icon: Network,
                },
                {
                  name: "ResourceMemory-RAG",
                  detail: "Context retrieval & medical memory",
                  icon: Database,
                },
                {
                  name: "NotificationBot",
                  detail: "Real-time updates & coordination",
                  icon: Bot,
                },
              ].map((a) => (
                <div className="agent-row" key={a.name}>
                  <div className="agent-icon">
                    <a.icon />
                  </div>
                  <div className="agent-info">
                    <strong>{a.name}</strong>
                    <small>{a.detail}</small>
                  </div>
                  <span className="dot" />
                </div>
              ))}
            </div>
            <div className="agent-footer">
              <span>Autonomous mesh connected</span>
              <span className="mono">24 ms</span>
            </div>
          </section>
          <section className="panel">
            <div className="panel-head compact-head">
              <h2>
                <MapPin />
                Your response zone
              </h2>
              <ArrowUpRight size={13} className="text-muted-foreground" />
            </div>
            <ZoneMap />
            <div className="zone-meta">
              <div>
                <strong>Central District · Zone 04</strong>
                <small>2 hospitals · 3 rescue units nearby</small>
              </div>
              <Badge tone="green">Covered</Badge>
            </div>
          </section>
        </aside>
      </div>
      <Dialog open={profileOpen} onOpenChange={setProfileOpen}>
        <DialogContent className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle>Medical & Emergency Profile</DialogTitle>
            <DialogDescription>
              Private medical and access information. Shared with agents only
              with your consent.
            </DialogDescription>
          </DialogHeader>
          <div className="dialog-form">
            <div className="field-row">
              {profileFields.map(([key, label]) => (
                <label className="field" key={key}>
                  {label}
                  <input
                    aria-label={label}
                    value={draft[key]}
                    maxLength={500}
                    type={key === "age" ? "number" : "text"}
                    min={key === "age" ? 1 : undefined}
                    max={key === "age" ? 120 : undefined}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, [key]: e.target.value }))
                    }
                  />
                </label>
              ))}
            </div>
          </div>
          <div className="flex justify-between items-center gap-3">
            <span className="text-[10px] text-muted-foreground">
              Demo changes last this visit; accounts save privately.
            </span>
            <Button onClick={saveProfile} disabled={saving}>
              {saving ? <LoaderCircle className="animate-spin" /> : <Check />}
              Save profile
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={photoChoiceOpen} onOpenChange={setPhotoChoiceOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>Add a scene photo</DialogTitle>
            <DialogDescription>
              Take a photo now or choose an image from this device.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Button
              variant="outline"
              onClick={() => void openCamera()}
              disabled={!canUseCamera}
            >
              <Camera size={16} /> Take photo
            </Button>
            {!canUseCamera && (
              <p className="text-xs text-muted-foreground">
                Camera capture isn’t available in this browser. Image upload is
                still available.
              </p>
            )}
            <Button
              onClick={() => {
                setPhotoChoiceOpen(false);
                fileRef.current?.click();
              }}
            >
              <Paperclip size={16} /> Upload image
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
            ref={cameraRef}
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
              <Camera size={16} /> Capture photo
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={isRecording}
        onOpenChange={(open) => {
          if (!open) stopAudioRecording();
        }}
      >
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>Recording audio note</DialogTitle>
            <DialogDescription>
              Speak clearly. Stop the recording when your note is complete.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 text-sm">
            <span className="dot pulse" />
            Recording from your microphone
          </div>
          <div className="flex justify-end">
            <Button onClick={stopAudioRecording}>
              <Mic size={16} /> Stop and preview
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={audioPreviewOpen}
        onOpenChange={(open) => {
          if (!open && audioPreview) {
            URL.revokeObjectURL(audioPreview.url);
            urls.current = urls.current.filter(
              (url) => url !== audioPreview.url,
            );
            setAudioPreview(null);
          }
          setAudioPreviewOpen(open);
        }}
      >
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>Preview audio note</DialogTitle>
            <DialogDescription>
              Listen before attaching this recording to your report.
            </DialogDescription>
          </DialogHeader>
          {audioPreview && (
            <audio controls src={audioPreview.url} className="w-full" />
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => setAudioPreviewOpen(false)}
            >
              Discard
            </Button>
            <Button
              onClick={() => {
                if (audioPreview) attach([audioPreview.file]);
                setAudioPreviewOpen(false);
                setAudioPreview(null);
              }}
            >
              <Check size={16} /> Attach recording
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Shell>
  );
}
