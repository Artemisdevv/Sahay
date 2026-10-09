import { createFileRoute, redirect } from "@tanstack/react-router";
import { pageHead } from "@/lib/dispatch";
export const Route = createFileRoute("/")({
  head: () =>
    pageHead(
      "Aegis emergency dispatch",
      "A coordinated incident response workspace for citizens and emergency services.",
    ),
  beforeLoad: () => {
    throw redirect({ to: "/user/$username", params: { username: "alex-morgan" } });
  },
});
