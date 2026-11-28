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
  "PW-109": ["sudo certbot renew", "sudo systemctl start certbot.timer"],  // nginx still serves the old cert, timer not enabled
  "PW-109b": ["sudo systemctl enable --now certbot.timer", "sudo systemctl reload nginx"], // nothing actually renewed
  "PW-110": [{ edit: "sudo nano /etc/nginx/sites-enabled/parcelwise", fn: (t) => t.replace("    location / {", "    deny 203.0.113.77;\n    location / {") }], // edited, never reloaded
  "PW-110b": [{ edit: "sudo nano /etc/nginx/sites-enabled/parcelwise", fn: (t) => t.replace("    location / {", "    deny all;\n    location / {") }, "sudo systemctl reload nginx"], // blocks everyone
  "PW-111": ["sudo apt update", "sudo apt install -y --allow-change-held-packages openssh-server", "sudo systemctl restart ssh"], // patched, but still held
  "PW-111b": ["sudo apt update", "sudo apt-mark unhold openssh-server", "sudo apt upgrade -y"], // old sshd still running
  "PW-208": ["docker build -t parcelwise/label-ui:2.1.1 /home/ops/label-ui", "docker rm -f label-ui", "docker run -d --name label-ui -p 80:8080 --restart unless-stopped parcelwise/label-ui:2.1.1"], // same vulnerable base
  "PW-209": ["sudo rm /var/lib/docker/containers/1a4f898daaaae1f0c9d2a7b4/1a4f898daaaae1f0c9d2a7b4-json.log"], // dockerd still holds it open
  "PW-209b": ["sudo truncate -s 0 /var/lib/docker/containers/1a4f898daaaae1f0c9d2a7b4/1a4f898daaaae1f0c9d2a7b4-json.log"], // space back, but it will fill up again
  "PW-310": ["kubectl set image deploy/storefront storefront=parcelwise/storefront:5.5.0"], // Helm still stuck and out of sync
  "PW-311": ["kubectl drain ip-10-0-11-42 --ignore-daemonsets --disable-eviction"], // bypassed the budget
  "PW-311b": ["kubectl delete pdb checkout-api", "kubectl drain ip-10-0-11-42 --ignore-daemonsets"], // removed the protection
  "PW-407": [{ edit: "sudo nano /opt/scripts/db-backup.sh", fn: (t) => t.replace("set -eu\n", "set -euo pipefail\n") }, "sudo /opt/scripts/db-backup.sh"], // fails loudly now, but still no backup
  "PW-407b": [{ edit: "sudo nano /root/.pgpass", fn: (t) => t.replace("Bk-2025-Summer!", "Bk-9f2!Rotated-Nov") }, "sudo /opt/scripts/db-backup.sh"], // backup works, but never restored and no pipefail
  "PW-408": [{ edit: "kubectl edit deploy checkout-api", fn: (t, y) => { const o = y.load(t); o.spec.template.spec.containers[0].readinessProbe = { httpGet: { path: "/healthz", port: 8080 } }; return y.dump(o); } }], // still replaces every pod at once
  "PW-408b": [{ edit: "kubectl edit deploy checkout-api", fn: (t, y) => { const o = y.load(t); o.spec.strategy.rollingUpdate = { maxUnavailable: 0, maxSurge: 1 }; return y.dump(o); } }], // traffic still hits cold pods
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
