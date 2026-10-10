import { useRef, useState, type ReactNode, type TouchEvent } from "react";
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
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
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

// Section change: slide in from the side we are navigating towards. Functions of `custom` must live in variants
// (passing them to initial/exit directly does not type-check).
const sectionVariants = {
  enter: (direction: number) => ({ opacity: 0, x: direction * 24 }),
  center: { opacity: 1, x: 0 },
  exit: (direction: number) => ({ opacity: 0, x: direction * -24 }),
};

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
  const mobileItems = tabs
    ? tabs.map((tab) => ({
        value: tab.id,
        label: tab.label,
        icon: <tab.icon size={16} aria-hidden="true" />,
      }))
    : [
        ...(link
          ? [
              {
                value: "role",
                label: link.label,
                icon: <link.icon size={16} aria-hidden="true" />,
              },
            ]
          : []),
        {
          value: "status",
          label: "Status",
          icon: <Activity size={16} aria-hidden="true" />,
        },
        {
          value: "help",
          label: "Help",
          icon: <CircleHelp size={16} aria-hidden="true" />,
        },
        {
          value: "signout",
          label: "Sign out",
          icon: <LogOut size={16} aria-hidden="true" />,
        },
      ];
  const [mobileAction, setMobileAction] = useState(link ? "role" : "status");
  const mobileValue = activeTab ?? mobileAction;
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const [navigationDirection, setNavigationDirection] = useState(0);
  const selectTab = (next: string) => {
    if (!tabs || !onTab) return;
    const currentIndex = tabs.findIndex((item) => item.id === activeTab);
    const nextIndex = tabs.findIndex((item) => item.id === next);
    if (nextIndex < 0) return;
    if (currentIndex >= 0 && nextIndex !== currentIndex)
      setNavigationDirection(nextIndex > currentIndex ? 1 : -1);
    onTab(next);
  };
  const onContentTouchStart = (event: TouchEvent<HTMLElement>) => {
    if (
      !tabs ||
      typeof window === "undefined" ||
      !window.matchMedia("(max-width: 768px)").matches
    )
      return;
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest(
        "input, textarea, select, [contenteditable='true'], [data-no-section-swipe]",
      )
    ) {
      touchStart.current = null;
      return;
    }
    if (event.touches.length !== 1) {
      touchStart.current = null;
      return;
    }
    const touch = event.touches[0]!;
    touchStart.current = { x: touch.clientX, y: touch.clientY };
  };
  const onContentTouchEnd = (event: TouchEvent<HTMLElement>) => {
    const start = touchStart.current;
    touchStart.current = null;
    if (!start || !tabs || event.changedTouches.length !== 1) return;
    const touch = event.changedTouches[0]!;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy) * 1.25) return;
    const index = tabs.findIndex((item) => item.id === activeTab);
    const next = tabs[index + (dx < 0 ? 1 : -1)];
    if (next) selectTab(next.id);
  };
  const handleMobileChange = (next: string) => {
    if (tabs) {
      selectTab(next);
      return;
    }
    setMobileAction(next);
    if (next === "role" && link) {
      void navigate({ to: link.to, params: link.params });
    } else if (next === "status") {
      toast.success("All systems working");
    } else if (next === "help") {
      SUPPORT_TOAST();
    } else if (next === "signout") {
      signOut();
    }
  };
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
              onClick={() => selectTab(t.id)}
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
              onClick={() =>
                toast(
                  t("no_new_notifications", {
                    defaultValue: "No new notifications",
                  }),
                )
              }
            >
              <Bell size={18} />
            </Button>
          </div>
        </header>
        <motion.main
          className="page"
          onTouchStart={onContentTouchStart}
          onTouchEnd={onContentTouchEnd}
          onTouchCancel={() => {
            touchStart.current = null;
          }}
          initial={reduced ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.2 }}
        >
          <AnimatePresence
            mode="wait"
            initial={false}
            custom={navigationDirection}
          >
            <motion.div
              key={activeTab ?? "page"}
              className="section-transition"
              custom={navigationDirection}
              {...(reduced
                ? { initial: false as const }
                : {
                    variants: sectionVariants,
                    initial: "enter",
                    animate: "center",
                    exit: "exit",
                  })}
              transition={{ duration: reduced ? 0 : 0.2, ease: "easeOut" }}
            >
              {children}
            </motion.div>
          </AnimatePresence>
        </motion.main>
      </div>
      <nav className="bottom-nav" aria-label="Main navigation">
        <div
          className="bottom-nav-items"
          style={{
            gridTemplateColumns: `repeat(${mobileItems.length}, minmax(0, 1fr))`,
          }}
        >
          {mobileItems.map((item) => (
            <button
              key={item.value}
              type="button"
              className={`bottom-nav-item ${mobileValue === item.value ? "active" : ""}`}
              aria-current={mobileValue === item.value ? "page" : undefined}
              onClick={() => handleMobileChange(item.value)}
            >
              <span className="bottom-nav-icon">{item.icon}</span>
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}
export { IncidentMap };
