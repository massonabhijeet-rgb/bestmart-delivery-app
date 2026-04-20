import { useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import type { LatLng, Map as LeafletMap } from 'leaflet';
import 'leaflet/dist/leaflet.css';

export interface PickedLocation {
  latitude: number;
  longitude: number;
}

interface AddressPickerModalProps {
  open: boolean;
  initialLatitude?: number | null;
  initialLongitude?: number | null;
  fetchCurrentLocationOnOpen?: boolean;
  onConfirm: (picked: PickedLocation) => void;
  onClose: () => void;
}

// Delhi fallback so the map doesn't render in the middle of the Atlantic
// when we have no initial coords and geolocation hasn't resolved yet.
const FALLBACK: [number, number] = [28.6139, 77.209];

// Tracks the map's centre as the user pans / zooms, so the absolute-positioned
// overlay pin is always pointing at the actual pinned coordinate.
function CenterTracker({
  onCenterChange,
}: {
  onCenterChange: (center: LatLng) => void;
}) {
  const map = useMapEvents({
    move: () => onCenterChange(map.getCenter()),
    zoom: () => onCenterChange(map.getCenter()),
  });
  return null;
}

// Exposes the map instance so the parent can call `flyTo` when the user
// taps "use my current location".
function MapRefCapture({
  onReady,
}: {
  onReady: (map: LeafletMap) => void;
}) {
  const map = useMap();
  useEffect(() => {
    onReady(map);
  }, [map, onReady]);
  return null;
}

export function AddressPickerModal({
  open,
  initialLatitude,
  initialLongitude,
  fetchCurrentLocationOnOpen = false,
  onConfirm,
  onClose,
}: AddressPickerModalProps) {
  const initialCenter = useMemo<[number, number]>(() => {
    if (initialLatitude != null && initialLongitude != null) {
      return [initialLatitude, initialLongitude];
    }
    return FALLBACK;
  }, [initialLatitude, initialLongitude]);

  const [center, setCenter] = useState<[number, number]>(initialCenter);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const autoLocatedRef = useRef(false);

  // Reset state whenever the modal is reopened so a stale pin from an earlier
  // pick session doesn't appear in the next open.
  useEffect(() => {
    if (!open) return;
    setCenter(initialCenter);
    setLocationError(null);
    autoLocatedRef.current = false;
  }, [open, initialCenter]);

  const fetchCurrent = async () => {
    if (!navigator.geolocation) {
      setLocationError('Geolocation is not available in this browser.');
      return;
    }
    setLocating(true);
    setLocationError(null);
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 10000,
        });
      });
      const next: [number, number] = [pos.coords.latitude, pos.coords.longitude];
      setCenter(next);
      mapRef.current?.flyTo(next, 17, { duration: 0.6 });
    } catch (err) {
      setLocationError(
        err instanceof GeolocationPositionError && err.code === err.PERMISSION_DENIED
          ? 'Location permission denied. You can still pan the map to pick a spot.'
          : 'Could not fetch your location. You can pan the map to pick a spot.',
      );
    } finally {
      setLocating(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    if (!fetchCurrentLocationOnOpen) return;
    if (autoLocatedRef.current) return;
    autoLocatedRef.current = true;
    void fetchCurrent();
  }, [open, fetchCurrentLocationOnOpen]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15, 23, 42, 0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1100,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(560px, 100vw)',
          height: 'min(640px, 100vh)',
          background: '#fff',
          borderRadius: 16,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            padding: '12px 16px',
            display: 'flex',
            alignItems: 'center',
            borderBottom: '1px solid var(--c-border, #e2e8f0)',
          }}
        >
          <strong style={{ flex: 1, fontSize: 16 }}>Pin your delivery location</strong>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'transparent',
              border: 0,
              fontSize: 22,
              cursor: 'pointer',
              color: '#64748b',
              lineHeight: 1,
              padding: 4,
            }}
          >
            ×
          </button>
        </div>
        <div style={{ position: 'relative', flex: 1, minHeight: 260 }}>
          <MapContainer
            center={initialCenter}
            zoom={16}
            minZoom={4}
            maxZoom={19}
            style={{ width: '100%', height: '100%' }}
          >
            <TileLayer
              attribution='© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
              url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            <MapRefCapture
              onReady={(map) => {
                mapRef.current = map;
              }}
            />
            <CenterTracker
              onCenterChange={(c) => setCenter([c.lat, c.lng])}
            />
          </MapContainer>
          {/* Hint strip */}
          <div
            style={{
              position: 'absolute',
              top: 10,
              left: 10,
              right: 10,
              padding: '8px 12px',
              background: '#fff',
              borderRadius: 10,
              fontSize: 12,
              fontWeight: 600,
              color: '#0f172a',
              boxShadow: '0 2px 12px rgba(15, 23, 42, 0.15)',
              zIndex: 1000,
            }}
          >
            Drag the map to move the pin to your exact spot.
          </div>
          {/* Center pin overlay (not a leaflet marker — stays fixed at viewport centre) */}
          <div
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -100%)',
              pointerEvents: 'none',
              fontSize: 40,
              lineHeight: 1,
              zIndex: 1000,
            }}
          >
            📍
          </div>
          <button
            type="button"
            onClick={() => void fetchCurrent()}
            disabled={locating}
            title="Use my current location"
            style={{
              position: 'absolute',
              right: 12,
              bottom: 12,
              width: 40,
              height: 40,
              borderRadius: 20,
              border: '1px solid var(--c-border, #e2e8f0)',
              background: '#fff',
              color: '#2563eb',
              fontSize: 18,
              cursor: locating ? 'default' : 'pointer',
              boxShadow: '0 2px 8px rgba(15, 23, 42, 0.15)',
              zIndex: 1000,
            }}
          >
            {locating ? '…' : '📡'}
          </button>
        </div>
        <div
          style={{
            padding: 14,
            borderTop: '1px solid var(--c-border, #e2e8f0)',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div style={{ fontSize: 12, color: '#64748b', fontWeight: 600 }}>
            📍 {center[0].toFixed(5)}, {center[1].toFixed(5)}
          </div>
          {locationError ? (
            <span style={{ color: '#ef4444', fontSize: 12 }}>{locationError}</span>
          ) : null}
          <button
            type="button"
            onClick={() =>
              onConfirm({
                latitude: center[0],
                longitude: center[1],
              })
            }
            style={{
              height: 48,
              borderRadius: 12,
              border: 0,
              background: '#2563eb',
              color: '#fff',
              fontSize: 15,
              fontWeight: 800,
              cursor: 'pointer',
            }}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
