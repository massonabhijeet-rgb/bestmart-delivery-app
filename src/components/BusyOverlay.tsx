import { useEffect, useState } from 'react';

type Listener = () => void;
const listeners = new Set<Listener>();
const labels: string[] = [];

function notify() {
  listeners.forEach((cb) => cb());
}

export function pushBusy(label = 'Working…') {
  labels.push(label);
  notify();
}

export function popBusy() {
  labels.pop();
  notify();
}

export async function withBusy<T>(label: string, fn: () => Promise<T>): Promise<T> {
  pushBusy(label);
  try {
    return await fn();
  } finally {
    popBusy();
  }
}

export function BusyOverlay() {
  const [, force] = useState(0);
  useEffect(() => {
    const cb = () => force((n) => n + 1);
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  }, []);

  if (labels.length === 0) return null;
  const label = labels[labels.length - 1];

  return (
    <div className="busy-overlay" role="status" aria-live="polite" aria-busy="true">
      <div className="busy-overlay__backdrop" />
      <div className="busy-overlay__card">
        <div className="busy-overlay__spinner" aria-hidden />
        <div className="busy-overlay__label">{label}</div>
      </div>
    </div>
  );
}
