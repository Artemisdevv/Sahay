import { createFileRoute, Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { IncidentMap } from "@/components/incident-map";
import { pageHead } from "@/lib/dispatch";

export const Route = createFileRoute("/map")({
  head: () =>
    pageHead(
      "Sahay public map",
      "Confirmed incidents in Kochi, shown by area. No personal details.",
    ),
  component: PublicMapPage,
});

function PublicMapPage() {
  const { t } = useTranslation();
  return (
    <main className="public-map-page">
      <header>
        <div>
          <h1>{t("publicMap.title")}</h1>
          <p>{t("publicMap.lead")}</p>
        </div>
        <Link to="/login">{t("publicMap.signIn")}</Link>
      </header>
      <IncidentMap role="public" className="public-map-canvas" />
    </main>
  );
}
