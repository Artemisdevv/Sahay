import { createFileRoute, Link } from "@tanstack/react-router";
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
  return (
    <main className="public-map-page">
      <header>
        <div>
          <h1>Sahay public map</h1>
          <p>
            Confirmed incidents, by area. No names, messages or exact addresses
            are shown. In an emergency call 112.
          </p>
        </div>
        <Link to="/login">Sign in</Link>
      </header>
      <IncidentMap role="public" className="public-map-canvas" />
    </main>
  );
}
