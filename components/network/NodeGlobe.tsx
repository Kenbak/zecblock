'use client';

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ChartWatermark } from '@/components/ChartWatermark';
import type { NodeLocation } from '@/lib/node-map-locations';
import {
  clampGlobeZoom, createGlobeView, GLOBE_LAND_POINTS, latLonToVector,
  projectGlobeVector, rotateGlobeView, type GlobeVector,
} from '@/lib/node-globe';

interface NodeGlobeProps {
  locations: readonly NodeLocation[];
  selectedCountry: string | null;
  onHover: (location: NodeLocation | null) => void;
}

interface ScreenMarker {
  location: NodeLocation;
  x: number;
  y: number;
  radius: number;
}

const INITIAL_VIEW = { centerLon: 20, centerLat: 20, zoom: 1 };
const MOTION_QUERY = '(prefers-reduced-motion: reduce)';
function subscribeMotion(callback: () => void) {
  const query = window.matchMedia(MOTION_QUERY);
  query.addEventListener('change', callback);
  return () => query.removeEventListener('change', callback);
}
const getReducedMotion = () => window.matchMedia(MOTION_QUERY).matches;
const getServerMotion = () => true;

// The graticule uses the same projection and horizon clipping as the land.
const GRID_LINES: readonly GlobeVector[][] = [
  ...[-60, -30, 0, 30, 60].map(lat => Array.from({ length: 181 }, (_, i) => latLonToVector(lat, i * 2 - 180))),
  ...Array.from({ length: 12 }, (_, i) => Array.from({ length: 91 }, (_, j) => latLonToVector(j * 2 - 90, i * 30 - 180))),
];

function markerColor(count: number) {
  return count >= 10 ? '#F8BC21' : count >= 5 ? '#D49A20' : count >= 2 ? '#A07818' : '#7A6030';
}

