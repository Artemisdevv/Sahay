import { useCallback, useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { AlertTriangle, Loader2, MapPin, X } from "lucide-react";
import {
  getIncidents,
  getUnits,
  type IncidentSummary,
  type Unit,
} from "@/lib/api";
import { getSession } from "@/lib/session";
import { useDispatchWS, type WSEvent } from "@/hooks/use-dispatch-ws";

type MapRole = "admin" | "service" | "civilian";

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
  const [incidents, setIncidents] = useState<IncidentSummary[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [selected, setSelected] = useState<IncidentSummary | null>(null);
  const [loadingState, setLoading] = useState(
    role !== "civilian" && !incidentData,
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
        if (!session?.token || role === "civilian") return;
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

  useEffect(() => {
    if (role === "civilian") return;
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
    L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
      {
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: "abcd",
        maxZoom: 20,
      },
    ).addTo(instance);
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
    });
  }, [incidents]);

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
            <MapPin size={15} /> No incidents available in this view.
          </div>
        )}
      {role === "civilian" && (
        <div className="map-state">
          <MapPin size={15} /> Shared incident locations aren’t available for
          civilian accounts.
        </div>
      )}
      {selected && (
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
