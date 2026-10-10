import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from "motion/react";
import "./rubber-segment.css";

export type RubberSegmentItem =
  string | { value: string; label: ReactNode; icon?: ReactNode };

type Size = "sm" | "md" | "lg";
type Slot = { l: number; r: number };
type DragState = {
  id: number;
  x0: number;
  slot: number;
  onThumb: boolean;
  live: boolean;
  offset: number;
  w: number;
  hist: Array<[number, number]>;
};

type RubberSegmentProps = {
  items: RubberSegmentItem[];
  value?: string;
  defaultValue?: string;
  onChange?: (value: string, index: number) => void;
  trackColor?: string;
  thumbColor?: string;
  textColor?: string;
  activeTextColor?: string;
  size?: Size;
  radius?: number;
  inset?: number;
  equalSlots?: boolean;
  stretch?: number;
  squash?: number;
  speed?: number;
  glide?: number;
  draggable?: boolean;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
};

const EASE_OUT = [0.23, 1, 0.32, 1] as const;
const SPRING_UI = { type: "spring", duration: 0.3, bounce: 0 } as const;
const SPRING_MOMENTUM = {
  type: "spring",
  duration: 0.4,
  bounce: 0.2,
} as const;
const SPRING_RELAX = { type: "spring", duration: 0.16, bounce: 0 } as const;
const DILATE = 0.19;
const HANDOFF = 0.15;
const FLICK = 110;
const MAX_VELOCITY = 2000;
const DEADZONE = 4;
const SLOP = 10;
const RUBBER = 0.55;
const SIZES: Record<
  Size,
  { height: number; font: number; pad: number; min: number }
> = {
  sm: { height: 28, font: 12, pad: 10, min: 36 },
  md: { height: 36, font: 13, pad: 14, min: 44 },
  lg: { height: 44, font: 14, pad: 18, min: 48 },
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));
const rubber = (over: number, dim: number) =>
  (over * dim * RUBBER) / (dim + RUBBER * Math.abs(over));
const project = (velocity: number, glide: number) => {
  const d = 1 - 0.1 * Math.pow(0.05, glide / 100);
  return ((velocity / 1000) * d) / (1 - d);
};
const velocityOf = (hist: Array<[number, number]>, now: number) => {
  const recent = hist.filter(([time]) => now - time <= 100);
  if (recent.length < 2) return 0;
  const [t0, x0] = recent[0]!;
  const [t1, x1] = recent[recent.length - 1]!;
  return t1 - t0 >= 8 ? ((x1 - x0) / (t1 - t0)) * 1000 : 0;
};
const nearestSlot = (slots: Slot[], x: number) => {
  let best = 0;
  for (let i = 1; i < slots.length; i += 1) {
    if (
      Math.abs((slots[i]!.l + slots[i]!.r) / 2 - x) <
      Math.abs((slots[best]!.l + slots[best]!.r) / 2 - x)
    )
      best = i;
  }
  return best;
};

