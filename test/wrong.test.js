// Tempting-but-wrong fixes must NOT pass the grader.
const fs = require("fs"), path = require("path"), vm = require("vm");
const ctx = { console, atob, btoa, URL }; ctx.window = ctx; vm.createContext(ctx);
for (const f of ["vendor/js-yaml.min.js", "js/core.js", "js/linux.js", "js/docker.js", "js/k8s.js", "js/tickets.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, "..", f), "utf8"), ctx);
const OD = ctx.OD, byId = Object.fromEntries(OD.TICKETS.map((t) => [t.id, t]));
const WRONG = {
  "PW-101": ["sudo rm /var/log/parcelwise/app.log"],                    // live log is still held open
  "PW-104": ["sudo chmod 777 /opt/scripts/db-backup.sh", "sudo /opt/scripts/db-backup.sh"], // world-writable root script
  "PW-105": ["sudo systemctl stop parcelwise-api", "kill -9 31877"],    // took the API down
  "PW-202": ["docker restart label-ui"],                                 // mapping still wrong
  "PW-204": ["docker rm -f tracking-api label-ui", "docker system prune -a -f"], // killed the services
  "PW-301": ["kubectl delete pod --all"],                                // the tag is still wrong
  "PW-403": ["kubectl scale deploy storefront --replicas=8"],            // faster, but no autoscaler
  "PW-106": ["sudo systemctl start parcelwise-api"],                       // up now, gone after the next reboot
  "PW-107": [{ edit: "sudo nano /etc/cron.d/daily-report", fn: (t) => t.replace("* 6 * * *", "0 * * * *") }], // once an hour, all day
  "PW-107b": [{ edit: "nano /etc/cron.d/daily-report", fn: (t) => t.replace("* 6 * * *", "0 6 * * *") }],      // no sudo: the save must be refused
  "PW-107c": ["sudo rm /etc/cron.d/daily-report"],                         // no more duplicates, no more report
  "PW-108": ["sudo chmod 777 /home/jlee/.ssh/authorized_keys"],            // anyone could add a key
  "PW-108b": ["sudo chmod 600 /home/jlee/.ssh/authorized_keys"],           // still owned by root
  "PW-205": ["docker restart statuspage-db"],                              // still no volume
  "PW-206": ["docker rm -f payments-worker", "docker run -d --name payments-worker --env-file ~/payments-worker.env --restart unless-stopped parcelwise/payments-worker:1.0"], // leaky image still in use
  "PW-207": ["docker run -d --name tracking-api-new -p 8081:8080 --env-file ~/tracking-api.env --restart unless-stopped parcelwise/tracking-api:1.9.2"], // wrong port and name
  "PW-307": ["kubectl rollout restart deploy/returns-api"],                // the pods were never the problem
  "PW-308": [{ edit: "kubectl edit deploy orders-api", fn: (t, y) => { const o = y.load(t); o.spec.template.spec.containers[0].env = [{ name: "DB_HOST", value: "orders-db" }, { name: "DB_PASSWORD", value: "0rd3rs-R0tated!-Nov" }]; return y.dump(o); } }], // password pasted into the Deployment
  "PW-309": [{ edit: "kubectl edit deploy scanner-gateway -n warehouse", fn: (t, y) => { const o = y.load(t); const c = o.spec.template.spec.containers[0]; delete c.envFrom; c.env = [{ name: "SCANNER_API_URL", value: "https://scanners.parcelwise.internal/api" }, { name: "SITE_ID", value: "LHR-02" }]; return y.dump(o); } }], // config hard-coded
  "PW-404": ["kubectl rollout undo deploy/payments-api", "kubectl rollout undo deploy/payments-api"], // flips between two broken releases
  "PW-405": ["kubectl scale deploy search-api --replicas=6"],               // more pods, but the HPA is still blind
  "PW-406": ["kubectl scale deploy load-generator -n loadtest --replicas=1"], // the HPA scales it straight back to 30
};
let fail = 0;
for (const [id, lines] of Object.entries(WRONG)) {
  const t = byId[id.replace(/[a-z]$/, "")], s = t.setup();
  for (const step of lines) {
    const r = OD.run(s, typeof step === "string" ? step : step.edit);
    if (typeof step !== "string") { if (!r.editor) { console.log(`✗ ${id}: '${step.edit}' did not open an editor`); fail++; continue; } r.editor.save(step.fn(r.editor.content, ctx.jsyaml)); }
  }
  const ok = t.checks(s).every((c) => c.ok);
  console.log(`${ok ? "✗ accepted" : "✓ rejected"} ${id}: ${lines.map((l) => (typeof l === "string" ? l : l.edit + " …")).join(" ; ")}`); if (ok) fail++;
}
process.exit(fail ? 1 : 0);
