# SPEC (local model) — nursery price list parser

Write ONE new file: `src/lib/plantImport.ts`. Pure functions only. No React,
no Supabase, no imports from anywhere except the one type import shown.

This is the deterministic half of `docs/plant-list-import.md`: turn the CSV a
nursery emails you into typed rows the office can review. It does **not** talk
to a database and it does **not** decide what to create or update — a later
pass does that.

## Background in three lines

A nursery price list is one row per species per size, and its price column is
**what they charge YOU** (your cost), never your sell price. Your sell price is
cost × a markup the office picks. Nurseries name columns inconsistently
(`Price`, `Wholesale`, `Your Cost`, `Ea.`, `Cont`, `Container`) so the columns
have to be guessed and then confirmed by a human.

## Exact contract — implement these five exports, no others

```ts
import type { PlantCategory } from "@/lib/plantProducts";

export type ImportField = "name" | "botanical_name" | "category" | "size" | "cost";

// field -> zero-based column index in the parsed row
export type ColumnMapping = Partial<Record<ImportField, number>>;

export type ParsedFile = { headers: string[]; rows: string[][] };

export type ImportRow = {
  rowNumber: number;              // 1-based data row, NOT counting the header
  name: string;
  botanical_name: string | null;
  category: PlantCategory;
  size: string;
  cost: number;
  unit_price: number;             // cost * markupMultiple, rounded to cents
  errors: string[];               // empty array = importable
};

export function parseDelimited(text: string): ParsedFile;
export function guessColumnMapping(headers: string[]): ColumnMapping;
export function parseMoney(raw: string): number | null;
export function buildImportRows(
  file: ParsedFile,
  mapping: ColumnMapping,
  markupMultiple: number
): ImportRow[];
```

## 1. `parseDelimited(text)`

- Auto-detect the delimiter: **tab if the first line contains a tab, else
  comma.** Nurseries send both.
- Handle RFC4180 quoting: `"Ilex vomitoria ""Nana"", 3 gal"` is ONE field
  containing `Ilex vomitoria "Nana", 3 gal`. A doubled `""` inside quotes is a
  literal quote.
- Strip a UTF-8 BOM from the very start if present. Excel adds one and it
  silently corrupts the first header.
- Accept `\r\n` and `\n`.
- Skip completely blank lines.
- First non-blank line is `headers`; the rest are `rows`.
- Trim each field.
- Empty input → `{ headers: [], rows: [] }`. Never throw.

## 2. `guessColumnMapping(headers)`

Match case-insensitively after lowercasing and removing everything that is not
a letter or digit (so `Your Cost`, `your_cost` and `YOUR-COST` all normalise to
`yourcost`).

Match a field to the FIRST header that matches any of its keys:

| Field | Keys (normalised) |
|---|---|
| `botanical_name` | `botanical`, `botanicalname`, `latin`, `latinname`, `scientificname` |
| `name` | `common`, `commonname`, `name`, `plant`, `plantname`, `description`, `item` |
| `size` | `size`, `container`, `cont`, `pot`, `potsize`, `containersize`, `grade` |
| `cost` | `price`, `cost`, `yourcost`, `wholesale`, `wholesaleprice`, `ea`, `each`, `unitprice`, `net` |
| `category` | `category`, `type`, `class`, `planttype` |

Two rules that matter:

- **Check `botanical_name` before `name`.** A header literally called
  `Botanical Name` contains `name`, and mapping it to `name` puts Latin names
  in the common-name column for the whole file.
- A field with no match is simply **absent** from the returned object. Do not
  guess an index, and do not default to 0.

## 3. `parseMoney(raw)`

Returns a number, or **`null`** when the value is not a price.

- Strip `$`, spaces, commas, and a trailing `.` — `"$1,250.00"` → `1250`.
- Accept a leading `-`? **No.** A negative price is not valid; return `null`.
- `""`, `"N/A"`, `"CALL"`, `"—"`, `"TBD"`, `"-"` → `null`. Nursery lists use all
  of these for "ask us", and turning them into `0` would quote plants as free.
- Anything that does not fully parse as a finite number → `null`.
- `"0"` → `0`. Zero is a real value; only unparseable is null.

## 4. `buildImportRows(file, mapping, markupMultiple)`

One `ImportRow` per data row, **in file order, never reordered, never dropped**.
A bad row comes back WITH its errors so the office can see and fix it — silently
skipping rows is the one behaviour that must not happen.

For each row:
- `rowNumber` = 1-based index among data rows.
- `name`: from `mapping.name`. If that is absent or the cell is empty, fall
  back to `botanical_name`'s cell. If both are empty →
  error `"No plant name"` and leave `name` as `""`.
- `botanical_name`: the cell, or `null` if absent/empty.
- `size`: the cell trimmed. Empty → error `"Missing size"`, leave `""`.
- `cost`: `parseMoney` of the cell. `null` → error
  `` `Could not read price "<the raw cell>"` `` and set `cost` to `0`.
- `category`: lowercase the cell and accept it ONLY if it is one of
  `"tree" | "palm" | "shrub" | "perennial" | "grass" | "annual" | "groundcover"`.
  Anything else, or absent → `"shrub"` with **no error** (nursery lists rarely
  carry a category; the office picks it in the preview).
- `unit_price`: `Math.round(cost * markupMultiple * 100) / 100`. If
  `markupMultiple` is not a finite number greater than 0, use `0` and add error
  `"Invalid markup"`.
- A row missing several things collects **several** errors, not just the first.

## Worked example — your output must match this exactly

Input text (comma-delimited, note the quoted field and the CALL price):

```
Botanical Name,Common Name,Cont,Price
Quercus virginiana,Live Oak,30 gal,$150.00
"Ilex vomitoria ""Nana""",Dwarf Yaupon,3 gal,"9.50"
Acer rubrum,Red Maple,45 box,CALL
Muhlenbergia capillaris,,1 gal,4.25
```

`guessColumnMapping(headers)` returns:

```ts
{ botanical_name: 0, name: 1, size: 2, cost: 3 }
```

`buildImportRows(file, mapping, 2.5)` returns 4 rows:

| # | name | botanical_name | size | cost | unit_price | errors |
|---|---|---|---|---|---|---|
| 1 | Live Oak | Quercus virginiana | 30 gal | 150 | 375 | [] |
| 2 | Dwarf Yaupon | `Ilex vomitoria "Nana"` | 3 gal | 9.5 | 23.75 | [] |
| 3 | Red Maple | Acer rubrum | 45 box | 0 | 0 | `['Could not read price "CALL"']` |
| 4 | Muhlenbergia capillaris | Muhlenbergia capillaris | 1 gal | 4.25 | 10.63 | [] |

Row 4 shows the name fallback: the common-name cell is empty, so the botanical
name is used for both. Row 2 shows that `""` became one literal `"`.
`4.25 * 2.5 = 10.625`, which rounds to `10.63`.

## Rules

- TypeScript, strict. No `any`. No new dependency — no csv library.
- Every export above, nothing extra exported.
- Pure: no I/O, no `Date.now()`, no randomness. Same input, same output.
- **Never throw.** Malformed input produces rows with errors.
- Comment WHY where a rule is non-obvious (the botanical-before-common ordering,
  and why `CALL` must not become `0`).
- `npx tsc --noEmit` must pass.

## Output format — obey exactly

Emit ONLY the complete contents of `src/lib/plantImport.ts`.
No prose before or after. No markdown fences. No backticks around the file.
Start with the import line and end with the last closing brace.
