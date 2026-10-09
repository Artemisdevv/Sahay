import { createFileRoute } from "@tanstack/react-router";
import { LoginHub } from "@/components/login-hub";
import { pageHead } from "@/lib/dispatch";
export const Route = createFileRoute("/login")({
  head: () =>
    pageHead(
      "Secure network access",
      "Sign in to Sahay or explore the citizen, hospital, fire rescue and orchestrator demonstration workspaces.",
    ),
  component: LoginHub,
});
