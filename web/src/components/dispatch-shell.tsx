import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Building2,
  LayoutDashboard,
  HeartPulse,
  Flame,
  Network,
  Bell,
  LogOut,
  MapPin,
  CircleHelp,
  Activity,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { clearSession } from "@/lib/session";
import { motion, useReducedMotion } from "framer-motion";
import { IncidentMap } from "./incident-map";
import { LanguageSelector } from "./language-selector";
import { useTranslation } from "react-i18next";

export function Brand() {
  const { t } = useTranslation("shell");
  return (
    <div className="brand">
      <div className="brand-title">
        sahay<span className="text-primary">.</span>
      </div>
      <div className="brand-subtitle">{t("brand_subtitle")}</div>
    </div>
  );
}
export function Badge({
  children,
  tone = "",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export type ShellTab = { id: string; label: string; icon: LucideIcon };

type Role = "citizen" | "hospital" | "fire" | "ambulance" | "police" | "admin";

function roleLink(role: Role) {
  if (role === "hospital")
    return {
      label: "Hospital",
      icon: HeartPulse,
      to: "/service/$serviceId",
      params: { serviceId: "city-general-hospital" },
    };
  if (role === "fire")
    return {
      label: "Fire and rescue",
      icon: Flame,
      to: "/service/$serviceId",
      params: { serviceId: "metro-fire-station-4" },
    };
  return {
    label: "Operations",
    icon: Network,
    to: "/admin/dashboard",
    params: {},
  };
}

const SUPPORT_TOAST = () =>
  toast("In a real emergency, call 112", {
    description: "This workspace uses simulated dispatches.",
  });

/**
 * App frame. Wide screens: sidebar + top bar. Phones (<= 768px): content plus a bottom navigation bar.
 * Citizen pages pass `tabs` so the same three destinations appear in the sidebar and the bottom bar.
 */
export function Shell({
  children,
  role = "citizen",
  title,
  tabs,
  activeTab,
  onTab,
}: {
  children: ReactNode;
  role?: Role;
  title: string;
  tabs?: ShellTab[];
  activeTab?: string;
  onTab?: (id: string) => void;
}) {
  const navigate = useNavigate();
  const reduced = useReducedMotion();
  const staff = role !== "citizen";
  const { t } = useTranslation("shell");
  const signOut = () => {
    clearSession();
    void navigate({ to: "/login" });
  };
  const link = staff ? roleLink(role) : null;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand />
        <div className="workspace">
          <Building2 size={16} />
          <div>
            <strong>Kochi</strong>
            <small>{t("workspace")}</small>
          </div>
        </div>
        <nav aria-label="Main navigation" className="side-nav">
          {tabs?.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`nav-item ${activeTab === t.id ? "active" : ""}`}
              aria-current={activeTab === t.id ? "page" : undefined}
              onClick={() => onTab?.(t.id)}
            >
              <t.icon />
              {t.label}
            </button>
          ))}
          {!tabs && !staff && (
            <Link
              to="/user/$username"
              params={{ username: "civilian" }}
              className="nav-item active"
            >
              <LayoutDashboard />
              Home
            </Link>
          )}
          {link && (
            <Link to={link.to} params={link.params} className="nav-item active">
              <link.icon />
              {link.label}
            </Link>
          )}
        </nav>
        <div className="sidebar-bottom">
          <Button
            variant="ghost"
            className="nav-item w-full justify-start"
            onClick={SUPPORT_TOAST}
          >
            <CircleHelp />
            {t("help")}
          </Button>
          <Button
            variant="ghost"
            className="nav-item w-full justify-start"
            onClick={signOut}
          >
            <LogOut />
            {t("sign_out")}
          </Button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <h2 className="topbar-title">{title}</h2>
          <div className="topbar-right">
            <span className="flex items-center gap-2 text-muted-foreground">
              <MapPin size={14} />
              Kochi, Kerala
            </span>
            <Badge tone="amber">Demo</Badge>
            <LanguageSelector />
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("notifications", { defaultValue: "Notifications" })}
              onClick={() => toast(t("no_new_notifications", { defaultValue: "No new notifications" }))}
            >
              <Bell size={18} />
            </Button>
          </div>
        </header>
        <motion.main
          className="page"
          initial={reduced ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.2 }}
        >
          {children}
        </motion.main>
      </div>
      <nav className="bottom-nav" aria-label="Main navigation">
        {tabs ? (
          tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`bottom-nav-item ${activeTab === t.id ? "active" : ""}`}
              aria-current={activeTab === t.id ? "page" : undefined}
              onClick={() => onTab?.(t.id)}
            >
              <t.icon />
              <span>{t.label}</span>
            </button>
          ))
        ) : (
          <>
            {link && (
              <Link
                to={link.to}
                params={link.params}
                className="bottom-nav-item active"
              >
                <link.icon />
                <span>{link.label}</span>
              </Link>
            )}
            <button
              type="button"
              className="bottom-nav-item"
              onClick={() => toast.success("All systems working")}
            >
              <Activity />
              <span>Status</span>
            </button>
            <button
              type="button"
              className="bottom-nav-item"
              onClick={SUPPORT_TOAST}
            >
              <CircleHelp />
              <span>Help</span>
            </button>
          </>
        )}
        {(staff || !tabs) && (
          <button type="button" className="bottom-nav-item" onClick={signOut}>
            <LogOut />
            <span>Sign out</span>
          </button>
        )}
      </nav>
    </div>
  );
}
export { IncidentMap };