/** A projected sphere drawn locally; no WebGL context or external map service. */
export function NodeGlobe({ locations, selectedCountry, onHover }: NodeGlobeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const requestDraw = useRef(() => {});
  const scene = useRef({ ...INITIAL_VIEW, rotating: false, hovering: false, focused: false });
  const currentHover = useRef<NodeLocation | null>(null);
  const data = useRef({ locations, selectedCountry, onHover });
  const [rotationMode, setRotationMode] = useState<'auto' | 'on' | 'off'>('auto');
  const [zoom, setZoom] = useState(1);
  const reducedMotion = useSyncExternalStore(subscribeMotion, getReducedMotion, getServerMotion);
  const rotating = rotationMode === 'on' || (rotationMode === 'auto' && !reducedMotion);
  const markers = useMemo(() => [...locations]
    .sort((a, b) => b.nodeCount - a.nodeCount)
    .map(location => ({ location, vector: latLonToVector(location.lat, location.lon) })), [locations]);
  const markerData = useRef(markers);

  useEffect(() => {
    data.current = { locations, selectedCountry, onHover };
    markerData.current = markers;
    currentHover.current = null;
    onHover(null);
    requestDraw.current();
  }, [locations, selectedCountry, onHover, markers]);

  useEffect(() => {
    scene.current.rotating = rotating;
    requestDraw.current();
  }, [rotating]);

  useEffect(() => {
    if (!selectedCountry) return;
    // Recenter on the largest group, avoiding an invented country centroid.
    const largest = markers.find(marker => marker.location.countryCode === selectedCountry);
    if (largest) {
      Object.assign(scene.current, rotateGlobeView(largest.location.lon, largest.location.lat, 0, 0));
      requestDraw.current();
    }
  }, [selectedCountry, markers]);

  function changeZoom(value: number) {
    scene.current.zoom = clampGlobeZoom(value);
    setZoom(scene.current.zoom);
    requestDraw.current();
  }

  function resetView() {
    Object.assign(scene.current, INITIAL_VIEW);
    const selected = markerData.current.find(marker => marker.location.countryCode === data.current.selectedCountry);
    if (selected) Object.assign(scene.current, rotateGlobeView(selected.location.lon, selected.location.lat, 0, 0));
    setZoom(1);
    currentHover.current = null;
    data.current.onHover(null);
    requestDraw.current();
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    let width = 1;
    let height = 1;
    let frame = 0;
    let lastTime = 0;
    let dirty = true;
    let visible = true;
    let screenMarkers: ScreenMarker[] = [];
    const pointers = new Map<number, { x: number; y: number }>();
    let moved = false;
    let dragDistance = 0;
    let colors = { land: '', grid: '', ocean: '', rim: '' };

    function readColors() {
      const style = getComputedStyle(canvas!);
      colors = {
        land: style.getPropertyValue('--color-globe-land').trim() || '#8D8F8B',
        grid: style.getPropertyValue('--color-globe-grid').trim() || '#373734',
        ocean: style.getPropertyValue('--color-globe-ocean').trim() || '#0D0E0F',
        rim: style.getPropertyValue('--color-globe-rim').trim() || '#A9A69E',
      };
      invalidate();
    }

    function setHover(location: NodeLocation | null) {
      if (currentHover.current === location) return;
      currentHover.current = location;
      data.current.onHover(location);
      invalidate();
    }

    function hitTest(x: number, y: number) {
      for (let i = screenMarkers.length - 1; i >= 0; i--) {
        const marker = screenMarkers[i];
        if (data.current.selectedCountry && marker.location.countryCode !== data.current.selectedCountry) continue;
        if (Math.hypot(x - marker.x, y - marker.y) <= marker.radius + 5) return marker.location;
      }
      return null;
    }

    function geometry() {
      return { centerX: width / 2, centerY: (height - 44) / 2,
        radius: Math.max(1, Math.min(width * 0.43, (height - 70) * 0.48)) * scene.current.zoom };
    }

    function onSphere(point: { x: number; y: number }) {
      const { centerX, centerY, radius } = geometry();
      return Math.hypot(point.x - centerX, point.y - centerY) <= radius;
    }

    function draw() {
      const ctx = context!;
      ctx.clearRect(0, 0, width, height);
      const { centerX, centerY, radius } = geometry();
      const view = createGlobeView(scene.current.centerLon, scene.current.centerLat);
      canvas!.dataset.longitude = scene.current.centerLon.toFixed(2);
      canvas!.dataset.latitude = scene.current.centerLat.toFixed(2);

      ctx.beginPath();
      ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
      ctx.fillStyle = colors.ocean;
      ctx.fill();
      ctx.strokeStyle = colors.rim;
      ctx.globalAlpha = 0.3;
      ctx.lineWidth = 1;
      ctx.setLineDash([1, 5]);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.strokeStyle = colors.grid;
      ctx.globalAlpha = 0.3;
      ctx.lineWidth = 0.6;
      ctx.setLineDash([1, 4]);
      for (const line of GRID_LINES) {
        ctx.beginPath();
        let connected = false;
        for (const vector of line) {
          const p = projectGlobeVector(vector, view);
          if (p.depth <= 0) { connected = false; continue; }
          const x = centerX + p.x * radius;
          const y = centerY + p.y * radius;
          if (connected) ctx.lineTo(x, y); else ctx.moveTo(x, y);
          connected = true;
        }
        ctx.stroke();
      }
      ctx.setLineDash([]);

      ctx.fillStyle = colors.land;
      for (const vector of GLOBE_LAND_POINTS) {
        const p = projectGlobeVector(vector, view);
        if (p.depth <= 0) continue;
        const x = centerX + p.x * radius;
        const y = centerY + p.y * radius;
        if (x < -5 || x > width + 5 || y < -5 || y > height + 5) continue;
        ctx.globalAlpha = 0.7 + p.depth * 0.3;
        ctx.beginPath();
        ctx.arc(x, y, 1.15 * Math.sqrt(scene.current.zoom), 0, Math.PI * 2);
        ctx.fill();
      }

      screenMarkers = [];
      for (const { location, vector } of markerData.current) {
        const p = projectGlobeVector(vector, view);
        if (p.depth <= 0.04) continue;
        const x = centerX + p.x * radius;
        const y = centerY + p.y * radius;
        const r = Math.max(8, Math.min(17, 6 + Math.sqrt(location.nodeCount) * 2));
        if (x < -r || x > width + r || y < -r || y > height + r) continue;
        const dimmed = data.current.selectedCountry != null && data.current.selectedCountry !== location.countryCode;
        const hovered = currentHover.current === location;
        ctx.globalAlpha = (dimmed ? 0.12 : 0.95) * Math.min(1, p.depth * 5);
        ctx.fillStyle = markerColor(location.nodeCount);
        ctx.shadowColor = ctx.fillStyle;
        ctx.shadowBlur = !dimmed && location.nodeCount >= 10 ? 12 : 0;
        ctx.beginPath();
        ctx.arc(x, y, r + (hovered ? 2 : 0), 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.lineWidth = hovered ? 2 : 0.5;
        ctx.strokeStyle = hovered ? '#ffffff' : 'rgba(255,255,255,0.2)';
        ctx.stroke();
        ctx.fillStyle = '#08090F';
        ctx.font = '600 11px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(location.nodeCount), x, y + 0.5);
        screenMarkers.push({ location, x, y, radius: r });
      }
      ctx.globalAlpha = 1;
    }

    function shouldRotate() {
      return scene.current.rotating && !scene.current.hovering && !scene.current.focused &&
        pointers.size === 0 && visible && !document.hidden;
    }

    function render(time: number) {
      frame = 0;
      const elapsed = Math.min(0.05, (time - lastTime) / 1000);
      if (dirty || time - lastTime >= 32) {
        if (shouldRotate()) Object.assign(scene.current, rotateGlobeView(scene.current.centerLon, scene.current.centerLat, elapsed * 6, 0));
        lastTime = time;
        dirty = false;
        draw();
      }
      if (shouldRotate()) frame = requestAnimationFrame(render);
    }

    function invalidate() {
      dirty = true;
      if (!frame && visible && !document.hidden) frame = requestAnimationFrame(render);
    }
    requestDraw.current = invalidate;

    function resize() {
      const rect = canvas!.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas!.width = Math.round(width * ratio);
      canvas!.height = Math.round(height * ratio);
      context!.setTransform(ratio, 0, 0, ratio, 0, 0);
      invalidate();
    }

    function localPoint(event: MouseEvent) {
      const rect = canvas!.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    }
    function pointerDown(event: PointerEvent) {
      const point = localPoint(event);
      if (event.button !== 0 || !onSphere(point)) return;
      event.preventDefault();
      pointers.set(event.pointerId, point);
      if (pointers.size === 1) { moved = false; dragDistance = 0; }
      canvas!.setPointerCapture(event.pointerId);
      setHover(null);
      canvas!.style.cursor = 'grabbing';
    }
    function pointerMove(event: PointerEvent) {
      const point = localPoint(event);
      const previous = pointers.get(event.pointerId);
      if (previous) {
        const before = [...pointers.values()];
        pointers.set(event.pointerId, point);
        dragDistance += Math.hypot(point.x - previous.x, point.y - previous.y);
        moved ||= dragDistance > 4;
        if (pointers.size === 2) {
          const after = [...pointers.values()];
          const oldDistance = Math.hypot(before[0].x - before[1].x, before[0].y - before[1].y);
          const distance = Math.hypot(after[0].x - after[1].x, after[0].y - after[1].y);
          if (oldDistance > 0) {
            scene.current.zoom = clampGlobeZoom(scene.current.zoom * distance / oldDistance);
            setZoom(scene.current.zoom);
          }
        } else if (pointers.size === 1) {
          const sensitivity = 0.35 / scene.current.zoom;
          Object.assign(scene.current, rotateGlobeView(scene.current.centerLon, scene.current.centerLat,
            (previous.x - point.x) * sensitivity, (point.y - previous.y) * sensitivity));
        }
        invalidate();
      } else {
        const wasHovering = scene.current.hovering;
        scene.current.hovering = event.pointerType === 'mouse' && onSphere(point);
        if (wasHovering !== scene.current.hovering) invalidate();
        const location = hitTest(point.x, point.y);
        setHover(location);
        canvas!.style.cursor = location ? 'pointer' : onSphere(point) ? 'grab' : 'default';
      }
    }
    function pointerUp(event: PointerEvent) {
      pointers.delete(event.pointerId);
      if (canvas!.hasPointerCapture(event.pointerId)) canvas!.releasePointerCapture(event.pointerId);
      if (!moved && event.type === 'pointerup') {
        const point = localPoint(event);
        setHover(hitTest(point.x, point.y));
      }
      const inside = onSphere(localPoint(event));
      if (event.pointerType === 'mouse') scene.current.hovering = inside;
      canvas!.style.cursor = inside ? 'grab' : 'default';
      invalidate();
    }
    function pointerEnter(event: PointerEvent) {
      if (event.pointerType === 'mouse') scene.current.hovering = onSphere(localPoint(event));
      invalidate();
    }
    function pointerLeave(event: PointerEvent) {
      scene.current.hovering = false;
      // Touch has no hover: preserve a tapped marker until the next interaction.
      if (event.pointerType === 'mouse' && !pointers.size) setHover(null);
      invalidate();
    }
    function wheel(event: WheelEvent) {
      // Zoom the sphere; scrolling beside it still scrolls the page.
      if (!onSphere(localPoint(event))) return;
      event.preventDefault();
      scene.current.zoom = clampGlobeZoom(scene.current.zoom * Math.exp(-event.deltaY * 0.002));
      setZoom(scene.current.zoom);
      setHover(null);
      invalidate();
    }
    function keyDown(event: KeyboardEvent) {
      const deltas: Record<string, [number, number]> = {
        ArrowLeft: [-12, 0], ArrowRight: [12, 0], ArrowUp: [0, 12], ArrowDown: [0, -12],
      };
      if (event.key in deltas) {
        const [lon, lat] = deltas[event.key];
        Object.assign(scene.current, rotateGlobeView(scene.current.centerLon, scene.current.centerLat, lon, lat));
        setRotationMode('off');
      } else if (['+', '=', '-', '_'].includes(event.key)) {
        scene.current.zoom = clampGlobeZoom(scene.current.zoom * (['+', '='].includes(event.key) ? 1.2 : 1 / 1.2));
        setZoom(scene.current.zoom);
      } else if (event.key === 'Home' || event.key === '0') {
        Object.assign(scene.current, INITIAL_VIEW);
        const selected = markerData.current.find(marker => marker.location.countryCode === data.current.selectedCountry);
        if (selected) Object.assign(scene.current, rotateGlobeView(selected.location.lon, selected.location.lat, 0, 0));
        setZoom(1);
      } else return;
      event.preventDefault();
      setHover(null);
      invalidate();
    }
    function focus() { scene.current.focused = true; }
    function blur() { scene.current.focused = false; invalidate(); }

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);
    const intersectionObserver = new IntersectionObserver(entries => {
      visible = entries[0].isIntersecting;
      if (visible) invalidate();
    });
    intersectionObserver.observe(canvas);
    const themeObserver = new MutationObserver(readColors);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    const listeners = { pointerdown: pointerDown, pointermove: pointerMove, pointerup: pointerUp,
      pointercancel: pointerUp, lostpointercapture: pointerUp, pointerenter: pointerEnter, pointerleave: pointerLeave,
      keydown: keyDown, focus, blur };
    for (const [name, handler] of Object.entries(listeners)) canvas.addEventListener(name, handler as EventListener);
    canvas.addEventListener('wheel', wheel, { passive: false });
    document.addEventListener('visibilitychange', invalidate);
    readColors();
    resize();
    return () => {
      cancelAnimationFrame(frame);
      requestDraw.current = () => {};
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      themeObserver.disconnect();
      for (const [name, handler] of Object.entries(listeners)) canvas.removeEventListener(name, handler as EventListener);
      canvas.removeEventListener('wheel', wheel);
      document.removeEventListener('visibilitychange', invalidate);
    };
  }, []);

  const controlClass = 'flex h-10 w-10 items-center justify-center rounded-sm text-secondary hover:text-cipher-gold hover:bg-cipher-hover disabled:opacity-30 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-cipher-gold transition-colors';
  const iconClass = 'h-4 w-4';
  return (
    <div className="relative">
        <canvas ref={canvasRef} tabIndex={0} role="img"
          aria-label="Interactive globe of observed Zcash node IPs. Drag or use arrow keys to rotate; pinch or use plus and minus keys to zoom. Home resets the view. Top country totals are listed below."
          className="block w-full h-[400px] sm:h-[520px] focus-visible:outline-2 focus-visible:outline-cipher-gold focus-visible:-outline-offset-2"
          style={{ touchAction: 'none' }} data-node-globe="true" data-zoom={zoom.toFixed(2)}>
          Observed node IPs grouped by approximate geographic location. Top country totals follow the globe.
        </canvas>
        <div className="absolute top-3 left-4 pointer-events-none"><ChartWatermark /></div>
        <div className="absolute bottom-3 left-3 grid grid-cols-2 gap-x-3 gap-y-1.5 sm:flex sm:gap-3 rounded-md border border-cipher-border bg-cipher-surface-solid/90 backdrop-blur-sm px-3 py-2.5 text-caption font-mono text-muted pointer-events-none"
          aria-label="Observed IPs per geographic group">
          {[[10, '10+'], [5, '5–9'], [2, '2–4'], [1, '1']].map(([count, label]) => (
            <span key={label} className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: markerColor(Number(count)) }} />
              {label}
            </span>
          ))}
        </div>
        <div className="absolute bottom-3 right-3 flex items-center gap-0.5 rounded-md border border-cipher-border bg-cipher-surface-solid/90 backdrop-blur-sm p-1"
          role="group" aria-label="Globe controls">
          <button type="button" className={controlClass} onClick={() => setRotationMode(rotating ? 'off' : 'on')}
            title={rotating ? 'Pause rotation' : 'Play rotation'}
            aria-label={rotating ? 'Pause globe rotation' : 'Start globe rotation'} aria-pressed={rotating}>
            <svg className={iconClass} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              {rotating ? <><rect x="5" y="3.5" width="3" height="13" rx="0.75" /><rect x="12" y="3.5" width="3" height="13" rx="0.75" /></>
                : <path d="M6 3.75a.75.75 0 0 1 1.15-.64l9 5.5a.75.75 0 0 1 0 1.28l-9 5.5A.75.75 0 0 1 6 14.75z" />}
            </svg>
          </button>
          <button type="button" className={controlClass} aria-label="Zoom out" title="Zoom out" disabled={zoom <= 1}
            onClick={() => changeZoom(scene.current.zoom / 1.25)}>
            <svg className={iconClass} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true"><path d="M4 10h12" /></svg>
          </button>
          <button type="button" className={controlClass} aria-label="Zoom in" title="Zoom in" disabled={zoom >= 3}
            onClick={() => changeZoom(scene.current.zoom * 1.25)}>
            <svg className={iconClass} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true"><path d="M4 10h12M10 4v12" /></svg>
          </button>
          <button type="button" className={controlClass} onClick={resetView} aria-label="Reset globe view" title="Reset view">
            <svg className={iconClass} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4.1 7a6.5 6.5 0 1 1-.3 5M4 3v4h4" /></svg>
          </button>
        </div>
    </div>
  );
}
