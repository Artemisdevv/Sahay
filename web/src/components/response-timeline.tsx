import type { ServiceCallList } from "@/lib/api";

const SERVICE_LABELS: Record<ServiceCallList["service_type"], string> = {
  ambulance: "Ambulance",
  police: "Police",
  fire: "Fire and rescue",
  municipal: "City services",
};

const STATE_LABELS = {
  calling: "Being called",
  accepted: "Accepted",
  declined: "Could not respond",
  no_answer: "No answer",
  standby: "Not called yet",
} as const;

export function ResponseTimeline({
  lists,
  civilian = false,
}: {
  lists: ServiceCallList[];
  civilian?: boolean;
}) {
  if (lists.length === 0) {
    return (
      <p className="response-timeline-empty">
        {civilian
          ? "Help is being arranged. Service updates will appear here."
          : "No nearby services have been called yet."}
      </p>
    );
  }

  return (
    <div className="response-timeline">
      {lists.map((list) => (
        <section key={list.service_type}>
          <h5>{SERVICE_LABELS[list.service_type]}</h5>
          <ol>
            {[...list.candidates]
              .sort((a, b) => a.rank - b.rank)
              .map((candidate, index) => (
                <li key={`${list.service_type}-${candidate.rank}-${index}`}>
                  <span className="response-timeline-rank">
                    {candidate.rank}
                  </span>
                  <span className="response-timeline-unit">
                    {!civilian && candidate.name
                      ? candidate.name
                      : `${SERVICE_LABELS[list.service_type]} ${candidate.rank}`}
                  </span>
                  <span
                    className={`response-timeline-state is-${candidate.state}`}
                  >
                    {STATE_LABELS[candidate.state]}
                  </span>
                  <span className="response-timeline-distance">
                    {candidate.distance_km.toFixed(1)} km · about{" "}
                    {candidate.eta_minutes} min
                  </span>
                </li>
              ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

export function serviceLabel(
  serviceType: ServiceCallList["service_type"],
): string {
  return SERVICE_LABELS[serviceType];
}
