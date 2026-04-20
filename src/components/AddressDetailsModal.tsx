import { useEffect, useState } from 'react';

export interface AddressDetails {
  fullName: string;
  phone: string;
  addressLine: string;
  deliveryNotes: string;
}

interface AddressDetailsModalProps {
  open: boolean;
  latitude: number | null;
  longitude: number | null;
  initial?: Partial<AddressDetails>;
  onConfirm: (details: AddressDetails) => void;
  onClose: () => void;
}

export function AddressDetailsModal({
  open,
  latitude,
  longitude,
  initial,
  onConfirm,
  onClose,
}: AddressDetailsModalProps) {
  const [fullName, setFullName] = useState(initial?.fullName ?? '');
  const [phone, setPhone] = useState(initial?.phone ?? '');
  const [addressLine, setAddressLine] = useState(initial?.addressLine ?? '');
  const [deliveryNotes, setDeliveryNotes] = useState(initial?.deliveryNotes ?? '');

  // Reset inputs whenever the modal is re-opened so we don't leak draft values
  // from a prior session if the user abandoned and returned.
  useEffect(() => {
    if (!open) return;
    setFullName(initial?.fullName ?? '');
    setPhone(initial?.phone ?? '');
    setAddressLine(initial?.addressLine ?? '');
    setDeliveryNotes(initial?.deliveryNotes ?? '');
  }, [open, initial?.fullName, initial?.phone, initial?.addressLine, initial?.deliveryNotes]);

  if (!open) return null;

  const canSave =
    addressLine.trim().length > 0 && fullName.trim().length > 0 && phone.trim().length > 0;

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
        zIndex: 1110,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(520px, 100vw)',
          maxHeight: '90vh',
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
          <strong style={{ flex: 1, fontSize: 16 }}>Address details</strong>
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
        <div style={{ padding: 16, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {latitude != null && longitude != null ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 12px',
                background: 'rgba(37, 99, 235, 0.06)',
                border: '1px solid rgba(37, 99, 235, 0.2)',
                borderRadius: 10,
                fontSize: 12,
                fontWeight: 700,
                color: '#1e3a8a',
              }}
            >
              <span>📍</span>
              Pinned at {latitude.toFixed(5)}, {longitude.toFixed(5)}
            </div>
          ) : null}
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, fontWeight: 600, color: '#334155' }}>
            Flat / house no., floor, landmark
            <textarea
              value={addressLine}
              onChange={(e) => setAddressLine(e.target.value)}
              placeholder="Flat 12B, 2nd floor, opp. HDFC bank"
              rows={2}
              style={{
                resize: 'vertical',
                padding: '10px 12px',
                borderRadius: 10,
                border: '1px solid var(--c-border, #e2e8f0)',
                fontFamily: 'inherit',
                fontSize: 14,
              }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, fontWeight: 600, color: '#334155' }}>
            Full name
            <input
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Name for the rider to ask for"
              style={{
                padding: '10px 12px',
                borderRadius: 10,
                border: '1px solid var(--c-border, #e2e8f0)',
                fontFamily: 'inherit',
                fontSize: 14,
              }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, fontWeight: 600, color: '#334155' }}>
            Phone number
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+91 98xxx xxxxx"
              inputMode="tel"
              style={{
                padding: '10px 12px',
                borderRadius: 10,
                border: '1px solid var(--c-border, #e2e8f0)',
                fontFamily: 'inherit',
                fontSize: 14,
              }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, fontWeight: 600, color: '#334155' }}>
            Delivery notes (optional)
            <input
              value={deliveryNotes}
              onChange={(e) => setDeliveryNotes(e.target.value)}
              placeholder="Gate code, landmark, call before arrival"
              style={{
                padding: '10px 12px',
                borderRadius: 10,
                border: '1px solid var(--c-border, #e2e8f0)',
                fontFamily: 'inherit',
                fontSize: 14,
              }}
            />
          </label>
          <button
            type="button"
            disabled={!canSave}
            onClick={() => {
              if (!canSave) return;
              onConfirm({
                fullName: fullName.trim(),
                phone: phone.trim(),
                addressLine: addressLine.trim(),
                deliveryNotes: deliveryNotes.trim(),
              });
            }}
            style={{
              marginTop: 6,
              height: 48,
              borderRadius: 12,
              border: 0,
              background: canSave ? '#2563eb' : '#cbd5e1',
              color: '#fff',
              fontSize: 15,
              fontWeight: 800,
              cursor: canSave ? 'pointer' : 'not-allowed',
            }}
          >
            Save delivery address
          </button>
        </div>
      </div>
    </div>
  );
}
