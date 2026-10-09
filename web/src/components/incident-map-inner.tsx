import { useCallback, useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { AlertTriangle, Loader2, MapPin, X } from "lucide-react";
import {
  getIncidents,
  getPublicIncidents,
  getUnits,
  type IncidentSummary,
  type PublicIncident,
  type Unit,
} from "@/lib/api";
import { getSession } from "@/lib/session";
import { useDispatchWS, type WSEvent } from "@/hooks/use-dispatch-ws";

type MapRole = "admin" | "service" | "civilian" | "public";

const PUBLIC_SEVERITY = { low: 2, medium: 3, high: 4, critical: 5 } as const;

/** Public items carry only coarse facts; the other fields stay empty and are never shown in the public panel. */
function fromPublic(item: PublicIncident): IncidentSummary {
  return {
    incident_id: item.id,
    status: item.status,
    incident_type: item.incident_type,
    severity: PUBLIC_SEVERITY[item.severity],
    urgency_score: 0,
    location: item.location,
    summary_redacted: "",
    people_count: 0,
    hazards: [],
    needed_services: [],
    report_count: 0,
    report_ids: [],
    reason: "",
    created_at: item.reported_at,
    updated_at: item.reported_at,
  };
}

export function IncidentMap({
  role,
  className = "",
  incidentData,
  loading: loadingOverride,
  error: errorOverride,
}: {
  role: MapRole;
  className?: string;
  incidentData?: IncidentSummary[];
  loading?: boolean;
  error?: string | null;
}) {
  const mapElement = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const incidentMarkers = useRef<L.LayerGroup | null>(null);
  const unitMarkers = useRef<L.LayerGroup | null>(null);
  const fitted = useRef(false);
  const [incidents, setIncidents] = useState<IncidentSummary[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [selected, setSelected] = useState<IncidentSummary | null>(null);
  const [loadingState, setLoading] = useState(
    role !== "civilian" && role !== "public" && !incidentData,
  );
  const [error, setError] = useState<string | null>(null);
  const loading = loadingOverride ?? loadingState;
  const visibleError = errorOverride ?? error;

  const onEvent = useCallback(
    (event: WSEvent) => {
      if (event.type === "unit.moved") {
        setUnits((current) =>
          current.map((unit) =>
            unit.unit_id === event.data.unit_id
              ? {
                  ...unit,
                  location: event.data.location,
                  status: event.data.status as Unit["status"],
                }
              : unit,
          ),
        );
        return;
      }
      if (
        event.type === "incident.created" ||
        event.type === "incident.updated"
      ) {
        const session = getSession();
        if (!session?.token || role === "civilian" || role === "public") return;
        void getIncidents(session.token)
          .then((result) => setIncidents(result.incidents))
          .catch((refreshError: unknown) => {
            setError(
              refreshError instanceof Error
                ? refreshError.message
                : "Map data could not be refreshed.",
            );
          });
      }
    },
    [role],
  );
  useDispatchWS(onEvent);

  // Open map: poll the public feed every 10 s. No login, no websocket.
  useEffect(() => {
    if (role !== "public") return;
    let active = true;
    const load = () =>
      getPublicIncidents()
        .then((result) => {
          if (!active) return;
          setIncidents(result.incidents.map(fromPublic));
          setError(null);
        })
        .catch(() => {
          if (active) setError("The map could not be refreshed. Retrying.");
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [role]);

  useEffect(() => {
    if (role === "civilian" || role === "public") return;
    let active = true;
    const session = getSession();
    if (!session?.token) {
      setError("Sign in to load permitted map data.");
      setLoading(false);
      return;
    }
    const incidentRequest = incidentData
      ? Promise.resolve({ incidents: incidentData })
      : getIncidents(session.token);
    const unitRequest =
      role === "admin"
        ? getUnits(session.token)
        : Promise.resolve({ units: [] as Unit[] });
    Promise.all([incidentRequest, unitRequest])
      .then(([incidentData, unitData]) => {
        if (!active) return;
        setIncidents(incidentData.incidents);
        setUnits(unitData.units);
        setError(null);
      })
      .catch((loadError: unknown) => {
        if (!active) return;
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Map data could not be loaded.",
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [role, incidentData]);

  useEffect(() => {
    if (incidentData) setIncidents(incidentData);
  }, [incidentData]);

  useEffect(() => {
    if (!mapElement.current || map.current) return;
    const instance = L.map(mapElement.current, { zoomControl: true }).setView(
      [9.9312, 76.2673],
      12,
    );
    // CARTO's free dark basemap now answers "API key required", so use OpenStreetMap's standard tiles
    // (fine for demo-scale traffic under the OSM tile policy; swap for a keyed provider before real load).
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(instance);
    incidentMarkers.current = L.layerGroup().addTo(instance);
    unitMarkers.current = L.layerGroup().addTo(instance);
    map.current = instance;
    return () => {
      instance.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    const group = incidentMarkers.current;
    if (!group) return;
    group.clearLayers();
    const points: L.LatLngTuple[] = [];
    incidents.forEach((incident) => {
      if (
        !Number.isFinite(incident.location?.lat) ||
        !Number.isFinite(incident.location?.lng)
      )
        return;
      const marker = L.marker([incident.location.lat, incident.location.lng], {
        icon: L.divIcon({
          className: `incident-marker severity-${Math.min(5, Math.max(1, incident.severity))}`,
          html: "<span></span>",
          iconSize: [24, 24],
          iconAnchor: [12, 12],
        }),
        title: `${incident.incident_type}, severity ${incident.severity}`,
        alt: `${incident.incident_type}, severity ${incident.severity}`,
      });
      marker.on("click", () => setSelected(incident));
      marker.addTo(group);
      points.push([incident.location.lat, incident.location.lng]);
    });
    // Open map: show wherever the incidents are, not only the default Kochi view.
    // Only once, so the 10 s refresh does not fight the user panning the map.
    if (
      role === "public" &&
      points.length > 0 &&
      map.current &&
      !fitted.current
    ) {
      fitted.current = true;
      map.current.fitBounds(L.latLngBounds(points), {
        padding: [40, 40],
        maxZoom: 13,
      });
    }
  }, [incidents, role]);

  useEffect(() => {
    const group = unitMarkers.current;
    if (!group) return;
    group.clearLayers();
    units.forEach((unit) => {
      if (
        !Number.isFinite(unit.location?.lat) ||
        !Number.isFinite(unit.location?.lng)
      )
        return;
      L.marker([unit.location.lat, unit.location.lng], {
        icon: L.divIcon({
          className: `unit-marker unit-${unit.service_type}`,
          html: "<span></span>",
          iconSize: [22, 22],
          iconAnchor: [11, 11],
        }),
        title: `${unit.name} · ${unit.status}`,
        alt: `${unit.name} · ${unit.status}`,
      }).addTo(group);
    });
  }, [units]);

  return (
    <div className={`incident-map ${className}`}>
      <div
        ref={mapElement}
        className="incident-map-canvas"
        role="application"
        aria-label="Incident and response unit map"
      />
      {loading && (
        <div className="map-state">
          <Loader2 size={16} className="animate-spin" /> Loading permitted map
          data…
        </div>
      )}
      {visibleError && (
        <div className="map-state map-state-error" role="alert">
          <AlertTriangle size={16} /> {visibleError}
        </div>
      )}
      {!loading &&
        !visibleError &&
        incidents.length === 0 &&
        role !== "civilian" && (
          <div className="map-state">
            <MapPin size={15} />{" "}
            {role === "public"
              ? "No confirmed incidents right now."
              : "No incidents available in this view."}
          </div>
        )}
      {role === "civilian" && (
        <div className="map-state">
          <MapPin size={15} /> Shared incident locations aren’t available for
          civilian accounts.
        </div>
      )}
      {selected && role === "public" && (
        <aside className="incident-map-detail" aria-label="Incident details">
          <button
            type="button"
            aria-label="Close incident details"
            onClick={() => setSelected(null)}
          >
            <X size={15} />
          </button>
          <span className="map-detail-kicker">
            {selected.status} ·{" "}
            {new Date(selected.created_at).toLocaleTimeString("en-IN", {
              hour: "numeric",
              minute: "2-digit",
            })}
          </span>
          <strong>{selected.incident_type}</strong>
          <small>
            Severity:{" "}
            {
              ["", "low", "low", "medium", "high", "critical"][
                selected.severity
              ]
            }
          </small>
          <small>
            The marker shows the area (about 1 km), not the exact spot.
          </small>
        </aside>
      )}
      {selected && role !== "public" && (
        <aside className="incident-map-detail" aria-label="Incident details">
          <button
            type="button"
            aria-label="Close incident details"
            onClick={() => setSelected(null)}
          >
            <X size={15} />
          </button>
          <span className="map-detail-kicker">
            Severity {selected.severity} ·{" "}
            {selected.status.replaceAll("_", " ")}
          </span>
          <strong>{selected.incident_type}</strong>
          <p>{selected.summary_redacted || "No incident summary available."}</p>
          <small>
            {selected.people_count} people · {selected.report_count} report
            {selected.report_count === 1 ? "" : "s"}
          </small>
          {selected.hazards.length > 0 && (
            <small>Hazards: {selected.hazards.join(", ")}</small>
          )}
        </aside>
      )}
      <div className="map-legend">
        <span>
          <i className="legend-incident" /> Incidents
        </span>
        {role === "admin" && (
          <span>
            <i className="legend-unit" /> Units
          </span>
        )}
      </div>
    </div>
  );
}
