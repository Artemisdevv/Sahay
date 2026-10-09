import { createFileRoute } from "@tanstack/react-router";
import { AdminDashboard } from "@/components/operations-console";
import { pageHead } from "@/lib/dispatch";
export const Route = createFileRoute("/admin/dashboard")({
  head: () =>
    pageHead(
      "Agent orchestration control",
      "Monitor the Aegis multi-agent mesh, pipeline health, vector memory retrieval, and human oversight simulation.",
    ),
  component: AdminDashboard,
});
