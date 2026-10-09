import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  HeartPulse,
  Flame,
  UserRound,
  Network,
  ShieldCheck,
  ArrowRight,
  LockKeyhole,
  Database,
  Bot,
  LoaderCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Brand, Badge } from "./dispatch-shell";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
const roles = [
  { id: "citizen", name: "Civilian / User", icon: UserRound },
  { id: "hospital", name: "Hospital service", icon: HeartPulse },
  { id: "fire", name: "Fire & Rescue", icon: Flame },
  { id: "admin", name: "System orchestrator", icon: Network },
];
export function LoginHub() {
  const [role, setRole] = useState("citizen");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [signup, setSignup] = useState(false);
  const navigate = useNavigate();
  function enter(value: string) {
    if (value === "citizen")
      void navigate({ to: "/user/$username", params: { username: "alex-morgan" } });
    else if (value === "admin") void navigate({ to: "/admin/dashboard" });
    else
      void navigate({
        to: "/service/$serviceId",
        params: {
          serviceId: value === "hospital" ? "city-general-hospital" : "metro-fire-station-4",
        },
      });
  }
  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (password.length < 8) {
      setError("Use a password with at least 8 characters.");
      return;
    }
    setBusy(true);
    try {
      if (signup) {
        const result = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${window.location.origin}/login` },
        });
        if (result.error) throw result.error;
        toast.success("Check your email to confirm your account");
        setSignup(false);
      } else {
        const result = await supabase.auth.signInWithPassword({ email, password });
        if (result.error) throw result.error;
        enter("citizen");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to sign in. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-layout">
      <section className="login-network">
        <Brand />
        <h1>
          Every second matters.
          <br />
          Every agent connected.
        </h1>
        <p className="subtitle">
          One coordinated network for citizens, first responders, and the intelligence that connects
          them.
        </p>
        <div className="login-diagram">
          {[
            { name: "TriageAgent-01", desc: "Assess · Prioritize", icon: HeartPulse },
            { name: "DispatchRouter-v2", desc: "Route · Coordinate", icon: Network },
            { name: "ResourceMemory-RAG", desc: "Retrieve · Contextualize", icon: Database },
            { name: "NotificationBot", desc: "Notify · Synchronize", icon: Bot },
          ].map((a) => (
            <div className="login-node" key={a.name}>
              <a.icon />
              <strong>{a.name}</strong>
              <small>
                <span className="dot mr-2" />
                {a.desc}
              </small>
            </div>
          ))}
        </div>
        <div className="login-live">
          <div className="flex items-center gap-2">
            <span className="dot pulse" />
            Agentic Dispatch Network: Active — 4 Nodes Online
          </div>
          <p className="mono mt-3">99.98% uptime · 24 ms network latency</p>
        </div>
      </section>
      <section className="login-form-side">
        <div className="login-form">
          <Badge tone="green">
            <ShieldCheck size={12} />
            Secure network access
          </Badge>
          <h1 className="mt-5">Welcome to Aegis</h1>
          <p className="subtitle">Sign in to your citizen workspace or explore a demo role.</p>
          <form onSubmit={signIn}>
            <div className="section-label">Select your workspace</div>
            <div className="role-selector">
              {roles.map((r) => (
                <Button
                  type="button"
                  variant="outline"
                  className={role === r.id ? "selected" : ""}
                  onClick={() => setRole(r.id)}
                  key={r.id}
                >
                  <r.icon />
                  {r.name}
                </Button>
              ))}
            </div>
            {role !== "citizen" ? (
              <div className="mb-5">
                <Badge tone="amber">Simulation workspace</Badge>
                <p className="subtitle">
                  Service and orchestrator consoles contain demonstration data only. Role selection
                  does not grant account permissions.
                </p>
                <Button type="button" className="w-full mt-5" onClick={() => enter(role)}>
                  Enter {roles.find((r) => r.id === role)?.name} demo
                  <ArrowRight />
                </Button>
              </div>
            ) : (
              <>
                <label className="field">
                  Email address
                  <input
                    type="email"
                    placeholder="you@example.com"
                    required
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    maxLength={255}
                  />
                </label>
                <label className="field">
                  Password
                  <input
                    type="password"
                    placeholder="Enter your password"
                    required
                    minLength={8}
                    autoComplete={signup ? "new-password" : "current-password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    maxLength={128}
                  />
                </label>
                {error && (
                  <p role="alert" className="error-text">
                    {error}
                  </p>
                )}
                <Button type="submit" className="w-full" disabled={busy}>
                  {busy ? <LoaderCircle className="animate-spin" /> : <LockKeyhole />}
                  {signup ? "Create secure account" : "Sign in to workspace"}
                  <ArrowRight />
                </Button>
                <Button
                  type="button"
                  variant="link"
                  className="w-full mt-2 text-[11px]"
                  onClick={() => {
                    setSignup(!signup);
                    setError("");
                  }}
                >
                  {signup ? "Already have an account? Sign in" : "New citizen? Create an account"}
                </Button>
              </>
            )}
          </form>
          <div className="demo-bar">
            <span>Demo quick login · No account required</span>
            <div className="demo-buttons">
              {roles.map((r) => (
                <Button variant="outline" key={r.id} onClick={() => enter(r.id)}>
                  <r.icon size={12} />
                  {r.id === "citizen"
                    ? "Citizen"
                    : r.id === "hospital"
                      ? "Hospital"
                      : r.id === "fire"
                        ? "Fire"
                        : "Admin"}
                </Button>
              ))}
            </div>
          </div>
          <p className="login-footer">Simulated dispatch only. For emergencies, call 112 / 911.</p>
        </div>
      </section>
    </div>
  );
}
