import { useEffect, useRef } from "react";
import type { CSSProperties, ReactNode } from "react";
import "./BorderGlow.css";

type BorderGlowProps = {
  children: ReactNode;
  className?: string;
  as?: "div" | "section";
  active?: boolean;
  glowColor?: string;
  backgroundColor?: string;
  borderRadius?: number;
  glowRadius?: number;
  glowIntensity?: number;
  coneSpread?: number;
  animated?: boolean;
  colors?: string[];
  fillOpacity?: number;
};

function parseHSL(hslStr: string) {
  const match = hslStr.match(/([\d.]+)\s*([\d.]+)%?\s*([\d.]+)%?/);
  if (!match) return { h: 40, s: 80, l: 80 };
  return { h: Number.parseFloat(match[1]), s: Number.parseFloat(match[2]), l: Number.parseFloat(match[3]) };
}

function buildGlowVars(glowColor: string, intensity: number) {
  const { h, s, l } = parseHSL(glowColor);
  const base = `${h}deg ${s}% ${l}%`;
  const opacities = [100, 60, 50, 40, 30, 20, 10];
  const keys = ["", "-60", "-50", "-40", "-30", "-20", "-10"];
  const vars: Record<string, string> = {};
  for (let index = 0; index < opacities.length; index += 1) {
    vars[`--glow-color${keys[index]}`] = `hsl(${base} / ${Math.min(opacities[index] * intensity, 100)}%)`;
  }
  return vars;
}

const GRADIENT_POSITIONS = ["80% 55%", "69% 34%", "8% 6%", "41% 38%", "86% 85%", "82% 18%", "51% 4%"];
const GRADIENT_KEYS = ["--gradient-one", "--gradient-two", "--gradient-three", "--gradient-four", "--gradient-five", "--gradient-six", "--gradient-seven"];
const COLOR_MAP = [0, 1, 2, 0, 1, 2, 1];

function buildGradientVars(colors: string[]) {
  const safeColors = colors.length ? colors : ["#c084fc", "#f472b6", "#38bdf8"];
  const vars: Record<string, string> = {};
  for (let index = 0; index < GRADIENT_KEYS.length; index += 1) {
    const color = safeColors[Math.min(COLOR_MAP[index], safeColors.length - 1)];
    vars[GRADIENT_KEYS[index]] = `radial-gradient(at ${GRADIENT_POSITIONS[index]}, ${color} 0px, transparent 50%)`;
  }
  vars["--glow-stop-one"] = safeColors[0];
  vars["--glow-stop-two"] = safeColors[Math.min(1, safeColors.length - 1)];
  vars["--glow-stop-three"] = safeColors[Math.min(2, safeColors.length - 1)];
  vars["--gradient-base"] = `linear-gradient(${safeColors[0]} 0 100%)`;
  return vars;
}

function easeInOutCubic(x: number) {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

function animateSweep(card: HTMLElement) {
  const startedAt = performance.now();
  const duration = 1800;
  card.classList.add("sweep-active");
  function tick(now: number) {
    const progress = Math.min((now - startedAt) / duration, 1);
    const eased = easeInOutCubic(progress);
    card.style.setProperty("--edge-proximity", `${70 + eased * 30}`);
    card.style.setProperty("--cursor-angle", `${110 + eased * 360}deg`);
    if (progress < 1) {
      requestAnimationFrame(tick);
      return;
    }
    card.style.removeProperty("--edge-proximity");
    card.style.removeProperty("--cursor-angle");
    card.classList.remove("sweep-active");
  }
  requestAnimationFrame(tick);
}

export default function BorderGlow({
  children,
  className = "",
  as = "div",
  active = false,
  glowColor = "40 80 80",
  backgroundColor = "#120F17",
  borderRadius = 28,
  glowRadius = 40,
  glowIntensity = 1,
  coneSpread = 25,
  animated = false,
  colors = ["#c084fc", "#f472b6", "#38bdf8"],
  fillOpacity = 0
}: BorderGlowProps) {
  const cardRef = useRef<HTMLElement | null>(null);
  const Component = as;

  useEffect(() => {
    if (!active || !animated || !cardRef.current) return;
    animateSweep(cardRef.current);
  }, [active, animated]);

  const style = {
    "--card-bg": backgroundColor,
    "--border-radius": `${borderRadius}px`,
    "--glow-padding": `${glowRadius}px`,
    "--cone-spread": coneSpread,
    "--fill-opacity": fillOpacity,
    ...buildGlowVars(glowColor, glowIntensity),
    ...buildGradientVars(colors)
  } as CSSProperties;

  return (
    <Component
      ref={cardRef as never}
      className={`border-glow-card ${active ? "is-active" : ""} ${className}`}
      style={style}
    >
      <span className="edge-light" aria-hidden="true" />
      <div className="border-glow-inner">{children}</div>
    </Component>
  );
}
