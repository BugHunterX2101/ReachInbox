"use client";

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "outline";

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary: "bg-brand-600 text-white hover:bg-brand-700 shadow-sm",
  secondary: "bg-gray-100 text-gray-800 hover:bg-gray-200",
  ghost: "text-gray-600 hover:bg-gray-100",
  danger: "bg-red-600 text-white hover:bg-red-700",
  outline: "border border-brand-600 text-brand-700 hover:bg-brand-50",
};

export function Button({
  variant = "primary",
  className = "",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-medium transition
        disabled:opacity-50 disabled:cursor-not-allowed ${BUTTON_STYLES[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export function Input({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`w-full rounded-xl border border-gray-200 bg-white px-3.5 py-2.5 text-sm outline-none
        transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100 disabled:bg-gray-50 disabled:text-gray-400 ${className}`}
      {...rest}
    />
  );
}

export function Select({ className = "", children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`w-full rounded-xl border border-gray-200 bg-white px-3.5 py-2.5 text-sm outline-none
        transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100 ${className}`}
      {...rest}
    >
      {children}
    </select>
  );
}

export function Label({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-1 block text-sm font-medium text-gray-700">
      {children}
    </label>
  );
}

// ---------------------------------------------------------------------------
// States (consistent loading/empty/error per FR-33 / §9.4)
// ---------------------------------------------------------------------------

export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="divide-y divide-gray-100">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-5 py-4">
          <div className="shimmer h-9 w-9 rounded-full" />
          <div className="flex-1 space-y-2">
            <div className="shimmer h-3 w-1/4 rounded" />
            <div className="shimmer h-3 w-2/3 rounded" />
          </div>
          <div className="shimmer h-6 w-20 rounded-full" />
        </div>
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-2xl bg-gray-100 text-xl">
        ✉️
      </div>
      <p className="font-medium text-gray-700">{title}</p>
      {hint && <p className="max-w-sm text-sm text-gray-400">{hint}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="m-4 flex items-center justify-between gap-4 rounded-xl border border-red-100 bg-red-50 px-4 py-3">
      <p className="text-sm text-red-700">{message}</p>
      {onRetry && (
        <Button variant="secondary" onClick={onRetry} className="shrink-0">
          Retry
        </Button>
      )}
    </div>
  );
}
