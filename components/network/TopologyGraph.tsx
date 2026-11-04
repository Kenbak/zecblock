'use client';

import { ChartWatermark } from '@/components/ChartWatermark';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, Instances, Instance } from '@react-three/drei';
import * as THREE from 'three';
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceX,
  forceY,
  forceZ,
  type Simulation,
  type SimulationNode,
} from 'd3-force-3d';
import { useTheme } from '@/contexts/ThemeContext';
import { useApiQuery } from '@/hooks/useApiQuery';
import { clientColor as sharedClientColor, clientLabel as sharedClientLabel, CLIENT_COLORS } from '@/lib/network-colors';

interface ApiNode {
  id: number;
  client: string | null;
  reachable: boolean;
  isTor: boolean;
  countryCode: string | null;
  betweenness: number | null;
  closeness: number | null;
  degree: number | null;
}

interface ApiEdge {
  source: number;
  target: number;
}

interface TopologyResponse {
  topologyAvailable?: boolean;
  gossipProvenance?: string | null;
  observedAt?: string | null;
  expiresAt?: string | null;
  truncated?: boolean;
  nodes: ApiNode[];
  edges: ApiEdge[];
  counts?: { total: number; reachable: number; off: number; edges: number };
}

export const MAX_LAYOUT_NODES = 600;
export const MAX_LAYOUT_EDGES = 2000;
const LAYOUT_TICKS = 120;
const GOSSIP_PROVENANCE = 'zcash-mainnet-qualified-addr-v1';
const MIN_EXPIRY_REFRESH_MS = 30_000;

function subscribeVisibility(callback: () => void) {
  document.addEventListener('visibilitychange', callback);
  return () => document.removeEventListener('visibilitychange', callback);
}
const getPageVisible = () => document.visibilityState !== 'hidden';
const getServerVisible = () => false;

/** New gossip observations must expire even if a refresh fails or is paused. */
export function topologyIsFresh(data: TopologyResponse | null, now: number): boolean {
  if (!data || data.topologyAvailable === false) return false;
  // Peer-mode legacy responses have no qualified-gossip capability contract.
  if (!Object.hasOwn(data, 'gossipProvenance')) return true;
  const expiresAt = typeof data.expiresAt === 'string' ? Date.parse(data.expiresAt) : NaN;
  return data.topologyAvailable === true && data.gossipProvenance === GOSSIP_PROVENANCE
    && Number.isFinite(expiresAt) && expiresAt > now;
}

/** Keep the layout bounded; full API counts are reported separately below. */
export function selectTopologyLayout(data: TopologyResponse) {
  const unique = new Map<number, ApiNode>();
  for (const node of Array.isArray(data.nodes) ? data.nodes : []) {
    if (node && Number.isSafeInteger(node.id) && node.id >= 0 && !unique.has(node.id)) unique.set(node.id, node);
  }
  const nodes = [...unique.values()].sort((a, b) => Number(b.reachable) - Number(a.reachable)
    || (b.degree || 0) - (a.degree || 0) || a.id - b.id).slice(0, MAX_LAYOUT_NODES);
  const ids = new Set(nodes.map(node => node.id));
  const edges: ApiEdge[] = [];
  for (const edge of Array.isArray(data.edges) ? data.edges : []) {
    if (edge && ids.has(edge.source) && ids.has(edge.target) && edge.source !== edge.target) {
      edges.push({ source: edge.source, target: edge.target });
      if (edges.length === MAX_LAYOUT_EDGES) break;
    }
  }
  return { nodes, edges, subset: nodes.length < unique.size || edges.length < (data.edges?.length || 0) };
}

interface SimNode extends SimulationNode {
  id: number;
  client: string | null;
  reachable: boolean;
  isTor: boolean;
  countryCode: string | null;
  betweenness: number | null;
  closeness: number | null;
  degree: number | null;
}

interface PositionedNode extends SimNode {
  x: number;
  y: number;
  z: number;
  radius: number;
  color: string;
}

const EMPTY_NODES: PositionedNode[] = [];
const EMPTY_PAIRS: [number, number][] = [];

