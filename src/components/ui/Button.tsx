"use client";

import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { isLawn } from "@/lib/variant";

// Shared button.
//
// PRIMARY colour, and why it differs per deploy:
//   CONSTRUCTION — fixed platform blue (bg-blue-600 / active:bg-blue-700).
//     Unchanged. The 2026-08-22 preference ("keep blue everywhere, the brand
//     token is for chrome only") still stands for this deploy.
//   LAWN — bg-brand (green). That preference was SUPERSEDED for the lawn
//     variant by the approved Terra Verde UI redesign: reserving the brand
//     token for chrome left a green app whose every call-to-action was blue,
//     which read as unfinished rather than as restraint.
// This is the ONLY place the switch is made. Call sites (hundreds of them) pass
// variant="primary" and are untouched.
//
// Two entry points:
//   <Button>            — renders a <button> (supports onClick, disabled, type).
//   <LinkButton href>   — renders a next/link styled identically.
//   buttonClasses(...)  — the class string only, for the rare <Link>/<button>
//                         that needs bespoke markup but the standard look.

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

// isLawn() is a build-time constant, so each deploy inlines one branch of these
// ternaries and the other never reaches the bundle. The construction strings
// below are byte-identical to what shipped before this redesign.
const BASE = isLawn()
  ? "inline-flex items-center justify-center gap-2 font-bold rounded-[10px] transition-colors disabled:opacity-50 disabled:pointer-events-none active:scale-[.99] focus-visible:outline-2 focus-visible:outline-offset-2"
  : "inline-flex items-center justify-center gap-2 font-semibold rounded-lg transition-colors disabled:opacity-50 disabled:pointer-events-none active:scale-[.99] focus-visible:outline-2 focus-visible:outline-offset-2";

const VARIANTS: Record<ButtonVariant, string> = isLawn()
  ? {
      primary: "bg-brand text-white active:bg-brand-dark hover:bg-brand-dark",
      // The redesign drops the border-plus-fill on secondary: a hairline on the
      // page surface is enough to read as "button" next to a solid primary.
      secondary:
        "bg-surface text-foreground border border-line active:bg-surface-muted hover:bg-surface-muted",
      ghost:
        "bg-transparent text-muted-strong active:bg-surface-muted hover:bg-surface-muted",
      danger: "bg-danger text-white active:opacity-90 hover:opacity-90",
    }
  : {
      // Fixed platform blue (user pref 2026-08-22: keep blue). Construction only.
      primary: "bg-blue-600 text-white active:bg-blue-700 hover:bg-blue-700",
      secondary:
        "bg-white text-gray-800 border border-gray-300 active:bg-gray-50 hover:bg-gray-50",
      ghost: "bg-transparent text-gray-700 active:bg-gray-100 hover:bg-gray-100",
      danger: "bg-red-600 text-white active:bg-red-700 hover:bg-red-700",
    };

const SIZES: Record<ButtonSize, string> = isLawn()
  ? {
      sm: "text-xs px-3 py-1.5",
      md: "text-[13.5px] px-[18px] py-2.5",
      lg: "text-base px-5 py-3",
    }
  : {
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