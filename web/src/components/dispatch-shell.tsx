import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  Shield,
  Building2,
  LayoutDashboard,
  HeartPulse,
  Flame,
  Network,
  ChevronDown,
  ChevronsUpDown,
  Bell,
  LogOut,
  MapPin,
  Menu,
  X,
  CircleHelp,
  ArrowUpRight,
  Radio,
  Activity,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { motion, useReducedMotion } from "framer-motion";
export function Brand() {
  return (
    <div className="brand">
      <div className="brand-mark">
        <Shield size={21} strokeWidth={2} />
      </div>
      <div>
        <div className="brand-title">
          sahay<span className="text-primary">.</span>
        </div>
        <div className="brand-subtitle">Autonomous dispatch</div>
      </div>
    </div>
  );
}
export function Badge({ children, tone = "" }: { children: ReactNode; tone?: string }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function Shell({
  children,
  role = "citizen",
  title,
}: {
  children: ReactNode;
  role?: "citizen" | "hospital" | "fire" | "admin";
  title: string;
}) {
  const [open, setOpen] = useState(false);
  const reduced = useReducedMotion();
  return (
    <div className="app-shell">
      <aside className={`sidebar ${open ? "open" : ""}`}>
        <div className="flex items-center justify-between">
          <Brand />
          <Button
            variant="ghost"
            size="icon"
            className="mobile-trigger"
            aria-label="Close navigation"
            onClick={() => setOpen(false)}
          >
            <X />
          </Button>
        </div>
        <div className="workspace">
          <div className="workspace-icon">
            <Building2 size={15} />
          </div>
          <div>
            <strong>San Francisco</strong>
            <small>City response network</small>
          </div>
          <ChevronsUpDown size={12} className="ml-auto text-muted-foreground" />
        </div>
        <div className="nav-label">Workspace</div>
        <nav aria-label="Main navigation">
          <Link
            to="/user/$username"
            params={{ username: "alex-morgan" }}
            className={`nav-item ${role === "citizen" ? "active" : ""}`}
          >
            <LayoutDashboard />
            Citizen portal
          </Link>
          <Link
            to="/service/$serviceId"
            params={{ serviceId: "city-general-hospital" }}
            className={`nav-item ${role === "hospital" ? "active" : ""}`}
          >
            <HeartPulse />
            Hospital console<span className="count">3</span>
          </Link>
          <Link
            to="/service/$serviceId"
            params={{ serviceId: "metro-fire-station-4" }}
            className={`nav-item ${role === "fire" ? "active" : ""}`}
          >
            <Flame />
            Fire & rescue<span className="count">2</span>
          </Link>
          <Link to="/admin/dashboard" className={`nav-item ${role === "admin" ? "active" : ""}`}>
            <Network />
            Agent orchestration
          </Link>
        </nav>
        <div className="nav-label mt-7">System</div>
        <Button
          variant="ghost"
          className="nav-item w-full justify-start"
          onClick={() =>
            toast.success("All systems operational", {
              description: "4 agents online · 99.98% network uptime · 24 ms latency",
            })
          }
        >
          <Activity />
          Network status
          <ArrowUpRight size={12} className="ml-auto" />
        </Button>
        <Button
          variant="ghost"
          className="nav-item w-full justify-start"
          onClick={() =>
            toast("Emergency support", {
              description:
                "For a real emergency, call 112 or 911. This workspace uses simulated dispatches.",
            })
          }
        >
          <CircleHelp />
          Help & support
        </Button>
        <div className="sidebar-bottom">
          <div className="network-health">
            <div className="flex items-center gap-2 text-[10px] font-medium">
              <span className="dot pulse" />
              All systems operational
            </div>
            <small>4 agents connected · 99.98% uptime</small>
          </div>
          <div className="account">
            <div className="avatar">
              {role === "citizen" ? "AM" : role === "admin" ? "SO" : "OP"}
            </div>
            <div>
              <strong className="text-[11px]">
                {role === "citizen"
                  ? "Alex Morgan"
                  : role === "admin"
                    ? "System operator"
                    : "Response operator"}
              </strong>
              <small>{role === "citizen" ? "Citizen account" : "Demo workspace"}</small>
            </div>
            <Button variant="ghost" size="icon" className="ml-auto" asChild>
              <Link to="/login" aria-label="Switch account">
                <LogOut size={14} />
              </Link>
            </Button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <Button
              variant="ghost"
              size="icon"
              className="mobile-trigger"
              aria-label="Open navigation"
              onClick={() => setOpen(true)}
            >
              <Menu />
            </Button>
            <span>Workspace</span>
            <span>/</span>
            <strong>{title}</strong>
            <ChevronDown size={11} />
          </div>
          <div className="topbar-right">
            <span className="flex items-center gap-2 text-muted-foreground">
              <MapPin size={12} />
              San Francisco, CA
            </span>
            <Badge tone="amber">Demo environment</Badge>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Notifications"
              onClick={() =>
                toast("You’re up to date", { description: "No unread coordinator notifications." })
              }
            >
              <Bell size={16} />
            </Button>
            <div className="avatar">{role === "citizen" ? "AM" : "OP"}</div>
          </div>
        </header>
        <motion.main
          className="page"
          initial={reduced ? false : { opacity: 0, y: 7 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
        >
          {children}
          <footer className="page-footer">
            <span>
              <Shield size={11} />
              Secure by design. Coordinated by intelligence.
            </span>
            <span>
              <Radio size={10} />
              Sahay network <span className="mx-1">·</span> Simulation only
            </span>
          </footer>
        </motion.main>
      </div>
    </div>
  );
}
export function ZoneMap() {
  const [authorized, setAuthorized] = useState(false);
  return <MapInner authorized={authorized} setAuthorized={setAuthorized} />;
}
import { useEffect } from "react";
function MapInner({
  authorized,
  setAuthorized,
}: {
  authorized: boolean;
  setAuthorized: (value: boolean) => void;
}) {
  useEffect(() => {
    const host = window.location.hostname;
    setAuthorized(
      host.endsWith(".lovable.app") ||
        (host.endsWith(".lovableproject.com") && !host.includes("-devserver-")),
    );
  }, [setAuthorized]);
  const key = import.meta.env["VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_BROWSER_KEY"];
  return (
    <div className="network-map">
      {authorized && key ? (
        <iframe
          title="San Francisco response zone map"
          loading="lazy"
          src={`https://www.google.com/maps/embed/v1/view?key=${key}&center=37.7749,-122.4194&zoom=13&maptype=roadmap`}
        />
      ) : (
        <div className="map-placeholder">
          <MapPin size={23} />
          <span className="mono">SAN FRANCISCO · CENTRAL ZONE</span>
          <small>Map available on authorized deployment</small>
        </div>
      )}
    </div>
  );
}
