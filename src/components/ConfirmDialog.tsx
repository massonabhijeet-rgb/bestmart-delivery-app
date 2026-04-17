import { useEffect, useState } from 'react';

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger' | 'caution';
}

type Opener = (opts: ConfirmOptions) => Promise<boolean>;

let currentOpener: Opener | null = null;

// Exported imperative API — matches window.confirm's ergonomics but themed.
export function confirm(opts: ConfirmOptions): Promise<boolean> {
  if (!currentOpener) {
    // Fallback to native confirm if <ConfirmHost /> isn't mounted yet.
    return Promise.resolve(window.confirm(opts.message));
  }
  return currentOpener(opts);
}

export interface RiderChoice {
  id: number;
  label: string;
  sublabel?: string;
}

export interface PickRiderOptions {
  title?: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  riders: RiderChoice[];
  initialRiderId?: number | null;
}

type RiderPickerOpener = (opts: PickRiderOptions) => Promise<number | null>;
let currentRiderPickerOpener: RiderPickerOpener | null = null;

// Returns the chosen rider id, or null if the admin cancelled.
export function pickRider(opts: PickRiderOptions): Promise<number | null> {
  if (!currentRiderPickerOpener) {
    return Promise.resolve(opts.initialRiderId ?? null);
  }
  return currentRiderPickerOpener(opts);
}

interface PendingState {
  opts: ConfirmOptions;
  resolve: (answer: boolean) => void;
}

export function ConfirmHost() {
  const [pending, setPending] = useState<PendingState | null>(null);

  useEffect(() => {
    currentOpener = (opts) =>
      new Promise((resolve) => {
        setPending({ opts, resolve });
      });
    return () => {
      currentOpener = null;
    };
  }, []);

  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        pending.resolve(false);
        setPending(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending]);

  if (!pending) return null;

  const { opts } = pending;
  const tone = opts.tone ?? 'default';

  const close = (answer: boolean) => {
    pending.resolve(answer);
    setPending(null);
  };

  return (
    <div
      className="confirm-backdrop"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) close(false);
      }}
    >
      <div className={`confirm-dialog confirm-dialog--${tone}`}>
        <div className="confirm-dialog__body">
          {opts.title ? <h3 className="confirm-dialog__title">{opts.title}</h3> : null}
          <p className="confirm-dialog__message">{opts.message}</p>
        </div>
        <div className="confirm-dialog__actions">
          <button type="button" className="confirm-dialog__btn confirm-dialog__btn--ghost" onClick={() => close(false)}>
            {opts.cancelLabel ?? 'Cancel'}
          </button>
          <button
            type="button"
            className={`confirm-dialog__btn confirm-dialog__btn--primary confirm-dialog__btn--${tone}`}
            onClick={() => close(true)}
            autoFocus
          >
            {opts.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}

interface PendingRiderPick {
  opts: PickRiderOptions;
  resolve: (answer: number | null) => void;
}

export function RiderPickerHost() {
  const [pending, setPending] = useState<PendingRiderPick | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  useEffect(() => {
    currentRiderPickerOpener = (opts) =>
      new Promise((resolve) => {
        setSelected(opts.initialRiderId ?? null);
        setPending({ opts, resolve });
      });
    return () => {
      currentRiderPickerOpener = null;
    };
  }, []);

  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        pending.resolve(null);
        setPending(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending]);

  if (!pending) return null;

  const { opts } = pending;

  const close = (answer: number | null) => {
    pending.resolve(answer);
    setPending(null);
  };

  return (
    <div
      className="confirm-backdrop"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) close(null);
      }}
    >
      <div className="confirm-dialog confirm-dialog--default rider-picker">
        <div className="confirm-dialog__body">
          <h3 className="confirm-dialog__title">{opts.title ?? 'Select a rider'}</h3>
          <p className="confirm-dialog__message">
            {opts.message ?? 'Choose who will deliver this order.'}
          </p>

          {opts.riders.length === 0 ? (
            <p className="rider-picker__empty">
              No riders available. Add a team member with role "rider" first.
            </p>
          ) : (
            <ul className="rider-picker__list">
              {opts.riders.map((r) => {
                const active = selected === r.id;
                return (
                  <li key={r.id}>
                    <button
                      type="button"
                      className={`rider-picker__option${active ? ' rider-picker__option--active' : ''}`}
                      onClick={() => setSelected(r.id)}
                    >
                      <span className="rider-picker__radio" aria-hidden>
                        {active ? '●' : '○'}
                      </span>
                      <span className="rider-picker__text">
                        <strong>{r.label}</strong>
                        {r.sublabel ? <span>{r.sublabel}</span> : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="confirm-dialog__actions">
          <button
            type="button"
            className="confirm-dialog__btn confirm-dialog__btn--ghost"
            onClick={() => close(null)}
          >
            {opts.cancelLabel ?? 'Cancel'}
          </button>
          <button
            type="button"
            className="confirm-dialog__btn confirm-dialog__btn--primary confirm-dialog__btn--default"
            disabled={selected == null}
            onClick={() => close(selected)}
          >
            {opts.confirmLabel ?? 'Dispatch'}
          </button>
        </div>
      </div>
    </div>
  );
}