export default function RubberSegment({
  items,
  value,
  defaultValue,
  onChange,
  trackColor = "#27272a",
  thumbColor = "#fafafa",
  textColor = "#fafafa",
  activeTextColor = "#18181b",
  size = "md",
  radius = 10,
  inset = 3,
  equalSlots = true,
  stretch = 100,
  squash = 3,
  speed = 1,
  glide = 75,
  draggable = true,
  disabled = false,
  className = "",
  "aria-label": ariaLabel = "Segmented control",
}: RubberSegmentProps) {
  const list = items.map((item) =>
    typeof item === "string" ? { value: item, label: item } : item,
  );
  const [inner, setInner] = useState(defaultValue ?? list[0]?.value);
  const current = value !== undefined ? value : inner;
  const foundIndex = list.findIndex((item) => item.value === current);
  const index = foundIndex < 0 ? 0 : foundIndex;
  const reduce = useReducedMotion();

  const trackRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const slots = useRef<Slot[]>([]);
  const box = useRef<DOMRect | null>(null);
  const committed = useRef(index);
  const handoff = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drag = useRef<DragState | null>(null);
  const generation = useRef(0);

  const edgeL = useMotionValue(0);
  const edgeR = useMotionValue(0);
  const innerW = useMotionValue(0);
  const thumbRadius = Math.max(0, radius - inset);
  const clipPath = useTransform(
    () =>
      `inset(0 ${Math.max(0, innerW.get() - edgeR.get())}px 0 ${Math.max(0, edgeL.get())}px round ${thumbRadius}px)`,
  );
  const t = (seconds: number) => seconds / speed;

  const clearHandoff = () => {
    if (handoff.current !== null) clearTimeout(handoff.current);
    handoff.current = null;
  };

  const jumpTo = (i: number) => {
    const slot = slots.current[i];
    if (!slot) return;
    clearHandoff();
    generation.current += 1;
    edgeL.jump(slot.l);
    edgeR.jump(slot.r);
  };

  const measure = () => {
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    box.current = rect;
    slots.current = list.map((_, i) => {
      const el = itemRefs.current[i];
      if (!el) return { l: 0, r: 0 };
      const itemRect = el.getBoundingClientRect();
      return {
        l: itemRect.left - rect.left - inset,
        r: itemRect.right - rect.left - inset,
      };
    });
    innerW.set(rect.width - inset * 2);
    jumpTo(committed.current);
  };

  const listKey = list.map((item) => item.value).join("|");
  useLayoutEffect(() => {
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    if (trackRef.current) observer.observe(trackRef.current);
    if (typeof document !== "undefined" && document.fonts)
      void document.fonts.ready.then(measure);
    return () => observer.disconnect();
    // Measurements are recalculated only when slot geometry can change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listKey, size, inset, equalSlots]);

  useEffect(() => {
    if (!drag.current && committed.current !== index) {
      committed.current = index;
      jumpTo(index);
    }
  });

  useEffect(
    () => () => {
      clearHandoff();
      edgeL.stop();
      edgeR.stop();
    },
    [edgeL, edgeR],
  );

  const commit = (i: number) => {
    committed.current = i;
    if (i === index || !list[i]) return;
    if (value === undefined) setInner(list[i].value);
    onChange?.(list[i].value, i);
  };

  const land = (
    to: number,
    velocity: number | null,
    flick: boolean,
    withSquash: boolean,
  ) => {
    const slot = slots.current[to];
    if (!slot) return;
    const g = ++generation.current;
    const dir =
      Math.sign((slot.l + slot.r) / 2 - (edgeL.get() + edgeR.get()) / 2) || 1;
    const [lead, leadTo, trail, trailTo] =
      dir > 0 ? [edgeR, slot.r, edgeL, slot.l] : [edgeL, slot.l, edgeR, slot.r];
    const velocityFor = (motionValue: typeof edgeL) =>
      clamp(
        velocity === null ? motionValue.getVelocity() : velocity,
        -MAX_VELOCITY,
        MAX_VELOCITY,
      );
    animate(lead, leadTo, {
      ...(flick ? SPRING_MOMENTUM : SPRING_UI),
      duration: t(flick ? 0.4 : 0.3),
      velocity: velocityFor(lead),
    });
    const trailVelocity = velocityFor(trail);
    if (!withSquash || squash <= 0) {
      animate(trail, trailTo, {
        ...SPRING_UI,
        duration: t(0.3),
        velocity: trailVelocity,
      });
      return;
    }
    void animate(trail, trailTo + dir * squash, {
      ...SPRING_UI,
      duration: t(0.3),
      velocity: trailVelocity,
    }).then(() => {
      if (generation.current === g)
        animate(trail, trailTo, { ...SPRING_RELAX, duration: t(0.16) });
    });
  };

  const travel = (from: number, to: number) => {
    const a = slots.current[from];
    const b = slots.current[to];
    if (!a || !b) return;
    clearHandoff();
    generation.current += 1;
    if (reduce) {
      edgeL.jump(b.l);
      edgeR.jump(b.r);
      return;
    }
    const amount = stretch / 100;
    const tween = { duration: t(DILATE), ease: EASE_OUT };
    animate(edgeL, b.l + (Math.min(a.l, b.l) - b.l) * amount, tween);
    animate(edgeR, b.r + (Math.max(a.r, b.r) - b.r) * amount, tween);
    handoff.current = setTimeout(
      () => land(to, null, false, true),
      t(HANDOFF) * 1000,
    );
  };

  const localX = (event: { clientX: number }) =>
    event.clientX - (box.current ? box.current.left : 0) - inset;

  const handlePointerDown = (
    event: PointerEvent<HTMLButtonElement>,
    i: number,
  ) => {
    if (disabled || drag.current || event.button !== 0) return;
    box.current = trackRef.current?.getBoundingClientRect() ?? null;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is unavailable in some embedded browsers.
    }
    const x = localX(event);
    const onThumb = draggable && x >= edgeL.get() && x <= edgeR.get();
    drag.current = {
      id: event.pointerId,
      x0: x,
      slot: i,
      onThumb,
      live: false,
      offset: 0,
      w: 0,
      hist: [[event.timeStamp, x]],
    };
    if (onThumb) {
      clearHandoff();
      generation.current += 1;
      edgeL.stop();
      edgeR.stop();
    } else if (!reduce) {
      event.currentTarget.dataset["pressed"] = "";
    }
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || event.pointerId !== d.id || !d.onThumb) return;
    const x = localX(event);
    d.hist.push([event.timeStamp, x]);
    if (d.hist.length > 8) d.hist.shift();
    if (!d.live) {
      if (Math.abs(x - d.x0) < DEADZONE) return;
      d.live = true;
      d.offset = x - edgeL.get();
      d.w = edgeR.get() - edgeL.get();
      if (trackRef.current) trackRef.current.dataset["held"] = "";
    }
    const width = innerW.get();
    const l = x - d.offset;
    const maxL = width - d.w;
    if (reduce) {
      const c = clamp(l, 0, maxL);
      edgeL.set(c);
      edgeR.set(c + d.w);
    } else if (l < 0) {
      edgeL.set(0);
      edgeR.set(d.w - rubber(-l, d.w));
    } else if (l > maxL) {
      edgeR.set(width);
      edgeL.set(maxL + rubber(l - maxL, d.w));
    } else {
      edgeL.set(l);
      edgeR.set(l + d.w);
    }
  };

  const release = () => {
    const d = drag.current;
    drag.current = null;
    if (trackRef.current) delete trackRef.current.dataset["held"];
    if (d) {
      const el = itemRefs.current[d.slot];
      if (el) delete el.dataset["pressed"];
    }
    return d;
  };

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || event.pointerId !== d.id) return;
    release();
    const x = localX(event);
    if (!d.live) {
      if (Math.abs(x - d.x0) <= SLOP && d.slot !== committed.current) {
        const from = committed.current;
        commit(d.slot);
        travel(from, d.slot);
      }
      return;
    }
    const velocity = velocityOf(d.hist, event.timeStamp);
    const flick = Math.abs(velocity) > FLICK;
    let to = nearestSlot(
      slots.current,
      (edgeL.get() + edgeR.get()) / 2 + project(velocity, glide),
    );
    if (flick && to === committed.current)
      to = clamp(to + Math.sign(velocity), 0, list.length - 1);
    commit(to);
    if (reduce) jumpTo(to);
    else land(to, velocity, flick, flick);
  };

  const handlePointerCancel = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || event.pointerId !== d.id) return;
    release();
    if (!d.live) return;
    if (reduce) jumpTo(committed.current);
    else land(committed.current, null, false, false);
  };

  const select = (i: number) => {
    if (disabled || i === index) return;
    const from = committed.current;
    commit(i);
    travel(from, i);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    const last = list.length - 1;
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown")
      next = Math.min(last, index + 1);
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp")
      next = Math.max(0, index - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    if (next === null) return;
    event.preventDefault();
    if (next === index) return;
    commit(next);
    jumpTo(next);
    itemRefs.current[next]?.focus();
  };

  const preset = SIZES[size] ?? SIZES.md;
  const style = {
    "--rs-track": trackColor,
    "--rs-thumb": thumbColor,
    "--rs-ink": textColor,
    "--rs-ink-active": activeTextColor,
    "--rs-radius": `${radius}px`,
    "--rs-inset": `${inset}px`,
    "--rs-thumb-radius": `${thumbRadius}px`,
    "--rs-h": `${preset.height}px`,
    "--rs-font": `${preset.font}px`,
    "--rs-pad": `${preset.pad}px`,
    "--rs-min": `${preset.min}px`,
  } as CSSProperties;

  return (
    <div
      ref={trackRef}
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      data-equal={equalSlots ? "" : undefined}
      data-draggable={draggable && !disabled ? "" : undefined}
      className={`rubber-segment${className ? ` ${className}` : ""}`}
      style={style}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onLostPointerCapture={handlePointerCancel}
    >
      {list.map((item, i) => (
        <button
          key={item.value}
          ref={(el) => {
            itemRefs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={i === index}
          tabIndex={i === index ? 0 : -1}
          disabled={disabled}
          className="rubber-segment__item"
          onPointerDown={(event) => handlePointerDown(event, i)}
          onKeyDown={handleKeyDown}
          onClick={(event) => {
            if (event.detail === 0) select(i);
          }}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
      <motion.div
        className="rubber-segment__thumb"
        aria-hidden="true"
        style={{ clipPath }}
      >
        {list.map((item) => (
          <span
            key={item.value}
            className="rubber-segment__item rubber-segment__copy"
          >
            {item.icon}
            {item.label}
          </span>
        ))}
      </motion.div>
    </div>
  );
}
