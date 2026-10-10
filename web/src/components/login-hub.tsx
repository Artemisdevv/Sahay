import { useState } from "react";
import { useTranslation } from "react-i18next";
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
import { LanguageSelector } from "./language-selector";
import { login } from "@/lib/api";
import { saveSession } from "@/lib/session";

const roles = [
  { id: "service", nameKey: "login.roleService", icon: HeartPulse },
  { id: "admin", nameKey: "login.roleAdmin", icon: Network },
] as const;

export function LoginHub() {
  const { t } = useTranslation();
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
        throw new Error(t("login.wrongRole", { role: session.role }));
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
      setError(err instanceof Error ? err.message : t("login.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-layout">
      <section className="login-network">
        <Brand />
        <h1>{t("login.headline1")}<br />{t("login.headline2")}</h1>
        <p className="subtitle">{t("login.subtitle")}</p>
        <div className="login-diagram">
          {[
            { name: "TriageAgent-01", descKey: "login.agentTriage", icon: HeartPulse },
            { name: "DispatchRouter-v2", descKey: "login.agentDispatch", icon: Network },
            { name: "ResourceMemory-RAG", descKey: "login.agentMemory", icon: Database },
            { name: "NotificationBot", descKey: "login.agentNotify", icon: Bot },
          ].map((a) => <div className="login-node" key={a.name}><a.icon /><strong>{a.name}</strong><small><span className="dot mr-2" />{t(a.descKey)}</small></div>)}
        </div>
        <div className="login-live"><div className="flex items-center gap-2"><span className="dot pulse" />{t("login.network")}</div><p className="mono mt-3">{t("login.city")}</p></div>
      </section>
      <section className="login-form-side">
        <div className="login-form">
          <div className="login-lang"><LanguageSelector /></div>
          <Badge tone="green"><ShieldCheck size={12} />{t("login.secure")}</Badge>
          <h1 className="mt-5">{t("login.welcome")}</h1>
          <p className="subtitle">{t("login.intro")}</p>
          <form onSubmit={signIn}>
            <div className="section-label">{t("login.selectWorkspace")}</div>
            <div className="role-selector">
              {roles.map((r) => <Button type="button" variant="outline" className={role === r.id ? "selected" : ""} onClick={() => setRole(r.id)} key={r.id}><r.icon />{t(r.nameKey)}</Button>)}
            </div>
            <label className="field">{t("login.username")}<input type="text" placeholder={t("login.usernamePlaceholder")} required autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} maxLength={128} /></label>
            <label className="field">{t("login.password")}<input type="password" placeholder={t("login.passwordPlaceholder")} required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} maxLength={128} /></label>
            {error && <p role="alert" className="error-text">{error}</p>}
            <Button type="submit" className="w-full" disabled={busy}>{busy ? <LoaderCircle className="animate-spin" /> : <LockKeyhole />}{busy ? t("login.signingIn") : t("login.signIn")}<ArrowRight /></Button>
          </form>
          <div className="demo-bar"><span>{t("login.civiliansNote")}</span><div className="demo-buttons"><Button variant="outline" onClick={() => void navigate({ to: "/user/$username", params: { username: "civilian" } })}><UserRound size={12} />{t("login.civilianReport")}</Button></div></div>
          <p className="login-footer">{t("login.emergency")}</p>
        </div>
      </section>
    </div>
  );
}
