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
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Shell, Badge, IncidentMap } from "./dispatch-shell";
import { ResponseTimeline } from "./response-timeline";
import { toast } from "sonner";
import { getSession } from "@/lib/session";
import {
  getDispatchesMine,
  acceptDispatch,
  declineDispatch,
  updateDispatchStatus,
  getIncidents,
  getIncidentDetails,
  getIncidentCalls,
  getIncidentTrace,
  getUnits,
  approveIncident,
  rejectIncident,
  reassignIncident,
  getAuditEntries,
  revealIncidentPii,
  fetchIncidentAudio,
  verifyAuditChain,
  getPublicUnits,
  type AuditEntry,
  type AgentTraceStep,
  type Dispatch,
  type IncidentActionResult,
  type IncidentPii,
  type IncidentSummary,
  type PublicUnit,
  type ServiceType,
  type ServiceCallList,
  type Unit,
} from "@/lib/api";
import { useDispatchWS, type WSEvent } from "@/hooks/use-dispatch-ws";

function getStatusBadgeTone(status: Dispatch["status"]) {
  switch (status) {
    case "proposed":
    case "approved":
      return "amber";
    case "accepted":
      return "blue";
    case "en_route":
      return "sky";
    case "on_scene":
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

function getAuditCategory(action: string) {
  if (action === "pii.reveal") return "PII";
  if (action.startsWith("auth.")) return "Auth";
  if (action.startsWith("dispatch.") || action.startsWith("incident."))
    return "Dispatch";
  return "Other";
}

type IncidentPanelData = {
  dispatches: Dispatch[];
  trace: AgentTraceStep[];
  callLists: ServiceCallList[];
};

const SERVICE_TYPES: ServiceType[] = [
  "ambulance",
  "police",
  "fire",
  "municipal",
];

function formatTraceTime(value: string | null) {
  if (!value) return "In progress";
  return new Date(value).toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function OperationsConsole({ serviceId }: { serviceId: string }) {
  const fire = serviceId.includes("fire");
  const ambulance = serviceId.includes("ambulance");
  const police = serviceId.includes("police");
  const [ack, setAck] = useState(false);
  const [rerouted, setRerouted] = useState(false);
  const [capacity, setCapacity] = useState(fire ? 4 : 8);
  const [capacityOpen, setCapacityOpen] = useState(false);
  const [nextCapacity, setNextCapacity] = useState(capacity);
  const [logs, setLogs] = useState(true);
  const [dispatches, setDispatches] = useState<Dispatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [wsConnected, setWsConnected] = useState(false);
  const [updatingDispatchIds, setUpdatingDispatchIds] = useState<Set<string>>(
    new Set(),
  );
  const [callCountdown, setCallCountdown] = useState<
    Record<
      string,
      {
        serviceType: string;
        candidates: Array<{
          rank: number;
          unitId: string;
          name: string;
          distanceKm: number;
          etaMinutes: number;
          state: string;
        }>;
      }
    >
  >({});
  const [publicUnits, setPublicUnits] = useState<PublicUnit[]>([]);

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

  const loadPublicUnits = useCallback(async () => {
    try {
      const data = await getPublicUnits();
      setPublicUnits(data.units);
    } catch (e) {
      console.error("Failed to load public units:", e);
    }
  }, []);

  useEffect(() => {
    loadDispatches();
    loadPublicUnits();
  }, [loadDispatches, loadPublicUnits]);

  const handleWsEvent = useCallback(
    (event: WSEvent) => {
      if (event.type === "dispatch.updated") {
        toast.info(
          `Dispatch ${event.data.dispatch_id.slice(0, 8)}: ${getStatusLabel(event.data.status as Dispatch["status"])}`,
        );
      }
      if (event.type === "dispatch.called") {
        const { incident_id, service_type, candidates } = event.data as {
          incident_id: string;
          service_type: string;
          candidates: Array<{
            rank: number;
            unit_id: string;
            name: string;
            distance_km: number;
            eta_minutes: number;
            state: string;
          }>;
        };
        setCallCountdown((prev) => ({
          ...prev,
          [incident_id]: {
            serviceType: service_type,
            candidates: candidates.map((c) => ({
              rank: c.rank,
              unitId: c.unit_id,
              name: c.name,
              distanceKm: c.distance_km,
              etaMinutes: c.eta_minutes,
              state: c.state,
            })),
          },
        }));
      }
      if (event.type !== "unit.moved") void loadDispatches();
    },
    [loadDispatches],
  );

  const { connected } = useDispatchWS(handleWsEvent);
  useEffect(() => setWsConnected(connected), [connected]);

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
      await declineDispatch(dispatchId, session.token);
      await loadDispatches();
      toast.success("Dispatch declined");
    } catch (e) {
      toast.error("Failed to decline dispatch");
    }
  };

  const handleStatusUpdate = async (
    dispatchId: string,
    status: "en_route" | "on_scene" | "completed",
  ) => {
    const session = getSession();
    if (!session?.token) return;
    if (updatingDispatchIds.has(dispatchId)) return;
    setUpdatingDispatchIds((prev) => new Set(prev).add(dispatchId));
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
    } finally {
      setUpdatingDispatchIds((prev) => {
        const next = new Set(prev);
        next.delete(dispatchId);
        return next;
      });
    }
  };

  const proposedDispatches = dispatches.filter((d) => d.status === "approved");
  const activeDispatches = dispatches.filter(
    (d) =>
      d.status !== "proposed" &&
      d.status !== "approved" &&
      d.status !== "declined" &&
      d.status !== "completed",
  );

  const serviceLabel = fire
    ? "Fire & rescue"
    : ambulance
      ? "Ambulance"
      : police
        ? "Police"
        : "Hospital";
  const serviceIcon = fire
    ? Flame
    : ambulance
      ? HeartPulse
      : police
        ? ShieldCheck
        : BedDouble;
  const serviceColor = fire
    ? "amber"
    : ambulance
      ? "hospital"
      : police
        ? "blue"
        : "hospital";
  const stationName = fire
    ? "Metro Fire Station 4"
    : ambulance
      ? "Ambulance Unit 1"
      : police
        ? "Police Unit 1"
        : "City General Hospital";
  const stationDetail = fire
    ? "Station 04"
    : ambulance
      ? "EMS Station"
      : police
        ? "Precinct 1"
        : "Hospital 01";

  return (
    <Shell
      role={
        fire ? "fire" : ambulance ? "ambulance" : police ? "police" : "hospital"
      }
      title={serviceLabel}
    >
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            First responder workspace · {stationDetail}
          </div>
          <h1>{stationName}</h1>
          <p className="subtitle">
            {fire
              ? "Dispatch intelligence and field resource coordination."
              : ambulance
                ? "Emergency medical dispatch and patient transport coordination."
                : police
                  ? "Law enforcement dispatch and field unit coordination."
                  : "Emergency intake, patient context, and critical care coordination."}
          </p>
        </div>
        <Badge
          tone={
            wsConnected
              ? "green"
              : serviceColor === "amber"
                ? "amber"
                : serviceColor === "blue"
                  ? "blue"
                  : "sky"
          }
        >
          <span className="dot" />
          {wsConnected ? "Live" : "Receiving dispatches"}
        </Badge>
      </div>
      <div className="metrics">
        {[
          {
            label: fire
              ? "Active incidents"
              : ambulance
                ? "Active patients"
                : police
                  ? "Active calls"
                  : "Active patients",
            value: String(activeDispatches.length).padStart(2, "0"),
            note: loading ? "Loading..." : "From backend",
            icon: Activity,
          },
          {
            label: fire
              ? "Available units"
              : ambulance
                ? "Available ambulances"
                : police
                  ? "Available units"
                  : "Available critical beds",
            value: String(capacity).padStart(2, "0"),
            note: fire
              ? "Across Central District"
              : ambulance
                ? "Across EMS network"
                : police
                  ? "Across precinct"
                  : "24 total critical care beds",
            icon: fire
              ? Flame
              : ambulance
                ? HeartPulse
                : police
                  ? ShieldCheck
                  : BedDouble,
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
      <section className="panel mb-6">
        <div className="panel-head compact-head">
          <h2>
            <MapPin />
            Response map · Assigned incidents
          </h2>
        </div>
        <IncidentMap role="service" />
        <div className="zone-meta">
          <strong>Central District</strong>
          <Badge tone="sky">Contract filtered</Badge>
        </div>
      </section>
      <div className="service-grid">
        <div>
          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>
                  {fire ? (
                    <Flame className="text-warning" />
                  ) : ambulance ? (
                    <HeartPulse className="text-hospital" />
                  ) : police ? (
                    <ShieldCheck className="text-blue" />
                  ) : (
                    <HeartPulse className="text-hospital" />
                  )}
                  {fire
                    ? "Pending dispatches"
                    : ambulance
                      ? "Incoming patient dispatches"
                      : police
                        ? "Incoming police dispatches"
                        : "Incoming patient dispatches"}
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
                        : ambulance
                          ? `EMS: ${d.incident_id.slice(0, 8)}`
                          : police
                            ? `Police: ${d.incident_id.slice(0, 8)}`
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
                {activeDispatches.map((d) => {
                  const callInfo = callCountdown[d.incident_id];
                  return (
                    <div key={d.dispatch_id} className="patient">
                      <div className="patient-top">
                        <h3>
                          {fire
                            ? `Fire: ${d.incident_id.slice(0, 8)}`
                            : ambulance
                              ? `EMS: ${d.incident_id.slice(0, 8)}`
                              : police
                                ? `Police: ${d.incident_id.slice(0, 8)}`
                                : `EMS: ${d.incident_id.slice(0, 8)}`}
                        </h3>
                        <Badge tone={getStatusBadgeTone(d.status)}>
                          {getStatusLabel(d.status)}
                        </Badge>
                      </div>
                      <p>
                        Unit: {d.unit_id.slice(0, 8)} · Distance:{" "}
                        {d.distance_km} km
                      </p>
                      {callInfo && callInfo.serviceType === d.service_type && (
                        <div className="call-countdown mb-2 p-2 bg-muted rounded text-sm">
                          <strong>Calling {callInfo.serviceType} units:</strong>
                          {callInfo.candidates.map((c) => (
                            <div
                              key={c.unitId}
                              className="flex items-center gap-2 text-[11px]"
                            >
                              <span className="mono">#{c.rank}</span>
                              <span>{c.name}</span>
                              <span className="text-muted-foreground">
                                {c.distanceKm} km · {c.etaMinutes} min
                              </span>
                              <Badge
                                tone={
                                  c.state === "calling"
                                    ? "amber"
                                    : c.state === "accepted"
                                      ? "green"
                                      : c.state === "declined"
                                        ? "rose"
                                        : "gray"
                                }
                              >
                                {c.state}
                              </Badge>
                            </div>
                          ))}
                        </div>
                      )}
                      <div className="patient-meta">
                        <span className="mono">
                          {d.dispatch_id.slice(0, 12)}
                        </span>
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
                            disabled={updatingDispatchIds.has(d.dispatch_id)}
                          >
                            {updatingDispatchIds.has(d.dispatch_id) ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              "En route"
                            )}
                          </Button>
                        )}
                        {d.status === "en_route" && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              handleStatusUpdate(d.dispatch_id, "on_scene")
                            }
                            disabled={updatingDispatchIds.has(d.dispatch_id)}
                          >
                            {updatingDispatchIds.has(d.dispatch_id) ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              "On scene"
                            )}
                          </Button>
                        )}
                        {d.status === "on_scene" && (
                          <Button
                            size="sm"
                            onClick={() =>
                              handleStatusUpdate(d.dispatch_id, "completed")
                            }
                            disabled={updatingDispatchIds.has(d.dispatch_id)}
                          >
                            {updatingDispatchIds.has(d.dispatch_id) ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <>
                                <Check className="h-3 w-3" />
                                Complete
                              </>
                            )}
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
          <section className="panel mt-5">
            <div className="panel-head compact-head">
              <h2>
                <Database className="text-hospital" />
                {fire
                  ? "Field agent incident briefing"
                  : ambulance
                    ? "EMS dispatch briefing"
                    : police
                      ? "Police dispatch briefing"
                      : "RAG-assisted trauma briefing"}
              </h2>
              <Badge tone="sky">Context retrieved</Badge>
            </div>
            <div className="briefing">
              <strong>RESOURCE MEMORY · FIELD AGENT CONTEXT</strong>
              {fire
                ? "Market Street incident: residential structure, 4 floors. Entry from north gate; flammable materials reported. Rescue priority on floor 3. Joint EMS staging recommended on adjacent street."
                : ambulance
                  ? "Patient context matches prior asthma history. Known allergy: Penicillin. Current medication: Albuterol inhaler. No implanted devices. Field triage suggests respiratory distress; respiratory team and critical care bed should be prepared."
                  : police
                    ? "Suspect vehicle last seen heading north on Main St. Registered to known associate. Caution advised. Backup units positioned at intersection of 5th and Oak."
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
                {fire ? (
                  <Flame />
                ) : ambulance ? (
                  <HeartPulse />
                ) : police ? (
                  <ShieldCheck />
                ) : (
                  <BedDouble />
                )}
                {fire
                  ? "Unit availability"
                  : ambulance
                    ? "Ambulance availability"
                    : police
                      ? "Unit availability"
                      : "Critical care capacity"}
              </h2>
              <Badge tone="green">{capacity} available</Badge>
            </div>
            {fire || ambulance || police ? (
              <>
                {(() => {
                  const filteredPublicUnits = publicUnits.filter((u) =>
                    fire
                      ? u.service_type === "fire"
                      : ambulance
                        ? u.service_type === "ambulance"
                        : u.service_type === "police",
                  );
                  const serviceLabel = fire
                    ? "Fire unit"
                    : ambulance
                      ? "Ambulance unit"
                      : "Police unit";
                  return (
                    <>
                      {filteredPublicUnits.map((u, idx) => (
                        <div
                          className="unit-row"
                          key={`${u.service_type}-${idx}`}
                        >
                          <div>
                            <strong>{serviceLabel}</strong>
                            <small>{u.status.replace("_", " ")}</small>
                          </div>
                          <Badge
                            tone={
                              u.status === "available"
                                ? "green"
                                : u.status === "assigned"
                                  ? "amber"
                                  : u.status === "en_route"
                                    ? "sky"
                                    : u.status === "on_scene"
                                      ? "violet"
                                      : "gray"
                            }
                          >
                            {u.status.replace("_", " ")}
                          </Badge>
                        </div>
                      ))}
                      {filteredPublicUnits.length === 0 && (
                        <p className="text-muted-foreground text-center py-4">
                          No units available
                        </p>
                      )}
                    </>
                  );
                })()}
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
  const [auditFilter, setAuditFilter] = useState("All");
  const [selected, setSelected] = useState<string | null>(null);
  const [incidents, setIncidents] = useState<IncidentSummary[]>([]);
  const [incidentLoadError, setIncidentLoadError] = useState<string | null>(
    null,
  );
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [adminDataLoading, setAdminDataLoading] = useState(true);
  const [piiModalOpen, setPiiModalOpen] = useState(false);
  const [selectedIncident, setSelectedIncident] = useState<string | null>(null);
  const [revealReason, setRevealReason] = useState("");
  const [piiError, setPiiError] = useState<string | null>(null);
  const [piiData, setPiiData] = useState<IncidentPii | null>(null);
  const [piiLoading, setPiiLoading] = useState(false);
  const [auditVerified, setAuditVerified] = useState<boolean | null>(null);
  const [auditVerifying, setAuditVerifying] = useState(false);
  const [adminUnits, setAdminUnits] = useState<Unit[]>([]);
  const [expandedIncidentId, setExpandedIncidentId] = useState<string | null>(
    null,
  );
  const [incidentPanelData, setIncidentPanelData] = useState<
    Record<string, IncidentPanelData>
  >({});
  const [incidentPanelLoading, setIncidentPanelLoading] = useState<
    string | null
  >(null);
  const [incidentActionLoading, setIncidentActionLoading] = useState<
    string | null
  >(null);
  const [rejectReasons, setRejectReasons] = useState<Record<string, string>>(
    {},
  );
  const [reassignUnits, setReassignUnits] = useState<Record<string, string>>(
    {},
  );

  const refreshIncidentPanelData = useCallback(async (incidentId: string) => {
    const session = getSession();
    if (!session?.token) return;
    setIncidentPanelLoading(incidentId);
    try {
      const [details, trace, calls] = await Promise.all([
        getIncidentDetails(incidentId, session.token),
        getIncidentTrace(incidentId, session.token),
        getIncidentCalls(incidentId, session.token),
      ]);
      setIncidentPanelData((current) => ({
        ...current,
        [incidentId]: {
          dispatches: details.dispatches,
          trace: trace.trace,
          callLists: calls.lists,
        },
      }));
      setIncidents((current) =>
        current.map((incident) =>
          incident.incident_id === incidentId ? details : incident,
        ),
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Incident details could not be loaded.",
      );
    } finally {
      setIncidentPanelLoading((current) =>
        current === incidentId ? null : current,
      );
    }
  }, []);

  const refreshIncidentList = useCallback(async () => {
    const session = getSession();
    if (!session?.token) return;
    try {
      const result = await getIncidents(session.token);
      setIncidents(result.incidents);
    } catch {
      setIncidentLoadError("Incident data could not be refreshed.");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const session = getSession();
    if (!session?.token) {
      setAdminDataLoading(false);
      return;
    }

    Promise.allSettled([
      getIncidents(session.token),
      getAuditEntries(session.token),
      verifyAuditChain(session.token),
      getUnits(session.token),
    ]).then(
      ([incidentResult, auditResult, verificationResult, unitsResult]) => {
        if (cancelled) return;
        if (incidentResult.status === "fulfilled") {
          setIncidents(incidentResult.value.incidents);
        } else {
          setIncidentLoadError("Incident data could not be loaded.");
          toast.error("Failed to load incidents");
        }
        if (auditResult.status === "fulfilled") {
          setAudit(auditResult.value.entries);
        } else {
          toast.error("Failed to load audit entries");
        }
        if (verificationResult.status === "fulfilled") {
          setAuditVerified(verificationResult.value.valid);
        }
        if (unitsResult.status === "fulfilled") {
          setAdminUnits(unitsResult.value.units);
        }
        setAdminDataLoading(false);
      },
    );

    return () => {
      cancelled = true;
    };
  }, []);

  const handleAdminEvent = useCallback(
    (event: WSEvent) => {
      if (event.type === "incident.created") void refreshIncidentList();
      if (event.type === "incident.updated") void refreshIncidentList();

      let changedIncidentId: string | undefined;
      if (
        event.type === "incident.updated" ||
        event.type === "dispatch.updated" ||
        event.type === "dispatch.proposed" ||
        event.type === "dispatch.called" ||
        event.type === "agent.trace"
      ) {
        changedIncidentId = event.data.incident_id;
      } else if (event.type === "incident.created") {
        const id = event.data["incident_id"];
        if (typeof id === "string") changedIncidentId = id;
      }
      if (changedIncidentId && changedIncidentId === expandedIncidentId)
        void refreshIncidentPanelData(changedIncidentId);
    },
    [expandedIncidentId, refreshIncidentList, refreshIncidentPanelData],
  );
  useDispatchWS(handleAdminEvent);

  const toggleIncidentDetails = (incidentId: string) => {
    if (expandedIncidentId === incidentId) {
      setExpandedIncidentId(null);
      return;
    }
    setExpandedIncidentId(incidentId);
    void refreshIncidentPanelData(incidentId);
  };

  const applyIncidentAction = (result: IncidentActionResult) => {
    setIncidents((current) =>
      current.map((incident) =>
        incident.incident_id === result.incident.incident_id
          ? result.incident
          : incident,
      ),
    );
  };

  const handleApproveIncident = async (incidentId: string) => {
    const token = getSession()?.token;
    if (!token) {
      toast.error("Sign in again to approve dispatches.");
      return;
    }
    setIncidentActionLoading(incidentId);
    try {
      const result = await approveIncident(incidentId, token);
      applyIncidentAction(result);
      await refreshIncidentPanelData(incidentId);
      toast.success("Proposed dispatches approved.");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not approve dispatches.",
      );
    } finally {
      setIncidentActionLoading(null);
    }
  };

  const handleRejectIncident = async (incidentId: string) => {
    const token = getSession()?.token;
    const reason = rejectReasons[incidentId]?.trim();
    if (!token) {
      toast.error("Sign in again to reject this incident.");
      return;
    }
    if (!reason) {
      toast.error("Enter a reason before rejecting.");
      return;
    }
    setIncidentActionLoading(incidentId);
    try {
      const result = await rejectIncident(incidentId, reason, token);
      applyIncidentAction(result);
      setRejectReasons((current) => ({ ...current, [incidentId]: "" }));
      await refreshIncidentPanelData(incidentId);
      toast.success("Incident rejected.");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not reject this incident.",
      );
    } finally {
      setIncidentActionLoading(null);
    }
  };

  const handleReassignIncident = async (
    incidentId: string,
    serviceType: ServiceType,
  ) => {
    const token = getSession()?.token;
    const key = `${incidentId}:${serviceType}`;
    const unitId = reassignUnits[key];
    if (!token) {
      toast.error("Sign in again to reassign this incident.");
      return;
    }
    if (!unitId) {
      toast.error("Choose an available unit first.");
      return;
    }
    setIncidentActionLoading(incidentId);
    try {
      const result = await reassignIncident(
        incidentId,
        serviceType,
        unitId,
        token,
      );
      applyIncidentAction(result);
      setReassignUnits((current) => ({ ...current, [key]: "" }));
      await refreshIncidentPanelData(incidentId);
      toast.success(`${serviceType} response unit reassigned.`);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not reassign this unit.",
      );
    } finally {
      setIncidentActionLoading(null);
    }
  };

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
  const handleRevealPii = (incidentId: string) => {
    setSelectedIncident(incidentId);
    setRevealReason("");
    setPiiError(null);
    setPiiData(null);
    setPiiModalOpen(true);
  };

  const submitPiiReveal = async () => {
    const session = getSession();
    const reason = revealReason.trim();
    if (!session?.token || !selectedIncident) return;
    if (!reason) {
      setPiiError("Enter a reason before revealing PII.");
      return;
    }
    setPiiLoading(true);
    setPiiError(null);
    try {
      const data = await revealIncidentPii(
        selectedIncident,
        reason,
        session.token,
      );
      setPiiData(data);
      const [auditResult, verificationResult] = await Promise.allSettled([
        getAuditEntries(session.token),
        verifyAuditChain(session.token),
      ]);
      if (auditResult.status === "fulfilled") {
        setAudit(auditResult.value.entries);
      }
      if (verificationResult.status === "fulfilled") {
        setAuditVerified(verificationResult.value.valid);
      }
    } catch (e) {
      setPiiError(e instanceof Error ? e.message : "Failed to reveal PII");
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

  const formatPhone = (phone: string | null) =>
    phone?.replace(/(\+\d{2})(\d{5})(\d{5})/, "$1 $2 $3") ?? "Not provided";

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
          <section className="panel mb-5">
            <div className="panel-head">
              <div>
                <h2>
                  <MapPin className="text-primary" /> Live distress map
                </h2>
                <p>
                  Incidents and response units across the permitted operations
                  view
                </p>
              </div>
              <Badge tone="green">
                <span className="dot pulse" /> Live positions
              </Badge>
            </div>
            <IncidentMap
              role="admin"
              incidentData={incidents}
              loading={adminDataLoading}
              error={incidentLoadError}
              className="admin-map"
            />
          </section>
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
              <Badge
                tone={
                  auditVerified === true
                    ? "green"
                    : auditVerified === false
                      ? "rose"
                      : "amber"
                }
              >
                {auditVerified === true
                  ? "Chain verified"
                  : auditVerified === false
                    ? "Chain invalid"
                    : adminDataLoading
                      ? "Verifying chain…"
                      : "Chain unverified"}
              </Badge>
              <div className="audit-filters">
                {["All", "Auth", "Dispatch", "PII", "Other"].map((s) => (
                  <Button
                    key={s}
                    variant={auditFilter === s ? "secondary" : "ghost"}
                    aria-pressed={auditFilter === s}
                    onClick={() => setAuditFilter(s)}
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
            {adminDataLoading ? (
              <div className="audit-row">Loading audit entries…</div>
            ) : audit.length === 0 ? (
              <div className="audit-row">No audit entries yet.</div>
            ) : (
              audit
                .slice()
                .reverse()
                .filter(
                  (entry) =>
                    auditFilter === "All" ||
                    getAuditCategory(entry.action) === auditFilter,
                )
                .map((entry) => {
                  const category = getAuditCategory(entry.action);
                  return (
                    <div className="audit-row" key={entry.seq}>
                      <span className="mono">
                        {new Date(entry.ts).toLocaleTimeString()}
                      </span>
                      <Badge
                        tone={
                          category === "PII"
                            ? "rose"
                            : category === "Auth"
                              ? "green"
                              : category === "Dispatch"
                                ? "blue"
                                : ""
                        }
                      >
                        {category}
                      </Badge>
                      <span>
                        {entry.action} · {entry.actor.type}:{entry.actor.id} ·{" "}
                        {entry.target.type}:{entry.target.id}
                      </span>
                    </div>
                  );
                })
            )}
          </section>
          <section className="panel mt-5">
            <div className="panel-head">
              <div>
                <h2>
                  <ShieldCheck className="text-primary" />
                  Incident response
                </h2>
                <p>
                  Review agent traces and proposed dispatches. Revealing report
                  details remains an audited admin action.
                </p>
              </div>
              <Badge tone="amber">Admin only</Badge>
            </div>
            <div className="space-y-3">
              {adminDataLoading ? (
                <p className="text-muted-foreground">Loading incidents…</p>
              ) : incidents.length === 0 ? (
                <p className="text-muted-foreground">No incidents available.</p>
              ) : (
                incidents.map((inc) => {
                  const panel = incidentPanelData[inc.incident_id];
                  const dispatches = panel?.dispatches ?? [];
                  const activeServices = Array.from(
                    new Set([
                      ...inc.needed_services,
                      ...dispatches.map((dispatch) => dispatch.service_type),
                    ]),
                  ).filter((service): service is ServiceType =>
                    SERVICE_TYPES.includes(service as ServiceType),
                  );
                  const isExpanded = expandedIncidentId === inc.incident_id;
                  return (
                    <div key={inc.incident_id} className="patient">
                      <div className="patient-top">
                        <h3>{inc.summary_redacted || inc.incident_type}</h3>
                        <Badge
                          tone={
                            inc.status === "resolved" ||
                            inc.status === "completed"
                              ? "green"
                              : inc.status === "dispatched"
                                ? "blue"
                                : "rose"
                          }
                        >
                          {inc.status}
                        </Badge>
                      </div>
                      <p className="mono text-xs">{inc.incident_id}</p>
                      <div className="patient-meta">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() =>
                            void toggleIncidentDetails(inc.incident_id)
                          }
                        >
                          {isExpanded ? "Hide response" : "Review response"}
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => handleRevealPii(inc.incident_id)}
                          disabled={piiLoading}
                        >
                          {piiLoading &&
                          selectedIncident === inc.incident_id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <ShieldCheck className="h-3 w-3" />
                          )}
                          Reveal PII
                        </Button>
                      </div>
                      {isExpanded && (
                        <div className="incident-workflow">
                          {incidentPanelLoading === inc.incident_id ? (
                            <p className="text-muted-foreground">
                              Loading trace, calls, and dispatches…
                            </p>
                          ) : (
                            <>
                              <div>
                                <h4>Proposed dispatches and ETAs</h4>
                                {dispatches.length === 0 ? (
                                  <p className="text-muted-foreground">
                                    No dispatches proposed.
                                  </p>
                                ) : (
                                  <div className="incident-dispatch-list">
                                    {dispatches.map((dispatch) => {
                                      const unit = adminUnits.find(
                                        (item) =>
                                          item.unit_id === dispatch.unit_id,
                                      );
                                      return (
                                        <div
                                          className="incident-dispatch"
                                          key={dispatch.dispatch_id}
                                        >
                                          <strong>
                                            {unit?.name ?? dispatch.unit_id}
                                          </strong>
                                          <span>{dispatch.service_type}</span>
                                          <Badge
                                            tone={getStatusBadgeTone(
                                              dispatch.status,
                                            )}
                                          >
                                            {dispatch.status}
                                          </Badge>
                                          <span>
                                            ETA {dispatch.eta_minutes} min ·{" "}
                                            {dispatch.distance_km.toFixed(1)} km
                                          </span>
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                                <h4 className="mt-4">
                                  Calling nearby services
                                </h4>
                                <ResponseTimeline
                                  lists={panel?.callLists ?? []}
                                />
                                <div className="incident-response-controls">
                                  <Button
                                    size="sm"
                                    onClick={() =>
                                      void handleApproveIncident(
                                        inc.incident_id,
                                      )
                                    }
                                    disabled={
                                      incidentActionLoading ===
                                        inc.incident_id ||
                                      !dispatches.some(
                                        (item) => item.status === "proposed",
                                      )
                                    }
                                  >
                                    Approve proposed
                                  </Button>
                                  <Input
                                    aria-label={`Rejection reason for ${inc.incident_id}`}
                                    placeholder="Reason for rejection"
                                    value={rejectReasons[inc.incident_id] ?? ""}
                                    onChange={(event) =>
                                      setRejectReasons((current) => ({
                                        ...current,
                                        [inc.incident_id]: event.target.value,
                                      }))
                                    }
                                  />
                                  <Button
                                    size="sm"
                                    variant="destructive"
                                    onClick={() =>
                                      void handleRejectIncident(inc.incident_id)
                                    }
                                    disabled={
                                      incidentActionLoading ===
                                        inc.incident_id ||
                                      !(
                                        rejectReasons[inc.incident_id] ?? ""
                                      ).trim() ||
                                      [
                                        "resolved",
                                        "rejected",
                                        "completed",
                                      ].includes(inc.status)
                                    }
                                  >
                                    Reject
                                  </Button>
                                </div>
                                {activeServices.length > 0 && (
                                  <div className="incident-reassign-list">
                                    {activeServices.map((service) => {
                                      const candidates = adminUnits.filter(
                                        (unit) =>
                                          unit.service_type === service &&
                                          unit.status === "available",
                                      );
                                      const selectionKey = `${inc.incident_id}:${service}`;
                                      return (
                                        <div
                                          className="incident-response-controls"
                                          key={service}
                                        >
                                          <span>Reassign {service}</span>
                                          <select
                                            aria-label={`Available ${service} unit`}
                                            value={
                                              reassignUnits[selectionKey] ?? ""
                                            }
                                            onChange={(event) =>
                                              setReassignUnits((current) => ({
                                                ...current,
                                                [selectionKey]:
                                                  event.target.value,
                                              }))
                                            }
                                          >
                                            <option value="">
                                              Choose available unit
                                            </option>
                                            {candidates.map((unit) => (
                                              <option
                                                key={unit.unit_id}
                                                value={unit.unit_id}
                                              >
                                                {unit.name}
                                              </option>
                                            ))}
                                          </select>
                                          <Button
                                            size="sm"
                                            variant="secondary"
                                            onClick={() =>
                                              void handleReassignIncident(
                                                inc.incident_id,
                                                service,
                                              )
                                            }
                                            disabled={
                                              incidentActionLoading ===
                                                inc.incident_id ||
                                              !reassignUnits[selectionKey] ||
                                              candidates.length === 0
                                            }
                                          >
                                            Reassign
                                          </Button>
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                              <div>
                                <h4>Agent trace</h4>
                                {!panel?.trace.length ? (
                                  <p className="text-muted-foreground">
                                    No trace steps available.
                                  </p>
                                ) : (
                                  <ol className="incident-trace">
                                    {panel.trace.map((step, index) => (
                                      <li
                                        className="incident-trace-item"
                                        key={`${step.step}-${step.started_at}-${index}`}
                                      >
                                        <div className="incident-trace-heading">
                                          <strong>{step.step}</strong>
                                          <Badge
                                            tone={
                                              step.status === "done"
                                                ? "green"
                                                : step.status === "failed"
                                                  ? "rose"
                                                  : "amber"
                                            }
                                          >
                                            {step.status}
                                          </Badge>
                                        </div>
                                        <span>
                                          {step.agent} ·{" "}
                                          {formatTraceTime(step.started_at)}
                                          {step.finished_at
                                            ? ` – ${formatTraceTime(step.finished_at)}`
                                            : ""}
                                        </span>
                                        {step.summary && <p>{step.summary}</p>}
                                      </li>
                                    ))}
                                  </ol>
                                )}
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
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
              {piiData
                ? "Access was recorded in the audit chain."
                : "Enter the required reason to record and reveal incident PII."}
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
                          {r.name || "Name not provided"} ·{" "}
                          {formatPhone(r.phone)} · {r.language}
                          <br />
                          Emergency:{" "}
                          {r.emergency_contact?.name ||
                            "Name not provided"} ·{" "}
                          {formatPhone(r.emergency_contact?.phone ?? null)}
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
                    {piiData.audio && piiData.audio.length > 0 ? (
                      <div className="mt-1 space-y-2">
                        {piiData.audio.map((a, i) => (
                          <OriginalAudio
                            key={a.report_id}
                            url={a.url}
                            label={`Original voice message ${piiData.audio!.length > 1 ? i + 1 : ""}`.trim()}
                          />
                        ))}
                      </div>
                    ) : (
                      <p className="mt-1 font-mono text-xs">Not provided</p>
                    )}
                  </div>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                This action has been logged to the audit chain. PII access
                requires admin role.
              </p>
            </div>
          ) : (
            <div className="space-y-4 mt-4">
              <label
                className="block space-y-2 text-sm"
                htmlFor="pii-reveal-reason"
              >
                Reason for access (required)
                <Input
                  id="pii-reveal-reason"
                  value={revealReason}
                  onChange={(event) => setRevealReason(event.target.value)}
                  maxLength={250}
                  autoComplete="off"
                  placeholder="Explain why this incident’s PII is needed"
                  disabled={piiLoading}
                />
              </label>
              {piiError && (
                <p className="text-sm text-destructive" role="alert">
                  {piiError}
                </p>
              )}
              <Button
                onClick={submitPiiReveal}
                disabled={piiLoading || !revealReason.trim()}
              >
                Reveal PII and record access
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Shell>
  );
}

/** Loads one original voice message on demand (the server checks the reveal and audits the play) and plays it. */
function OriginalAudio({ url, label }: { url: string; label: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [message, setMessage] = useState("");
  useEffect(() => () => void (src && URL.revokeObjectURL(src)), [src]);
  async function load() {
    const session = getSession();
    if (!session?.token) return;
    setState("loading");
    try {
      const blob = await fetchIncidentAudio(url, session.token);
      setSrc(URL.createObjectURL(blob));
      setState("idle");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Could not load the audio");
      setState("error");
    }
  }
  return (
    <div>
      {src ? (
        <audio
          controls
          autoPlay
          src={src}
          className="w-full"
          aria-label={label}
        />
      ) : (
        <Button
          size="sm"
          variant="outline"
          onClick={() => void load()}
          disabled={state === "loading"}
        >
          {state === "loading" ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : null}
          Play {label.toLowerCase()}
        </Button>
      )}
      {state === "error" && (
        <p className="mt-1 text-xs text-destructive" role="alert">
          {message}
        </p>
      )}
    </div>
  );
}
