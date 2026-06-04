import { type CSSProperties, type ReactNode, useEffect, useRef } from "react";
import "./PixelCard.css";

type PixelCardProps = {
  variant?: "default" | "blue" | "yellow" | "pink" | "signalDark";
  gap?: number;
  speed?: number;
  colors?: string;
  noFocus?: boolean;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
  active?: boolean;
  audioLevel?: number;
};

type VariantConfig = {
  gap: number;
  speed: number;
  colors: string;
  noFocus: boolean;
};

const VARIANTS: Record<string, VariantConfig> = {
  default: {
    gap: 5,
    speed: 35,
    colors: "#0c0a09,#292524,#57534e",
    noFocus: false
  },
  blue: {
    gap: 10,
    speed: 25,
    colors: "#0c0a09,#292524,#57534e",
    noFocus: false
  },
  yellow: {
    gap: 3,
    speed: 20,
    colors: "#0c0a09,#292524,#57534e",
    noFocus: false
  },
  pink: {
    gap: 6,
    speed: 80,
    colors: "#0c0a09,#292524,#57534e",
    noFocus: true
  },
  signalDark: {
    gap: 5,
    speed: 42,
    colors: "#ffffff,#d6d3d1,#a8a29e",
    noFocus: true
  }
};

class Pixel {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly x: number;
  private readonly y: number;
  private readonly color: string;
  private readonly speed: number;
  private readonly distance: number;
  private readonly maxSize: number;
  private readonly maxSizeInteger = 2.4;
  private readonly phase = Math.random() * Math.PI * 2;
  private size = 0;

  constructor(context: CanvasRenderingContext2D, x: number, y: number, color: string, speed: number, distance: number) {
    this.ctx = context;
    this.x = x;
    this.y = y;
    this.color = color;
    this.speed = this.random(0.1, 0.9) * speed;
    this.distance = distance;
    this.maxSize = this.random(0.5, this.maxSizeInteger);
  }

  private random(min: number, max: number) {
    return Math.random() * (max - min) + min;
  }

  draw() {
    if (this.size <= 0.04) return;
    const centerOffset = this.maxSizeInteger * 0.5 - this.size * 0.5;
    this.ctx.fillStyle = this.color;
    this.ctx.fillRect(this.x + centerOffset, this.y + centerOffset, this.size, this.size);
  }

  step(revealRadius: number, audioEnergy: number, time: number, reducedMotion: boolean) {
    const insideWave = Math.sin(time * (2.3 + audioEnergy * 5) + this.distance * 0.035 + this.phase);
    const revealSoftness = 90 + audioEnergy * 155;
    const distanceDelta = revealRadius - this.distance;
    const reveal = Math.max(0, Math.min(1, (distanceDelta + revealSoftness) / revealSoftness));
    const shimmer = reducedMotion ? 0 : insideWave * (0.16 + audioEnergy * 0.32);
    const targetSize = reveal > 0
      ? this.maxSize * reveal * (0.82 + audioEnergy * 1.95 + shimmer)
      : 0;
    const rate = reducedMotion ? 0.18 : Math.max(0.06, this.speed * (1 + audioEnergy * 5.5));
    this.size += (targetSize - this.size) * rate;
    this.draw();
  }
}

