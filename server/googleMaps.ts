import { listActiveDeliveriesForRider, saveOrderRoute } from './db.js';

const SERVER_KEY = process.env.GOOGLE_MAPS_SERVER_KEY ?? '';

export function isGoogleMapsServerConfigured(): boolean {
  return SERVER_KEY.length > 0;
}

interface DirectionsResult {
  polyline: string;
  durationSec: number;
  distanceM: number;
}

async function fetchDirections(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number }
): Promise<DirectionsResult | null> {
  const url = new URL('https://maps.googleapis.com/maps/api/directions/json');
  url.searchParams.set('origin', `${origin.lat},${origin.lng}`);
  url.searchParams.set('destination', `${destination.lat},${destination.lng}`);
  url.searchParams.set('mode', 'driving');
  url.searchParams.set('key', SERVER_KEY);

  const res = await fetch(url);
  if (!res.ok) return null;
  const body = (await res.json()) as {
    status: string;
    routes?: Array<{
      overview_polyline: { points: string };
      legs: Array<{
        duration: { value: number };
        distance: { value: number };
      }>;
    }>;
  };
  if (body.status !== 'OK' || !body.routes?.length) return null;
  const route = body.routes[0];
  return {
    polyline: route.overview_polyline.points,
    durationSec: route.legs[0].duration.value,
    distanceM: route.legs[0].distance.value,
  };
}

/**
 * Fire-and-forget: on every rider GPS ping, cache a driving route for any
 * active delivery that doesn't already have one. Exactly one Directions API
 * call per order, lifetime — subsequent pings are no-ops. The customer app
 * reads the cached polyline from the order row and never calls Google.
 * Swallows errors so the ping handler never breaks on transient Google
 * failures or a missing key.
 */
export async function maybeRefreshRouteForRider(
  riderId: number,
  riderLat: number,
  riderLng: number
): Promise<void> {
  if (!isGoogleMapsServerConfigured()) return;
  try {
    const deliveries = await listActiveDeliveriesForRider(riderId);
    for (const d of deliveries) {
      if (d.routeOriginLat !== null && d.routeOriginLng !== null) continue;
      const route = await fetchDirections(
        { lat: riderLat, lng: riderLng },
        { lat: d.deliveryLatitude, lng: d.deliveryLongitude }
      );
      if (!route) continue;
      await saveOrderRoute(d.publicId, {
        polyline: route.polyline,
        durationSec: route.durationSec,
        distanceM: route.distanceM,
        originLat: riderLat,
        originLng: riderLng,
      });
    }
  } catch (err) {
    console.error('maybeRefreshRouteForRider error:', err);
  }
}
