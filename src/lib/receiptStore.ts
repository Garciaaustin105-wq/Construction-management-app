// Local-first receipt storage via IndexedDB. No dependency — vanilla wrapper.
// Client-only: every public function guards against SSR (no indexedDB on server).
//
// Only receipts a user chooses to "Share with office" are uploaded to Supabase.
// Everything else lives here on the device to avoid filling cloud storage.

export type LocalReceipt = {
  localId?: number; // auto-increment key (present after addReceipt)
  jobId: string;
  jobName: string;
  blob: Blob; // stamped JPEG
  thumb: string; // small data URL for list rendering
  vendor?: string;
  amount?: number; // dollars
  notes?: string;
  capturedAt: string; // ISO string — the tax/stamp date
  shared: boolean;
  remoteId?: string | null; // receipts.id once shared
  storagePath?: string | null; // bucket path once shared
  // Extra accounting rows (optional; only required by the office at share time)
  category?: string; // Materials / Fuel / Tools / Travel / Meals / Permits / Other
  tax?: number; // dollars
  paymentMethod?: string; // Cash / Personal Card / Company Card / Account
  receiptNo?: string; // vendor receipt / reference number
  costCodeId?: string | null; // tag against a cost code for budget-vs-actual
};

const DB_NAME = "cmapp";
const STORE = "receipts";
const VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB is not available"));
  }
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, {
          keyPath: "localId",
          autoIncrement: true,
        });
        store.createIndex("jobId", "jobId", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(
  db: IDBDatabase,
  mode: IDBTransactionMode
): IDBObjectStore {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Insert a receipt; returns the assigned localId. */
export async function addReceipt(
  r: Omit<LocalReceipt, "localId">
): Promise<number> {
  const db = await openDB();
  const key = await promisify(tx(db, "readwrite").add(r));
  return key as number;
}

/** All local receipts for a job (both shared and unshared). */
export async function getReceiptsByJob(jobId: string): Promise<LocalReceipt[]> {
  const db = await openDB();
  const idx = tx(db, "readonly").index("jobId");
  const all = await promisify(idx.getAll(jobId));
  return (all as LocalReceipt[]).sort((a, b) =>
    b.capturedAt.localeCompare(a.capturedAt)
  );
}

/** Patch a receipt (e.g. mark shared, edit vendor/amount). */
export async function updateReceipt(
  localId: number,
  patch: Partial<LocalReceipt>
): Promise<void> {
  const db = await openDB();
  const store = tx(db, "readwrite");
  const existing = (await promisify(store.get(localId))) as LocalReceipt;
  if (!existing) return;
  await promisify(store.put({ ...existing, ...patch, localId }));
}

/** Remove a local receipt. */
export async function deleteReceipt(localId: number): Promise<void> {
  const db = await openDB();
  await promisify(tx(db, "readwrite").delete(localId));
}