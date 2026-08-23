"use client";

import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";

// Shared button. The PRIMARY variant is fixed platform blue (bg-blue-600 /
// active:bg-blue-700) on BOTH deploys — the user explicitly wants blue action
// buttons everywhere and the lawn app to keep the blue it already had (not
// recolor per variant). The `brand` token is reserved for chrome only
// (Sidebar / layout accents, login) where green-on-lawn/blue-on-construction
// theming is wanted. Secondary/ghost/danger are neutral.
//
// Two entry points:
//   <Button>            — renders a <button> (supports onClick, disabled, type).
//   <LinkButton href>   — renders a next/link styled identically.
//   buttonClasses(...)  — the class string only, for the rare <Link>/<button>
//                         that needs bespoke markup but the standard look.

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const BASE =
  "inline-flex items-center justify-center gap-2 font-semibold rounded-lg transition-colors disabled:opacity-50 disabled:pointer-events-none active:scale-[.99] focus-visible:outline-2 focus-visible:outline-offset-2";

const VARIANTS: Record<ButtonVariant, string> = {
  // Fixed platform blue on both deploys (user pref 2026-08-22: keep blue).
  primary: "bg-blue-600 text-white active:bg-blue-700 hover:bg-blue-700",
  secondary:
    "bg-white text-gray-800 border border-gray-300 active:bg-gray-50 hover:bg-gray-50",
  ghost: "bg-transparent text-gray-700 active:bg-gray-100 hover:bg-gray-100",
  danger: "bg-red-600 text-white active:bg-red-700 hover:bg-red-700",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "text-xs px-3 py-1.5",
  md: "text-sm px-4 py-2.5",
  lg: "text-base px-5 py-3",
};

export function buttonClasses(
  variant: ButtonVariant = "primary",
  size: ButtonSize = "md",
  block = false
): string {
  return [BASE, VARIANTS[variant], SIZES[size], block ? "w-full" : ""]
    .filter(Boolean)
    .join(" ");
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  children: ReactNode;
};

export default function Button({
  variant = "primary",
  size = "md",
  block = false,
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button className={buttonClasses(variant, size, block) + (className ? ` ${className}` : "")} {...rest}>
      {children}
    </button>
  );
}

type LinkButtonProps = {
  href: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  className?: string;
  children: ReactNode;
} & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "className">;

export function LinkButton({
  href,
  variant = "primary",
  size = "md",
  block = false,
  className,
  children,
  ...rest
}: LinkButtonProps) {
  return (
    <Link
      href={href}
      className={buttonClasses(variant, size, block) + (className ? ` ${className}` : "")}
      {...rest}
    >
      {children}
    </Link>
  );
}