import { useState } from "react";
import {
  Activity,
  ArrowUpRight,
  ArrowRight,
  HeartPulse,
  Flame,
  Network,
  Database,
  Bot,
  ShieldCheck,
  Clock3,
  Users,
  BedDouble,
  Check,
  Radio,
  ChevronDown,
  Terminal,
  Route,
  SlidersHorizontal,
  AlertTriangle,
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
import { Shell, Badge, ZoneMap } from "./dispatch-shell";
import { toast } from "sonner";
export function OperationsConsole({ serviceId }: { serviceId: string }) {
  const fire = serviceId.includes("fire");
  const [ack, setAck] = useState(false);
  const [rerouted, setRerouted] = useState(false);
  const [capacity, setCapacity] = useState(fire ? 4 : 8);
  const [capacityOpen, setCapacityOpen] = useState(false);
  const [nextCapacity, setNextCapacity] = useState(capacity);
  const [logs, setLogs] = useState(true);
  return (
    <Shell role={fire ? "fire" : "hospital"} title={fire ? "Fire & rescue" : "Hospital console"}>
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            First responder workspace · {fire ? "Station 04" : "Hospital 01"}
          </div>
          <h1>{fire ? "Metro Fire Station 4" : "City General Hospital"}</h1>
          <p className="subtitle">
            {fire
              ? "Dispatch intelligence and field resource coordination."
              : "Emergency intake, patient context, and critical care coordination."}
          </p>
        </div>
        <Badge tone={fire ? "amber" : "sky"}>
          <span className="dot" />
          Receiving dispatches
        </Badge>
      </div>
      <div className="metrics">
        {[
          {
            label: fire ? "Active incidents" : "Incoming patients",
            value: fire ? "02" : "03",
            note: "Awaiting response",
            icon: Activity,
          },
          {
            label: fire ? "Available units" : "Available critical beds",
            value: String(capacity).padStart(2, "0"),
            note: fire ? "Across Central District" : "24 total critical care beds",
            icon: fire ? Flame : BedDouble,
          },
          {
            label: "Average response",
            value: fire ? "4.2 min" : "6.1 min",
            note: "Within network target",
            icon: Clock3,
          },
          {
            label: "Agent coordination",
            value: "Online",
            note: "4 nodes connected",
            icon: Network,
          },
        ].map((m) => (
          <div className="metric" key={m.label}>
            <div className="status-label">
              {m.label}
              <m.icon />
            </div>
            <strong>{m.value}</strong>
            <small>{m.note}</small>
          </div>
        ))}
      </div>
      <div className="flex gap-2 flex-wrap mb-6">
        <Button
          onClick={() => {
            setAck(true);
            toast.success("Demo dispatch acknowledged");
          }}
          disabled={ack}
        >
          <Check />
          {ack ? "Dispatch acknowledged" : "Acknowledge Dispatch"}
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            setRerouted(true);
            toast.success("Demo fleet re-routed via Mission Street");
          }}
        >
          <Route />
          {rerouted ? "Fleet re-routed" : "Re-route Autonomous Drone/Fleet"}
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            setNextCapacity(capacity);
            setCapacityOpen(true);
          }}
        >
          <SlidersHorizontal />
          Update Capacity
        </Button>
      </div>
      <div className="service-grid">
        <div>
          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>
                  {fire ? (
                    <Flame className="text-warning" />
                  ) : (
                    <HeartPulse className="text-hospital" />
                  )}
                  {fire ? "Active dispatch telemetry" : "Incoming patient feed"}
                </h2>
                <p>Live agent-coordinated requests · Simulated data</p>
              </div>
              <Badge tone="green">
                <span className="dot" />
                Live feed
              </Badge>
            </div>
            {(fire
              ? [
                  {
                    name: "Structure fire · Market Street",
                    id: "INC-2041",
                    desc: "Smoke visible from the third floor. Two people reported trapped. Engine 3 and Rescue 1 assigned.",
                    priority: "Critical",
                    eta: "4 min",
                    meta: "Joint response · Zone 04",
                  },
                  {
                    name: "Gas leak · Hayes Valley",
                    id: "INC-2039",
                    desc: "Suspected gas leak in a residential building. Evacuation in progress; Hazmat team requested.",
                    priority: "High",
                    eta: "7 min",
                    meta: "Hazmat response · Zone 03",
                  },
                ]
              : [
                  {
                    name: "Alex Morgan · 32 yrs",
                    id: "EMS-1049",
                    desc: "Acute shortness of breath with asthma history. Conscious and responsive. Penicillin allergy flagged in emergency profile.",
                    priority: "Critical",
                    eta: "6 min",
                    meta: "Ambulance #12 · O+",
                  },
                  {
                    name: "Taylor Reed · 58 yrs",
                    id: "EMS-1047",
                    desc: "Chest pain, radiating to left arm. Field ECG assessment completed. Cardiology team notified.",
                    priority: "Critical",
                    eta: "3 min",
                    meta: "Ambulance #08 · A+",
                  },
                  {
                    name: "Sam Patel · 24 yrs",
                    id: "EMS-1045",
                    desc: "Lower limb injury following a bicycle collision. Vitals stable. Orthopedic assessment requested.",
                    priority: "High",
                    eta: "9 min",
                    meta: "Ambulance #15 · B+",
                  },
                ]
            ).map((p, i) => (
              <article className="patient" key={p.id}>
                <div className="patient-top">
                  <h3>{p.name}</h3>
                  <Badge tone={p.priority === "Critical" ? "rose" : "amber"}>{p.priority}</Badge>
                </div>
                <p>{p.desc}</p>
                <div className="patient-meta">
                  <span className="mono">{p.id}</span>
                  <span>{p.meta}</span>
                  <span className="ml-auto text-foreground">
                    {i === 0 && ack ? "Acknowledged" : `ETA ${p.eta}`}
                  </span>
                </div>
              </article>
            ))}
          </section>
          <section className="panel mt-5">
            <div className="panel-head compact-head">
              <h2>
                <Database className="text-hospital" />
                {fire ? "Field agent incident briefing" : "RAG-assisted trauma briefing"}
              </h2>
              <Badge tone="sky">Context retrieved</Badge>
            </div>
            <div className="briefing">
              <strong>RESOURCE MEMORY · FIELD AGENT CONTEXT</strong>
              {fire
                ? "Market Street incident: residential structure, 4 floors. Entry from north gate; flammable materials reported. Rescue priority on floor 3. Joint EMS staging recommended on adjacent street."
                : "Patient context matches prior asthma history. Known allergy: Penicillin. Current medication: Albuterol inhaler. No implanted devices. Field triage suggests respiratory distress; respiratory team and critical care bed should be prepared."}
              <p className="text-muted-foreground mt-3 text-[10px]">
                Demonstration briefing · Human clinical / field review required
              </p>
            </div>
          </section>
        </div>
        <aside className="right-stack">
          <section className="panel">
            <div className="panel-head compact-head">
              <h2>
                {fire ? <Flame /> : <BedDouble />}
                {fire ? "Unit availability" : "Critical care capacity"}
              </h2>
              <Badge tone="green">{capacity} available</Badge>
            </div>
            {fire ? (
              <>
                {[
                  {
                    name: "Engine 3",
                    detail: "Structure fire · Market Street",
                    status: "Dispatched",
                  },
                  { name: "Rescue 1", detail: "Technical rescue", status: "En route" },
                  { name: "Hazmat 2", detail: "Specialized response", status: "Available" },
                  { name: "Engine 5", detail: "Central District standby", status: "Available" },
                ].map((u) => (
                  <div className="unit-row" key={u.name}>
                    <div>
                      <strong>{u.name}</strong>
                      <small>{u.detail}</small>
                    </div>
                    <Badge tone={u.status === "Available" ? "green" : "amber"}>{u.status}</Badge>
                  </div>
                ))}
              </>
            ) : (
              <div className="compact-body">
                <div className="flex justify-between text-[11px]">
                  <strong>{24 - capacity} / 24 beds occupied</strong>
                  <span className="text-muted-foreground">
                    {Math.round(((24 - capacity) / 24) * 100)}% occupancy
                  </span>
                </div>
                <div className="capacity">
                  {Array.from({ length: 24 }, (_, i) => (
                    <div className={`bed ${i < 24 - capacity ? "occupied" : ""}`} key={i}>
                      <BedDouble size={13} />
                    </div>
                  ))}
                </div>
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>● Occupied</span>
                  <span className="text-primary">● Available</span>
                </div>
              </div>
            )}
          </section>
          {fire && (
            <section className="panel">
              <div className="panel-head compact-head">
                <h2>
                  <MapPinIcon />
                  Response zone · Active alerts
                </h2>
              </div>
              <ZoneMap />
              <div className="zone-meta">
                <strong>Central District</strong>
                <Badge tone="amber">2 active alerts</Badge>
              </div>
            </section>
          )}
          <section className="panel">
            <div className="panel-head compact-head">
              <h2>
                <Terminal />
                Autonomous Agent Logs
              </h2>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Toggle autonomous agent logs"
                onClick={() => setLogs(!logs)}
              >
                <ChevronDown />
              </Button>
            </div>
            {logs && (
              <div className="logs">
                <p>
                  <span>07:06:12</span> Context lookup complete
                </p>
                <p>
                  <span>07:06:13</span> TriageAgent: priority P1
                </p>
                <p>
                  <span>07:06:14</span> Route availability resolved
                </p>
                <p>
                  <span>07:06:15</span> {fire ? "Engine 3" : "Ambulance #12"} assigned
                </p>
                <p>
                  <span>07:06:16</span> Facility alert delivered
                </p>
                {ack && (
                  <p>
                    <span>07:06:18</span> Operator acknowledged
                  </p>
                )}
                {rerouted && (
                  <p>
                    <span>07:06:20</span> Fleet route updated
                  </p>
                )}
              </div>
            )}
          </section>
        </aside>
      </div>
      <Dialog open={capacityOpen} onOpenChange={setCapacityOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Update {fire ? "unit" : "bed"} capacity</DialogTitle>
            <DialogDescription>Update available resources in this simulation.</DialogDescription>
          </DialogHeader>
          <label className="field">
            Available {fire ? "units" : "critical care beds"}
            <input
              type="number"
              min={0}
              max={fire ? 20 : 24}
              value={nextCapacity}
              onChange={(e) =>
                setNextCapacity(Math.max(0, Math.min(fire ? 20 : 24, Number(e.target.value))))
              }
            />
          </label>
          <Button
            onClick={() => {
              setCapacity(nextCapacity);
              setCapacityOpen(false);
              toast.success("Demo capacity updated");
            }}
          >
            <Check />
            Save capacity
          </Button>
        </DialogContent>
      </Dialog>
    </Shell>
  );
}
import { MapPin as MapPinIcon } from "lucide-react";
export function AdminDashboard() {
  const [intervene, setIntervene] = useState(false);
  const [severity, setSeverity] = useState("All");
  const [selected, setSelected] = useState<string | null>(null);
  const agents = [
    {
      name: "TriageAgent-01",
      role: "Clinical prioritization",
      icon: HeartPulse,
      latency: "42 ms",
      work: "1,842",
    },
    {
      name: "DispatchRouter-v2",
      role: "Response orchestration",
      icon: Network,
      latency: "28 ms",
      work: "1,796",
    },
    {
      name: "ResourceMemory-RAG",
      role: "Vector context retrieval",
      icon: Database,
      latency: "18 ms",
      work: "3,104",
    },
    {
      name: "NotificationBot",
      role: "Cross-channel delivery",
      icon: Bot,
      latency: "12 ms",
      work: "4,682",
    },
  ];
  const audit = [
    {
      time: "07:06:24",
      level: "Info",
      text: "DispatchRouter-v2 assigned Ambulance #12 to EMS-1049.",
    },
    {
      time: "07:06:22",
      level: "Success",
      text: "ResourceMemory-RAG retrieved medical context. Similarity: 0.98.",
    },
    {
      time: "07:06:20",
      level: "Warning",
      text: "Critical care occupancy reached 67%. Capacity monitor notified.",
    },
    {
      time: "07:06:18",
      level: "Info",
      text: "TriageAgent-01 classified INC-2041 as critical. Joint response requested.",
    },
    {
      time: "07:06:15",
      level: "Success",
      text: "NotificationBot delivered incident alert to Metro Fire Station 4.",
    },
    {
      time: "07:06:11",
      level: "Info",
      text: "Vector memory index synchronized. 24,816 context records ready.",
    },
  ];
  return (
    <Shell role="admin" title="Agent orchestration">
      <div className="page-heading">
        <div>
          <div className="eyebrow">System administration · Mission control</div>
          <h1>Agent orchestration</h1>
          <p className="subtitle">
            A live view of your autonomous dispatch mesh, pipeline health, and decisions.
          </p>
        </div>
        <Badge tone="green">
          <span className="dot pulse" />
          All pipelines operational
        </Badge>
      </div>
      <div className="metrics">
        {[
          {
            label: "Autonomous workflows",
            value: "12,486",
            trend: "+12.8%",
            note: "this week",
            icon: Activity,
          },
          {
            label: "Active agent count",
            value: "04 / 04",
            trend: "100%",
            note: "availability",
            icon: Network,
          },
          {
            label: "Mean resolution time",
            value: "2.4 min",
            trend: "−18.2%",
            note: "vs. last week",
            icon: Clock3,
          },
          {
            label: "Vector memory hit rate",
            value: "98.6%",
            trend: "+2.1%",
            note: "retrieval accuracy",
            icon: Database,
          },
        ].map((m) => (
          <div className="metric" key={m.label}>
            <div className="status-label">
              {m.label}
              <m.icon />
            </div>
            <strong>{m.value}</strong>
            <small>
              <em>{m.trend}</em> {m.note}
            </small>
          </div>
        ))}
      </div>
      <div className="content-grid">
        <div>
          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>
                  <Network className="text-orchestrator" />
                  Multi-agent orchestration mesh
                </h2>
                <p>Connected intelligence · Sequential review and coordinated action</p>
              </div>
              <Badge tone="violet">4 active nodes</Badge>
            </div>
            <div className="mesh">
              <div className="mesh-nodes">
                {agents.map((a) => (
                  <Button
                    variant="outline"
                    className="mesh-node"
                    key={a.name}
                    onClick={() => setSelected(a.name)}
                  >
                    <a.icon />
                    <strong>{a.name}</strong>
                    <small>{a.role}</small>
                    <span className="flex items-center gap-1 text-primary">
                      <span className="dot" />
                      Operational
                    </span>
                  </Button>
                ))}
              </div>
            </div>
            <div className="agent-footer">
              <span>Context ingestion → Triage → Dispatch → Notification</span>
              <span className="mono">MESH v2.4</span>
            </div>
          </section>
          <section className="panel mt-5">
            <div className="panel-head">
              <div>
                <h2>
                  <Terminal />
                  System audit stream
                </h2>
                <p>Autonomous decisions & network events</p>
              </div>
              <div className="audit-filters">
                {["All", "Info", "Warning", "Success"].map((s) => (
                  <Button
                    key={s}
                    variant={severity === s ? "secondary" : "ghost"}
                    aria-pressed={severity === s}
                    onClick={() => setSeverity(s)}
                  >
                    {s}
                  </Button>
                ))}
              </div>
            </div>
            {intervene && (
              <div className="audit-row">
                <span className="mono">Now</span>
                <Badge tone="amber">Override</Badge>
                <span>Human review activated. New autonomous dispatches paused in demo.</span>
              </div>
            )}
            {audit
              .filter((a) => severity === "All" || a.level === severity)
              .map((a) => (
                <div className="audit-row" key={a.time}>
                  <span className="mono">{a.time}</span>
                  <Badge
                    tone={a.level === "Warning" ? "amber" : a.level === "Success" ? "green" : ""}
                  >
                    {a.level}
                  </Badge>
                  <span>{a.text}</span>
                </div>
              ))}
          </section>
        </div>
        <aside className="right-stack">
          <section className="panel">
            <div className="panel-head compact-head">
              <h2>
                <Activity className="text-orchestrator" />
                Pipeline health
              </h2>
              <Badge tone="green">Healthy</Badge>
            </div>
            <div className="compact-body">
              <div className="section-label">
                RAG retrieval latency <strong className="mono">18 ms</strong>
              </div>
              <div className="progress-track">
                <div className="progress-fill" />
              </div>
              <div className="section-label">
                Context window utilization<strong className="mono">42%</strong>
              </div>
              <div className="progress-track">
                <div className="progress-fill violet" />
              </div>
              <div className="section-label">
                Queue depth<strong className="mono">03 tasks</strong>
              </div>
              <div className="section-label mt-5">
                Error rate<strong className="text-primary mono">0.02%</strong>
              </div>
            </div>
          </section>
          <section className="panel">
            <div className="panel-head compact-head">
              <h2>
                <Database />
                Vector store status
              </h2>
              <span className="dot" />
            </div>
            <div className="compact-body">
              <div className="profile-summary">
                <div>
                  <small>CONTEXT RECORDS</small>
                  <strong>24,816</strong>
                </div>
                <div>
                  <small>DIMENSIONS</small>
                  <strong>1,536</strong>
                </div>
                <div>
                  <small>INDEX HEALTH</small>
                  <strong className="text-primary">Optimal</strong>
                </div>
                <div>
                  <small>LAST SYNC</small>
                  <strong>12 seconds ago</strong>
                </div>
              </div>
              <Badge tone="green">
                <ShieldCheck size={11} />
                Consent-controlled retrieval
              </Badge>
            </div>
          </section>
          <section className="panel">
            <div className="panel-head compact-head">
              <h2>
                <Users />
                Human-in-the-loop
              </h2>
            </div>
            <div className="compact-body">
              <div className="flex justify-between items-center gap-3">
                <strong className="text-[11px]">Human-in-the-Loop Intervene</strong>
                <Switch
                  checked={intervene}
                  onCheckedChange={(v) => {
                    setIntervene(v);
                    toast(
                      v ? "Human review activated in demo" : "Autonomous review resumed in demo",
                    );
                  }}
                  aria-label="Human-in-the-Loop Intervene"
                />
              </div>
              <p className="subtitle text-[10px]">
                {intervene
                  ? "Human review required. Simulated autonomous dispatch is paused."
                  : "Autonomous decisions monitored. Human oversight on standby."}
              </p>
              <Badge tone={intervene ? "amber" : "green"}>
                {intervene ? "Manual review active" : "Autonomous mode"}
              </Badge>
            </div>
          </section>
        </aside>
      </div>
      <Dialog
        open={selected !== null}
        onOpenChange={(v) => {
          if (!v) setSelected(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{selected}</DialogTitle>
            <DialogDescription>Agent operational detail · Demonstration data</DialogDescription>
          </DialogHeader>
          {agents
            .filter((a) => a.name === selected)
            .map((a) => (
              <div key={a.name}>
                <Badge tone="green">Operational</Badge>
                <div className="profile-summary mt-6">
                  <div>
                    <small>RESPONSIBILITY</small>
                    <strong>{a.role}</strong>
                  </div>
                  <div>
                    <small>LATENCY</small>
                    <strong>{a.latency}</strong>
                  </div>
                  <div>
                    <small>WORKFLOWS COMPLETED</small>
                    <strong>{a.work}</strong>
                  </div>
                  <div>
                    <small>OVERSIGHT</small>
                    <strong>{intervene ? "Human review" : "Autonomous"}</strong>
                  </div>
                </div>
              </div>
            ))}
        </DialogContent>
      </Dialog>
    </Shell>
  );
}