function getEffectiveSpeed(value: number, reducedMotion: boolean) {
  const min = 0;
  const max = 100;
  const throttle = 0.001;
  if (value <= min || reducedMotion) return min;
  if (value >= max) return max * throttle;
  return value * throttle;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

export default function PixelCard({
  variant = "default",
  gap,
  speed,
  colors,
  noFocus,
  className = "",
  style,
  children,
  active = false,
  audioLevel = 0
}: PixelCardProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pixelsRef = useRef<Pixel[]>([]);
  const maxDistanceRef = useRef(1);
  const dimsRef = useRef({ w: 1, h: 1 });
  const animationRef = useRef(0);
  const timePreviousRef = useRef(performance.now());
  const startTimeRef = useRef(performance.now());
  const activeRef = useRef(active);
  const audioLevelRef = useRef(audioLevel);
  const smoothedEnergyRef = useRef(0);
  const hoverActiveRef = useRef(false);
  const reducedMotion = useRef(window.matchMedia("(prefers-reduced-motion: reduce)").matches).current;

  const variantConfig = VARIANTS[variant] || VARIANTS.default;
  const finalGap = gap ?? variantConfig.gap;
  const finalSpeed = speed ?? variantConfig.speed;
  const finalColors = colors ?? variantConfig.colors;
  const finalNoFocus = noFocus ?? variantConfig.noFocus;

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    audioLevelRef.current = audioLevel;
  }, [audioLevel]);

  useEffect(() => {
    const initPixels = () => {
      if (!containerRef.current || !canvasRef.current) return;
      // Use the stable LAYOUT box (clientWidth/Height), not getBoundingClientRect:
      // the card lives inside the app's `zoom: 0.75` shell, and getBoundingClientRect
      // returns zoom-scaled (and Chrome-version-dependent) values, which made the
      // canvas smaller than its container on some browsers (texture looked cropped).
      const width = Math.max(1, Math.floor(containerRef.current.clientWidth));
      const height = Math.max(1, Math.floor(containerRef.current.clientHeight));
      const context = canvasRef.current.getContext("2d");
      if (!context) return;

      const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
      canvasRef.current.width = Math.floor(width * dpr);
      canvasRef.current.height = Math.floor(height * dpr);
      // Never pin a pixel size — let CSS (.pixel-canvas { width/height: 100% }) fill
      // the container so the texture always covers its box regardless of zoom/DPR.
      canvasRef.current.style.removeProperty("width");
      canvasRef.current.style.removeProperty("height");
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      dimsRef.current = { w: width, h: height };

      const centerX = width * 0.34;
      const centerY = height * 0.52;
      maxDistanceRef.current = Math.sqrt(Math.max(centerX, width - centerX) ** 2 + Math.max(centerY, height - centerY) ** 2);

      const colorArray = finalColors.split(",").map((color) => color.trim()).filter(Boolean);
      const pixels: Pixel[] = [];
      for (let x = 0; x < width; x += finalGap) {
        for (let y = 0; y < height; y += finalGap) {
          const color = colorArray[Math.floor(Math.random() * colorArray.length)] || "#0c0a09";
          const dx = x - centerX;
          const dy = y - centerY;
          const distance = Math.sqrt(dx * dx + dy * dy);
          pixels.push(new Pixel(context, x, y, color, getEffectiveSpeed(finalSpeed, reducedMotion), distance));
        }
      }
      pixelsRef.current = pixels;
    };

    const animate = () => {
      animationRef.current = requestAnimationFrame(animate);
      const timeNow = performance.now();
      const timePassed = timeNow - timePreviousRef.current;
      const timeInterval = 1000 / 60;
      if (timePassed < timeInterval) return;
      timePreviousRef.current = timeNow - (timePassed % timeInterval);

      const canvas = canvasRef.current;
      const context = canvas?.getContext("2d");
      if (!canvas || !context) return;

      context.clearRect(0, 0, dimsRef.current.w, dimsRef.current.h);
      const rawEnergy = clamp01(audioLevelRef.current / 100);
      const voicedEnergy = Math.pow(rawEnergy, 0.68);
      const targetEnergy = activeRef.current || hoverActiveRef.current ? Math.max(voicedEnergy, hoverActiveRef.current ? 0.3 : 0.055) : 0;
      const smoothing = targetEnergy > smoothedEnergyRef.current ? 0.44 : 0.14;
      smoothedEnergyRef.current += (targetEnergy - smoothedEnergyRef.current) * smoothing;
      const energy = smoothedEnergyRef.current;
      const revealRadius = maxDistanceRef.current * Math.min(1.12, energy * 1.34);
      const time = (timeNow - startTimeRef.current) * 0.001;

      for (const pixel of pixelsRef.current) {
        pixel.step(revealRadius, energy, time, reducedMotion);
      }
    };

    initPixels();
    const observer = new ResizeObserver(initPixels);
    if (containerRef.current) observer.observe(containerRef.current);
    animationRef.current = requestAnimationFrame(animate);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(animationRef.current);
    };
  }, [finalColors, finalGap, finalSpeed, reducedMotion]);

  const handleEnter = () => {
    hoverActiveRef.current = true;
  };
  const handleLeave = () => {
    hoverActiveRef.current = false;
  };
  const handleFocus = () => {
    if (!finalNoFocus) hoverActiveRef.current = true;
  };
  const handleBlur = () => {
    if (!finalNoFocus) hoverActiveRef.current = false;
  };

  return (
    <div
      ref={containerRef}
      className={`pixel-card ${className}`.trim()}
      style={style}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      onFocus={handleFocus}
      onBlur={handleBlur}
      tabIndex={finalNoFocus ? -1 : 0}
    >
      <canvas className="pixel-canvas" ref={canvasRef} />
      {children}
    </div>
  );
}
