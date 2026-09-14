import React from 'react';

export interface Toast {
  id: number;
  message: string;
  type: 'success' | 'error' | 'info';
}

interface Props {
  toasts: Toast[];
}

export default function ToastContainer({ toasts }: Props) {
  if (toasts.length === 0) return null;

  return (
    <div className="toast-container">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast ${t.type === 'error' ? 'toast-error' : t.type === 'success' ? 'toast-success' : ''}`}
        >
          {t.type === 'success' ? '✓ ' : t.type === 'error' ? '✕ ' : 'ℹ '}
          {t.message}
        </div>
      ))}
    </div>
  );
}
