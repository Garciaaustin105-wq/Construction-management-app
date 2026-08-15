import Skeleton, { SkeletonCard } from "@/components/Skeleton";

/**
 * Generic route loading shell — a skeleton TopBar (with the brand mark
 * placeholder) plus a column of skeleton cards. Used by every `loading.tsx`
 * so server-component data fetches show branded structure instead of a
 * blank screen on slow networks.
 */
export default function RouteLoading({ cards = 4 }: { cards?: number }) {
  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      {/* TopBar skeleton */}
      <div className="sticky top-0 z-40 bg-white border-b border-gray-200 px-4 py-3 flex items-center gap-2">
        <Skeleton className="w-7 h-7 rounded-md shrink-0" />
        <div className="space-y-1.5">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-3 w-20" />
        </div>
      </div>

      <main className="max-w-md lg:max-w-5xl mx-auto p-4 space-y-4">
        {Array.from({ length: cards }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </main>
    </div>
  );
}