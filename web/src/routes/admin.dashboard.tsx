import { createFileRoute } from "@tanstack/react-router";
import { AdminDashboard } from "@/components/operations-console";
import { pageHead } from "@/lib/dispatch";
export const Route = createFileRoute("/admin/dashboard")({
  head: () =>
    pageHead(
      "Sahay incident operations",
      "Monitor incidents and response units across Kochi.",
    ),
  component: AdminDashboard,
});
