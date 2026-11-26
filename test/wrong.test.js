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
};
let fail = 0;
for (const [id, lines] of Object.entries(WRONG)) {
  const s = byId[id].setup(); lines.forEach((l) => OD.run(s, l));
  const ok = byId[id].checks(s).every((c) => c.ok);
  console.log(`${ok ? "✗ accepted" : "✓ rejected"} ${id}: ${lines.join(" ; ")}`); if (ok) fail++;
}
process.exit(fail ? 1 : 0);
