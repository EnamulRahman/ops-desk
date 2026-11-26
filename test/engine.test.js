// Headless check: every ticket starts broken, and its reference solution makes the grader pass.
const fs = require("fs"), path = require("path"), vm = require("vm");
const root = path.join(__dirname, "..");
const ctx = { console, atob, btoa, URL }; ctx.window = ctx; vm.createContext(ctx);
for (const f of ["vendor/js-yaml.min.js", "js/core.js", "js/linux.js", "js/docker.js", "js/k8s.js", "js/tickets.js", "js/briefs.js"]) vm.runInContext(fs.readFileSync(path.join(root, f), "utf8"), ctx, { filename: f });
const OD = ctx.OD, y = ctx.jsyaml, SOL = require("./solutions");
const verbose = process.argv.includes("-v"); let fail = 0;
for (const t of OD.TICKETS) {
  if (!t.brief || !t.brief.what || !t.brief.context || !t.brief.info.length) { console.log(`✗ ${t.id}: missing briefing`); fail++; }
  const s = t.setup();
  const before = t.checks(s);
  if (before.every((c) => c.ok)) { console.log(`✗ ${t.id}: already passes before any fix`); fail++; }
  for (const step of SOL[t.id] || []) {
    const line = typeof step === "string" ? step : step.edit;
    const r = OD.run(s, line);
    if (verbose) console.log(`\n[${t.id}] $ ${line}\n${r.out}`);
    if (typeof step !== "string") {
      if (!r.editor) { console.log(`✗ ${t.id}: '${line}' did not open an editor: ${r.out}`); fail++; break; }
      const res = r.editor.save(step.fn(r.editor.content, y));
      if (verbose) console.log("[saved]", res && (res.out || res));
    }
  }
  const after = t.checks(s);
  const bad = after.filter((c) => !c.ok);
  if (bad.length) { console.log(`✗ ${t.id}: ${bad.map((c) => c.label).join("; ")}`); fail++; } else console.log(`✓ ${t.id} ${t.title}`);
}
console.log(fail ? `\n${fail} problem(s)` : `\nAll ${OD.TICKETS.length} tickets solvable.`); process.exit(fail ? 1 : 0);
