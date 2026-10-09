import { createFileRoute, redirect } from "@tanstack/react-router";
import { AdminDashboard } from "@/components/operations-console";
import { pageHead } from "@/lib/dispatch";
import { hasRole } from "@/lib/session";
export const Route = createFileRoute("/admin/dashboard")({
  head: () =>
    pageHead(
      "Sahay incident operations",
      "Monitor incidents and response units across Kochi.",
    ),
  // Browser only: sessionStorage does not exist during server rendering. The API still enforces roles.
  beforeLoad: () => {
    if (typeof window !== "undefined" && !hasRole("admin"))
      throw redirect({ to: "/login" });
  },
  component: AdminDashboard,
});
