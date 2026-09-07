// Makes the standalone build of navItems.ts runnable under plain Node.
//
// Two problems, both of which stop the harness before its first assertion:
//   1. "@/lib/x" aliases survive into the emitted JS wherever the import is a
//      VALUE rather than a type. Node cannot resolve them.
//   2. lucide-react is a real dependency whose icons are values, so that import
//      survives too — and pulling React into a node harness to check a list of
//      strings is absurd. It is stubbed with a Proxy that answers to any icon
//      name, because the nav only ever passes the icons through.
import fs from "node:fs";
import path from "node:path";

const dir = ".nav-build";

fs.writeFileSync(
  path.join(dir, "lucide-stub.js"),
  "// Any icon name returns the same placeholder; the nav only passes them on.\n" +
    "export default new Proxy({}, { get: () => () => null });\n" +
    "export const __esModule = true;\n" +
    "const handler = { get: (_t, name) => (name === '__esModule' ? true : () => null) };\n" +
    "export const icons = new Proxy({}, handler);\n",
);

let changed = 0;
for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".js"))) {
  const p = path.join(dir, f);
  const before = fs.readFileSync(p, "utf8");
  let after = before.replace(/(["'])@\/lib\/([A-Za-z0-9_]+)\1/g, '"./$2.js"');
  // Rewrite the named icon import into destructuring off the Proxy, since a
  // named ESM import of a name the module does not export is a hard error.
  after = after.replace(
    /import\s*\{([^}]*)\}\s*from\s*["']lucide-react["'];?/g,
    (_m, names) =>
      `import __icons from "./lucide-stub.js";\nconst {${names
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean)
        .join(", ")}} = new Proxy({}, { get: () => () => null });`,
  );
  if (after !== before) {
    fs.writeFileSync(p, after);
    changed += 1;
  }
}
console.log(`rewrote specifiers in ${changed} file(s)`);
