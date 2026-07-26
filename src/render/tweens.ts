export type Easing = (t: number) => number;

export const easeOutCubic: Easing = (t) => 1 - (1 - t) ** 3;
export const easeOutBack: Easing = (t) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
};
export const easeInOutQuad: Easing = (t) =>
  t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
export const easeOutElastic: Easing = (t) => {
  if (t === 0 || t === 1) return t;
  const c4 = (2 * Math.PI) / 3;
  return 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
};

export interface Point {
  x: number;
  y: number;
}

/**
 * Quadratic bezier with the control point lifted perpendicular to the travel
 * direction — jewels arc over the board rather than sliding through it, which
 * is most of why the movement reads as physical.
 */
export function arc(from: Point, to: Point, t: number, lift = 0.28): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  const cx = (from.x + to.x) / 2 - (dy / (dist || 1)) * dist * lift;
  const cy = (from.y + to.y) / 2 + (dx / (dist || 1)) * dist * lift;
  const u = 1 - t;
  return {
    x: u * u * from.x + 2 * u * t * cx + t * t * to.x,
    y: u * u * from.y + 2 * u * t * cy + t * t * to.y,
  };
}

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Progress of a staggered item that starts `delay` ms after the batch began. */
export function stagger(now: number, start: number, delay: number, duration: number): number {
  return clamp01((now - start - delay) / duration);
}
