import { useCallback, useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { AlertTriangle, Loader2, MapPin, X } from "lucide-react";
import {
  getIncidents,
  getPublicIncidents,
  getPublicUnits,
  getUnits,
  type IncidentSummary,
  type PublicIncident,
  type PublicUnit,
  type Unit,
} from "@/lib/api";
import { useTranslation } from "react-i18next";
import i18n from "@/lib/i18n";
import { getSession } from "@/lib/session";
import { useDispatchWS, type WSEvent } from "@/hooks/use-dispatch-ws";

type MapRole = "admin" | "service" | "civilian" | "public";

type MapUnit = {
  unit_id: string;
  name: string;
  service_type: Unit["service_type"];
  status: string;
  location: { lat: number; lng: number };
  incident_id?: string | null;
  eta_seconds?: number | null;
  eta_minutes?: number | null;
};

type UnitLayers = {
  marker: L.Marker;
  route: L.Polyline | null;
  frame: number | null;
};

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

function fromPublicUnit(item: PublicUnit): MapUnit {
  return {
    unit_id: item.id,
    name: `${item.service_type} response unit`,
    service_type: item.service_type,
    status: item.status,
    location: item.location,
    incident_id: item.incident,
    eta_minutes: item.eta_minutes,
  };
}

function isMovingStatus(status: string): boolean {
  const normalized = status.toLowerCase().replaceAll("_", " ");
  return normalized.includes("en route") || normalized.includes("on the way");
}

function isArrivedStatus(status: string): boolean {
  return status.toLowerCase().replaceAll("_", " ").includes("on scene");
}

function etaChip(unit: MapUnit): string {
  if (isArrivedStatus(unit.status)) return i18n.t("map.onScene");
  const etaSeconds =
    unit.eta_seconds ??
    (unit.eta_minutes === null || unit.eta_minutes === undefined
      ? null
      : unit.eta_minutes * 60);
  if (etaSeconds !== null && Number.isFinite(etaSeconds))
    return etaSeconds <= 0 ? i18n.t("map.onScene") : `~${Math.ceil(etaSeconds / 60)} min`;
  return isMovingStatus(unit.status) ? i18n.t("map.enRoute") : i18n.t("map.assigned");
}

function unitIcon(unit: MapUnit): L.DivIcon {
  const abbreviation = {
    ambulance: "A",
    police: "P",
    fire: "F",
    municipal: "M",
  }[unit.service_type];
  return L.divIcon({
    className: `unit-marker unit-${unit.service_type}${isArrivedStatus(unit.status) ? " is-arrived" : ""}`,
    html: `<span aria-hidden="true">${abbreviation}</span>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

function unitColor(serviceType: Unit["service_type"]): string {
  return {
    ambulance: "#3b82f6",
    police: "#818cf8",
    fire: "#f97316",
    municipal: "#2dd4bf",
  }[serviceType];
}

export function IncidentMap({
  role,
  className = "",
  incidentData,
  loading: loadingOverride,
  error: errorOverride,
  userLocation,
  recenterKey = 0,
}: {
  role: MapRole;
  className?: string;
  incidentData?: IncidentSummary[];
  loading?: boolean;
  error?: string | null;
  /** The viewer's own position (civilian app): drawn as "You are here" and the map centres on it. */
  userLocation?: { lat: number; lng: number; accuracy_m?: number } | null;
  /** Change this number to centre the map on `userLocation` again (the Update button). */
  recenterKey?: number;
}) {
  const { t } = useTranslation();
  const mapElement = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const incidentMarkers = useRef<L.LayerGroup | null>(null);
  const unitMarkers = useRef<L.LayerGroup | null>(null);
  const unitLayers = useRef(new Map<string, UnitLayers>());
  const fitted = useRef(false);
  const youLayer = useRef<L.LayerGroup | null>(null);
  const lastRecenter = useRef<number | null>(null);
  const [incidents, setIncidents] = useState<IncidentSummary[]>([]);
  const [units, setUnits] = useState<MapUnit[]>([]);
  const [selected, setSelected] = useState<IncidentSummary | null>(null);
  const [loadingState, setLoading] = useState(!incidentData);
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
                  name: event.data.name ?? unit.name,
                  service_type: event.data.service_type ?? unit.service_type,
                  ...(event.data.incident_id === undefined
                    ? {}
                    : { incident_id: event.data.incident_id }),
                  ...(event.data.eta_seconds === undefined
                    ? {}
                    : { eta_seconds: event.data.eta_seconds }),
                  status: event.data.status,
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
                : i18n.t("map.errRefresh"),
            );
          });
      }
    },
    [role],
  );
  useDispatchWS(onEvent);

  // Public and civilian maps consume only the coarse, non-identifying feeds.
  useEffect(() => {
    if (role !== "public" && role !== "civilian") return;
    let active = true;
    let timer: number | null = null;
    const load = async () => {
      try {
        const [incidentResult, unitResult] = await Promise.all([
          getPublicIncidents(),
          getPublicUnits().catch(() => null),
        ]);
        if (!active) return;
        setIncidents(incidentResult.incidents.map(fromPublic));
        const nextUnits = unitResult?.units.map(fromPublicUnit) ?? [];
        setUnits(nextUnits);
        setError(
          unitResult
            ? null
            : i18n.t("map.errUnits"),
        );
        timer = window.setTimeout(
          () => void load(),
          nextUnits.some((unit) => isMovingStatus(unit.status)) ? 3000 : 10_000,
        );
      } catch {
        if (!active) return;
        setError(i18n.t("map.errRetry"));
        timer = window.setTimeout(() => void load(), 10_000);
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [role]);

  useEffect(() => {
    if (role === "civilian" || role === "public") return;
    let active = true;
    const session = getSession();
    if (!session?.token) {
      setError(i18n.t("map.errSignIn"));
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
        setUnits(unitData.units.map((unit) => ({ ...unit })));
        setError(null);
      })
      .catch((loadError: unknown) => {
        if (!active) return;
        setError(
          loadError instanceof Error
            ? loadError.message
            : i18n.t("map.errLoad"),
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
    youLayer.current = L.layerGroup().addTo(instance);
    map.current = instance;
    return () => {
      unitLayers.current.forEach(({ frame }) => {
        if (frame !== null) window.cancelAnimationFrame(frame);
      });
      unitLayers.current.clear();
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
      (role === "public" || role === "civilian") &&
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
    const activeIds = new Set<string>();
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    units.forEach((unit) => {
      if (
        !Number.isFinite(unit.location?.lat) ||
        !Number.isFinite(unit.location?.lng)
      )
        return;
      activeIds.add(unit.unit_id);
      const destination = L.latLng(unit.location.lat, unit.location.lng);
      const incident = incidents.find(
        (item) => item.incident_id === unit.incident_id,
      );
      const incidentPoint = incident
        ? L.latLng(incident.location.lat, incident.location.lng)
        : null;
      let layers = unitLayers.current.get(unit.unit_id);
      if (!layers) {
        const marker = L.marker(destination, {
          icon: unitIcon(unit),
          title: `${unit.name} · ${unit.status}`,
          alt: `${unit.service_type} response unit · ${unit.status}`,
        })
          .bindTooltip(etaChip(unit), {
            permanent: true,
            direction: "right",
            offset: [10, 0],
            opacity: 1,
            className: `unit-eta-chip unit-eta-${unit.service_type}`,
          })
          .addTo(group);
        const route = incidentPoint
          ? L.polyline([destination, incidentPoint], {
              color: unitColor(unit.service_type),
              weight: 3,
              opacity: 0.72,
              dashArray: "7 7",
              className: "response-route",
            }).addTo(group)
          : null;
        layers = { marker, route, frame: null };
        unitLayers.current.set(unit.unit_id, layers);
        return;
      }

      const start = layers.marker.getLatLng();
      if (layers.frame !== null) window.cancelAnimationFrame(layers.frame);
      layers.marker.setIcon(unitIcon(unit));
      layers.marker.options.title = `${unit.name} · ${unit.status}`;
      layers.marker.setTooltipContent(etaChip(unit));
      if (incidentPoint) {
        if (layers.route) {
          layers.route.setStyle({ color: unitColor(unit.service_type) });
        } else {
          layers.route = L.polyline([start, incidentPoint], {
            color: unitColor(unit.service_type),
            weight: 3,
            opacity: 0.72,
            dashArray: "7 7",
            className: "response-route",
          }).addTo(group);
        }
      } else if (layers.route) {
        group.removeLayer(layers.route);
        layers.route = null;
      }

      if (reducedMotion) {
        layers.marker.setLatLng(destination);
        if (layers.route && incidentPoint)
          layers.route.setLatLngs([destination, incidentPoint]);
        layers.frame = null;
        return;
      }

      const startedAt = performance.now();
      const duration = role === "public" || role === "civilian" ? 2800 : 950;
      const step = (now: number) => {
        const progress = Math.min(1, (now - startedAt) / duration);
        const eased = 1 - (1 - progress) ** 3;
        const position = L.latLng(
          start.lat + (destination.lat - start.lat) * eased,
          start.lng + (destination.lng - start.lng) * eased,
        );
        layers!.marker.setLatLng(position);
        if (layers!.route && incidentPoint)
          layers!.route.setLatLngs([position, incidentPoint]);
        if (progress < 1) {
          layers!.frame = window.requestAnimationFrame(step);
        } else {
          layers!.frame = null;
        }
      };
      layers.frame = window.requestAnimationFrame(step);
    });
    unitLayers.current.forEach((layers, id) => {
      if (activeIds.has(id)) return;
      if (layers.frame !== null) window.cancelAnimationFrame(layers.frame);
      group.removeLayer(layers.marker);
      if (layers.route) group.removeLayer(layers.route);
      unitLayers.current.delete(id);
    });
  }, [units, incidents]);

  // i18n.t("map.youAreHere"): a dot with an accuracy circle, redrawn whenever the position changes.
  useEffect(() => {
    const group = youLayer.current;
    if (!group) return;
    group.clearLayers();
    if (!userLocation) return;
    const at = L.latLng(userLocation.lat, userLocation.lng);
    if (userLocation.accuracy_m && userLocation.accuracy_m < 5_000) {
      L.circle(at, {
        radius: userLocation.accuracy_m,
        color: "#2563eb",
        weight: 1,
        fillColor: "#2563eb",
        fillOpacity: 0.12,
        interactive: false,
      }).addTo(group);
    }
    L.circleMarker(at, {
      radius: 8,
      color: "#ffffff",
      weight: 3,
      fillColor: "#2563eb",
      fillOpacity: 1,
    })
      .bindTooltip(i18n.t("map.youAreHere"), { direction: "top", offset: [0, -8] })
      .addTo(group);
  }, [userLocation]);

  // Centre on the viewer when we first know where they are, and again each time Update is pressed.
  useEffect(() => {
    if (!userLocation || !map.current) return;
    if (lastRecenter.current === recenterKey) return;
    lastRecenter.current = recenterKey;
    fitted.current = true; // the viewer's position wins over fitting to incidents
    map.current.setView(
      [userLocation.lat, userLocation.lng],
      Math.max(map.current.getZoom(), 14),
    );
  }, [userLocation, recenterKey]);

  return (
    <div className={`incident-map ${className}`}>
      <div
        ref={mapElement}
        className="incident-map-canvas"
        role="application"
        aria-label={t("map.ariaMap")}
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
      {!loading && !visibleError && incidents.length === 0 && (
        <div className="map-state">
          <MapPin size={15} />{" "}
          {role === "public" || role === "civilian"
            ? t("map.noConfirmed")
            : t("map.noIncidents")}
        </div>
      )}
      {selected && (role === "public" || role === "civilian") && (
        <aside className="incident-map-detail" aria-label={t("map.details")}>
          <button
            type="button"
            aria-label={t("map.closeDetails")}
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
          <small>{t("map.approxArea")}</small>
        </aside>
      )}
      {selected && role !== "public" && role !== "civilian" && (
        <aside className="incident-map-detail" aria-label={t("map.details")}>
          <button
            type="button"
            aria-label={t("map.closeDetails")}
            onClick={() => setSelected(null)}
          >
            <X size={15} />
          </button>
          <span className="map-detail-kicker">
            Severity {selected.severity} ·{" "}
            {selected.status.replaceAll("_", " ")}
          </span>
          <strong>{selected.incident_type}</strong>
          <p>{selected.summary_redacted || t("map.noSummary")}</p>
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
          <i className="legend-incident" /> {t("map.incidents")}
        </span>
        {role !== "service" && (
          <span>
            <i className="legend-ambulance" /> {t("timeline.service.ambulance")}
          </span>
        )}
        {role !== "service" && (
          <span>
            <i className="legend-police" /> {t("timeline.service.police")}
          </span>
        )}
        {role !== "service" && (
          <span>
            <i className="legend-fire" /> {t("map.fire")}
          </span>
        )}
        {role !== "service" && (
          <span>
            <i className="legend-municipal" /> {t("timeline.service.municipal")}
          </span>
        )}
      </div>
    </div>
  );
}
