import { createFileRoute, redirect } from "@tanstack/react-router";
import { OperationsConsole } from "@/components/operations-console";
import { pageHead } from "@/lib/dispatch";
import { hasRole } from "@/lib/session";
export const Route = createFileRoute("/service/$serviceId")({
  head: ({ params }) =>
    pageHead(
      params.serviceId.includes("fire")
        ? "Fire & rescue console"
        : "Hospital response console",
      "Manage simulated incoming dispatches, response unit capacity, field briefings, and autonomous routing logs.",
    ),
  beforeLoad: () => {
    if (typeof window !== "undefined" && !hasRole("service", "admin"))
      throw redirect({ to: "/login" });
  },
  component: ServicePage,
});
function ServicePage() {
  const { serviceId } = Route.useParams();
  return <OperationsConsole key={serviceId} serviceId={serviceId} />;
}
