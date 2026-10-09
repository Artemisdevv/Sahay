import { createFileRoute } from "@tanstack/react-router";
import { LoginHub } from "@/components/login-hub";
import { pageHead } from "@/lib/dispatch";
export const Route = createFileRoute("/login")({
  head: () =>
    pageHead(
      "Secure network access",
      "Sign in to Sahay as a service responder or administrator, or open the civilian reporting workspace.",
    ),
  component: LoginHub,
});
