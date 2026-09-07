// Rewrites "@/lib/x" to "./x.js" in the standalone build of the material
// take-off, so Node can resolve what tsc emitted.
//
// tsc erases a TYPE-only import but leaves a VALUE import's specifier exactly as
// written, and Node ESM resolves neither the "@/" alias nor an extensionless
// path. Without this the harness cannot start — which is how a harness in this
// repo was believed green for days without ever having run.
import fs from "node:fs";
import path from "node:path";

const dir = ".mat-build";
let changed = 0;
for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".js"))) {
  const p = path.join(dir, f);
  const before = fs.readFileSync(p, "utf8");
  const after = before.replace(/(["'])@\/lib\/([A-Za-z0-9_]+)\1/g, '"./$2.js"');
  if (after !== before) {
    fs.writeFileSync(p, after);
    changed += 1;
  }
}
console.log(`rewrote specifiers in ${changed} file(s)`);
