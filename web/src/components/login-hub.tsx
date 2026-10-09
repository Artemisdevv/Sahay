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
import { login } from "@/lib/api";
import { saveSession } from "@/lib/session";

const roles = [
  { id: "service", name: "Service unit", icon: HeartPulse },
  { id: "admin", name: "Administrator", icon: Network },
];

export function LoginHub() {
  const [role, setRole] = useState("service");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const navigate = useNavigate();

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const session = await login(username.trim(), password);
      if (session.role !== role) {
        throw new Error(`This account has the ${session.role} role. Select that workspace to continue.`);
      }
      saveSession(session);
      if (session.role === "admin") {
        await navigate({ to: "/admin/dashboard" });
      } else {
        await navigate({
          to: "/service/$serviceId",
          params: { serviceId: session.unit_id ?? "service" },
        });
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
        <h1>Every second matters.<br />Every responder connected.</h1>
        <p className="subtitle">One coordinated network for civilians, first responders, and the intelligence that connects them.</p>
        <div className="login-diagram">
          {[
            { name: "TriageAgent-01", desc: "Assess · Prioritize", icon: HeartPulse },
            { name: "DispatchRouter-v2", desc: "Route · Coordinate", icon: Network },
            { name: "ResourceMemory-RAG", desc: "Retrieve · Contextualize", icon: Database },
            { name: "NotificationBot", desc: "Notify · Synchronize", icon: Bot },
          ].map((a) => <div className="login-node" key={a.name}><a.icon /><strong>{a.name}</strong><small><span className="dot mr-2" />{a.desc}</small></div>)}
        </div>
        <div className="login-live"><div className="flex items-center gap-2"><span className="dot pulse" />Sahay response network</div><p className="mono mt-3">Kochi · Kerala</p></div>
      </section>
      <section className="login-form-side">
        <div className="login-form">
          <Badge tone="green"><ShieldCheck size={12} />Secure network access</Badge>
          <h1 className="mt-5">Welcome to Sahay</h1>
          <p className="subtitle">Sign in to a service or administrator workspace.</p>
          <form onSubmit={signIn}>
            <div className="section-label">Select your workspace</div>
            <div className="role-selector">
              {roles.map((r) => <Button type="button" variant="outline" className={role === r.id ? "selected" : ""} onClick={() => setRole(r.id)} key={r.id}><r.icon />{r.name}</Button>)}
            </div>
            <label className="field">Username<input type="text" placeholder="e.g. amb-01" required autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} maxLength={128} /></label>
            <label className="field">Password<input type="password" placeholder="Enter your password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} maxLength={128} /></label>
            {error && <p role="alert" className="error-text">{error}</p>}
            <Button type="submit" className="w-full" disabled={busy}>{busy ? <LoaderCircle className="animate-spin" /> : <LockKeyhole />}{busy ? "Signing in…" : "Sign in"}<ArrowRight /></Button>
          </form>
          <div className="demo-bar"><span>Civilians can report without signing in</span><div className="demo-buttons"><Button variant="outline" onClick={() => void navigate({ to: "/user/$username", params: { username: "civilian" } })}><UserRound size={12} />Civilian report</Button></div></div>
          <p className="login-footer">For emergencies, call 112.</p>
        </div>
      </section>
    </div>
  );
}
