import { createFileRoute, redirect } from "@tanstack/react-router";
import { pageHead } from "@/lib/dispatch";
import { getSession } from "@/lib/session";
export const Route = createFileRoute("/")({
  head: () =>
    pageHead(
      "Sahay emergency response",
      "A coordinated incident response workspace for citizens and emergency services.",
    ),
  beforeLoad: () => {
    const session = getSession();
    if (!session?.token) {
      throw redirect({ to: "/login" });
    }
    if (session.role === "admin") {
      throw redirect({ to: "/admin/dashboard" });
    }
    if (session.role === "service" && session.unit_id) {
      throw redirect({ to: "/service/$serviceId", params: { serviceId: session.unit_id } });
    }
    // For civilian role or fallback
    throw redirect({ to: "/user/$username", params: { username: "civilian" } });
  },
});
