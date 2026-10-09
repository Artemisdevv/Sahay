import { useState, useEffect, useCallback } from "react";
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
  Loader2,
  X,
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
import { Shell, Badge, ZoneMap } from "./dispatch-shell";
import { toast } from "sonner";
import { getSession } from "@/lib/session";
import {
  getDispatchesMine,
  acceptDispatch,
  declineDispatch,
  updateDispatchStatus,
  revealIncidentPii,
  verifyAuditChain,
  type Dispatch,
  type IncidentPii,
} from "@/lib/api";
import {
  useDispatchWS,
  type DispatchUpdatedEvent,
} from "@/hooks/use-dispatch-ws";

function getStatusBadgeTone(status: Dispatch["status"]) {
  switch (status) {
    case "proposed":
      return "amber";
    case "accepted":
      return "blue";
    case "en_route":
      return "sky";
    case "arrived":
      return "violet";
    case "completed":
      return "green";
    case "declined":
      return "rose";
    default:
      return "";
  }
}

function getStatusLabel(status: Dispatch["status"]) {
  return status.charAt(0).toUpperCase() + status.slice(1).replace("_", " ");
}

export function OperationsConsole({ serviceId }: { serviceId: string }) {
  const fire = serviceId.includes("fire");
  const [ack, setAck] = useState(false);
  const [rerouted, setRerouted] = useState(false);
  const [capacity, setCapacity] = useState(fire ? 4 : 8);
  const [capacityOpen, setCapacityOpen] = useState(false);
  const [nextCapacity, setNextCapacity] = useState(capacity);
  const [logs, setLogs] = useState(true);
  const [dispatches, setDispatches] = useState<Dispatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [wsConnected, setWsConnected] = useState(false);

  const loadDispatches = useCallback(async () => {
    const session = getSession();
    if (!session?.token) return;
    try {
      const data = await getDispatchesMine(session.token);
      setDispatches(data.dispatches);
    } catch (e) {
      console.error("Failed to load dispatches:", e);
      toast.error("Failed to load dispatches");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDispatches();
  }, [loadDispatches]);

  const handleWsEvent = useCallback(
    (
      event:
        | DispatchUpdatedEvent
        | {
            type: "incident.updated";
            ts: string;
            data: { incident_id: string; status: string };
          },
    ) => {
      if (event.type === "dispatch.updated") {
        setDispatches((prev) =>
          prev.map((d) =>
            d.dispatch_id === event.data.dispatch_id
              ? {
                  ...d,
                  status: event.data.status as Dispatch["status"],
                  updated_at: event.ts,
                }
              : d,
          ),
        );
        toast.info(
          `Dispatch ${event.data.dispatch_id.slice(0, 8)}: ${getStatusLabel(event.data.status as Dispatch["status"])}`,
        );
      }
    },
    [],
  );

  useDispatchWS(handleWsEvent);

  const handleAccept = async (dispatchId: string) => {
    const session = getSession();
    if (!session?.token) return;
    try {
      const updated = await acceptDispatch(dispatchId, session.token);
      setDispatches((prev) =>
        prev.map((d) => (d.dispatch_id === dispatchId ? updated : d)),
      );
      toast.success("Dispatch accepted");
    } catch (e) {
      toast.error("Failed to accept dispatch");
    }
  };

  const handleDecline = async (dispatchId: string) => {
    const session = getSession();
    if (!session?.token) return;
    try {
      const updated = await declineDispatch(dispatchId, session.token);
      setDispatches((prev) =>
        prev.map((d) => (d.dispatch_id === dispatchId ? updated : d)),
      );
      toast.success("Dispatch declined");
    } catch (e) {
      toast.error("Failed to decline dispatch");
    }
  };

  const handleStatusUpdate = async (
    dispatchId: string,
    status: Dispatch["status"],
  ) => {
    const session = getSession();
    if (!session?.token) return;
    try {
      const updated = await updateDispatchStatus(
        dispatchId,
        status,
        session.token,
      );
      setDispatches((prev) =>
        prev.map((d) => (d.dispatch_id === dispatchId ? updated : d)),
      );
      toast.success(`Status updated to ${getStatusLabel(status)}`);
    } catch (e) {
      toast.error("Failed to update status");
    }
  };

  const proposedDispatches = dispatches.filter((d) => d.status === "proposed");
  const activeDispatches = dispatches.filter(
    (d) =>
      d.status !== "proposed" &&
      d.status !== "declined" &&
      d.status !== "completed",
  );

  return (
    <Shell
      role={fire ? "fire" : "hospital"}
      title={fire ? "Fire & rescue" : "Hospital console"}
    >
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
        <Badge tone={wsConnected ? "green" : fire ? "amber" : "sky"}>
          <span className="dot" />
          {wsConnected ? "Live" : "Receiving dispatches"}
        </Badge>
      </div>
      <div className="metrics">
        {[
          {
            label: fire ? "Active dispatches" : "Active patients",
            value: String(activeDispatches.length).padStart(2, "0"),
            note: loading ? "Loading..." : "From backend",
            icon: Activity,
          },
          {
            label: fire ? "Available units" : "Available critical beds",
            value: String(capacity).padStart(2, "0"),
            note: fire
              ? "Across Central District"
              : "24 total critical care beds",
            icon: fire ? Flame : BedDouble,
          },
          {
            label: "Pending dispatches",
            value: String(proposedDispatches.length).padStart(2, "0"),
            note: "Awaiting response",
            icon: Clock3,
          },
          {
            label: "Agent coordination",
            value: wsConnected ? "Online" : "Connecting...",
            note: wsConnected ? "WebSocket connected" : "Reconnecting...",
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
        <Button variant="outline" onClick={loadDispatches} disabled={loading}>
          <Loader2 className={`${loading ? "animate-spin" : ""}`} />
          Refresh
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
                  {fire ? "Pending dispatches" : "Incoming patient dispatches"}
                </h2>
                <p>
                  Real-time from backend · {proposedDispatches.length} awaiting
                  response
                </p>
              </div>
              <Badge tone={proposedDispatches.length > 0 ? "rose" : "green"}>
                <span className="dot" />
                {proposedDispatches.length > 0
                  ? "Action required"
                  : "All clear"}
              </Badge>
            </div>
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="animate-spin h-6 w-6" />
              </div>
            ) : proposedDispatches.length === 0 ? (
              <p className="text-muted-foreground text-center py-8">
                No pending dispatches
              </p>
            ) : (
              proposedDispatches.map((d) => (
                <article className="patient" key={d.dispatch_id}>
                  <div className="patient-top">
                    <h3>
                      {fire
                        ? `Fire: ${d.incident_id.slice(0, 8)}`
                        : `EMS: ${d.incident_id.slice(0, 8)}`}
                    </h3>
                    <Badge tone={getStatusBadgeTone(d.status)}>
                      {getStatusLabel(d.status)}
                    </Badge>
                  </div>
                  <p>
                    Distance: {d.distance_km} km · ETA: {d.eta_minutes} min ·
                    Type: {d.service_type}
                  </p>
                  <div className="patient-meta">
                    <span className="mono">{d.dispatch_id.slice(0, 12)}</span>
                    <span>Proposed by: {d.proposed_by}</span>
                    <div className="flex gap-2 ml-auto">
                      <Button
                        size="sm"
                        onClick={() => handleAccept(d.dispatch_id)}
                      >
                        <Check className="h-3 w-3" />
                        Accept
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleDecline(d.dispatch_id)}
                      >
                        <X className="h-3 w-3" />
                        Decline
                      </Button>
                    </div>
                  </div>
                </article>
              ))
            )}
          </section>
          {activeDispatches.length > 0 && (
            <section className="panel mt-5">
              <div className="panel-head compact-head">
                <h2>
                  <Database className="text-hospital" />
                  Active dispatches
                </h2>
                <Badge tone="sky">{activeDispatches.length} in progress</Badge>
              </div>
              <div className="space-y-3">
                {activeDispatches.map((d) => (
                  <div key={d.dispatch_id} className="patient">
                    <div className="patient-top">
                      <h3>
                        {fire
                          ? `Fire: ${d.incident_id.slice(0, 8)}`
                          : `EMS: ${d.incident_id.slice(0, 8)}`}
                      </h3>
                      <Badge tone={getStatusBadgeTone(d.status)}>
                        {getStatusLabel(d.status)}
                      </Badge>
                    </div>
                    <p>
                      Unit: {d.unit_id.slice(0, 8)} · Distance: {d.distance_km}{" "}
                      km
                    </p>
                    <div className="patient-meta">
                      <span className="mono">{d.dispatch_id.slice(0, 12)}</span>
                      <span>
                        Updated: {new Date(d.updated_at).toLocaleTimeString()}
                      </span>
                      {d.status === "accepted" && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            handleStatusUpdate(d.dispatch_id, "en_route")
                          }
                        >
                          En route
                        </Button>
                      )}
                      {d.status === "en_route" && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            handleStatusUpdate(d.dispatch_id, "arrived")
                          }
                        >
                          Arrived
                        </Button>
                      )}
                      {d.status === "arrived" && (
                        <Button
                          size="sm"
                          onClick={() =>
                            handleStatusUpdate(d.dispatch_id, "completed")
                          }
                        >
                          <Check className="h-3 w-3" />
                          Complete
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
          <section className="panel mt-5">
            <div className="panel-head compact-head">
              <h2>
                <Database className="text-hospital" />
                {fire
                  ? "Field agent incident briefing"
                  : "RAG-assisted trauma briefing"}
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
                  {
                    name: "Rescue 1",
                    detail: "Technical rescue",
                    status: "En route",
                  },
                  {
                    name: "Hazmat 2",
                    detail: "Specialized response",
                    status: "Available",
                  },
                  {
                    name: "Engine 5",
                    detail: "Central District standby",
                    status: "Available",
                  },
                ].map((u) => (
                  <div className="unit-row" key={u.name}>
                    <div>
                      <strong>{u.name}</strong>
                      <small>{u.detail}</small>
                    </div>
                    <Badge tone={u.status === "Available" ? "green" : "amber"}>
                      {u.status}
                    </Badge>
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
                    <div
                      className={`bed ${i < 24 - capacity ? "occupied" : ""}`}
                      key={i}
                    >
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
                  <MapPin />
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
                  <span>07:06:15</span> {fire ? "Engine 3" : "Ambulance #12"}{" "}
                  assigned
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
            <DialogDescription>
              Update available resources in this simulation.
            </DialogDescription>
          </DialogHeader>
          <label className="field">
            Available {fire ? "units" : "critical care beds"}
            <input
              type="number"
              min={0}
              max={fire ? 20 : 24}
              value={nextCapacity}
              onChange={(e) =>
                setNextCapacity(
                  Math.max(0, Math.min(fire ? 20 : 24, Number(e.target.value))),
                )
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
export function AdminDashboard() {
  const [intervene, setIntervene] = useState(false);
  const [severity, setSeverity] = useState("All");
  const [selected, setSelected] = useState<string | null>(null);
  const [piiModalOpen, setPiiModalOpen] = useState(false);
  const [selectedIncident, setSelectedIncident] = useState<string | null>(null);
  const [piiData, setPiiData] = useState<IncidentPii | null>(null);
  const [piiLoading, setPiiLoading] = useState(false);
  const [auditVerified, setAuditVerified] = useState<boolean | null>(null);
  const [auditVerifying, setAuditVerifying] = useState(false);

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
  const incidents = [
    {
      id: "22222222-2222-4222-8222-222222222222",
      title: "Car accident · Highway 101",
      status: "dispatched",
    },
    {
      id: "33333333-3333-4333-8333-333333333333",
      title: "Structure fire · Market Street",
      status: "active",
    },
    {
      id: "44444444-4444-4444-8444-444444444444",
      title: "Medical emergency · Downtown",
      status: "resolved",
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

  const handleRevealPii = async (incidentId: string) => {
    const session = getSession();
    if (!session?.token) return;
    setSelectedIncident(incidentId);
    setPiiLoading(true);
    setPiiData(null);
    setAuditVerified(null);
    setPiiModalOpen(true);
    try {
      const data = await revealIncidentPii(incidentId, session.token);
      setPiiData(data);
    } catch (e) {
      toast.error("Failed to reveal PII");
    } finally {
      setPiiLoading(false);
    }
  };

  const handleVerifyAudit = async () => {
    const session = getSession();
    if (!session?.token) return;
    setAuditVerifying(true);
    try {
      const result = await verifyAuditChain(session.token);
      setAuditVerified(result.valid);
      toast.success(
        result.valid ? "Audit chain verified ✓" : "Audit chain INVALID ✗",
      );
    } catch (e) {
      toast.error("Failed to verify audit chain");
      setAuditVerified(false);
    } finally {
      setAuditVerifying(false);
    }
  };

  const formatPhone = (phone: string) =>
    phone.replace(/(\+\d{2})(\d{5})(\d{5})/, "$1 $2 $3");

  return (
    <Shell role="admin" title="Agent orchestration">
      <div className="page-heading">
        <div>
          <div className="eyebrow">System administration · Mission control</div>
          <h1>Agent orchestration</h1>
          <p className="subtitle">
            A live view of your autonomous dispatch mesh, pipeline health, and
            decisions.
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
                <p>
                  Connected intelligence · Sequential review and coordinated
                  action
                </p>
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
                <span>
                  Human review activated. New autonomous dispatches paused in
                  demo.
                </span>
              </div>
            )}
            {audit
              .filter((a) => severity === "All" || a.level === severity)
              .map((a) => (
                <div className="audit-row" key={a.time}>
                  <span className="mono">{a.time}</span>
                  <Badge
                    tone={
                      a.level === "Warning"
                        ? "amber"
                        : a.level === "Success"
                          ? "green"
                          : ""
                    }
                  >
                    {a.level}
                  </Badge>
                  <span>{a.text}</span>
                </div>
              ))}
          </section>
          <section className="panel mt-5">
            <div className="panel-head">
              <div>
                <h2>
                  <ShieldCheck className="text-primary" />
                  PII Reveal & Audit Verification
                </h2>
                <p>
                  Decrypt incident PII (admin only) and verify hash-chained
                  audit log integrity
                </p>
              </div>
              <Badge tone="amber">Admin only</Badge>
            </div>
            <div className="space-y-3">
              {incidents.map((inc) => (
                <div key={inc.id} className="patient">
                  <div className="patient-top">
                    <h3>{inc.title}</h3>
                    <Badge
                      tone={
                        inc.status === "active"
                          ? "rose"
                          : inc.status === "dispatched"
                            ? "blue"
                            : "green"
                      }
                    >
                      {inc.status}
                    </Badge>
                  </div>
                  <p className="mono text-xs">{inc.id}</p>
                  <div className="patient-meta">
                    <Button
                      size="sm"
                      onClick={() => handleRevealPii(inc.id)}
                      disabled={piiLoading}
                    >
                      {piiLoading && selectedIncident === inc.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <ShieldCheck className="h-3 w-3" />
                      )}
                      Reveal PII
                    </Button>
                  </div>
                </div>
              ))}
            </div>
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
                <strong className="text-[11px]">
                  Human-in-the-Loop Intervene
                </strong>
                <Switch
                  checked={intervene}
                  onCheckedChange={(v) => {
                    setIntervene(v);
                    toast(
                      v
                        ? "Human review activated in demo"
                        : "Autonomous review resumed in demo",
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
            <DialogDescription>
              Agent operational detail · Demonstration data
            </DialogDescription>
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
      <Dialog open={piiModalOpen} onOpenChange={setPiiModalOpen}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              PII Reveal · {selectedIncident?.slice(0, 12)}
            </DialogTitle>
            <DialogDescription>
              Decrypted personally identifiable information. Audit trail
              recorded.
            </DialogDescription>
          </DialogHeader>
          {piiLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="animate-spin h-6 w-6" />
            </div>
          ) : piiData ? (
            <div className="space-y-4 mt-4">
              <div className="flex items-center gap-3">
                <Badge
                  tone={
                    auditVerified === true
                      ? "green"
                      : auditVerified === false
                        ? "rose"
                        : "amber"
                  }
                >
                  {auditVerified === null
                    ? "Not verified"
                    : auditVerified
                      ? "Chain valid ✓"
                      : "Chain INVALID ✗"}
                </Badge>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleVerifyAudit}
                  disabled={auditVerifying}
                >
                  {auditVerifying ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <ShieldCheck className="h-3 w-3" />
                  )}
                  Verify Audit Chain
                </Button>
              </div>
              <div className="border rounded p-4 bg-muted/30 max-h-96 overflow-y-auto">
                <div className="space-y-3 text-sm">
                  <div>
                    <strong>Transcript:</strong>
                    <p className="mt-1 font-mono text-xs whitespace-pre-wrap">
                      {piiData.transcript}
                    </p>
                  </div>
                  <div>
                    <strong>Reporters:</strong>
                    <ul className="mt-1 space-y-1">
                      {piiData.reporters.map((r) => (
                        <li key={r.report_id} className="font-mono text-xs">
                          {r.name} · {formatPhone(r.phone)} · {r.language}
                          <br />
                          Emergency: {r.emergency_contact.name} ·{" "}
                          {formatPhone(r.emergency_contact.phone)}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <strong>PII Spans:</strong>
                    <ul className="mt-1 space-y-1">
                      {piiData.pii_spans.map((s, i) => (
                        <li key={i} className="font-mono text-xs">
                          {s.type}: "{s.text}" [{s.start}-{s.end}]
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <strong>Audio:</strong>
                    <p className="mt-1 font-mono text-xs">
                      {piiData.audio_url}
                    </p>
                  </div>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                This action has been logged to the audit chain. PII access
                requires admin role.
              </p>
            </div>
          ) : (
            <p className="text-muted-foreground text-center py-8">
              Failed to load PII data
            </p>
          )}
        </DialogContent>
      </Dialog>
    </Shell>
  );
}
