import { useTranslation } from "react-i18next";

import type { ServiceCallList } from "@/lib/api";
import i18n from "@/lib/i18n";

const SERVICE_TYPES = ["ambulance", "police", "fire", "municipal"] as const;

export function ResponseTimeline({
  lists,
  civilian = false,
}: {
  lists: ServiceCallList[];
  civilian?: boolean;
}) {
  const { t } = useTranslation();
  const SERVICE_LABELS = Object.fromEntries(
    SERVICE_TYPES.map((k) => [k, t(`timeline.service.${k}`)]),
  ) as Record<ServiceCallList["service_type"], string>;
  if (lists.length === 0) {
    return (
      <p className="response-timeline-empty">
        {civilian
          ? t("timeline.civilianEmpty")
          : t("timeline.staffEmpty")}
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
                    {t(`timeline.state.${candidate.state}`)}
                  </span>
                  <span className="response-timeline-distance">
                    {t("timeline.distance", {
                      km: candidate.distance_km.toFixed(1),
                      min: candidate.eta_minutes,
                    })}
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
  return i18n.t(`timeline.service.${serviceType}`);
}
