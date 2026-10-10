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
import { useTranslation } from "react-i18next";
import i18n from "@/lib/i18n";

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
  if (!value) return i18n.t("ops.inProgress");
  return new Date(value).toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function OperationsConsole({ serviceId }: { serviceId: string }) {
  const { t: tService } = useTranslation("serviceConsole");
  const { t: tShell } = useTranslation("shell");
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
      toast.error(i18n.t("ops.errLoadDispatches"));
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
      toast.success(i18n.t("ops.dispatchAccepted"));
    } catch (e) {
      toast.error(i18n.t("ops.errAccept"));
    }
  };

  const handleDecline = async (dispatchId: string) => {
    const session = getSession();
    if (!session?.token) return;
    try {
      await declineDispatch(dispatchId, session.token);
      await loadDispatches();
      toast.success(i18n.t("ops.dispatchDeclined"));
    } catch (e) {
      toast.error(i18n.t("ops.errDecline"));
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
      toast.error(i18n.t("ops.errStatus"));
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
    ? tService("fire_rescue")
    : ambulance
      ? tService("ambulance_service")
      : police
        ? tService("police_service")
        : tService("hospital_console");
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
    ? tService("station_04")
    : ambulance
      ? tService("ems_station")
      : police
        ? tService("precinct_1")
        : tService("hospital_01");
  const stationDetail = fire
    ? tService("station_04")
    : ambulance
      ? tService("ems_station")
      : police
        ? tService("precinct_1")
        : tService("hospital_01");

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
            {tService("first_responder_workspace")} · {stationDetail}
          </div>
          <h1>{stationName}</h1>
          <p className="subtitle">
            {fire
              ? tService("dispatch_intelligence")
              : ambulance
                ? tService("ambulance_subtitle")
                : police
                  ? i18n.t("ops.policeSubtitle")
                  : tService("emergency_intake")}
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
          {wsConnected ? tService("live") : tService("receiving_dispatches")}
        </Badge>
      </div>
      <div className="metrics">
        {[
          {
            label: fire ? tService("active_incidents") : ambulance ? tService("active_patients") : police ? tService("active_calls") : tService("active_patients"),
            value: String(activeDispatches.length).padStart(2, "0"),
            note: loading ? tService("loading") : tService("from_backend"),
            icon: Activity,
          },
          {
            label: fire ? tService("available_units_label") : ambulance ? tService("available_ambulances") : police ? tService("available_units") : tService("available_critical_beds"),
            value: String(capacity).padStart(2, "0"),
            note: fire
              ? tService("across_central_district")
              : ambulance
                ? tService("across_ems_network")
                : police
                  ? tService("across_precinct")
                  : tService("critical_beds_total"),
            icon: fire
              ? Flame
              : ambulance
                ? HeartPulse
                : police
                  ? ShieldCheck
                  : BedDouble,
          },
          {
            label: tService("pending_dispatches"),
            value: String(proposedDispatches.length).padStart(2, "0"),
            note: tService("awaiting_response"),
            icon: Clock3,
          },
          {
            label: tService("agent_coordination"),
            value: wsConnected ? tService("online") : tService("connecting"),
            note: wsConnected ? tService("websocket_connected") : tService("reconnecting"),
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
          {i18n.t("ops.refresh")}
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            setNextCapacity(capacity);
            setCapacityOpen(true);
          }}
        >
          <SlidersHorizontal />
          {tService("update_capacity")}
        </Button>
      </div>
      <section className="panel mb-6">
        <div className="panel-head compact-head">
          <h2>
            <MapPin />
            {i18n.t("ops.mapAssigned")}
          </h2>
        </div>
        <IncidentMap role="service" />
        <div className="zone-meta">
          <strong>Central District</strong>
          <Badge tone="sky">{i18n.t("ops.contractFiltered")}</Badge>
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
                    ? tService("pending_dispatches_title")
                    : ambulance
                      ? tService("incoming_patient_dispatches")
                      : police
                        ? tService("incoming_police_dispatches")
                        : tService("incoming_patient_dispatches")}
                </h2>
                <p>
                  {tService("real_time_backend")} · {proposedDispatches.length} {tService("awaiting_response")}
                </p>
              </div>
              <Badge tone={proposedDispatches.length > 0 ? "rose" : "green"}>
                <span className="dot" />
                {proposedDispatches.length > 0
                  ? tService("action_required")
                  : tService("all_clear")}
              </Badge>
            </div>
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="animate-spin h-6 w-6" />
              </div>
            ) : proposedDispatches.length === 0 ? (
              <p className="text-muted-foreground text-center py-8">
                {tService("no_pending_dispatches")}
              </p>
            ) : (
              proposedDispatches.map((d) => (
                <article className="patient" key={d.dispatch_id}>
                  <div className="patient-top">
                    <h3>
                      {fire
                        ? `${tService("fire_rescue")}: ${d.incident_id.slice(0, 8)}`
                        : ambulance
                          ? `${tService("ambulance_service")}: ${d.incident_id.slice(0, 8)}`
                          : police
                            ? `${tService("police_service")}: ${d.incident_id.slice(0, 8)}`
                            : `${tService("ambulance_service")}: ${d.incident_id.slice(0, 8)}`}
                    </h3>
                    <Badge tone={getStatusBadgeTone(d.status)}>
                      {getStatusLabel(d.status)}
                    </Badge>
                  </div>
                  <p>
                    {tService("distance")}: {d.distance_km} {tService("distance_km")} · {tService("eta")}: {d.eta_minutes} {tService("eta_min")} ·
                    {tService("type")}: {d.service_type}
                  </p>
                  <div className="patient-meta">
                    <span className="mono">{d.dispatch_id.slice(0, 12)}</span>
                    <span>{tService("proposed_by")}: {d.proposed_by}</span>
                    <div className="flex gap-2 ml-auto">
                      <Button
                        size="sm"
                        onClick={() => handleAccept(d.dispatch_id)}
                      >
                        <Check className="h-3 w-3" />
                        {tService("accept")}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleDecline(d.dispatch_id)}
                      >
                        <X className="h-3 w-3" />
                        {tService("decline")}
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
                  {tService("active_dispatches_title")}
                </h2>
                <Badge tone="sky">{activeDispatches.length} {tService("in_progress")}</Badge>
              </div>
              <div className="space-y-3">
                {activeDispatches.map((d) => {
                  const callInfo = callCountdown[d.incident_id];
                  return (
                    <div key={d.dispatch_id} className="patient">
                      <div className="patient-top">
                        <h3>
                          {fire
                            ? `${tService("fire_rescue")}: ${d.incident_id.slice(0, 8)}`
                            : ambulance
                              ? `${tService("ambulance_service")}: ${d.incident_id.slice(0, 8)}`
                              : police
                                ? `${tService("police_service")}: ${d.incident_id.slice(0, 8)}`
                                : `${tService("ambulance_service")}: ${d.incident_id.slice(0, 8)}`}
                        </h3>
                        <Badge tone={getStatusBadgeTone(d.status)}>
                          {getStatusLabel(d.status)}
                        </Badge>
                      </div>
                      <p>
                        {tService("unit")}: {d.unit_id.slice(0, 8)} · {tService("distance")}: {d.distance_km} {tService("distance_km")}
                      </p>
                      {callInfo && callInfo.serviceType === d.service_type && (
                        <div className="call-countdown mb-2 p-2 bg-muted rounded text-sm">
                          <strong>{tService("calling_units")} {callInfo.serviceType} {tService("units")}:</strong>
                          {callInfo.candidates.map((c) => (
                            <div
                              key={c.unitId}
                              className="flex items-center gap-2 text-[11px]"
                            >
                              <span className="mono">#{c.rank}</span>
                              <span>{c.name}</span>
                              <span className="text-muted-foreground">
                                {c.distanceKm} {tService("distance_km")} · {c.etaMinutes} {tService("eta_min")}
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
                          {tService("updated")}: {new Date(d.updated_at).toLocaleTimeString()}
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
                              tService("en_route")
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
                              tService("on_scene")
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
                                {tService("complete")}
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
                  ? tService("field_agent_briefing")
                  : ambulance
                    ? tService("ems_dispatch_briefing")
                    : police
                      ? tService("police_dispatch_briefing")
                      : tService("rag_trauma_briefing")}
              </h2>
              <Badge tone="sky">{tService("context_retrieved")}</Badge>
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
                {i18n.t("ops.demoBriefing")}
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
                  ? tService("ambulance_availability")
                  : ambulance
                    ? tService("unit_availability")
                    : police
                      ? tService("unit_availability")
                      : tService("critical_care_capacity")}
              </h2>
              <Badge tone="green">{capacity} {tService("available")}</Badge>
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
                  const serviceLabel = fire ? tService("fire_rescue") + " " + tService("unit") : ambulance ? tService("ambulance_service") + " " + tService("unit") : tService("police_service") + " " + tService("unit");
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
                          {i18n.t("ops.noUnits")}
                        </p>
                      )}
                    </>
                  );
                })()}
              </>
            ) : (
              <div className="compact-body">
                <div className="flex justify-between text-[11px]">
                  <strong>{24 - capacity} / 24 {tService("beds_occupied")}</strong>
                  <span className="text-muted-foreground">
                    {Math.round(((24 - capacity) / 24) * 100)}% {tService("occupancy")}
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
                {tService("autonomous_agent_logs")}
              </h2>
              <Button
                variant="ghost"
                size="icon"
                aria-label={i18n.t("ops.toggleLogs")}
                onClick={() => setLogs(!logs)}
              >
                <ChevronDown />
              </Button>
            </div>
            {logs && (
              <div className="logs">
                <p>
                  <span>07:06:12</span> {tService("context_lookup")}
                </p>
                <p>
                  <span>07:06:13</span> {tService("triage_priority")}
                </p>
                <p>
                  <span>07:06:14</span> {tService("route_resolved")}
                </p>
                <p>
                  <span>07:06:15</span> {fire ? tService("engine_assigned") : tService("ambulance_assigned")}
                </p>
                <p>
                  <span>07:06:16</span> {tService("facility_alert")}
                </p>
                {ack && (
                  <p>
                    <span>07:06:18</span> {tService("operator_acknowledged")}
                  </p>
                )}
                {rerouted && (
                  <p>
                    <span>07:06:20</span> {tService("fleet_route_updated")}
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
            <DialogTitle>{tService("update_unit_capacity")}</DialogTitle>
            <DialogDescription>
              {i18n.t("ops.updateResources")}
            </DialogDescription>
          </DialogHeader>
          <label className="field">
            Available {fire ? tService("units") : tService("critical_care_beds")}
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
              toast.success(tService("demo_capacity_updated"));
            }}
          >
            <Check />
            {i18n.t("ops.saveCapacity")}
          </Button>
        </DialogContent>
      </Dialog>
    </Shell>
  );
}
export function AdminDashboard() {
  const { t: tAdmin } = useTranslation("admin");
  const { t: tShell } = useTranslation("shell");
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
          : i18n.t("ops.errIncidentDetails"),
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
      setIncidentLoadError(i18n.t("ops.errIncidentRefresh"));
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
          setIncidentLoadError(i18n.t("ops.errIncidentLoad"));
          toast.error(i18n.t("ops.errIncidents"));
        }
        if (auditResult.status === "fulfilled") {
          setAudit(auditResult.value.entries);
        } else {
          toast.error(i18n.t("ops.errAudit"));
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
      toast.error(i18n.t("ops.signInApprove"));
      return;
    }
    setIncidentActionLoading(incidentId);
    try {
      const result = await approveIncident(incidentId, token);
      applyIncidentAction(result);
      await refreshIncidentPanelData(incidentId);
      toast.success(i18n.t("ops.approved"));
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : i18n.t("ops.errApprove"),
      );
    } finally {
      setIncidentActionLoading(null);
    }
  };

  const handleRejectIncident = async (incidentId: string) => {
    const token = getSession()?.token;
    const reason = rejectReasons[incidentId]?.trim();
    if (!token) {
      toast.error(i18n.t("ops.signInReject"));
      return;
    }
    if (!reason) {
      toast.error(i18n.t("ops.rejectReason"));
      return;
    }
    setIncidentActionLoading(incidentId);
    try {
      const result = await rejectIncident(incidentId, reason, token);
      applyIncidentAction(result);
      setRejectReasons((current) => ({ ...current, [incidentId]: "" }));
      await refreshIncidentPanelData(incidentId);
      toast.success(i18n.t("ops.rejected"));
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : i18n.t("ops.errReject"),
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
      toast.error(i18n.t("ops.signInReassign"));
      return;
    }
    if (!unitId) {
      toast.error(i18n.t("ops.chooseUnit"));
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
          : i18n.t("ops.errReassign"),
      );
    } finally {
      setIncidentActionLoading(null);
    }
  };

  const agents = [
    {
      name: "TriageAgent-01",
      role: i18n.t("ops.roleTriage"),
      icon: HeartPulse,
      latency: "42 ms",
      work: "1,842",
    },
    {
      name: "DispatchRouter-v2",
      role: i18n.t("ops.roleDispatch"),
      icon: Network,
      latency: "28 ms",
      work: "1,796",
    },
    {
      name: "ResourceMemory-RAG",
      role: i18n.t("ops.roleMemory"),
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
      setPiiError(i18n.t("ops.piiReason"));
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
      setPiiError(e instanceof Error ? e.message : i18n.t("ops.errReveal"));
      toast.error(i18n.t("ops.errReveal"));
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
      toast.error(i18n.t("ops.errChain"));
      setAuditVerified(false);
    } finally {
      setAuditVerifying(false);
    }
  };

  const formatPhone = (phone: string | null) =>
    phone?.replace(/(\+\d{2})(\d{5})(\d{5})/, "$1 $2 $3") ?? i18n.t("ops.notProvided");

  return (
    <Shell role="admin" title={i18n.t("ops.agentOrch")}>
      <div className="page-heading">
        <div>
          <div className="eyebrow">{i18n.t("ops.sysAdmin")}</div>
          <h1>{i18n.t("ops.agentOrch")}</h1>
          <p className="subtitle">
            A live view of your autonomous dispatch mesh, pipeline health, and
            decisions.
          </p>
        </div>
        <Badge tone="green">
          <span className="dot pulse" />
          {i18n.t("ops.allPipelines")}
        </Badge>
      </div>
      <div className="metrics">
        {[
          {
            label: i18n.t("ops.metricWorkflows"),
            value: "12,486",
            trend: "+12.8%",
            note: "this week",
            icon: Activity,
          },
          {
            label: i18n.t("ops.metricAgents"),
            value: "04 / 04",
            trend: "100%",
            note: "availability",
            icon: Network,
          },
          {
            label: i18n.t("ops.metricResolution"),
            value: "2.4 min",
            trend: "−18.2%",
            note: "vs. last week",
            icon: Clock3,
          },
          {
            label: i18n.t("ops.metricMemory"),
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
                  <MapPin className="text-primary" /> {i18n.t("ops.liveMap")}
                </h2>
                <p>
{i18n.t("ops.liveMapLead")}
                </p>
              </div>
              <Badge tone="green">
                <span className="dot pulse" /> {i18n.t("ops.livePositions")}
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
                  {i18n.t("ops.meshTitle")}
                </h2>
                <p>
{i18n.t("ops.meshLead")}
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
              <span>{i18n.t("ops.pipeline")}</span>
              <span className="mono">MESH v2.4</span>
            </div>
          </section>
          <section className="panel mt-5">
            <div className="panel-head">
              <div>
                <h2>
                  <Terminal />
                  {tAdmin("system_audit_stream")}
                </h2>
                <p>{tAdmin("autonomous_decisions")}</p>
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
                  ? tAdmin("chain_verified")
                  : auditVerified === false
                    ? tAdmin("chain_invalid")
                    : adminDataLoading
                      ? tAdmin("verifying_chain")
                      : tAdmin("chain_unverified")}
              </Badge>
              <div className="audit-filters">
                {["All", "Auth", "Dispatch", "PII", "Other"].map((s) => (
                  <Button
                    key={s}
                    variant={auditFilter === s ? "secondary" : "ghost"}
                    aria-pressed={auditFilter === s}
                    onClick={() => setAuditFilter(s)}
                  >
                    {tAdmin(`audit_categories.${s.toLowerCase()}`) || s}
                  </Button>
                ))}
              </div>
            </div>
            {intervene && (
              <div className="audit-row">
                <span className="mono">Now</span>
                <Badge tone="amber">{i18n.t("ops.override")}</Badge>
                <span>
                  {tAdmin("override_active")}
                </span>
              </div>
            )}
            {adminDataLoading ? (
              <div className="audit-row">{tAdmin("loading_audit")}</div>
            ) : audit.length === 0 ? (
              <div className="audit-row">{tAdmin("no_audit_entries")}</div>
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
                  {tAdmin("pii_reveal_audit")}
                </h2>
                <p>
                  {tAdmin("decrypt_incident_pii")}
                </p>
              </div>
              <Badge tone="amber">{tAdmin("admin_only")}</Badge>
            </div>
            <div className="space-y-3">
              {adminDataLoading ? (
                <p className="text-muted-foreground">{tAdmin("loading_incidents")}</p>
              ) : incidents.length === 0 ? (
                <p className="text-muted-foreground">{tAdmin("no_incidents")}</p>
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
                          {isExpanded ? i18n.t("ops.hideResponse") : i18n.t("ops.reviewResponse")}
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
                          {tAdmin("reveal_pii")}
                        </Button>
                      </div>
                      {isExpanded && (
                        <div className="incident-workflow">
                          {incidentPanelLoading === inc.incident_id ? (
                            <p className="text-muted-foreground">
                              {i18n.t("ops.loadingTrace")}
                            </p>
                          ) : (
                            <>
                              <div>
                                <h4>{i18n.t("ops.proposedEtas")}</h4>
                                {dispatches.length === 0 ? (
                                  <p className="text-muted-foreground">
                                    {i18n.t("ops.noDispatches")}
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
                                  {i18n.t("ops.callingServices")}
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
                                    {i18n.t("ops.approveProposed")}
                                  </Button>
                                  <Input
                                    aria-label={`Rejection reason for ${inc.incident_id}`}
                                    placeholder={i18n.t("ops.rejectReasonPlaceholder")}
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
                                    {i18n.t("ops.reject")}
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
                                          <span>{i18n.t("ops.reassignService", { service })}</span>
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
                                              {i18n.t("ops.chooseAvailableUnit")}
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
                                            {i18n.t("ops.reassign")}
                                          </Button>
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                              <div>
                                <h4>{i18n.t("ops.agentTrace")}</h4>
                                {!panel?.trace.length ? (
                                  <p className="text-muted-foreground">
                                    {i18n.t("ops.noTrace")}
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
                {tAdmin("pipeline_health")}
              </h2>
              <Badge tone="green">{i18n.t("ops.healthy")}</Badge>
            </div>
            <div className="compact-body">
              <div className="section-label">
                {tAdmin("rag_latency")} <strong className="mono">18 ms</strong>
              </div>
              <div className="progress-track">
                <div className="progress-fill" />
              </div>
              <div className="section-label">
                {tAdmin("context_utilization")}<strong className="mono">42%</strong>
              </div>
              <div className="progress-track">
                <div className="progress-fill violet" />
              </div>
              <div className="section-label">
                {tAdmin("queue_depth")}<strong className="mono">03 tasks</strong>
              </div>
              <div className="section-label mt-5">
                {tAdmin("error_rate")}<strong className="text-primary mono">0.02%</strong>
              </div>
            </div>
          </section>
          <section className="panel">
            <div className="panel-head compact-head">
              <h2>
                <Database />
                {tAdmin("vector_store_status")}
              </h2>
              <span className="dot" />
            </div>
            <div className="compact-body">
              <div className="profile-summary">
                <div>
                  <small>{tAdmin("context_records")}</small>
                  <strong>24,816</strong>
                </div>
                <div>
                  <small>{tAdmin("dimensions")}</small>
                  <strong>1,536</strong>
                </div>
                <div>
                  <small>{tAdmin("index_health")}</small>
                  <strong className="text-primary">{tAdmin("optimal")}</strong>
                </div>
                <div>
                  <small>{tAdmin("last_sync")}</small>
                  <strong>12 {tAdmin("seconds_ago")}</strong>
                </div>
              </div>
              <Badge tone="green">
                <ShieldCheck size={11} />
                {tAdmin("consent_controlled")}
              </Badge>
            </div>
          </section>
          <section className="panel">
            <div className="panel-head compact-head">
              <h2>
                <Users />
                {tAdmin("human_in_the_loop")}
              </h2>
            </div>
            <div className="compact-body">
              <div className="flex justify-between items-center gap-3">
                <strong className="text-[11px]">
                  {tAdmin("human_intervene")}
                </strong>
                <Switch
                  checked={intervene}
                  onCheckedChange={(v) => {
                    setIntervene(v);
                    toast(
                      v
                        ? tAdmin("human_review_activated")
                        : tAdmin("autonomous_resumed"),
                    );
                  }}
                  aria-label="Human-in-the-Loop Intervene"
                />
              </div>
              <p className="subtitle text-[10px]">
                {intervene
                  ? tAdmin("human_review_required")
                  : tAdmin("autonomous_monitored")}
              </p>
              <Badge tone={intervene ? "amber" : "green"}>
                {intervene ? tAdmin("manual_review_active") : tAdmin("autonomous_mode")}
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
              {tAdmin("agent_detail")}
            </DialogDescription>
          </DialogHeader>
          {agents
            .filter((a) => a.name === selected)
            .map((a) => (
              <div key={a.name}>
                <Badge tone="green">{i18n.t("ops.operational")}</Badge>
                <div className="profile-summary mt-6">
                  <div>
                    <small>{tAdmin("responsibility")}</small>
                    <strong>{a.role}</strong>
                  </div>
                  <div>
                    <small>{tAdmin("latency")}</small>
                    <strong>{a.latency}</strong>
                  </div>
                  <div>
                    <small>{tAdmin("workflows_completed")}</small>
                    <strong>{a.work}</strong>
                  </div>
                  <div>
                    <small>{tAdmin("oversight")}</small>
                    <strong>{intervene ? tAdmin("human_review") : tAdmin("autonomous")}</strong>
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
              {tAdmin("pII_reveal")} · {selectedIncident?.slice(0, 12)}
            </DialogTitle>
            <DialogDescription>
              {piiData
                ? tAdmin("access_recorded")
                : tAdmin("enter_reason")}
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
                    ? tAdmin("not_verified")
                    : auditVerified
                      ? tAdmin("chain_valid")
                      : tAdmin("chain_invalid_symbol")}
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
                  {tAdmin("verify_audit_chain")}
                </Button>
              </div>
              <div className="border rounded p-4 bg-muted/30 max-h-96 overflow-y-auto">
                <div className="space-y-3 text-sm">
                  <div>
                    <strong>{tAdmin("transcript")}</strong>
                    <p className="mt-1 font-mono text-xs whitespace-pre-wrap">
                      {piiData.transcript}
                    </p>
                  </div>
                  <div>
                    <strong>{tAdmin("reporters")}</strong>
                    <ul className="mt-1 space-y-1">
                      {piiData.reporters.map((r) => (
                        <li key={r.report_id} className="font-mono text-xs">
                          {r.name || tAdmin("name_not_provided")} ·{" "}
                          {formatPhone(r.phone)} · {r.language}
                          <br />
                          {tAdmin("emergency_contact")}:{" "}
                          {r.emergency_contact?.name ||
                            tAdmin("name_not_provided")} ·{" "}
                          {formatPhone(r.emergency_contact?.phone ?? null)}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <strong>{tAdmin("pii_spans")}</strong>
                    <ul className="mt-1 space-y-1">
                      {piiData.pii_spans.map((s, i) => (
                        <li key={i} className="font-mono text-xs">
                          {s.type}: "{s.text}" [{s.start}-{s.end}]
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <strong>{tAdmin("audio")}</strong>
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
                      <p className="mt-1 font-mono text-xs">{tAdmin("not_provided")}</p>
                    )}
                  </div>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {tAdmin("logged_to_audit")}
              </p>
            </div>
          ) : (
            <div className="space-y-4 mt-4">
              <label
                className="block space-y-2 text-sm"
                htmlFor="pii-reveal-reason"
              >
                {tAdmin("reason_required")}
                <Input
                  id="pii-reveal-reason"
                  value={revealReason}
                  onChange={(event) => setRevealReason(event.target.value)}
                  maxLength={250}
                  autoComplete="off"
                  placeholder={tAdmin("explain_why")}
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
                {tAdmin("reveal_pii_record")}
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
      setMessage(e instanceof Error ? e.message : i18n.t("ops.errAudio"));
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
