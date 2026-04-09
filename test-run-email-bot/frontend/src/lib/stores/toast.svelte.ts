export type ToastVariant = 'success' | 'error' | 'info';

export interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
}

let toasts = $state<ToastItem[]>([]);
let nextId = 0;

export function getToasts(): ToastItem[] {
  return toasts;
}

export function addToast(message: string, variant: ToastVariant = 'info'): number {
  const id = ++nextId;
  toasts = [...toasts, { id, message, variant }];

  setTimeout(() => {
    removeToast(id);
  }, 5000);

  return id;
}

export function removeToast(id: number): void {
  toasts = toasts.filter((t) => t.id !== id);
}
