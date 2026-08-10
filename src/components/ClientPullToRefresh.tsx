"use client";

import PullToRefresh from "./PullToRefresh";

export default function ClientPullToRefresh({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <PullToRefresh className={className}>{children}</PullToRefresh>;
}