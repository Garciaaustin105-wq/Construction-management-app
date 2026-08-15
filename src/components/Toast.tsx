"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { CheckCircle2, XCircle, Info, AlertTriangle } from "lucide-react";

type ToastVariant = "success" | "error" | "info" | "warning";

type Toast = {
  id: number;
  message: string;
  variant: ToastVariant;
};

type ToastContextValue = {
  show: (message: string, variant?: ToastVariant) => void;
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
  warning: (message: string) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // Safe no-op fallback if used outside a provider (e.g. server-rendered)
    return {
      show: () => {},
      success: () => {},
      error: () => {},
      info: () => {},
      warning: () => {},
    } as ToastContextValue;
  }
  return ctx;
}

let nextId = 1;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (message: string, variant: ToastVariant = "info") => {
      const id = nextId++;
      setToasts((prev) => [...prev, { id, message, variant }]);
      // Auto-dismiss after 3.5s
      setTimeout(() => dismiss(id), 3500);
    },
    [dismiss]
  );

  // Memoized so consumers get a stable reference — otherwise useToast() returns
  // a new object every render, which makes any effect with `toast` in its deps
  // re-fire every render (and a toast call inside it -> infinite toast loop).
  const value = useMemo<ToastContextValue>(
    () => ({
      show,
      success: (m) => show(m, "success"),
      error: (m) => show(m, "error"),
      info: (m) => show(m, "info"),
      warning: (m) => show(m, "warning"),
    }),
    [show]
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="fixed top-3 inset-x-0 z-[200] flex flex-col items-center gap-2 pointer-events-none px-3">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
  }, []);

  const colors =
    toast.variant === "success"
      ? "bg-green-600 text-white"
      : toast.variant === "error"
      ? "bg-red-600 text-white"
      : toast.variant === "warning"
      ? "bg-amber-600 text-white"
      : "bg-gray-900 text-white";

  const Icon =
    toast.variant === "success"
      ? CheckCircle2
      : toast.variant === "error"
      ? XCircle
      : toast.variant === "warning"
      ? AlertTriangle
      : Info;

  return (
    <div
      role={toast.variant === "error" || toast.variant === "warning" ? "alert" : "status"}
      onClick={onDismiss}
      className={`pointer-events-auto max-w-sm w-full shadow-lg rounded-lg px-4 py-3 flex items-center gap-2 text-sm transition-all duration-200 ${
        visible ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-2"
      } ${colors}`}
    >
      <Icon className="w-5 h-5 flex-shrink-0" />
      <span className="flex-1">{toast.message}</span>
    </div>
  );
}