"use client";

import type {
  InputHTMLAttributes,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
  ReactNode,
} from "react";

// Shared form field primitives. Collapses the repeated
//   <label><span className="text-sm font-medium text-gray-700">Label</span>
//   <input className="mt-1 block w-full px-3 py-2 border border-gray-300
//   rounded-lg text-base"/></label>
// idiom, and adds error/hint slots so mobile forms can show what's required and
// why it failed inline (the "forms feel cramped/confusing" pain).

const INPUT_BASE =
  "mt-1 block w-full px-3 py-2 border rounded-lg text-base bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand disabled:bg-gray-50 disabled:text-gray-400";

const ERR_BORDER = "border-red-400";
const OK_BORDER = "border-gray-300";

export function FormField({
  label,
  htmlFor,
  required,
  error,
  hint,
  variant = "stacked",
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  required?: boolean;
  error?: string;
  hint?: ReactNode;
  // `stacked` (default): label above control — the mobile-first layout every
  // form already uses. `inline`: label left / control right at `lg` (Salesforce
  // record-form density), still stacked on mobile. The error/hint follow the
  // control in both variants.
  variant?: "stacked" | "inline";
  children: ReactNode;
}) {
  const root = variant === "inline" ? "block lg:flex lg:items-start lg:gap-3" : "block";
  const labelText =
    "text-sm font-medium text-gray-700" +
    (variant === "inline" ? " block lg:w-40 lg:flex-shrink-0 lg:pt-2" : "");
  // Inline wraps the control + its error/hint so they sit in the right column.
  const Inner = variant === "inline" ? "lg:flex-1" : "";

  return (
    <label htmlFor={htmlFor} className={root}>
      <span className={labelText}>
        {label}
        {required && <span className="text-red-500"> *</span>}
      </span>
      <div className={Inner}>
        {children}
        {error ? (
          <span className="mt-1 block text-xs text-red-600">{error}</span>
        ) : hint ? (
          <span className="mt-1 block text-xs text-muted">{hint}</span>
        ) : null}
      </div>
    </label>
  );
}

type TextInputProps = InputHTMLAttributes<HTMLInputElement> & {
  error?: boolean;
};

export function TextInput({ error, className, ...rest }: TextInputProps) {
  return (
    <input
      className={`${INPUT_BASE} ${error ? ERR_BORDER : OK_BORDER}${
        className ? ` ${className}` : ""
      }`}
      {...rest}
    />
  );
}

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  error?: boolean;
};

export function Select({ error, className, children, ...rest }: SelectProps) {
  return (
    <select
      className={`${INPUT_BASE} ${error ? ERR_BORDER : OK_BORDER}${
        className ? ` ${className}` : ""
      }`}
      {...rest}
    >
      {children}
    </select>
  );
}

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  error?: boolean;
};

export function Textarea({ error, className, ...rest }: TextareaProps) {
  return (
    <textarea
      className={`${INPUT_BASE} ${error ? ERR_BORDER : OK_BORDER}${
        className ? ` ${className}` : ""
      }`}
      {...rest}
    />
  );
}