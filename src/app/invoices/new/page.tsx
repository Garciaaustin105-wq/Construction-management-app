import { Suspense } from "react";
import NewInvoiceForm from "./NewInvoiceForm";

export default async function NewInvoicePage({
  searchParams,
}: {
  searchParams: Promise<{ job?: string }>;
}) {
  const params = await searchParams;
  const jobId = params.job ?? "";

  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-gray-50">
          <p className="text-gray-500">Loading...</p>
        </div>
      }
    >
      <NewInvoiceForm preselectedJobId={jobId} />
    </Suspense>
  );
}
