import { GLOBE_LAND_COORDINATES } from './globe-land.generated';

export interface GlobeVector {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface GlobeView {
  readonly right: GlobeVector;
  readonly up: GlobeVector;
  readonly forward: GlobeVector;
}

export interface GlobePoint {
  x: number;
  y: number;
  /** Positive on the visible hemisphere; negative behind the globe. */
  depth: number;
}

const DEGREES_TO_RADIANS = Math.PI / 180;

/** Unit sphere with north on +y and the prime meridian on +z. */
export function latLonToVector(lat: number, lon: number): GlobeVector {
  const latitude = lat * DEGREES_TO_RADIANS;
  const longitude = lon * DEGREES_TO_RADIANS;
  const cosLatitude = Math.cos(latitude);
  return {
    x: cosLatitude * Math.sin(longitude),
    y: Math.sin(latitude),
    z: cosLatitude * Math.cos(longitude),
  };
}

/** Compute once per frame; projecting a point then needs only dot products. */
export function createGlobeView(centerLon: number, centerLat: number): GlobeView {
  const longitude = centerLon * DEGREES_TO_RADIANS;
  const latitude = centerLat * DEGREES_TO_RADIANS;
  const sinLongitude = Math.sin(longitude);
  const cosLongitude = Math.cos(longitude);
  const sinLatitude = Math.sin(latitude);
  const cosLatitude = Math.cos(latitude);
  return {
    right: { x: cosLongitude, y: 0, z: -sinLongitude },
    up: {
      x: -sinLatitude * sinLongitude,
      y: cosLatitude,
      z: -sinLatitude * cosLongitude,
    },
    forward: {
      x: cosLatitude * sinLongitude,
      y: sinLatitude,
      z: cosLatitude * cosLongitude,
    },
  };
}

function dot(a: GlobeVector, b: GlobeVector): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/** Orthographic coordinates: x right, y down, and a sphere radius of one. */
export function projectGlobeVector(vector: GlobeVector, view: GlobeView): GlobePoint {
  return {
    x: dot(vector, view.right),
    y: -dot(vector, view.up),
    depth: dot(vector, view.forward),
  };
}

export function projectGlobePoint(
  lat: number,
  lon: number,
  centerLon: number,
  centerLat: number,
): GlobePoint {
  return projectGlobeVector(latLonToVector(lat, lon), createGlobeView(centerLon, centerLat));
}

export function clampGlobeZoom(zoom: number): number {
  return Number.isNaN(zoom) ? 1 : Math.max(1, Math.min(3, zoom));
}

/** Keep long drags bounded without introducing a jump at the date line. */
export function rotateGlobeView(
  centerLon: number,
  centerLat: number,
  deltaLon: number,
  deltaLat: number,
): { centerLon: number; centerLat: number } {
  return {
    centerLon: ((centerLon + deltaLon + 180) % 360 + 360) % 360 - 180,
    centerLat: Math.max(-65, Math.min(65, centerLat + deltaLat)),
  };
}

/** Generated spherical land sampling; convert geographic coordinates only once. */
export const GLOBE_LAND_POINTS: ReadonlyArray<GlobeVector> = GLOBE_LAND_COORDINATES.map(([lat, lon]) =>
  latLonToVector(lat, lon),
);
