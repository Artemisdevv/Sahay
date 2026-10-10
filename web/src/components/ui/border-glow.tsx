import { useCallback, useRef, type CSSProperties, type ReactNode } from "react";
import "./border-glow.css";

type BorderGlowProps = {
  children: ReactNode;
  className?: string;
  edgeSensitivity?: number;
  glowRadius?: number;
  glowIntensity?: number;
  colors?: [string, string, string];
};

type GlowStyle = CSSProperties & {
  "--glow-x": string;
  "--glow-y": string;
  "--glow-alpha": number;
  "--glow-radius": string;
  "--glow-intensity": number;
  "--glow-one": string;
  "--glow-two": string;
  "--glow-three": string;
};

export default function BorderGlow({
  children,
  className = "",
  edgeSensitivity = 30,
  glowRadius = 26,
  glowIntensity = 0.8,
  colors = ["#0f766e", "#34d399", "#99f6e4"],
}: BorderGlowProps) {
  const ref = useRef<HTMLDivElement>(null);
  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const element = ref.current;
      if (!element || event.pointerType === "touch") return;
      const rect = element.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const edge = Math.min(
        x / rect.width,
        (rect.width - x) / rect.width,
        y / rect.height,
        (rect.height - y) / rect.height,
      );
      const proximity = Math.max(0, Math.min(1, 1 - edge * 2));
      element.style.setProperty("--glow-x", `${x}px`);
      element.style.setProperty("--glow-y", `${y}px`);
      element.style.setProperty(
        "--glow-alpha",
        proximity >= edgeSensitivity / 100 ? String(proximity) : "0",
      );
    },
    [edgeSensitivity],
  );

  const style: GlowStyle = {
    "--glow-x": "50%",
    "--glow-y": "50%",
    "--glow-alpha": 0,
    "--glow-radius": `${glowRadius}px`,
    "--glow-intensity": glowIntensity,
    "--glow-one": colors[0],
    "--glow-two": colors[1],
    "--glow-three": colors[2],
  };

  return (
    <div
      ref={ref}
      className={`border-glow-card ${className}`}
      style={style}
      onPointerMove={handlePointerMove}
      onPointerLeave={() =>
        ref.current?.style.setProperty("--glow-alpha", "0")
      }
    >
      {children}
    </div>
  );
}
