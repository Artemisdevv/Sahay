import { createFileRoute } from "@tanstack/react-router";
import { CitizenPortal } from "@/components/citizen-portal";
import { pageHead } from "@/lib/dispatch";
export const Route = createFileRoute("/user/$username")({
  head: () =>
    pageHead(
      "Citizen incident portal",
      "Coordinate a simulated emergency response, maintain your private emergency profile, and track agent action telemetry.",
    ),
  component: CitizenPortal,
});