const TOR_COLOR = '#B6A0E0';
// Advertised addresses have no independent active-source observation here.
const OFF_COLOR = '#6B7FA0';

function nodeColor(n: { client: string | null; isTor: boolean; reachable: boolean }) {
  if (!n.reachable) return OFF_COLOR;
  if (n.isTor) return TOR_COLOR;
  return sharedClientColor(n.client);
}

function clientLabel(client: string | null, reachable = true) {
  if (!reachable) return 'Advertised only';
  return sharedClientLabel(client);
}

function nodeCategory(n: { client: string | null; isTor: boolean; reachable: boolean }): string {
  if (!n.reachable) return 'off';
  if (n.isTor) return 'Tor';
  const c = n.client || 'Unknown';
  if (c === 'Unknown') return 'Unidentified';
  return c in CLIENT_COLORS ? c : 'Other';
}

function Scene({
  nodes,
  edgePairs,
  focus,
  pinned,
  hidden,
  onHover,
  onPin,
  palette,
  rotating,
  resetKey,
}: {
  nodes: PositionedNode[];
  edgePairs: [number, number][];
  focus: PositionedNode | null;
  pinned: PositionedNode | null;
  hidden: Set<string>;
  palette: { edge: string; selected: string; tor: string; off: string };
  rotating: boolean;
  resetKey: number;
  onHover: (n: PositionedNode | null) => void;
  onPin: (n: PositionedNode | null) => void;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const { camera, controls, invalidate, size } = useThree() as unknown as {
    camera: THREE.PerspectiveCamera;
    invalidate: () => void;
    size: { width: number; height: number };
    controls: { target: THREE.Vector3; update: () => void } | null;
  };

  const flyRef = useRef<{ pos: THREE.Vector3; dir: THREE.Vector3; active: boolean } | null>(null);

  const posById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  const isVisible = useCallback((n: PositionedNode) => !hidden.has(nodeCategory(n)), [hidden]);

  const visibleNodes = useMemo(() => nodes.filter(isVisible), [nodes, isVisible]);
  const reachableVisible = useMemo(() => visibleNodes.filter((n) => n.reachable), [visibleNodes]);
  const offVisible = useMemo(() => visibleNodes.filter((n) => !n.reachable), [visibleNodes]);

  // Edges: only drawn between currently-visible nodes.
  const lineGeom = useMemo(() => {
    const pts: number[] = [];
    for (const [s, t] of edgePairs) {
      const a = posById.get(s);
      const b = posById.get(t);
      if (!a || !b) continue;
      if (!isVisible(a) || !isVisible(b)) continue;
      pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
    return g;
  }, [edgePairs, posById, isVisible]);

  const highlightGeom = useMemo(() => {
    if (!focus) return null;
    const pts: number[] = [];
    for (const [s, t] of edgePairs) {
      if (s !== focus.id && t !== focus.id) continue;
      const a = posById.get(s);
      const b = posById.get(t);
      if (!a || !b) continue;
      if (!isVisible(a) || !isVisible(b)) continue;
      pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
    return g;
  }, [focus, edgePairs, posById, isVisible]);

  // Fit the complete observed graph on initial load, resize or explicit reset.
  useEffect(() => {
    if (!nodes.length || !controls || !groupRef.current || size.width <= 0 || size.height <= 0) return;
    flyRef.current = null;
    groupRef.current.rotation.set(0, 0, 0);
    const bounds = new THREE.Box3();
    nodes.forEach(node => {
      bounds.expandByPoint(new THREE.Vector3(node.x - node.radius, node.y - node.radius, node.z - node.radius));
      bounds.expandByPoint(new THREE.Vector3(node.x + node.radius, node.y + node.radius, node.z + node.radius));
    });
    const sphere = bounds.getBoundingSphere(new THREE.Sphere());
    const verticalFov = THREE.MathUtils.degToRad(camera.fov);
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * size.width / Math.max(1, size.height));
    const distance = sphere.radius / Math.sin(Math.min(verticalFov, horizontalFov) / 2) * 1.06;
    controls.target.copy(sphere.center);
    camera.position.copy(sphere.center).add(new THREE.Vector3(0, 0, Math.max(40, distance)));
    camera.updateProjectionMatrix();
    controls.update();
    invalidate();
  }, [nodes, controls, camera, invalidate, size.width, size.height, resetKey]);
  useEffect(() => () => lineGeom.dispose(), [lineGeom]);
  useEffect(() => () => highlightGeom?.dispose(), [highlightGeom]);

  // When a node is pinned, glide the camera to frame it.
  useEffect(() => {
    if (!pinned || !groupRef.current) return;
    const world = new THREE.Vector3(pinned.x, pinned.y, pinned.z);
    groupRef.current.localToWorld(world);
    const dir = camera.position.clone().sub(world).normalize();
    flyRef.current = { pos: world, dir, active: true };
    invalidate();
  }, [pinned, camera, invalidate]);

  useFrame((_, delta) => {
    // Auto-rotate only when nothing is being inspected.
    if (groupRef.current && rotating && !focus) groupRef.current.rotation.y += delta * 0.04;

    // Smooth camera fly-to on pin.
    const fly = flyRef.current;
    if (fly?.active && controls) {
      controls.target.lerp(fly.pos, 0.12);
      const desired = fly.pos.clone().add(fly.dir.clone().multiplyScalar(42));
      camera.position.lerp(desired, 0.12);
      controls.update();
      if (camera.position.distanceTo(desired) < 1.2) fly.active = false;
      else invalidate();
    }
  });

  return (
    <group ref={groupRef}>
      <lineSegments geometry={lineGeom}>
        <lineBasicMaterial
          color={palette.edge}
          transparent
          opacity={focus ? 0.045 : 0.16}
          blending={THREE.NormalBlending}
          depthWrite={false}
        />
      </lineSegments>

      {highlightGeom && (
        <lineSegments geometry={highlightGeom}>
          <lineBasicMaterial
            color={palette.selected}
            transparent
            opacity={0.75}
            blending={THREE.NormalBlending}
            depthWrite={false}
          />
        </lineSegments>
      )}

      {/* Reachable nodes retain the shared client colors without lighting effects. */}
      {reachableVisible.length > 0 && (
        <Instances limit={reachableVisible.length} range={reachableVisible.length}>
          <sphereGeometry args={[1, 12, 12]} />
          <meshBasicMaterial toneMapped={false} />
          {reachableVisible.map((n) => {
            const isFocus = focus?.id === n.id;
            const c = new THREE.Color(isFocus ? palette.selected : n.isTor ? palette.tor : n.color);
            return (
              <Instance
                key={n.id}
                position={[n.x, n.y, n.z]}
                scale={isFocus ? n.radius * 1.9 : n.radius}
                color={c}
                onPointerOver={(e) => { e.stopPropagation(); onHover(n); }}
                onPointerOut={() => onHover(null)}
                onClick={(e) => { e.stopPropagation(); onPin(n); }}
              />
            );
          })}
        </Instances>
      )}

      {/* Advertised-only addresses remain distinct from active-source IPs. */}
      {offVisible.length > 0 && (
        <Instances limit={offVisible.length} range={offVisible.length}>
          <sphereGeometry args={[1, 8, 8]} />
          <meshBasicMaterial transparent opacity={0.6} toneMapped={false} />
          {offVisible.map((n) => {
            const isFocus = focus?.id === n.id;
            const c = new THREE.Color(isFocus ? palette.selected : palette.off);
            return (
              <Instance
                key={n.id}
                position={[n.x, n.y, n.z]}
                scale={isFocus ? n.radius * 2.2 : n.radius}
                color={c}
                onPointerOver={(e) => { e.stopPropagation(); onHover(n); }}
                onPointerOut={() => onHover(null)}
                onClick={(e) => { e.stopPropagation(); onPin(n); }}
              />
            );
          })}
        </Instances>
      )}

    </group>
  );
}

export function TopologyGraph({ active = true }: { active?: boolean }) {
  const { theme } = useTheme();
  const [rotating, setRotating] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const [palette, setPalette] = useState({ edge: CLIENT_COLORS.zcashd, selected: CLIENT_COLORS.Zebra, tor: TOR_COLOR, off: OFF_COLOR });
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const styles = getComputedStyle(document.documentElement);
      const rgb = (token: string) => `rgb(${styles.getPropertyValue(token).trim().split(/\s+/).join(',')})`;
      setPalette({ edge: styles.getPropertyValue('--color-text-muted').trim(), selected: rgb('--color-gold-rgb'), tor: rgb('--color-purple-rgb'), off: styles.getPropertyValue('--color-text-muted').trim() });
    });
    return () => cancelAnimationFrame(frame);
  }, [theme]);
  const pageVisible = useSyncExternalStore(subscribeVisibility, getPageVisible, getServerVisible);
  const topology = useApiQuery<TopologyResponse>('/v1/network/topology', undefined,
    { enabled: active && pageVisible, refreshInterval: 300_000 });
  const data = topology.data;
  const [clock, setClock] = useState(() => Date.now());
  const topologyAvailable = topologyIsFresh(data, Math.max(clock, Date.now()));
  const selectedLayout = useMemo(() => data && topologyAvailable ? selectTopologyLayout(data) : null, [data, topologyAvailable]);
  const [layout, setLayout] = useState<{ source: TopologyResponse | null; nodes: PositionedNode[]; pairs: [number, number][] }>({ source: null, nodes: [], pairs: [] });
  const layoutReady = layout.source === data;
  const nodes = layoutReady ? layout.nodes : EMPTY_NODES;
  const edgePairs = layoutReady ? layout.pairs : EMPTY_PAIRS;
  const counts = data?.counts;
  const edgeCount = counts?.edges ?? data?.edges?.length ?? 0;
  const loading = topology.loading || (topologyAvailable && !layoutReady);
  const expiresAt = data?.expiresAt;
  const observedAt = data?.observedAt;
  const attemptedExpiry = useRef<string | null>(null);
  const lastExpiryRefreshAt = useRef(-Infinity);
  const expiryEnabled = useRef(active && pageVisible);
  expiryEnabled.current = active && pageVisible;
  const { refetch, isRefreshing } = topology;
  useEffect(() => {
    const deadline = typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN;
    if (!active || !pageVisible || !Number.isFinite(deadline)) return;
    const identity = `${observedAt || ''}|${expiresAt}`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function expire() {
      const now = Date.now();
      setClock(now);
      // Visibility can change before the subscription's next render/cleanup.
      if (!expiryEnabled.current || !getPageVisible()) return;
      if (attemptedExpiry.current === identity || isRefreshing) return;
      const cooldown = lastExpiryRefreshAt.current + MIN_EXPIRY_REFRESH_MS - now;
      if (cooldown > 0) { timer = setTimeout(expire, cooldown); return; }
      // Mark before fetching: the same expired/error payload must not loop.
      attemptedExpiry.current = identity;
      lastExpiryRefreshAt.current = now;
      void refetch();
    }
    if (deadline <= Date.now()) expire();
    else timer = setTimeout(expire, Math.min(deadline - Date.now() + 1, 2_147_483_647));
    return () => { if (timer !== undefined) clearTimeout(timer); };
  }, [expiresAt, observedAt, active, pageVisible, refetch, isRefreshing]);
  const [hovered, setHovered] = useState<PositionedNode | null>(null);
  const [pinned, setPinned] = useState<PositionedNode | null>(null);
  const [query, setQuery] = useState('');
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const toggleCategory = (cat: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });

  // Ignore focus on a node that the current filters have hidden.
  const rawFocus = pinned ?? hovered;
  const focus = rawFocus && !hidden.has(nodeCategory(rawFocus)) ? rawFocus : null;

  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    return nodes.filter(node => !hidden.has(nodeCategory(node)) && (q
      ? `${clientLabel(node.client, node.reachable)} ${node.countryCode || ''} #${node.id}`.toLowerCase().includes(q)
      : node.reachable))
      .sort((a, b) => (b.degree || 0) - (a.degree || 0)).slice(0, 6);
  }, [nodes, query, hidden]);
  const selectNode = (node: PositionedNode) => {
    setPinned(node); setHovered(null); setQuery(''); setRotating(false);
  };
  const resetView = () => {
    setPinned(null); setHovered(null); setQuery(''); setRotating(false); setResetKey(value => value + 1);
  };

  useEffect(() => {
    if (!data || !selectedLayout || !active || !pageVisible || layoutReady) return;
    let cancelled = false;
    let frame = 0;
    setHovered(null);
    setPinned(null);
    if (!selectedLayout.nodes.length) {
      setLayout({ source: data, nodes: [], pairs: [] });
      return;
    }
    const simNodes: SimNode[] = selectedLayout.nodes.map(node => ({ ...node }));
    const maxDegree = Math.max(1, ...simNodes.map(node => node.degree || 0));
    const links = selectedLayout.edges.map(edge => ({ ...edge }));
    const centerPull = (node: SimNode) => 0.015 + 0.16 * Math.pow((node.degree || 0) / maxDegree, 1.4);
    const sim: Simulation<SimNode> = forceSimulation<SimNode>(simNodes, 3)
      .force('link', forceLink<SimNode, { source: number; target: number }>(links)
        .id((node: SimNode) => node.id).distance(18).strength(0.35))
      .force('charge', forceManyBody<SimNode>().strength(-18).distanceMax(220))
      .force('center', forceCenter<SimNode>(0, 0, 0))
      .force('x', forceX<SimNode>(0).strength(centerPull))
      .force('y', forceY<SimNode>(0).strength(centerPull))
      .force('z', forceZ<SimNode>(0).strength(centerPull))
      .alphaDecay(0.045).stop();
    let ticks = 0;
    function step() {
      if (cancelled) return;
      const started = performance.now();
      let batch = 0;
      do { sim.tick(); ticks++; batch++; }
      while (ticks < LAYOUT_TICKS && batch < 3 && performance.now() - started < 8);
      if (ticks < LAYOUT_TICKS) { frame = requestAnimationFrame(step); return; }
      const positioned = simNodes.map(node => {
        const radius = 0.4 + Math.pow((node.degree || 0) / maxDegree, 0.4) * 4.2;
        return { ...node, x: node.x ?? 0, y: node.y ?? 0, z: node.z ?? 0,
          radius: node.reachable ? radius : Math.min(radius * 0.6, 0.7), color: nodeColor(node) };
      });
      // d3 replaces endpoint IDs with objects; keep scene identities numeric.
      const pairs: [number, number][] = links.map(link => [
        typeof link.source === 'object' ? (link.source as SimNode).id : link.source,
        typeof link.target === 'object' ? (link.target as SimNode).id : link.target,
      ]);
      if (!cancelled) setLayout({ source: data, nodes: positioned, pairs });
    }
    frame = requestAnimationFrame(step);
    return () => { cancelled = true; cancelAnimationFrame(frame); sim.stop(); };
  }, [data, selectedLayout, active, pageVisible, layoutReady]);

  const focusLinks = useMemo(() => ({
    outgoing: focus ? edgePairs.filter(([source]) => source === focus.id).length : 0,
    incoming: focus ? edgePairs.filter(([, target]) => target === focus.id).length : 0,
  }), [focus, edgePairs]);
  const formatTime = (value: string) => new Date(value).toLocaleString('en-GB', { timeZone: 'UTC' });

  if (!loading && !topologyAvailable) {
    return <div className="border border-cipher-border rounded-lg px-5 py-6">
      <p className="text-sm text-secondary" role="status">Fresh verified gossip links are not available.</p>
      <p className="text-caption text-muted mt-2">{counts ? `${counts.reachable} observed active IPs.` : 'Active IP counts are unavailable.'} Explore geography or the node directory for available observations.</p>
      {expiresAt && Number.isFinite(Date.parse(expiresAt)) && Date.parse(expiresAt) <= Date.now() && <p className="text-caption text-muted mt-2">The previous snapshot expired at <time dateTime={expiresAt}>{formatTime(expiresAt)} UTC</time>.</p>}
    </div>;
  }

  return (
    <div>
      <div className="border border-cipher-border rounded-lg overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-cipher-border">
          <p className="text-caption text-muted font-mono">{loading ? 'Loading graph observations…' : `${counts?.reachable ?? nodes.filter(node => node.reachable).length} observed active IPs · ${counts?.off ?? nodes.filter(node => !node.reachable).length} advertised only · ${edgeCount.toLocaleString()} advertisement links`}</p>
          <div className="flex gap-2">
            <button type="button" onClick={resetView} disabled={!nodes.length} className="px-3 py-2 rounded border border-cipher-border text-caption font-mono text-secondary hover:text-primary disabled:opacity-50">Reset view</button>
            <button type="button" aria-pressed={rotating} disabled={!nodes.length} onClick={() => setRotating(value => !value)} className="px-3 py-2 rounded border border-cipher-border text-caption font-mono text-secondary hover:text-primary disabled:opacity-50">{rotating ? 'Pause rotation' : 'Rotate view'}</button>
          </div>
        </div>
        {observedAt && Number.isFinite(Date.parse(observedAt)) && <p className="px-4 py-2 text-caption text-muted border-b border-cipher-border">Snapshot: <time dateTime={observedAt}>{formatTime(observedAt)} UTC</time>{expiresAt && Number.isFinite(Date.parse(expiresAt)) && <> · Expires: <time dateTime={expiresAt}>{formatTime(expiresAt)} UTC</time></>}</p>}
        {data?.truncated && <p className="px-4 py-2 text-caption text-warning border-b border-cipher-border">This observation is partial. Additional advertisements are omitted.</p>}
        {selectedLayout?.subset && <p className="px-4 py-2 text-caption text-muted border-b border-cipher-border">Showing {selectedLayout.nodes.length.toLocaleString()} of {(data?.nodes.length ?? 0).toLocaleString()} nodes and {selectedLayout.edges.length.toLocaleString()} of {edgeCount.toLocaleString()} links to keep this view responsive.</p>}
        {topology.error && <p role="status" className="px-4 py-2 text-caption text-warning border-b border-cipher-border">Refresh failed. Showing the last received snapshot{expiresAt ? ' until it expires' : ''}.</p>}
        <div className="grid lg:grid-cols-[minmax(0,1fr)_260px]">
          <div className="relative min-w-0 h-[360px] sm:h-[500px] bg-cipher-bg" aria-label="Interactive 3D graph of observed peer advertisements">
            {loading ? <div className="absolute inset-0 flex items-center justify-center"><span className="text-sm text-muted font-mono">Computing layout…</span></div>
              : nodes.length === 0 ? <div className="absolute inset-0 flex items-center justify-center"><span className="text-sm text-muted">No nodes in this snapshot.</span></div>
              : <Canvas
                  frameloop={active && pageVisible ? rotating ? 'always' : 'demand' : 'never'}
                  camera={{ position: [0, 0, 190], fov: 55, near: 0.1, far: 2000 }}
                  dpr={[1, 1.5]} gl={{ antialias: true, alpha: true }}
                  onPointerMissed={() => { setPinned(null); setHovered(null); }}
                >
                  <Scene palette={palette} rotating={rotating && active && pageVisible} resetKey={resetKey} nodes={nodes} edgePairs={edgePairs} focus={focus} pinned={pinned} hidden={hidden} onHover={setHovered} onPin={node => { if (node) selectNode(node); }} />
                  <OrbitControls makeDefault enablePan={false} enableDamping dampingFactor={0.08} rotateSpeed={0.6} minDistance={15} maxDistance={1200} />
                </Canvas>}
            <ChartWatermark size="map" />
          </div>
          <aside className="border-t lg:border-t-0 lg:border-l border-cipher-border p-4 min-w-0" aria-label="Node inspector">
            <label htmlFor="topology-search" className="block type-label text-muted mb-2">Find a node</label>
            <input id="topology-search" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Client, country or #ID" className="w-full min-w-0 rounded border border-cipher-border bg-cipher-bg px-3 py-2.5 text-caption font-mono text-primary placeholder:text-muted focus-visible:outline-cipher-gold" />
            <p className="text-caption text-muted mt-2">IDs refer to this graph snapshot.</p>
            {focus && !query.trim() ? <div className="mt-5">
              <div className="flex items-center justify-between gap-3 mb-4"><h3 className="font-mono text-sm text-primary">Node #{focus.id}</h3>{pinned && <button onClick={() => setPinned(null)} className="text-caption text-muted hover:text-primary underline underline-offset-4">Clear</button>}</div>
              <dl className="space-y-3 text-caption">
                <Row label="Client" value={sharedClientLabel(focus.client)} />
                <Row label="Status" value={focus.reachable ? 'Observed active' : 'Advertised only'} />
                <Row label="Country" value={focus.countryCode || 'Unknown'} />
                <Row label="Tor flag" value={focus.reachable ? focus.isTor ? 'Yes' : 'No' : 'Unknown'} />
                <Row label="Observed advertisements" value={focus.degree != null ? String(focus.degree) : '—'} />
                <Row label="Shown outgoing" value={String(focusLinks.outgoing)} />
                <Row label="Shown incoming" value={String(focusLinks.incoming)} />
                <Row label="Betweenness" value={focus.betweenness != null ? focus.betweenness.toFixed(4) : '—'} />
                <Row label="Closeness" value={focus.closeness != null ? focus.closeness.toFixed(4) : '—'} />
              </dl>
              <p className="text-caption text-muted mt-5">{pinned ? 'Highlighted lines are advertisements involving this node.' : 'Click the node to keep these details open.'}</p>
            </div> : <div className="mt-5">
              <p className="text-caption text-muted mb-2">{query.trim() ? 'Matching nodes · highest degree first' : 'Inspect a hub · highest degree first'}</p>
              <div className="divide-y divide-cipher-border">
                {searchResults.map(node => <button key={node.id} onClick={() => selectNode(node)} className="w-full flex items-center gap-2 py-3 text-left text-caption hover:bg-cipher-bg">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: !node.reachable ? palette.off : node.isTor ? palette.tor : nodeColor(node) }} />
                  <span className="min-w-0"><span className="block text-secondary">{clientLabel(node.client, node.reachable)}</span><span className="text-muted font-mono">#{node.id} · {node.countryCode || 'Unknown'}</span></span>
                  <span className="ml-auto font-mono text-muted tabular-nums">{node.degree ?? '—'}</span>
                </button>)}
                {!loading && !searchResults.length && <p className="text-caption text-muted py-4">No matching nodes in the visible categories.</p>}
              </div>
            </div>}
          </aside>
        </div>
      </div>

      {/* Legend (clickable filters) */}
      <div className="flex flex-wrap items-center gap-3 mt-3 text-caption font-mono text-muted">
        {Object.entries(CLIENT_COLORS).filter(([k]) => k !== 'Unknown').map(([name, color]) => (
          <button
            key={name}
            aria-pressed={!hidden.has(name)}
            onClick={() => toggleCategory(name)}
            className={`flex items-center gap-1.5 transition-opacity ${hidden.has(name) ? 'opacity-30 line-through' : 'opacity-100 hover:opacity-80'}`}
          >
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
            {name}
          </button>
        ))}
        <button
          aria-pressed={!hidden.has('Tor')}
          onClick={() => toggleCategory('Tor')}
          className={`flex items-center gap-1.5 transition-opacity ${hidden.has('Tor') ? 'opacity-30 line-through' : 'opacity-100 hover:opacity-80'}`}
        >
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: palette.tor }} />
          Tor
        </button>
        <button
          aria-pressed={!hidden.has('off')}
          onClick={() => toggleCategory('off')}
          className={`flex items-center gap-1.5 transition-opacity ${hidden.has('off') ? 'opacity-30 line-through' : 'opacity-100 hover:opacity-80'}`}
        >
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: palette.off }} />
          Advertised only
        </button>

      </div>
      <p className="text-caption text-muted mt-3">Drag to orbit · scroll to zoom · select a node to inspect. Links run from a verified advertiser to an advertised address; they do not establish remote connections. Advertised-only addresses are shown smaller. Positions are topological, not geographic.</p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className="text-primary tabular-nums">{value}</dd>
    </div>
  );
}
