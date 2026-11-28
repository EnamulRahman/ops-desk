// Ops Desk — the tickets. Each one builds a broken world, and its grader inspects that world (never your typing).
(() => {
  "use strict";
  const OD = window.OD, C = OD.commands, GB = OD.GB, MB = OD.MB;

  OD.RANKS = [
    { id: "intern", title: "DevOps Intern", blurb: "Linux on the web servers: disks, services, users, permissions, processes." },
    { id: "junior", title: "Junior DevOps Engineer", blurb: "Docker on the build box: containers, ports, images, disk." },
    { id: "platform", title: "Platform Engineer", blurb: "Kubernetes in production: pods, services, probes, rollouts." },
    { id: "sre", title: "Senior SRE", blurb: "Cross-cutting incidents: ingress, secrets, scaling under load." },
  ];
  OD.PEOPLE = {
    maya: { name: "Maya Okafor", role: "Head of Engineering", avatar: "👩🏾‍💼" },
    tom: { name: "Tom Reyes", role: "Customer Support Lead", avatar: "🧑🏽‍🔧" },
    sam: { name: "Sam Patel", role: "Backend Developer", avatar: "👨🏻‍💻" },
    omar: { name: "Omar Haddad", role: "Data Analyst", avatar: "🧔🏽" },
    lena: { name: "Lena Fischer", role: "Finance Manager", avatar: "👩🏼‍💼" },
    jess: { name: "Jess Morgan", role: "Security Engineer", avatar: "🕵🏻‍♀️" },
  };

  // ------------------------------------------------------------------ nginx (validator used by several tickets)
  OD.nginxCheck = (s) => {
    const files = s.fs.walk("/etc/nginx/sites-enabled").filter((x) => !x.dir).map((x) => x.p);
    for (const f of files) {
      const lines = s.fs.get(f).content.split("\n"); let depth = 0;
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i].replace(/#.*$/, "").trim(); if (!l) continue;
        depth += (l.match(/{/g) || []).length - (l.match(/}/g) || []).length;
        if (depth < 0) return { ok: false, err: `nginx: [emerg] unexpected "}" in ${f}:${i + 1}` };
        if (!/[{};]$/.test(l)) return { ok: false, err: `nginx: [emerg] directive "${l.split(/\s+/)[0]}" is not terminated by ";" in ${f}:${i + 1}` };
      }
      if (depth !== 0) return { ok: false, err: `nginx: [emerg] unexpected end of file, expecting "}" in ${f}:${lines.length}` };
    }
    return { ok: true };
  };
  C.nginx = (ctx) => {
    const s = ctx.state; if (!s.services.nginx) return { out: "nginx: command not found", code: 127 };
    if (ctx.args.includes("-t") || ctx.args.includes("-T")) { const r = OD.nginxCheck(s); return r.ok ? "nginx: the configuration file /etc/nginx/nginx.conf syntax is ok\nnginx: configuration file /etc/nginx/nginx.conf test is successful" : { out: `${r.err}\nnginx: configuration file /etc/nginx/nginx.conf test failed`, code: 1 }; }
    if (ctx.args.includes("-s")) return C.systemctl({ ...ctx, args: ["reload", "nginx"] });
    return { out: "nginx: [emerg] bind() to 0.0.0.0:80 failed (98: Address already in use)\nTip: manage nginx with systemctl.", code: 1 };
  };
  const nginxSite = `server {
    listen 80;
    server_name parcelwise.test www.parcelwise.test;

    access_log /var/log/nginx/parcelwise.access.log;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
`;
  const STORE_HTML = '<!doctype html><title>Parcelwise · Track your parcel</title><h1>📦 Parcelwise</h1><p>Enter your tracking number…</p>';

  // what nginx has in memory: the config and certificates as they were at its last start/reload
  const nginxSnap = (st) => ({ conf: st.fs.walk("/etc/nginx/sites-enabled").filter((x) => !x.dir).map((x) => st.fs.get(x.p).content).join("\n"), certs: OD.clone(st.certs || {}) });
  const stripComments = (t) => t.split("\n").map((l) => l.replace(/#.*$/, "")).join("\n");
  // a standard web server: nginx in front of the parcelwise-api app on :8080
  function webHost(opts = {}) {
    const s = OD.newHost({ host: opts.host || "web-01", diskBase: opts.diskBase, diskTotal: opts.diskTotal, files: {
      "/etc/nginx/sites-enabled/parcelwise": { content: opts.site || nginxSite, owner: "root" },
      "/etc/nginx/nginx.conf": { content: "user www-data;\nworker_processes auto;\ninclude /etc/nginx/sites-enabled/*;\n", owner: "root" },
      "/var/log/nginx/parcelwise.access.log": { content: '10.0.1.17 - - [26/Nov/2026:10:12:44 +0000] "GET / HTTP/1.1" 200 5213\n', owner: "root", mode: "640" },
      "/home/ops/README.txt": { content: "Welcome to web-01 (Parcelwise production web).\nApp: parcelwise-api on :8080 behind nginx on :80.\nLogs: /var/log/parcelwise/ and /var/log/nginx/\n" },
      ...(opts.files || {}) }, groups: opts.groups, users: opts.users });
    OD.addService(s, "parcelwise-api", { desc: "Parcelwise API", port: 8080, bind: "127.0.0.1", proc: { cmd: "/usr/local/bin/parcelwise-api --port 8080", user: "www", cpu: 2.1, mem: 6.4 }, holds: ["/var/log/parcelwise/app.log"], active: opts.apiActive !== false });
    OD.addService(s, "nginx", { desc: "A high performance web server and a reverse proxy server", port: 80, proc: { cmd: "nginx: master process /usr/sbin/nginx -g daemon on; master_process on;", user: "root", cpu: 0.1, mem: 0.4 }, check: (st) => { const r = OD.nginxCheck(st); if (r.ok) st.nginxLoaded = nginxSnap(st); return r.ok ? { ok: true } : { ok: false, journal: [r.err, "nginx: configuration file /etc/nginx/nginx.conf test failed"] }; }, active: opts.nginxActive });
    s.web = (url, st) => {
      if (!["localhost", "127.0.0.1", st.host, "parcelwise.test"].includes(url.hostname)) return null;
      const port = +(url.port || 80);
      const api = st.services["parcelwise-api"];
      const app = () => (OD.diskPct(st) >= 95 ? { status: 500, headers: { "Content-Type": "application/json" }, body: '{"error":"ENOSPC: no space left on device, write"}' } : url.pathname === "/health" ? { status: 200, headers: { "Content-Type": "application/json" }, body: '{"status":"ok"}' } : { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", Server: port === 80 ? "nginx/1.24.0 (Ubuntu)" : "parcelwise-api" }, body: STORE_HTML });
      if (port === 80) { if (!st.services.nginx.active) return null; return api.active ? app() : { status: 502, headers: { Server: "nginx/1.24.0 (Ubuntu)" }, body: "<html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway</h1></center><hr><center>nginx/1.24.0 (Ubuntu)</center></body></html>" }; }
      if (port === 8080) return api.active ? app() : null;
      return null;
    };
    return s;
  }
  const check = (label, ok) => ({ label, ok: !!ok });
  const http200 = (s, url) => { const r = OD.http(s, url); return !r.error && r.status === 200; };

  // ------------------------------------------------------------------ Kubernetes building blocks
  const dep = (name, image, o = {}) => OD.clone({
    apiVersion: "apps/v1", kind: "Deployment", metadata: { name, namespace: o.ns || "shop", labels: { app: name } },
    spec: { replicas: o.replicas ?? 2, selector: { matchLabels: { app: o.label || name } }, template: { metadata: { labels: { app: o.label || name, ...(o.extraLabels || {}) } }, spec: { containers: [{
      name, image, ports: [{ name: "http", containerPort: o.port || 8080 }], env: o.env, envFrom: o.envFrom,
      resources: o.resources || { requests: { cpu: "100m", memory: "128Mi" }, limits: { memory: "256Mi" } },
      readinessProbe: o.readiness === false ? undefined : { httpGet: { path: o.readyPath || "/healthz", port: o.probePort || o.port || 8080 }, initialDelaySeconds: 3, periodSeconds: 5 },
      livenessProbe: o.liveness === false ? undefined : { httpGet: { path: "/healthz", port: o.port || 8080 }, initialDelaySeconds: 10, periodSeconds: 10 },
    }] } } },
  });
  const svc = (name, selector, o = {}) => ({ apiVersion: "v1", kind: "Service", metadata: { name, namespace: o.ns || "shop", labels: { app: name } }, spec: { type: "ClusterIP", selector, ports: [{ name: "http", port: 80, targetPort: o.targetPort ?? "http", protocol: "TCP" }] } });
  const ing = (name, host, paths, cls = "nginx") => ({ apiVersion: "networking.k8s.io/v1", kind: "Ingress", metadata: { name, namespace: "shop" }, spec: { ingressClassName: cls, rules: [{ host, http: { paths: paths.map(([path, svcName]) => ({ path, pathType: "Prefix", backend: { service: { name: svcName, port: { number: 80 } } } })) } }] } });
  const cm = (name, data) => ({ apiVersion: "v1", kind: "ConfigMap", metadata: { name, namespace: "shop" }, data });
  const REG = {
    "parcelwise/storefront": ["5.4.0", "5.4.1", "5.5.0"], "parcelwise/checkout-api": ["3.1.4", "3.2.0"], "parcelwise/tracking-api": ["1.8.0", "1.9.2"],
    "parcelwise/notify": ["0.9.1"], "parcelwise/label-renderer": ["2.0.3"], "parcelwise/payments-api": ["3.9.2", "4.0.0", "4.0.1"], "parcelwise/search-api": ["1.2.0"], "parcelwise/status-page": ["1.0.1"],
    "parcelwise/returns-api": ["1.0.0"], "parcelwise/orders-api": ["2.4.1"], "parcelwise/scanner-gateway": ["2.3.0"],
  };
  const APPS = {
    "parcelwise/storefront": { port: 8080, body: STORE_HTML, cpuLoad: 180, memMi: 160 },
    "parcelwise/tracking-api": { port: 8080, routes: { "/track": { status: 200, body: '{"parcel":"PW-48213","status":"Out for delivery"}' } }, memMi: 140 },
    "parcelwise/checkout-api": { port: 8080, routes: { "/checkout": { status: 200, body: '{"ok":true,"order":"ORD-99121"}' } }, memMi: 180 },
  };
  function shopCluster(extra = {}) {
    const base = {
      ns: "shop", registry: { ...REG }, apps: { ...APPS, ...(extra.apps || {}) }, knownHosts: ["shop.parcelwise.test", "status.parcelwise.test"],
      deployments: [dep("storefront", "parcelwise/storefront:5.4.1", { replicas: 2 }), dep("tracking-api", "parcelwise/tracking-api:1.9.2"), ...(extra.deployments || [])],
      services: [svc("storefront", { app: "storefront" }), svc("tracking-api", { app: "tracking-api" }), ...(extra.services || [])],
      ingresses: extra.ingresses || [ing("shop", "shop.parcelwise.test", [["/", "storefront"], ["/track", "tracking-api"], ...(extra.routes || [])])],
      configmaps: extra.configmaps || [], secrets: extra.secrets || [], hpas: extra.hpas || [],
    };
    return base;
  }
  function k8sHost(extra) { const s = OD.newHost({ host: "ops-bastion", files: { "/home/ops/README.txt": { content: "ops-bastion: jump box for the parcelwise-prod EKS cluster.\nkubectl is configured; the default namespace is 'shop'.\nThis box is on the cluster network, so Service DNS names (e.g. storefront.shop) resolve.\n" } } }); OD.addK8s(s, shopCluster(extra)); return s; }
  const podsOf = (s, name) => OD.k8sPods(s, "shop").filter((p) => p.owner && p.owner.metadata.name === name);
  const allReady = (s, name) => { const ps = podsOf(s, name); return ps.length > 0 && ps.every((p) => p.ev.ready) && ps.every((p) => p.hash === ps[0].hash); };
  const depObj = (s, name) => s.k8s.deployments.find((d) => d.metadata.name === name);
  const podsIn = (s, ns, name) => OD.k8sPods(s, ns).filter((p) => p.owner && p.owner.metadata.name === name);
  const cpuM = (v) => (v ? (String(v).endsWith("m") ? +String(v).slice(0, -1) : +v * 1000) : 0);
  const cronLine = (s, file, cmd) => { const f = s.fs.get(file); const l = f && f.content.split("\n").map((x) => x.trim()).find((x) => x && !x.startsWith("#") && x.includes(cmd)); return l ? l.split(/\s+/) : null; };
  const container = (s, name) => (depObj(s, name) || { spec: { template: { spec: { containers: [{}] } } } }).spec.template.spec.containers[0];

  // ------------------------------------------------------------------ the tickets
  OD.TICKETS = [
    // ===================================================== INTERN: Linux
    { id: "PW-101", rank: 0, xp: 100, priority: "High", from: "tom", title: "Website says \"something went wrong\"",
      message: "Customers can't load tracking pages. The app is throwing errors and someone mentioned 'disk full'? Can you take a look at web-01? 🙏",
      topic: "Disk space",
      setup: () => {
        const logs = {}; for (let i = 1; i <= 4; i++) logs[`/var/log/parcelwise/app.log.${i}`] = { content: `[2026-11-${20 + i}] request served in ${40 + i}ms (×millions)`, size: Math.round(6.2 * GB), owner: "www", group: "www", mode: "640", mtime: `Nov ${26 - i} 00:00` };
        logs["/var/log/parcelwise/app.log"] = { content: '{"level":"error","msg":"ENOSPC: no space left on device, write"}', size: Math.round(3.4 * GB), owner: "www", group: "www", mode: "640" };
        return webHost({ diskBase: 10 * GB, files: logs });
      },
      sop: ["Confirm the symptom: <code>df -h</code> shows how full each filesystem is.", "Find what's big: <code>sudo du -sh /var/log/*</code>, then go one level deeper.", "Old rotated logs (<code>.1</code>, <code>.2</code>…) are usually safe to delete. The <b>live</b> log is held open by the app.", "Check the result with <code>df -h</code> again, and that the app answers: <code>curl -s localhost/health</code>."],
      hints: ["Start with df -h, then hunt with du -sh. Which directory under /var/log is huge?", "Look in /var/log/parcelwise: there are rotated logs app.log.1 … app.log.4. They're old and big.", "sudo rm /var/log/parcelwise/app.log.*   (leave app.log alone: the app is writing to it)"],
      checks: (s) => [check("Root filesystem is below 80% used", OD.diskPct(s) < 80), check("parcelwise-api is still running", s.services["parcelwise-api"].active), check("The site answers 200 again", http200(s, "http://localhost/"))],
      debrief: "Disks fill up with logs more than anything else. Rotated logs are safe to remove. Deleting a file a process still has open does <b>not</b> free its space until that process closes it (<code>lsof +L1</code> finds them, and restarting the service releases it). The real fix is <b>logrotate</b> with compression and a retention limit, plus an alert at 80%." },

    { id: "PW-102", rank: 0, xp: 100, priority: "Critical", from: "sam", title: "Site down after my nginx change",
      message: "I tweaked the nginx config on web-01 to add a header and restarted it… now the whole site is down 😬 Connection refused. Sorry!!",
      topic: "Services & config",
      setup: () => webHost({ site: nginxSite.replace("proxy_pass http://127.0.0.1:8080;", "proxy_pass http://127.0.0.1:8080").replace("proxy_set_header Host $host;", "proxy_set_header Host $host;\n        add_header X-Served-By web-01;") }),
      sop: ["Is it running? <code>systemctl status nginx</code>.", "Why did it fail? <code>sudo journalctl -u nginx -n 20</code>, or test the config with <code>sudo nginx -t</code>.", "Fix the file it names: <code>sudo nano /etc/nginx/sites-enabled/parcelwise</code>.", "Test again, then <code>sudo systemctl restart nginx</code>, and <code>curl -I localhost</code>."],
      hints: ["The service failed to start. What does nginx -t say about the config?", "nginx -t points to a line in /etc/nginx/sites-enabled/parcelwise. Every directive must end with ;", "sudo nano /etc/nginx/sites-enabled/parcelwise → add the missing ; after proxy_pass http://127.0.0.1:8080 → sudo nginx -t → sudo systemctl restart nginx"],
      checks: (s) => [check("nginx config passes nginx -t", OD.nginxCheck(s).ok), check("nginx is running", s.services.nginx.active), check("http://localhost returns 200", http200(s, "http://localhost/"))],
      debrief: "Always run <code>nginx -t</code> <b>before</b> reloading. A <code>reload</code> with a bad config keeps the old config running, while a <code>restart</code> takes the site down. In a team, config changes go through Git and CI, with the syntax test as a pipeline step." },

    { id: "PW-103", rank: 0, xp: 80, priority: "Normal", from: "maya", title: "New starter needs access",
      message: "Jordan Lee joins the platform team today 🎉 Please create a login on web-01: username <b>jlee</b>, home directory, bash as the shell, and in the <b>deploy</b> group. No sudo yet, please.",
      topic: "Users & groups",
      setup: () => webHost({ groups: { deploy: ["ops"] } }),
      sop: ["Create users with <code>sudo useradd</code>: <code>-m</code> makes the home folder, <code>-s</code> sets the shell, <code>-G</code> adds groups.", "Check with <code>id jlee</code> and <code>getent passwd jlee</code>.", "Adding to an existing user later: <code>sudo usermod -aG group user</code>. Without <b>-a</b> you <i>replace</i> their groups."],
      hints: ["You need root for this: sudo useradd …", "One command can do it all: home dir, shell and the extra group.", "sudo useradd -m -s /bin/bash -G deploy jlee   then   id jlee"],
      checks: (s) => [check("User jlee exists", !!s.users.jlee), check("jlee has a home directory /home/jlee", s.fs.isDir("/home/jlee")), check("jlee's shell is bash", s.users.jlee && /bash$/.test(s.users.jlee.shell || "")), check("jlee is in the deploy group", (s.groups.deploy || []).includes("jlee")), check("jlee does NOT have sudo", !(s.groups.sudo || []).includes("jlee"))],
      debrief: "Least privilege from day one: give people the groups they need, not sudo. In real companies accounts come from a central identity provider (SSO, SSM Session Manager) rather than per-server users, but the ideas of users, groups and permissions are the same." },

    { id: "PW-104", rank: 0, xp: 100, priority: "High", from: "omar", title: "No database backups for 3 days",
      message: "Hi! The nightly database backup on web-01 hasn't produced a file since Monday. Finance needs one before month-end. Can you get it working and take a fresh backup now?",
      topic: "Permissions & cron",
      setup: () => {
        const s = webHost({ files: {
          "/opt/scripts/db-backup.sh": { content: "#!/bin/bash\nset -euo pipefail\n# Nightly logical backup of the parcelwise database\nOUT=/var/backups/parcelwise-$(date +%F).sql.gz\npg_dump parcelwise | gzip > \"$OUT\"\necho \"backup written to $OUT\"\n", owner: "root", mode: "644" },
          "/etc/cron.d/db-backup": { content: "# m h dom mon dow user command\n0 2 * * * root /opt/scripts/db-backup.sh >> /var/log/db-backup.log 2>&1\n", owner: "root" },
          "/var/log/db-backup.log": { content: "/bin/sh: 1: /opt/scripts/db-backup.sh: Permission denied\n/bin/sh: 1: /opt/scripts/db-backup.sh: Permission denied\n/bin/sh: 1: /opt/scripts/db-backup.sh: Permission denied\n", owner: "root" },
          "/var/backups/parcelwise-2026-11-22.sql.gz": { content: "", size: 412 * MB, owner: "root", mtime: "Nov 23 02:00" },
        } });
        s.scripts["/opt/scripts/db-backup.sh"] = (st, ctx) => {
          if (!OD.isRoot(ctx)) return { out: "/opt/scripts/db-backup.sh: line 5: /var/backups/parcelwise-2026-11-26.sql.gz: Permission denied", code: 1 };
          st.fs.write("/var/backups/parcelwise-2026-11-26.sql.gz", "", { owner: "root", size: 418 * MB, mtime: "Nov 26 10:31" });
          return "backup written to /var/backups/parcelwise-2026-11-26.sql.gz";
        };
        return s;
      },
      sop: ["Read the evidence first: <code>cat /etc/cron.d/db-backup</code> and <code>cat /var/log/db-backup.log</code>.", "Check permissions with <code>ls -l</code>. A script needs the <b>x</b> bit to run.", "Grant only what's needed: <code>chmod +x</code> or <code>755</code>, never <code>777</code>.", "Run it once by hand the same way cron does (as root) to prove it works."],
      hints: ["What does /var/log/db-backup.log keep saying?", "ls -l /opt/scripts/db-backup.sh: the script isn't executable.", "sudo chmod 755 /opt/scripts/db-backup.sh && sudo /opt/scripts/db-backup.sh"],
      checks: (s) => { const f = s.fs.get("/opt/scripts/db-backup.sh"); return [check("The backup script is executable", f && +f.mode[0] & 1), check("The script isn't writable by everyone (no 777)", f && !(+f.mode[2] & 2)), check("Today's backup file exists", s.fs.isFile("/var/backups/parcelwise-2026-11-26.sql.gz"))]; },
      debrief: "Cron failures are silent unless you log them, which this cron line did. Most 'script won't run' problems are permissions, the wrong user, or a missing PATH. <code>chmod 777</code> 'fixes' it by letting anyone rewrite a script that runs as root, which is a privilege-escalation hole. Next steps: alert when no backup file appears, and <b>test restores</b>." },

    { id: "PW-105", rank: 0, xp: 100, priority: "High", from: "tom", title: "Everything is crawling",
      message: "web-01 has been super slow for the last hour: pages take ages and the support dashboard times out. Nothing was deployed today. Help!",
      topic: "Processes",
      setup: () => {
        const s = webHost();
        s.procs.push({ pid: 31877, user: "ops", cpu: 98.7, mem: 31.2, cmd: "python3 /opt/reports/export.py --all-time --format=csv", start: "09:24", ignoreTerm: true });
        s.fs.write("/opt/reports/export.py", "# ad-hoc report export, started manually by Omar\n", { owner: "ops" }, true);
        return s;
      },
      sop: ["Find the hog: <code>top</code> (or <code>ps aux --sort=-%cpu</code>).", "Identify it before killing it: who owns it, and is it part of a service?", "Ask nicely first with <code>kill PID</code> (SIGTERM). Use <code>kill -9 PID</code> only if it ignores you.", "Don't touch the app or nginx processes. Verify with <code>uptime</code>."],
      hints: ["top shows one process using ~99% CPU. What is it?", "It's a manual report export (python3 /opt/reports/export.py), not part of the website.", "kill 31877 → check ps → it ignored SIGTERM → kill -9 31877"],
      checks: (s) => [check("The runaway export.py process is gone", !s.procs.some((p) => p.cmd.includes("export.py"))), check("parcelwise-api is still running", s.services["parcelwise-api"].active), check("nginx is still running", s.services.nginx.active)],
      debrief: "Find it, identify it, then stop it gently: SIGTERM first, SIGKILL (-9) only if needed, because -9 skips clean-up. Long-running jobs shouldn't share a box with production traffic. Run them on a worker, with <code>nice</code>, or as a scheduled job with resource limits, and tell the person who started it (Omar)." },

    { id: "PW-106", rank: 0, xp: 100, priority: "Critical", from: "tom", title: "502 after last night's patching",
      message: "web-02 got its security patches and a reboot overnight. Since then customers just get a <b>502 Bad Gateway</b> page. nginx is up, so what's going on? 😟",
      topic: "systemd",
      setup: () => {
        const s = webHost({ host: "web-02", apiActive: false, files: { "/home/ops/README.txt": { content: "Welcome to web-02 (Parcelwise production web).\nApp: parcelwise-api on :8080 behind nginx on :80.\nLogs: /var/log/parcelwise/ and /var/log/nginx/\n" } } });
        s.services["parcelwise-api"].enabled = false;
        s.uptime = "47 min";
        const boot = "-- Boot 7c1e0f2a9b4d4e5f8a6b3c2d1e0f9a8b --";
        s.journal["parcelwise-api"] = ["systemd[1]: Stopping parcelwise-api.service - Parcelwise API...", "systemd[1]: parcelwise-api.service: Deactivated successfully.", "systemd[1]: Stopped parcelwise-api.service - Parcelwise API.", boot];
        s.journal.nginx = [boot, "systemd[1]: Starting nginx.service - A high performance web server and a reverse proxy server...", "systemd[1]: Started nginx.service - A high performance web server and a reverse proxy server."];
        s.fs.write("/var/log/nginx/error.log", '2026/11/26 09:44:02 [error] 811#811: *1 connect() failed (111: Connection refused) while connecting to upstream, client: 10.0.1.17, server: parcelwise.test, request: "GET / HTTP/1.1", upstream: "http://127.0.0.1:8080/", host: "parcelwise.test"\n', { owner: "root", mode: "640" }, true);
        return s;
      },
      sop: ["A 502 from nginx means nginx is fine but the app behind it isn't answering. Check the app: <code>systemctl status parcelwise-api</code>.", "Read the <b>Loaded:</b> line too. <i>disabled</i> means systemd won't start it at boot.", "<code>sudo systemctl start NAME</code> starts it now. <code>sudo systemctl enable NAME</code> starts it on every boot. <code>enable --now</code> does both.", "Verify: <code>curl -I localhost</code> and <code>systemctl is-enabled parcelwise-api</code>."],
      hints: ["curl localhost gives 502. Is the app on :8080 running? systemctl status parcelwise-api", "It's inactive AND disabled, so it didn't come back after the reboot. Start it, and make it start on boot.", "sudo systemctl enable --now parcelwise-api   then   curl -I localhost"],
      checks: (s) => [check("parcelwise-api is running", s.services["parcelwise-api"].active), check("parcelwise-api starts on boot (enabled)", s.services["parcelwise-api"].enabled), check("nginx is still running", s.services.nginx.active), check("http://localhost returns 200", http200(s, "http://localhost/"))],
      debrief: "systemd has two separate switches: <b>start</b> (run it now) and <b>enable</b> (run it at every boot). Starting without enabling fixes today and breaks again on the next reboot, which is how the same incident comes back at 3am. After patching, check every service came back (<code>systemctl --failed</code>), and have monitoring call the real URL, not just check that the server answers ping." },

    { id: "PW-107", rank: 0, xp: 90, priority: "Normal", from: "omar", title: "60 copies of the daily report",
      message: "Since yesterday I get the daily sales report email <b>60 times</b> every morning, one a minute from 6:00 to 6:59 😅 It should arrive once, at 6:00. Sam changed the cron job on web-01 yesterday to move it from 7 to 6.",
      topic: "Cron",
      setup: () => webHost({ files: {
        "/etc/cron.d/daily-report": { content: "# Daily sales report, emailed to the analytics team\n# m h dom mon dow user command\n* 6 * * * root /opt/reports/daily-report.sh >> /var/log/daily-report.log 2>&1\n", owner: "root" },
        "/opt/reports/daily-report.sh": { content: "#!/bin/bash\n# Builds yesterday's sales CSV and emails it to analytics@parcelwise.test\n", owner: "root", mode: "755" },
        "/var/log/daily-report.log": { content: Array.from({ length: 60 }, (_, i) => `2026-11-26 06:${String(i).padStart(2, "0")}:01 report sent to analytics@parcelwise.test (rows: 18412)`).join("\n") + "\n", owner: "root" },
      } }),
      sop: ["Read the schedule: <code>cat /etc/cron.d/daily-report</code>. The five time fields are <b>minute hour day-of-month month day-of-week</b>.", "<code>*</code> means 'every'. So <code>* 6 * * *</code> runs every minute of the 6 o'clock hour.", "Edit it with <code>sudo nano /etc/cron.d/daily-report</code>. Files in <code>/etc/cron.d</code> have a <b>user</b> column before the command.", "cron re-reads <code>/etc/cron.d</code> by itself, so no restart is needed."],
      hints: ["Look at the first field of the schedule line. What does * mean in the minute column?", "* 6 * * * = every minute from 06:00 to 06:59. You want minute 0 only.", "sudo nano /etc/cron.d/daily-report → change '* 6 * * *' to '0 6 * * *' → save"],
      checks: (s) => { const f = s.fs.get("/etc/cron.d/daily-report"), l = cronLine(s, "/etc/cron.d/daily-report", "/opt/reports/daily-report.sh") || []; return [check("The report job is still scheduled", l.length >= 7), check("It runs once, at minute 0", l[0] === "0" || l[0] === "00"), check("…at 6 in the morning, every day", (l[1] === "6" || l[1] === "06") && l[2] === "*" && l[3] === "*" && l[4] === "*"), check("It still runs as root", l[5] === "root"), check("The cron file isn't writable by everyone", f && !(+f.mode[2] & 2))]; },
      debrief: "Cron syntax is easy to get subtly wrong: <code>*</code> in the minute field means every minute. Check schedules with a tool like crontab.guru before shipping them, and keep cron files in Git so someone reviews the change. Jobs that send email or charge cards should also be <b>idempotent</b>, meaning a duplicate run doesn't send a duplicate email." },

    { id: "PW-108", rank: 0, xp: 100, priority: "High", from: "maya", title: "Jordan can't log in with their SSH key",
      message: "Jordan (<b>jlee</b>) still can't SSH into web-01: <code>Permission denied (publickey)</code>. Sam copied their public key into place this morning. Can you sort it out?",
      topic: "SSH & permissions",
      setup: () => {
        const refused = (t, port) => [`sshd[${2200 + port % 97}]: Authentication refused: bad ownership or modes for file /home/jlee/.ssh/authorized_keys`, `sshd[${2200 + port % 97}]: Connection closed by authenticating user jlee 10.0.4.23 port ${port} [preauth]`].map((l) => `Nov 26 ${t} web-01 ${l}`);
        const lines = [...refused("09:12:40", 51122), ...refused("09:13:05", 51130), "Nov 26 09:20:11 web-01 sshd[2301]: Accepted publickey for ops from 10.0.4.8 port 40022 ssh2: ED25519 SHA256:q1Xv…", ...refused("10:02:51", 52004)];
        const s = webHost({ users: { jlee: { uid: 1001, home: "/home/jlee", shell: "/bin/bash" } }, groups: { deploy: ["ops", "jlee"], jlee: ["jlee"] }, files: {
          "/home/jlee/.ssh/authorized_keys": { content: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK3vYw0h9mJq2sT8pXbFzL4cR6nE1uD7oA5iG3wQ0yHk jordan@parcelwise-laptop\n", owner: "root", group: "root", mode: "666" },
          "/var/log/auth.log": { content: lines.join("\n") + "\n", owner: "root", group: "adm", mode: "640" },
        } });
        s.journal.ssh = lines.map((l) => l.replace(/^Nov 26 \S+ web-01 /, ""));
        return s;
      },
      sop: ["Read the SSH server's log: <code>sudo tail /var/log/auth.log</code> (or <code>sudo journalctl -u ssh</code>).", "Check the key file: <code>ls -la /home/jlee/.ssh/</code>. Who owns <code>authorized_keys</code>, and who can write to it?", "sshd ignores a key file that someone other than its user could edit. It must belong to the user and not be writable by group or others.", "<code>sudo chown jlee:jlee FILE</code> and <code>sudo chmod 600 FILE</code>."],
      hints: ["What does /var/log/auth.log say about jlee? (it's root-only, so use sudo)", "'bad ownership or modes': the file is owned by root and is mode 666, so anyone can write to it.", "sudo chown jlee:jlee /home/jlee/.ssh/authorized_keys && sudo chmod 600 /home/jlee/.ssh/authorized_keys"],
      checks: (s) => { const f = s.fs.get("/home/jlee/.ssh/authorized_keys"), m = f ? f.mode.split("").map(Number) : [0, 0, 0]; return [check("Jordan's key is still in authorized_keys", f && f.content.includes("jordan@parcelwise-laptop")), check("The file belongs to jlee", f && f.owner === "jlee"), check("Only jlee can change it (not writable by group or others)", f && !(m[1] & 2) && !(m[2] & 2)), check("jlee can still read it", f && m[0] & 4)]; },
      debrief: "SSH is strict on purpose: if anyone else could edit <code>authorized_keys</code>, they could add their own key and log in as that user. It wants the file owned by the user and not writable by anyone else (600 is normal, and <code>~/.ssh</code> itself should be 700). Files you copy with sudo end up owned by root, so fix the owner afterwards. Better still, manage keys with config management, or avoid them with SSO-based access such as AWS SSM Session Manager." },

    { id: "PW-109", rank: 0, xp: 110, priority: "Critical", from: "tom", title: "\"Your connection is not private\"",
      message: "Customers are getting a big red <b>'Your connection is not private'</b> warning on https://parcelwise.test since this morning, and most of them leave 😬 Didn't we set up automatic certificate renewal ages ago?",
      topic: "TLS certificates",
      setup: () => {
        const live = "/etc/letsencrypt/live/parcelwise.test", cert = `${live}/fullchain.pem`, key = `${live}/privkey.pem`;
        const site = nginxSite.replace("    listen 80;\n", `    listen 80;\n    listen 443 ssl;\n    ssl_certificate ${cert};\n    ssl_certificate_key ${key};\n`);
        const pem = "-----BEGIN CERTIFICATE-----\nMIIFBjCCA+6gAwIBAgISBKGx7oQh9uSn0Qd0pXhFh2mZMA0GCSqGSIb3DQEBCwUA\n…\n-----END CERTIFICATE-----\n";
        const s = webHost({ site, files: {
          [cert]: { content: pem, owner: "root" }, [key]: { content: "-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----\n", owner: "root", mode: "600" },
          "/etc/letsencrypt/renewal/parcelwise.test.conf": { content: "# renew_before_expiry = 30 days\nversion = 2.11.0\ncert = /etc/letsencrypt/live/parcelwise.test/cert.pem\nfullchain = /etc/letsencrypt/live/parcelwise.test/fullchain.pem\n\n[renewalparams]\nauthenticator = webroot\nwebroot_path = /var/www/letsencrypt,\nserver = https://acme-v02.api.letsencrypt.org/directory\n", owner: "root" },
          "/var/log/letsencrypt/letsencrypt.log": { content: "2026-08-27 09:14:03,112:INFO:certbot._internal.renewal:Cert not yet due for renewal\n2026-08-27 21:14:03,509:INFO:certbot._internal.main:Renewing an existing certificate for parcelwise.test and www.parcelwise.test\n2026-08-27 21:14:09,001:INFO:certbot._internal.renewal:Congratulations, all renewals succeeded\n", owner: "root", mode: "600" },
        } });
        s.certs = { [cert]: { subject: "CN = parcelwise.test", issuer: "C = US, O = Let's Encrypt, CN = R11", notBefore: "Aug 27 20:15:31 2026 GMT", notAfter: "Nov 25 20:15:30 2026 GMT", notAfterIso: "2026-11-25 20:15:30+00:00", serial: "04A1B17EE842F6E4A7D1077D29785876", san: ["parcelwise.test", "www.parcelwise.test"], expired: true } };
        s.letsencrypt = { "parcelwise.test": { cert, key, renewed: { notBefore: "Nov 26 09:31:07 2026 GMT", notAfter: "Feb 24 09:31:06 2027 GMT", notAfterIso: "2027-02-24 09:31:06+00:00", serial: "037F5C02D9E4A0B3F1C8D2E6A9B4C7D1" } } };
        s.nginxLoaded = nginxSnap(s);
        OD.addService(s, "certbot.timer", { desc: "Run certbot twice daily", active: false, activates: "certbot.service", last: "Wed 2026-09-02 11:02:44 UTC" });
        s.services["certbot.timer"].enabled = false;
        s.journal["certbot.timer"] = ["systemd[1]: certbot.timer: Deactivated successfully.", "systemd[1]: Stopped certbot.timer - Run certbot twice daily.", "systemd[1]: Removed \"/etc/systemd/system/timers.target.wants/certbot.timer\"."];
        s.tlsServing = () => (s.services.nginx.active ? (s.nginxLoaded.certs || {})[cert] : null);
        const web = s.web;
        s.web = (url, st) => { if (url.protocol === "https:" && ["localhost", "parcelwise.test", "www.parcelwise.test", st.host].includes(url.hostname)) { const c = st.tlsServing(); if (!c) return null; if (c.expired) return { error: 60, msg: "curl: (60) SSL certificate problem: certificate has expired\nMore details here: https://curl.se/docs/sslcerts.html" }; } return web(url, st); };
        return s;
      },
      sop: ["Confirm it: <code>curl -I https://parcelwise.test</code>, then look at the certificate: <code>openssl x509 -in /etc/letsencrypt/live/parcelwise.test/fullchain.pem -noout -dates</code>.", "Let's Encrypt certificates last 90 days, and renewal is meant to run automatically. Is it? <code>systemctl list-timers</code> / <code>systemctl status certbot.timer</code>.", "Renew: <code>sudo certbot renew</code>. Then make nginx load the new certificate: it keeps the old one in memory until you <code>sudo systemctl reload nginx</code>.", "Turn automatic renewal back on: <code>sudo systemctl enable --now certbot.timer</code>."],
      hints: ["openssl x509 … -noout -dates on the certificate. When did it expire? And why didn't it renew?", "certbot.timer is disabled, so nothing has tried to renew since September. Renew by hand, reload nginx, and re-enable the timer.", "sudo certbot renew && sudo systemctl reload nginx && sudo systemctl enable --now certbot.timer && curl -I https://parcelwise.test"],
      checks: (s) => { const c = s.tlsServing && s.tlsServing(), t = s.services["certbot.timer"]; return [check("The certificate on disk has been renewed", !s.certs["/etc/letsencrypt/live/parcelwise.test/fullchain.pem"].expired), check("nginx is serving the renewed certificate", c && !c.expired), check("Automatic renewal is back on (certbot.timer enabled and running)", t.enabled && t.active), check("https://parcelwise.test returns 200", http200(s, "https://parcelwise.test/"))]; },
      debrief: "Expired certificates are one of the most common avoidable outages, and they usually fail for boring reasons: the renewal timer was switched off, the renewal ran but nginx was never reloaded, or a firewall blocked the challenge. Run <code>certbot renew --dry-run</code> after any change, add a <b>deploy hook</b> (<code>--deploy-hook \"systemctl reload nginx\"</code>) so new certificates are picked up automatically, and alert on certificate expiry (for example 14 days out) from outside the server. In AWS, certificates on a load balancer from ACM renew themselves." },

    { id: "PW-110", rank: 0, xp: 110, priority: "High", from: "jess", title: "Someone is scraping tracking numbers",
      message: "The tracking pages have been slow all morning and I think someone is scraping us: thousands of requests for tracking numbers in order 🕵🏻‍♀️ Can you find the IP address in web-01's nginx access log and block it at nginx? Please don't block real customers or our office (10.0.1.17)!",
      topic: "Log analysis",
      setup: () => {
        const bad = "203.0.113.77", ok = ["10.0.1.17", "81.2.69.142", "86.140.11.23", "92.40.177.8", "185.31.18.4", "51.140.22.97", "2.29.61.200"];
        const ts = (i) => `26/Nov/2026:${String(8 + Math.floor(i / 120)).padStart(2, "0")}:${String(Math.floor(i / 2) % 60).padStart(2, "0")}:${String((i * 7) % 60).padStart(2, "0")} +0000`;
        const lines = [];
        for (let i = 0; i < 420; i++) {
          if (i % 7 !== 3 && i % 11 !== 5) lines.push(`${bad} - - [${ts(i)}] "GET /track?id=PW-${String(480000 + i).padStart(6, "0")} HTTP/1.1" ${i % 9 === 0 ? 429 : 200} 512 "-" "python-requests/2.32.3"`);
          else { const ip = ok[Math.floor(i / 5) % ok.length]; lines.push(`${ip} - - [${ts(i)}] "GET ${["/", "/track?id=PW-48213", "/checkout", "/health", "/returns"][i % 5]} HTTP/1.1" 200 ${4000 + i} "https://parcelwise.test/" "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X)"`); }
        }
        return webHost({ files: { "/var/log/nginx/parcelwise.access.log": { content: lines.join("\n") + "\n", owner: "root", group: "adm", mode: "640", size: 61 * OD.MB } } });
      },
      sop: ["The access log is <code>/var/log/nginx/parcelwise.access.log</code> (root-only, so use <code>sudo</code>). Each line starts with the client's IP address.", "Count requests per IP: <code>sudo awk '{print $1}' FILE | sort | uniq -c | sort -rn | head</code>. Check what the top one asks for with <code>sudo grep IP FILE | tail</code>.", "Block it in the site config: add <code>deny IP;</code> inside the <code>server { }</code> block with <code>sudo nano /etc/nginx/sites-enabled/parcelwise</code>.", "<code>sudo nginx -t</code>, then <code>sudo systemctl reload nginx</code>. An edit does nothing until nginx loads it."],
      hints: ["Which IP address appears most often in the access log? awk can print the first field of each line.", "sudo awk '{print $1}' /var/log/nginx/parcelwise.access.log | sort | uniq -c | sort -rn | head  → 203.0.113.77, user agent python-requests, walking through tracking numbers.", "sudo nano /etc/nginx/sites-enabled/parcelwise → add 'deny 203.0.113.77;' under server_name → sudo nginx -t → sudo systemctl reload nginx"],
      checks: (s) => { const conf = stripComments((s.nginxLoaded || {}).conf || ""); return [check("nginx is denying 203.0.113.77", /deny\s+203\.0\.113\.77(\/32)?\s*;/.test(conf)), check("…and nothing else (customers and the office still get in)", !/deny\s+all\s*;/.test(conf) && !/deny\s+(10\.0\.1\.17|81\.2\.69\.142|86\.140\.11\.23|92\.40\.177\.8|185\.31\.18\.4|51\.140\.22\.97|2\.29\.61\.200)\b/.test(conf) && !/deny\s+(0\.0\.0\.0\/0|10\.0\.0\.0\/8|203\.0\.113\.0\/24)/.test(conf)), check("nginx is running", s.services.nginx.active), check("The site still works", http200(s, "http://localhost/"))]; },
      debrief: "<code>awk | sort | uniq -c | sort -rn</code> is the Swiss Army knife of log analysis, and it works the same on any log, any server. Blocking one IP is a quick fix, but scrapers rotate addresses, so the lasting fixes are <b>rate limiting</b> (<code>limit_req</code> in nginx, or AWS WAF rate-based rules), not making tracking numbers guessable, and ideally a centralised log platform (ELK, CloudWatch, Datadog) where you'd spot this on a dashboard instead of over SSH." },

    { id: "PW-111", rank: 0, xp: 110, priority: "Critical", from: "jess", title: "Critical OpenSSH patch",
      message: "🔐 Security advisory: critical remote code execution in OpenSSH (CVE-2026-40112). web-01 must be running <b>openssh-server 1:9.6p1-3ubuntu13.8</b> or later by end of day, and it should keep getting security updates automatically after that. Sam says he 'pinned some packages' during the summer outage, if that helps?",
      topic: "Patching",
      setup: () => {
        const s = webHost();
        OD.addService(s, "ssh", { desc: "OpenBSD Secure Shell server", proc: { cmd: "sshd: /usr/sbin/sshd -D [listener] 0 of 10-100 startups", user: "root", cpu: 0.0, mem: 0.1 } });
        s.apt = { updated: false, pkgs: {
          "openssh-server": { installed: "1:9.6p1-3ubuntu13.5", available: "1:9.6p1-3ubuntu13.8", held: true, svc: "ssh", desc: "secure shell (SSH) server, for secure access from remote machines" },
          "openssh-client": { installed: "1:9.6p1-3ubuntu13.5", available: "1:9.6p1-3ubuntu13.8", desc: "secure shell (SSH) client" },
          "openssh-sftp-server": { installed: "1:9.6p1-3ubuntu13.5", available: "1:9.6p1-3ubuntu13.8", held: true, desc: "secure shell (SSH) sftp server module" },
          "tzdata": { installed: "2025b-0ubuntu0.24.04", available: "2026a-0ubuntu0.24.04", desc: "time zone and daylight-saving time data" },
          "nginx": { installed: "1.24.0-2ubuntu7.1", available: "1.24.0-2ubuntu7.1", desc: "small, powerful, scalable web/proxy server" },
        } };
        return s;
      },
      sop: ["Refresh the package lists first: <code>sudo apt update</code>, then <code>apt list --upgradable</code>.", "<code>sudo apt upgrade</code> upgrades everything it's allowed to. Read its output: anything <b>kept back</b>?", "Held packages are pinned on purpose: <code>apt-mark showhold</code>, then <code>sudo apt-mark unhold PKG</code> once you know why (here: an old incident).", "A running daemon keeps the old code in memory until it restarts. Check with <code>sudo needrestart</code>, then <code>sudo systemctl restart ssh</code>. Keep your current session open while you test a new one."],
      hints: ["sudo apt update && apt list --upgradable. Then try sudo apt upgrade -y. Does openssh-server get upgraded?", "It's 'kept back' because Sam put it on hold (apt-mark showhold). Unhold it, upgrade, then restart ssh so the new code is actually running.", "sudo apt-mark unhold openssh-server openssh-sftp-server && sudo apt upgrade -y && sudo systemctl restart ssh && sudo needrestart"],
      checks: (s) => { const p = s.apt.pkgs["openssh-server"], ssh = s.services.ssh; return [check("openssh-server 1:9.6p1-3ubuntu13.8 is installed", p.installed === "1:9.6p1-3ubuntu13.8"), check("The running sshd is the patched one (restarted after the upgrade)", ssh.active && p.upgradedTick !== undefined && ssh.startedTick > p.upgradedTick), check("openssh-server is no longer on hold, so future fixes apply", !p.held), check("ssh, nginx and parcelwise-api are all running", ssh.active && s.services.nginx.active && s.services["parcelwise-api"].active)]; },
      debrief: "Patching has three steps people forget: <b>update</b> the package lists, check what's <b>held</b> or kept back, and <b>restart</b> whatever runs the old code (needrestart tells you). Holds are fine as a short-term fix during an incident, but write down why and remove them afterwards, or they silently block security updates for months. At scale: unattended-upgrades for security fixes, a patch dashboard (AWS Systems Manager Patch Manager), or immutable servers that are rebuilt from a freshly patched image instead of patched in place." },

    // ===================================================== JUNIOR: Docker
    { id: "PW-201", rank: 1, xp: 120, priority: "High", from: "sam", title: "New tracking-api container dies instantly",
      message: "I tried to run tracking-api 1.8.0 on docker-01 but the container exits straight away. The env vars are in ~/tracking-api.env. It needs to be on port 8080, and it should come back if the box reboots.",
      topic: "Containers",
      setup: () => {
        const s = OD.newHost({ host: "docker-01", files: { "/home/ops/tracking-api.env": { content: "DATABASE_URL=postgres://tracking:s3cr3t@db.internal:5432/tracking\nREDIS_URL=redis://cache.internal:6379/0\nLOG_LEVEL=info\n" } } });
        OD.addDocker(s, {
          images: [{ repo: "parcelwise/tracking-api", tag: "1.8.0", size: 182 }],
          apps: { "parcelwise/tracking-api": { port: 8080, requiredEnv: ["DATABASE_URL", "REDIS_URL"], boot: ["> tracking-api@1.8.0 start", "> node dist/server.js"], missingEnvLog: (m) => [`Error: Missing required environment variable ${m[0]}`, "    at loadConfig (/app/dist/config.js:14:11)", "Node.js v22.11.0"], routes: { "/health": { status: 200, body: '{"status":"ok"}' } }, body: '{"service":"tracking-api","version":"1.8.0"}' } },
          containers: [{ name: "tracking-api", image: "parcelwise/tracking-api:1.8.0", ports: [{ host: 8080, container: 8080 }], env: { LOG_LEVEL: "info" }, created: "6 minutes ago", ago: "6 minutes ago" }],
        });
        return s;
      },
      sop: ["See every container, including dead ones: <code>docker ps -a</code>.", "Read why it died: <code>docker logs &lt;name&gt;</code>.", "Containers are disposable: remove it (<code>docker rm</code>) and run it again correctly.", "Useful <code>docker run</code> flags: <code>-d --name -p host:container --env-file FILE --restart unless-stopped</code>."],
      hints: ["docker ps -a, then docker logs tracking-api. What's missing?", "It needs DATABASE_URL (and REDIS_URL). They're in ~/tracking-api.env; pass them with --env-file.", "docker rm tracking-api && docker run -d --name tracking-api -p 8080:8080 --env-file ~/tracking-api.env --restart unless-stopped parcelwise/tracking-api:1.8.0"],
      checks: (s) => { const c = s.docker.containers.find((x) => x.name === "tracking-api"); return [check("A container named tracking-api is running", c && c.status === "running"), check("It has DATABASE_URL set", c && c.env && c.env.DATABASE_URL), check("http://localhost:8080/health returns 200", http200(s, "http://localhost:8080/health")), check("It restarts automatically (unless-stopped or always)", c && /unless-stopped|always/.test(c.restart || ""))]; },
      debrief: "<code>docker ps -a</code> + <code>docker logs</code> solves most 'container won't start' issues. Keep config in env files, not baked into images, and keep secrets out of Git. In production these values come from a secret store (Secrets Manager, Vault) and the container runs under an orchestrator (ECS, Kubernetes), which restarts it for you." },

    { id: "PW-202", rank: 1, xp: 100, priority: "High", from: "tom", title: "Label printer page won't load",
      message: "The warehouse label-printer UI on docker-01 (port 80) just gives 'connection reset'. It was redeployed this morning by someone on the night shift.",
      topic: "Ports",
      setup: () => {
        const s = OD.newHost({ host: "docker-01" });
        OD.addDocker(s, {
          images: [{ repo: "parcelwise/label-ui", tag: "2.1.0", size: 54 }],
          apps: { "parcelwise/label-ui": { port: 8080, user: "nginx", boot: ["/docker-entrypoint.sh: Configuration complete; ready for start up", "2026/11/26 06:12:41 [notice] 1#1: nginx/1.27.3", "2026/11/26 06:12:41 [notice] 1#1: start worker processes"], ready: () => ["listening on 0.0.0.0:8080 (unprivileged)"], body: "<!doctype html><title>Label Printer</title><h1>🏷️ Parcelwise labels</h1>" } },
          containers: [{ name: "label-ui", image: "parcelwise/label-ui:2.1.0", ports: [{ host: 80, container: 80 }], restart: "unless-stopped", up: "4 hours" }],
        });
        return s;
      },
      sop: ["Is it running? <code>docker ps</code>: check the PORTS column.", "Which port does the app listen on <i>inside</i> the container? Check <code>docker logs</code> or <code>docker inspect</code> (ExposedPorts).", "<code>-p HOST:CONTAINER</code>. The right-hand side must match the app.", "Port mappings can't be changed on a running container, so recreate it."],
      hints: ["The container is running, so the problem is the mapping. What's in the PORTS column?", "The image is nginx-unprivileged: it listens on 8080, not 80. The mapping is 80→80.", "docker rm -f label-ui && docker run -d --name label-ui -p 80:8080 --restart unless-stopped parcelwise/label-ui:2.1.0"],
      checks: (s) => { const c = s.docker.containers.find((x) => x.name === "label-ui"); return [check("label-ui is running", c && c.status === "running"), check("http://localhost/ returns 200", http200(s, "http://localhost/"))]; },
      debrief: "'Connection reset' on a published port usually means Docker forwarded the traffic, but nothing in the container listens on that port. Unprivileged images can't bind below 1024, so they use 8080. Write port mappings into Compose or task definitions, not someone's shell history." },

    { id: "PW-203", rank: 1, xp: 150, priority: "Normal", from: "jess", title: "Security review: parcel-web image",
      message: "Our image review flagged <b>parcel-web</b>: 1.5GB and running as root. Please rebuild it from ~/parcel-web as <b>parcel-web:2.0</b>: under 300MB and not running as root.",
      topic: "Dockerfiles",
      setup: () => {
        const s = OD.newHost({ host: "docker-01", files: {
          "/home/ops/parcel-web/Dockerfile": { content: "FROM node:22\nWORKDIR /app\nCOPY . .\nRUN npm install\nRUN npm run build\nEXPOSE 3000\nCMD [\"node\", \"dist/server.js\"]\n" },
          "/home/ops/parcel-web/package.json": { content: '{ "name": "parcel-web", "scripts": { "build": "tsc", "start": "node dist/server.js" } }\n' },
          "/home/ops/parcel-web/src/server.ts": { content: "// tiny web server\n" },
        } });
        OD.addDocker(s, { images: [{ repo: "parcel-web", tag: "1.0", size: 1530, user: "" }], apps: { "parcel-web": { port: 3000 } } });
        return s;
      },
      sop: ["Look at the current Dockerfile: <code>cat ~/parcel-web/Dockerfile</code>.", "<b>Multi-stage:</b> build in a full image, then copy only the output into a small runtime image (e.g. <code>node:22-alpine</code>).", "Install only production dependencies in the runtime stage (<code>npm ci --omit=dev</code>), or copy them from the build stage.", "Switch user before CMD: the official node images ship a <code>node</code> user (<code>USER node</code>).", "Build it: <code>docker build -t parcel-web:2.0 ~/parcel-web</code>, then check <code>docker images</code>."],
      hints: ["Edit ~/parcel-web/Dockerfile (nano). Two FROM lines: a build stage and a runtime stage.", "Runtime stage: FROM node:22-alpine, COPY --from=build the dist/ folder, install prod deps, USER node.", "FROM node:22 AS build / WORKDIR /app / COPY . . / RUN npm ci / RUN npm run build ··· FROM node:22-alpine / WORKDIR /app / COPY --from=build /app/dist ./dist / COPY package*.json ./ / RUN npm ci --omit=dev / USER node / CMD [\"node\",\"dist/server.js\"]  → docker build -t parcel-web:2.0 ~/parcel-web"],
      checks: (s) => { const i = s.docker.images.find((x) => x.repo === "parcel-web" && x.tag === "2.0"); return [check("Image parcel-web:2.0 exists", i), check("It's a multi-stage build", i && i.stages >= 2), check("It's under 300MB", i && i.size < 300 * MB), check("It doesn't run as root", i && i.user && i.user !== "root" && i.user !== "0")]; },
      debrief: "Smaller images pull faster, start faster and have fewer packages to patch. Multi-stage builds keep compilers and dev dependencies out of what you ship. Running as non-root limits the damage if the app is compromised. Add a scanner like Trivy to CI so this review happens on every build." },

    { id: "PW-204", rank: 1, xp: 120, priority: "High", from: "sam", title: "docker-01 disk almost full",
      message: "Builds on docker-01 are failing with 'no space left on device'. Please free up space, but don't take down the running containers (tracking-api and label-ui serve the warehouse).",
      topic: "Images & disk",
      setup: () => {
        const s = OD.newHost({ host: "docker-01", diskTotal: 60 * GB, diskBase: 7 * GB });
        const old = []; for (let i = 0; i <= 7; i++) old.push({ repo: "parcelwise/tracking-api", tag: `1.${i}.0`, size: 5600, created: `${12 - i} weeks ago` });
        OD.addDocker(s, {
          images: [...old.filter((x) => x.tag !== "1.8.0"), { repo: "parcelwise/tracking-api", tag: "1.8.0", size: 182 }, { repo: "parcelwise/label-ui", tag: "2.1.0", size: 54 }, { repo: "<none>", tag: "<none>", size: 4100, created: "3 weeks ago" }, { repo: "<none>", tag: "<none>", size: 3900, id: "9f1e2d3c4b5a", created: "2 weeks ago" }, { repo: "node", tag: "22", size: 1130 }],
          apps: { "parcelwise/tracking-api": { port: 8080, routes: { "/health": { status: 200, body: '{"status":"ok"}' } } }, "parcelwise/label-ui": { port: 8080 } },
          containers: [{ name: "tracking-api", image: "parcelwise/tracking-api:1.8.0", ports: [{ host: 8080, container: 8080 }], env: { DATABASE_URL: "x", REDIS_URL: "y" }, restart: "unless-stopped", up: "2 days" }, { name: "label-ui", image: "parcelwise/label-ui:2.1.0", ports: [{ host: 80, container: 8080 }], restart: "unless-stopped", up: "2 days" }, { name: "old-migrate", image: "parcelwise/tracking-api:1.6.0", status: "exited", exitCode: 0, ago: "5 weeks ago", manualStop: true }],
        });
        return s;
      },
      sop: ["Measure first: <code>df -h</code> and <code>docker system df</code>.", "<code>docker images</code>: old version tags and <code>&lt;none&gt;</code> (dangling) layers pile up on build boxes.", "<code>docker image prune -a -f</code> removes images no container uses. <code>docker system prune -a -f</code> also removes stopped containers.", "Never <code>docker rm -f</code> running services to 'free space'."],
      hints: ["docker system df shows how much is reclaimable.", "Old tracking-api tags and dangling <none> images are unused. Prune is safe for running containers' images.", "docker system prune -a -f   (then df -h and docker ps)"],
      checks: (s) => { const r = (n) => s.docker.containers.find((c) => c.name === n && c.status === "running"); return [check("Disk usage is below 70%", OD.diskPct(s) < 70), check("tracking-api is still running", r("tracking-api")), check("label-ui is still running", r("label-ui"))]; },
      debrief: "Build servers collect images like a junk drawer. Prune only touches what no container uses, so running services are safe. Automate it (a nightly <code>docker image prune -a --filter until=168h</code>), add ECR lifecycle policies for the registry, and alert on disk before it hits 100%." },

    { id: "PW-205", rank: 1, xp: 120, priority: "High", from: "maya", title: "Status page forgets every incident",
      message: "Every time we redeploy the status page database on docker-01, all our incident history disappears 😱 It just happened again, so there's nothing in it worth saving right now. Please make sure the next redeploy doesn't wipe it.",
      topic: "Volumes",
      setup: () => {
        const s = OD.newHost({ host: "docker-01", files: { "/home/ops/statuspage-db.env": { content: "POSTGRES_USER=status\nPOSTGRES_PASSWORD=St4tus-db-2026\nPOSTGRES_DB=status\n" } } });
        const persisted = (c) => (c.volumes || []).some((v) => /^\/var\/lib\/postgresql(\/data)?\/?$/.test(v.target));
        OD.addDocker(s, {
          images: [{ repo: "postgres", tag: "16", size: 432, created: "2 weeks ago", base: "debian:bookworm-slim", volumes: ["/var/lib/postgresql/data"], env: { PGDATA: "/var/lib/postgresql/data" }, layers: ["ENV PGDATA=/var/lib/postgresql/data", "VOLUME /var/lib/postgresql/data", "EXPOSE 5432", 'CMD ["postgres"]'] }],
          apps: { postgres: { port: 5432, requiredEnv: ["POSTGRES_PASSWORD"], cmd: "docker-entrypoint.s…", missingEnvLog: () => ["Error: Database is uninitialized and superuser password is not specified.", "       You must specify POSTGRES_PASSWORD to a non-empty value for the superuser."],
            boot: ["The files belonging to this database system will be owned by user \"postgres\"."],
            ready: (c) => [...(persisted(c) ? [] : ["creating directory /var/lib/postgresql/data ... ok", "initdb: creating a brand-new, empty database cluster (no existing data found)"]), "PostgreSQL init process complete; ready for start up.", "LOG:  listening on IPv4 address \"0.0.0.0\", port 5432", "LOG:  database system is ready to accept connections"] } },
          containers: [{ name: "statuspage-db", image: "postgres:16", env: { PGDATA: "/var/lib/postgresql/data", POSTGRES_USER: "status", POSTGRES_PASSWORD: "St4tus-db-2026", POSTGRES_DB: "status" }, restart: "unless-stopped", created: "25 minutes ago", up: "25 minutes" }],
        });
        return s;
      },
      sop: ["See how it runs today: <code>docker inspect statuspage-db</code>, and look at <b>Mounts</b>.", "A container's own filesystem is thrown away with the container. Data that must survive goes on a <b>volume</b>.", "<code>docker inspect postgres:16</code> shows which path the image expects you to persist (<b>Volumes</b>).", "Recreate it: <code>docker rm -f</code>, then <code>docker run -d --name … -v VOLUME:/var/lib/postgresql/data --env-file … --restart unless-stopped postgres:16</code>.", "<code>docker volume ls</code> lists named volumes."],
      hints: ["docker inspect statuspage-db: Mounts is empty. Where does Postgres keep its data?", "The data lives in /var/lib/postgresql/data inside the container. Mount a named volume there, and pass the settings from ~/statuspage-db.env.", "docker rm -f statuspage-db && docker run -d --name statuspage-db -v statuspage-data:/var/lib/postgresql/data --env-file ~/statuspage-db.env --restart unless-stopped postgres:16"],
      checks: (s) => { const c = s.docker.containers.find((x) => x.name === "statuspage-db"); return [check("statuspage-db is running", c && c.status === "running"), check("Its data directory (/var/lib/postgresql/data) is on a volume", c && (c.volumes || []).some((v) => /^\/var\/lib\/postgresql(\/data)?\/?$/.test(v.target))), check("It still has its database settings", c && c.env && c.env.POSTGRES_PASSWORD === "St4tus-db-2026" && c.env.POSTGRES_DB === "status"), check("It restarts automatically", c && /unless-stopped|always/.test(c.restart || ""))]; },
      debrief: "Containers are disposable: anything written inside one dies with it. Databases need their data directory on a volume. Named volumes are managed by Docker and survive <code>docker rm</code> (but not <code>docker rm -v</code> or <code>docker volume rm</code>, so be careful). A volume still isn't a backup, so schedule dumps and test restores. In the cloud, a managed database such as RDS takes this whole problem away." },

    { id: "PW-206", rank: 1, xp: 150, priority: "Critical", from: "jess", title: "AWS key baked into an image",
      message: "🔐 Our secret scanner found AWS credentials inside the <b>parcelwise/payments-worker:1.0</b> image on docker-01. I've already revoked that key and put a new one in <code>~/payments-worker.env</code>. Please rebuild it as <b>1.1</b> with no credentials inside, run it with the new key, and get rid of the leaky image.",
      topic: "Secrets in images",
      setup: () => {
        const old = { AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE", AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
        const queue = "https://sqs.eu-west-2.amazonaws.com/123456789012/payments";
        const lines = ["WORKDIR /app", "COPY requirements.txt .", "RUN pip install --no-cache-dir -r requirements.txt", "COPY . .", `ENV QUEUE_URL=${queue}`, `ENV AWS_ACCESS_KEY_ID=${old.AWS_ACCESS_KEY_ID}`, `ENV AWS_SECRET_ACCESS_KEY=${old.AWS_SECRET_ACCESS_KEY}`, "USER 1000", 'CMD ["python", "worker.py"]'];
        const s = OD.newHost({ host: "docker-01", files: {
          "/home/ops/payments-worker/Dockerfile": { content: ["FROM python:3.12-slim", ...lines].join("\n") + "\n" },
          "/home/ops/payments-worker/requirements.txt": { content: "boto3==1.35.60\n" },
          "/home/ops/payments-worker/worker.py": { content: "# polls the payments queue and settles card payments\nimport boto3\n" },
          "/home/ops/payments-worker.env": { content: "# rotated by Jess, 26 Nov\nAWS_ACCESS_KEY_ID=AKIAI44QH8DHBEXAMPLE\nAWS_SECRET_ACCESS_KEY=je7MtGbClwBF/2Zp9Utk/h3yCo8nvbEXAMPLEKEY\n" },
        } });
        OD.addDocker(s, {
          images: [{ repo: "parcelwise/payments-worker", tag: "1.0", size: 212, created: "3 weeks ago", user: "1000", base: "python:3.12-slim", env: { QUEUE_URL: queue, ...old }, layers: lines }, { repo: "python", tag: "3.12-slim", size: 155, created: "3 weeks ago" }],
          apps: { "parcelwise/payments-worker": { port: 8080, user: "1000", requiredEnv: ["QUEUE_URL", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"], cmd: "python worker.py", boot: ['{"level":"info","msg":"payments-worker starting"}'],
            missingEnvLog: (m) => [`botocore.exceptions.NoCredentialsError: Unable to locate credentials (${m[0]} is not set)`],
            ready: (c) => [`{"level":"info","msg":"polling queue","queue":"payments","aws_access_key_id":"${c.env.AWS_ACCESS_KEY_ID}"}`] } },
          containers: [{ name: "payments-worker", image: "parcelwise/payments-worker:1.0", env: { QUEUE_URL: queue, ...old }, restart: "unless-stopped", created: "3 weeks ago", up: "3 weeks" }],
        });
        return s;
      },
      sop: ["Confirm the leak: <code>docker history parcelwise/payments-worker:1.0</code> or <code>docker inspect</code> the image (Config.Env). Anyone who can pull the image can read these.", "Delete the <code>ENV AWS_…</code> lines from <code>~/payments-worker/Dockerfile</code> and rebuild it as <code>parcelwise/payments-worker:1.1</code>.", "Run the new image with the rotated key from <code>~/payments-worker.env</code> (<code>--env-file</code>), keeping the name and restart policy.", "Remove the old container and the leaky 1.0 image (<code>docker rm -f</code>, <code>docker rmi</code>)."],
      hints: ["docker history (or docker inspect) on parcelwise/payments-worker:1.0: look for ENV lines.", "Remove both ENV AWS_ lines from ~/payments-worker/Dockerfile, build :1.1, and run it with --env-file ~/payments-worker.env. Then delete the 1.0 image.", "nano ~/payments-worker/Dockerfile (delete the two ENV AWS_ lines) → docker build -t parcelwise/payments-worker:1.1 ~/payments-worker → docker rm -f payments-worker → docker run -d --name payments-worker --env-file ~/payments-worker.env --restart unless-stopped parcelwise/payments-worker:1.1 → docker rmi parcelwise/payments-worker:1.0"],
      checks: (s) => {
        const df = (s.fs.get("/home/ops/payments-worker/Dockerfile") || { content: "" }).content, keyEnv = (env) => Object.keys(env || {}).some((k) => /^AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY)$/.test(k));
        const img = s.docker.images.find((i) => i.repo === "parcelwise/payments-worker" && i.tag === "1.1"), c = s.docker.containers.find((x) => x.name === "payments-worker");
        return [check("The Dockerfile no longer sets AWS credentials", df && !/^\s*(ENV|ARG)\s+AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY)\b/m.test(df) && !/AKIA[0-9A-Z]{16}|EXAMPLEKEY/.test(df)),
          check("Image parcelwise/payments-worker:1.1 is built with no credentials inside", img && !keyEnv(img.env)),
          check("No image on the box still contains AWS credentials", !s.docker.images.some((i) => keyEnv(i.env))),
          check("payments-worker is running the 1.1 image", c && c.status === "running" && c.image === "parcelwise/payments-worker:1.1"),
          check("It uses the new key, passed in at run time", c && c.env && c.env.AWS_ACCESS_KEY_ID === "AKIAI44QH8DHBEXAMPLE" && c.env.AWS_SECRET_ACCESS_KEY === "je7MtGbClwBF/2Zp9Utk/h3yCo8nvbEXAMPLEKEY"),
          check("It restarts automatically", c && /unless-stopped|always/.test(c.restart || ""))];
      },
      debrief: "Every <code>ENV</code>, <code>ARG</code> and copied file becomes part of the image, and layers are just tarballs anyone with pull access can unpack. Deleting the line in a later layer doesn't help either. Pass secrets in at run time (env files, or better a secret store such as AWS Secrets Manager), prefer IAM roles over long-lived keys, and run a secret scanner (gitleaks, trufflehog, Trivy) in CI. Once a key has leaked, <b>rotating it</b> is the real fix, which Jess already did." },

    { id: "PW-207", rank: 1, xp: 110, priority: "Normal", from: "sam", title: "Upgrade tracking-api to 1.9.2",
      message: "Can you upgrade tracking-api on docker-01 to <b>1.9.2</b>? I tried <code>docker run -d --name tracking-api-new -p 8080:8080 --env-file ~/tracking-api.env parcelwise/tracking-api:1.9.2</code> but Docker says the port is already allocated 🤷 Please keep the container called <b>tracking-api</b>: our monitoring looks for that name.",
      topic: "Upgrades",
      setup: () => {
        const env = { DATABASE_URL: "postgres://tracking:s3cr3t@db.internal:5432/tracking", REDIS_URL: "redis://cache.internal:6379/0", LOG_LEVEL: "info" };
        const s = OD.newHost({ host: "docker-01", files: { "/home/ops/tracking-api.env": { content: Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n" } } });
        const app = (v) => ({ port: 8080, requiredEnv: ["DATABASE_URL", "REDIS_URL"], boot: [`> tracking-api@${v} start`, "> node dist/server.js"], ready: () => [`tracking-api ${v} listening on 0.0.0.0:8080`], routes: { "/health": { status: 200, body: '{"status":"ok"}' }, "/version": { status: 200, body: `{"service":"tracking-api","version":"${v}"}` } }, body: `{"service":"tracking-api","version":"${v}"}` });
        OD.addDocker(s, {
          images: [{ repo: "parcelwise/tracking-api", tag: "1.8.0", size: 182, created: "5 weeks ago" }, { repo: "parcelwise/tracking-api", tag: "1.9.2", size: 186, created: "2 days ago" }],
          apps: { "parcelwise/tracking-api:1.8.0": app("1.8.0"), "parcelwise/tracking-api:1.9.2": app("1.9.2") },
          containers: [{ name: "tracking-api", image: "parcelwise/tracking-api:1.8.0", ports: [{ host: 8080, container: 8080 }], env, restart: "unless-stopped", created: "5 weeks ago", up: "5 weeks" }],
        });
        return s;
      },
      sop: ["Only one container can publish a given host port. <code>docker ps</code> shows what holds 8080 now.", "Note how the old one is configured (<code>docker inspect tracking-api</code>: env, restart policy) so the new one matches.", "You can't swap the image of an existing container. Stop and remove the old one, then <code>docker run</code> the new version with the same name, port, env and restart policy.", "Check: <code>curl localhost:8080/version</code>. Rolling back would be the same steps with 1.8.0."],
      hints: ["docker ps: the old tracking-api (1.8.0) still holds 0.0.0.0:8080.", "Remove the old container first (that frees both the port and the name), then run 1.9.2 with the same settings.", "docker rm -f tracking-api && docker run -d --name tracking-api -p 8080:8080 --env-file ~/tracking-api.env --restart unless-stopped parcelwise/tracking-api:1.9.2 && curl localhost:8080/version"],
      checks: (s) => {
        const c = s.docker.containers.find((x) => x.name === "tracking-api"), on8080 = s.docker.containers.find((x) => x.status === "running" && (x.ports || []).some((p) => p.host === 8080)), v = OD.http(s, "http://localhost:8080/version");
        return [check("A container named tracking-api is running 1.9.2", c && c.status === "running" && c.image === "parcelwise/tracking-api:1.9.2"), check("It's the one serving port 8080", c && on8080 === c), check("http://localhost:8080/version reports 1.9.2", !v.error && v.status === 200 && v.body.includes('"1.9.2"')), check("It has its database settings", c && c.env && c.env.DATABASE_URL && c.env.REDIS_URL), check("It restarts automatically", c && /unless-stopped|always/.test(c.restart || "")), check("No 1.8.0 container is still running", !s.docker.containers.some((x) => x.status === "running" && x.image.endsWith(":1.8.0")))];
      },
      debrief: "With plain Docker an upgrade means a short gap: stop the old container, start the new one. That's fine for an internal service, but it's why production runs behind an orchestrator or load balancer that starts the new version, health-checks it, and only then drains the old one (a rolling or blue/green deploy). Keep the run command in a Compose file so an upgrade is a one-line tag change, and keep the previous image until the new one has proven itself." },

    { id: "PW-208", rank: 1, xp: 140, priority: "High", from: "jess", title: "Critical CVEs in the label printer image",
      message: "This week's Trivy scan flags <b>2 CRITICAL</b> vulnerabilities (OpenSSL) in <b>parcelwise/label-ui:2.1.0</b>, which runs the warehouse label printer on docker-01. Our policy is no CRITICAL or HIGH findings in production. Please rebuild it as <b>2.1.1</b> on a patched base, prove the scan is clean, and redeploy it.",
      topic: "Image scanning",
      setup: () => {
        const base = "nginxinc/nginx-unprivileged:1.27.3-alpine";
        const s = OD.newHost({ host: "docker-01", files: {
          "/home/ops/label-ui/Dockerfile": { content: `FROM ${base}\nCOPY nginx.conf /etc/nginx/conf.d/default.conf\nCOPY dist/ /usr/share/nginx/html/\nEXPOSE 8080\n` },
          "/home/ops/label-ui/nginx.conf": { content: "server {\n    listen 8080;\n    root /usr/share/nginx/html;\n}\n" },
          "/home/ops/label-ui/dist/index.html": { content: "<!doctype html><title>Label Printer</title><h1>🏷️ Parcelwise labels</h1>\n" },
        } });
        OD.addDocker(s, {
          images: [{ repo: "parcelwise/label-ui", tag: "2.1.0", size: 55, created: "7 weeks ago", base, layers: ["COPY nginx.conf /etc/nginx/conf.d/default.conf", "COPY dist/ /usr/share/nginx/html/", "EXPOSE 8080"] }, { repo: "nginxinc/nginx-unprivileged", tag: "1.27.3-alpine", size: 54, created: "2 months ago", base }],
          apps: { "parcelwise/label-ui": { port: 8080, user: "nginx", boot: ["/docker-entrypoint.sh: Configuration complete; ready for start up"], ready: () => ["nginx: listening on 0.0.0.0:8080 (unprivileged)"], body: "<!doctype html><title>Label Printer</title><h1>🏷️ Parcelwise labels</h1>" } },
          containers: [{ name: "label-ui", image: "parcelwise/label-ui:2.1.0", ports: [{ host: 80, container: 8080 }], restart: "unless-stopped", created: "7 weeks ago", up: "7 weeks" }],
        });
        return s;
      },
      sop: ["Reproduce the finding: <code>trivy image parcelwise/label-ui:2.1.0</code> (add <code>--severity CRITICAL,HIGH</code> to cut the noise). Note the package, installed and fixed versions.", "The vulnerable packages come from the <b>base image</b>. Look at <code>~/label-ui/Dockerfile</code>: which base and tag?", "Move to a patched base tag (here <code>nginxinc/nginx-unprivileged:1.27.5-alpine</code>), or add <code>RUN apk upgrade --no-cache</code>, then <code>docker build -t parcelwise/label-ui:2.1.1 ~/label-ui</code>.", "Scan the new image before shipping it, then replace the running container (same port mapping and restart policy)."],
      hints: ["trivy image --severity CRITICAL,HIGH parcelwise/label-ui:2.1.0: which library, and which fixed version?", "The OpenSSL libraries come from the base image nginx-unprivileged:1.27.3-alpine. 1.27.5-alpine includes the fix.", "nano ~/label-ui/Dockerfile (FROM nginxinc/nginx-unprivileged:1.27.5-alpine) → docker build -t parcelwise/label-ui:2.1.1 ~/label-ui → trivy image parcelwise/label-ui:2.1.1 → docker rm -f label-ui → docker run -d --name label-ui -p 80:8080 --restart unless-stopped parcelwise/label-ui:2.1.1"],
      checks: (s) => {
        const i = s.docker.images.find((x) => x.repo === "parcelwise/label-ui" && x.tag === "2.1.1"), bad = i ? OD.imageVulns(i).vulns.filter((v) => v[2] === "CRITICAL" || v[2] === "HIGH") : [1], c = s.docker.containers.find((x) => x.name === "label-ui");
        return [check("Image parcelwise/label-ui:2.1.1 exists", i), check("It has no CRITICAL or HIGH vulnerabilities", i && !bad.length), check("label-ui is running 2.1.1", c && c.status === "running" && c.image === "parcelwise/label-ui:2.1.1"), check("The label printer page works (http://localhost)", http200(s, "http://localhost/")), check("It restarts automatically", c && /unless-stopped|always/.test(c.restart || ""))];
      },
      debrief: "Most container CVEs live in the base image, not your code, so 'nothing changed' images still go stale. Pin base images to specific tags (or digests), rebuild regularly so you pick up patched bases, and run the scanner in CI with <code>--exit-code 1 --severity CRITICAL,HIGH</code> so a vulnerable image can't be shipped. Tools such as Dependabot or Renovate can open the base-image bump for you, and scanning the registry (ECR does this) catches CVEs published after you built." },

    { id: "PW-209", rank: 1, xp: 140, priority: "High", from: "sam", title: "docker-01 disk full again",
      message: "docker-01 is at 96% disk again and builds are failing 😩 I already ran <code>docker system prune</code> and it barely moved. Please free the space <b>without stopping the warehouse containers</b>, and make sure container logs can't do this to us again.",
      topic: "Container logs",
      setup: () => {
        const s = OD.newHost({ host: "docker-01", diskTotal: 60 * GB, diskBase: 15 * GB, files: { "/home/ops/carrier-sync.env": { content: "CARRIER_API=https://api.carrier.example/v2\nLOG_LEVEL=debug\n" } } });
        OD.addDocker(s, {
          logFiles: true,
          images: [{ repo: "parcelwise/carrier-sync", tag: "3.0.2", size: 148 }, { repo: "parcelwise/label-ui", tag: "2.1.0", size: 55 }, { repo: "parcelwise/tracking-api", tag: "1.8.0", size: 182 }],
          apps: { "parcelwise/carrier-sync": { port: 9000, requiredEnv: ["CARRIER_API"], boot: ['{"level":"info","msg":"carrier-sync 3.0.2 starting"}'], ready: () => ['{"level":"debug","msg":"poll carrier api","took_ms":41,"parcels":0}', '{"level":"debug","msg":"poll carrier api","took_ms":39,"parcels":0}', '{"level":"debug","msg":"poll carrier api","took_ms":44,"parcels":1}', "… (about 9,000 lines a minute)"] }, "parcelwise/label-ui": { port: 8080 }, "parcelwise/tracking-api": { port: 8080, routes: { "/health": { status: 200, body: '{"status":"ok"}' } } } },
          containers: [
            { name: "carrier-sync", image: "parcelwise/carrier-sync:3.0.2", env: { CARRIER_API: "https://api.carrier.example/v2", LOG_LEVEL: "debug" }, restart: "unless-stopped", created: "6 weeks ago", up: "6 weeks", logSize: 41.6 * GB },
            { name: "label-ui", image: "parcelwise/label-ui:2.1.0", ports: [{ host: 80, container: 8080 }], restart: "unless-stopped", up: "6 weeks", logSize: 210 * MB },
            { name: "tracking-api", image: "parcelwise/tracking-api:1.8.0", ports: [{ host: 8080, container: 8080 }], env: { DATABASE_URL: "x", REDIS_URL: "y" }, restart: "unless-stopped", up: "6 weeks", logSize: 380 * MB },
          ],
        });
        s.fs.mkdir("/etc/docker", true);
        OD.addService(s, "docker", OD.dockerService());
        return s;
      },
      sop: ["Measure: <code>df -h</code>, then find where the space is: <code>sudo du -sh /var/lib/docker/*</code> and one level deeper.", "Container stdout goes to a JSON log file per container (<code>docker inspect NAME</code> → LogPath). With the default settings it grows forever.", "Free space safely: dockerd keeps that file open, so <code>rm</code> won't free anything until Docker restarts. Empty it in place instead: <code>sudo truncate -s 0 FILE</code>.", "Prevent it: set a default in <code>/etc/docker/daemon.json</code> (<code>{\"log-opts\": {\"max-size\": \"10m\", \"max-file\": \"3\"}}</code>) and <code>sudo systemctl restart docker</code>. Log settings are fixed when a container is created, so recreate the noisy one too (or run it with <code>--log-opt max-size=10m</code>)."],
      hints: ["sudo du -sh /var/lib/docker/containers/*: one container's log is over 40G. Which one? (docker inspect shows each container's LogPath)", "carrier-sync logs at debug level with no rotation. Truncate its log file, add log-opts to /etc/docker/daemon.json, restart docker, and recreate carrier-sync so it picks the limits up.", "sudo truncate -s 0 <carrier-sync LogPath> → sudo nano /etc/docker/daemon.json → {\"log-opts\": {\"max-size\": \"10m\", \"max-file\": \"3\"}} → sudo systemctl restart docker → docker rm -f carrier-sync → docker run -d --name carrier-sync --env-file ~/carrier-sync.env --restart unless-stopped parcelwise/carrier-sync:3.0.2"],
      checks: (s) => {
        const r = (n) => s.docker.containers.find((c) => c.name === n && c.status === "running"), c = r("carrier-sync"), max = (o) => /^\d+[kmg]?$/i.test(String((o || {})["max-size"] || ""));
        return [check("Disk usage is below 80%", OD.diskPct(s) < 80), check("New containers get log rotation by default (daemon.json loaded by Docker)", s.services.docker.active && max(s.docker.daemonLogOpts)), check("carrier-sync is running with a log size limit", c && max(c.logOpts)), check("label-ui and tracking-api are still running", r("label-ui") && r("tracking-api")), check("carrier-sync restarts automatically", c && /unless-stopped|always/.test(c.restart || ""))];
      },
      debrief: "Docker's default json-file log driver never rotates, so one chatty container can fill a disk. That's a classic. Set <code>max-size</code>/<code>max-file</code> in <code>daemon.json</code> on every host (via config management or the AMI), remember that it only applies to containers created afterwards, and don't log at debug level in production. On a file that a process still holds open, <code>truncate</code> frees space immediately and <code>rm</code> doesn't. Longer term, ship logs off the box (CloudWatch, Loki, ELK) instead of keeping them on local disk." },

    // ===================================================== PLATFORM: Kubernetes
    { id: "PW-301", rank: 2, xp: 150, priority: "High", from: "sam", title: "checkout-api deploy stuck for 20 minutes",
      message: "I deployed checkout-api 3.2.0 to prod and the rollout is just… stuck? The old pods are still serving at least. Can you check what's wrong with the new ones?",
      topic: "Images & rollouts",
      setup: () => k8sHost({ deployments: [Object.assign(dep("checkout-api", "parcelwise/checkout-api:3.2.O", { replicas: 3 }), { _lastGood: (() => { const d = dep("checkout-api", "parcelwise/checkout-api:3.1.4", { replicas: 3 }); return d.spec.template; })(), _history: [dep("checkout-api", "parcelwise/checkout-api:3.1.4").spec.template] })], services: [svc("checkout-api", { app: "checkout-api" })], routes: [["/checkout", "checkout-api"]] }),
      sop: ["Look at the pods: <code>kubectl get pods</code>. A new pod that isn't Running is the clue.", "<code>kubectl describe pod NAME</code>: read the <b>Events</b> at the bottom.", "Fix the Deployment, not the pod: <code>kubectl set image deploy/NAME CONTAINER=IMAGE</code> (or <code>kubectl edit</code>).", "Watch it finish: <code>kubectl rollout status deploy/checkout-api</code>."],
      hints: ["kubectl get pods: one checkout-api pod is in ImagePullBackOff.", "kubectl describe pod on it: the image tag is 3.2.O (a letter O), not 3.2.0.", "kubectl set image deploy/checkout-api checkout-api=parcelwise/checkout-api:3.2.0 && kubectl rollout status deploy/checkout-api"],
      checks: (s) => [check("checkout-api runs image 3.2.0", container(s, "checkout-api").image === "parcelwise/checkout-api:3.2.0"), check("All checkout-api pods are Running and Ready on the new version", allReady(s, "checkout-api")), check("https://shop.parcelwise.test/checkout works", http200(s, "http://shop.parcelwise.test/checkout"))],
      debrief: "Rolling updates protect you: new pods must become Ready before old ones go, so a typo'd tag stalls the rollout instead of taking the site down. ImagePullBackOff means a wrong name or tag, a missing image, or no permission to pull. Pin tags by commit SHA from CI, so people never type them by hand." },

    { id: "PW-302", rank: 2, xp: 150, priority: "Critical", from: "tom", title: "Tracking page returns 503",
      message: "Customers get '503 Service Temporarily Unavailable' on shop.parcelwise.test/track. The rest of the shop is fine. The tracking-api pods look healthy apparently?",
      topic: "Services",
      setup: () => { const s = k8sHost(); s.k8s.services.find((v) => v.metadata.name === "tracking-api").spec.selector = { app: "tracking" }; return s; },
      sop: ["Follow the request: Ingress → Service → Endpoints → Pods.", "<code>kubectl get endpoints tracking-api</code>: if it's <code>&lt;none&gt;</code>, the Service selects no ready pods.", "Compare <code>kubectl describe svc tracking-api</code> (Selector) with <code>kubectl get pods --show-labels</code>.", "Fix the selector: <code>kubectl edit svc tracking-api</code>."],
      hints: ["The pods are fine. Does the tracking-api Service have endpoints?", "The Service selects app=tracking, but the pods are labelled app=tracking-api.", "kubectl edit svc tracking-api → set selector app: tracking-api → curl http://shop.parcelwise.test/track"],
      checks: (s) => { const v = s.k8s.services.find((x) => x.metadata.name === "tracking-api"); return [check("The tracking-api Service has endpoints", v && OD.k8sEndpoints(s, v).length > 0), check("http://shop.parcelwise.test/track returns 200", http200(s, "http://shop.parcelwise.test/track"))]; },
      debrief: "Services find pods by label, so a typo means zero endpoints and the ingress returns 503. <code>kubectl get endpoints</code> is the fastest check. Keep labels in one place (a Helm chart or Kustomize) so the Deployment and Service can't drift apart." },

    { id: "PW-303", rank: 2, xp: 150, priority: "High", from: "sam", title: "notify keeps crashing",
      message: "I shipped the new <b>notify</b> service (sends delivery emails). Pods are in CrashLoopBackOff. Infra already created a ConfigMap with the SMTP settings for it, I think it's called notify-config?",
      topic: "Config",
      setup: () => k8sHost({ apps: { "parcelwise/notify": { port: 8080, requiredEnv: ["SMTP_HOST", "SMTP_PORT"], boot: ['{"level":"info","msg":"notify starting","version":"0.9.1"}'] } }, deployments: [dep("notify", "parcelwise/notify:0.9.1", { replicas: 2 })], services: [svc("notify", { app: "notify" })], configmaps: [cm("notify-config", { SMTP_HOST: "smtp.parcelwise.internal", SMTP_PORT: "587", FROM_ADDRESS: "no-reply@parcelwise.test" })] }),
      sop: ["<code>kubectl get pods</code> → CrashLoopBackOff means the app starts, then exits.", "Read why: <code>kubectl logs POD --previous</code>.", "Inspect the config that exists: <code>kubectl get cm notify-config -o yaml</code>.", "Wire it in: <code>kubectl edit deploy notify</code> → add <code>envFrom: [{configMapRef: {name: notify-config}}]</code> to the container."],
      hints: ["kubectl logs on a notify pod (add --previous): which variable is missing?", "The ConfigMap has SMTP_HOST and SMTP_PORT, but the Deployment never references it.", "kubectl edit deploy notify → under the container add:\n  envFrom:\n  - configMapRef:\n      name: notify-config"],
      checks: (s) => { const c = container(s, "notify"); const refs = JSON.stringify([c.env || [], c.envFrom || []]); return [check("All notify pods are Running and Ready", allReady(s, "notify")), check("SMTP settings come from the notify-config ConfigMap", refs.includes("notify-config"))]; },
      debrief: "CrashLoopBackOff = the container keeps exiting, so read <code>logs --previous</code>. Keep config in ConfigMaps (and secrets in Secrets), referenced by the Deployment, so the same image runs in every environment. <code>envFrom</code> imports every key; <code>configMapKeyRef</code> picks one." },

    { id: "PW-304", rank: 2, xp: 150, priority: "High", from: "maya", title: "label-renderer restarting all day",
      message: "label-renderer (makes the shipping-label PDFs) has restarted 200+ times today and warehouse printing is flaky. Can you find out why and fix it properly?",
      topic: "Resources",
      setup: () => k8sHost({ apps: { "parcelwise/label-renderer": { port: 8080, memMi: 300, logs: ['{"level":"info","msg":"renderer ready","fonts":42}', '{"level":"info","msg":"rendering batch","labels":250}'] } }, deployments: [dep("label-renderer", "parcelwise/label-renderer:2.0.3", { replicas: 2, resources: { requests: { cpu: "100m", memory: "64Mi" }, limits: { memory: "128Mi" } } })], services: [svc("label-renderer", { app: "label-renderer" })] }),
      sop: ["<code>kubectl get pods</code>: lots of restarts.", "<code>kubectl describe pod</code> → <b>Last State: Terminated, Reason: OOMKilled, Exit Code 137</b>.", "The app needs more memory than its limit. Check what it really uses (here: about 300Mi) and give it headroom.", "<code>kubectl edit deploy label-renderer</code> → raise <code>resources.limits.memory</code> (and the request)."],
      hints: ["Describe one of the pods. What's the Last State reason?", "OOMKilled: the 128Mi memory limit is too low. The app needs ~300Mi.", "kubectl edit deploy label-renderer → requests.memory: 384Mi, limits.memory: 512Mi"],
      checks: (s) => { const r = container(s, "label-renderer").resources || {}; const mem = (v) => { const m = String(v || "").match(/^(\d+)(Mi|Gi)$/); return m ? +m[1] * (m[2] === "Gi" ? 1024 : 1) : 0; }; return [check("All label-renderer pods are Running and Ready", allReady(s, "label-renderer")), check("The memory limit leaves headroom (≥ 384Mi)", mem((r.limits || {}).memory) >= 384), check("…but isn't excessive (≤ 2Gi)", mem((r.limits || {}).memory) <= 2048), check("A memory request is set", mem((r.requests || {}).memory) >= 256)]; },
      debrief: "Exit code 137 + OOMKilled = over the memory limit. Size limits from real usage (<code>kubectl top</code>, Prometheus) plus headroom, and set requests so the scheduler places pods sensibly. Over the memory limit the container is killed; over a CPU limit it's only slowed down." },

    { id: "PW-305", rank: 2, xp: 150, priority: "Critical", from: "tom", title: "Payments failing since 10:05!",
      message: "🚨 Every payment fails since about 10:05: customers get 'something went wrong' at the pay step. Sam says payments-api 4.0.0 went out at 10:04. Please make it stop, we're losing orders!",
      topic: "Rollbacks",
      setup: () => { const good = dep("payments-api", "parcelwise/payments-api:3.9.2", { replicas: 3 }); return k8sHost({ apps: { "parcelwise/payments-api:4.0.0": { port: 8080, routes: { "/pay": { status: 500, body: '{"error":"TypeError: Cannot read properties of undefined (reading \'currency\')"}' } }, logs: ['{"level":"info","msg":"payments-api 4.0.0 listening"}', '{"level":"error","msg":"POST /pay 500","err":"TypeError: Cannot read properties of undefined (reading \'currency\')"}', '{"level":"error","msg":"POST /pay 500","err":"TypeError: Cannot read properties of undefined (reading \'currency\')"}'] }, "parcelwise/payments-api": { port: 8080, routes: { "/pay": { status: 200, body: '{"ok":true,"payment":"PAY-1182"}' } } } }, deployments: [Object.assign(dep("payments-api", "parcelwise/payments-api:4.0.0", { replicas: 3 }), { _history: [good.spec.template] })], services: [svc("payments-api", { app: "payments-api" })], routes: [["/pay", "payments-api"]] }); },
      sop: ["During an incident: <b>restore service first</b>, investigate after.", "<code>kubectl rollout history deploy/payments-api</code> shows previous revisions.", "<code>kubectl rollout undo deploy/payments-api</code> goes back one revision.", "Verify: <code>curl http://shop.parcelwise.test/pay</code>, then tell Sam so he can fix 4.0.0."],
      hints: ["The pods are healthy. The new code returns 500 on /pay (kubectl logs deploy/payments-api).", "Roll back to the previous revision (3.9.2).", "kubectl rollout undo deploy/payments-api && kubectl rollout status deploy/payments-api"],
      checks: (s) => [check("payments-api runs 3.9.2 again", container(s, "payments-api").image === "parcelwise/payments-api:3.9.2"), check("All payments-api pods are Ready", allReady(s, "payments-api")), check("http://shop.parcelwise.test/pay returns 200", http200(s, "http://shop.parcelwise.test/pay"))],
      debrief: "Health checks only prove the app is alive, not that it's correct. 4.0.0 passed them and still broke payments. Roll back first (it takes seconds), then debug. Prevent it with canary releases, automated smoke tests after deploy, and alerts on error rate." },

    { id: "PW-306", rank: 2, xp: 120, priority: "Normal", from: "sam", title: "search-api pods never become Ready",
      message: "New service <b>search-api</b> is deployed: pods are Running but show 0/1 Ready, so nothing gets traffic. Logs look totally normal?! 🤔",
      topic: "Probes",
      setup: () => k8sHost({ apps: { "parcelwise/search-api": { port: 8080, health: "/healthz", routes: { "/health": { status: 404, body: '{"error":"not found"}' } }, logs: ['{"level":"info","msg":"search index loaded","docs":182331}', '{"level":"info","msg":"listening","port":8080}'] } }, deployments: [dep("search-api", "parcelwise/search-api:1.2.0", { replicas: 2, readyPath: "/health" })], services: [svc("search-api", { app: "search-api" })] }),
      sop: ["0/1 Ready with normal logs = a failing <b>readiness probe</b>.", "<code>kubectl describe pod</code> → Events: 'Readiness probe failed: HTTP probe failed with statuscode: 404'.", "Check which path the app really serves (its liveness probe and docs use <code>/healthz</code>).", "<code>kubectl edit deploy search-api</code> → fix <code>readinessProbe.httpGet.path</code>."],
      hints: ["Describe a search-api pod and read the Events.", "The readiness probe calls /health, which returns 404. The app's health endpoint is /healthz.", "kubectl edit deploy search-api → readinessProbe.httpGet.path: /healthz"],
      checks: (s) => [check("All search-api pods are Ready", allReady(s, "search-api")), check("The readiness probe uses /healthz", (container(s, "search-api").readinessProbe || { httpGet: {} }).httpGet.path === "/healthz")],
      debrief: "Readiness controls traffic; liveness controls restarts. A wrong readiness path quietly keeps pods out of the Service. Nothing crashes, so look at <b>Events</b>. Use a cheap health endpoint that doesn't depend on the database for liveness." },

    { id: "PW-307", rank: 2, xp: 140, priority: "High", from: "tom", title: "Returns portal: 503 on launch day",
      message: "The new returns portal went live this morning but <b>shop.parcelwise.test/returns</b> only shows '503 Service Temporarily Unavailable'. Sam swears the pods are Ready AND the Service has endpoints this time 😅",
      topic: "Service ports",
      setup: () => k8sHost({ apps: { "parcelwise/returns-api": { port: 8080, routes: { "/returns": { status: 200, body: '{"service":"returns-api","open_returns":37}' } }, logs: ['{"level":"info","msg":"returns-api 1.0.0 starting"}', '{"level":"info","msg":"listening","addr":"0.0.0.0:8080"}'] } }, deployments: [dep("returns-api", "parcelwise/returns-api:1.0.0", { replicas: 2 })], services: [svc("returns-api", { app: "returns-api" }, { targetPort: 80 })], routes: [["/returns", "returns-api"]] }),
      sop: ["Endpoints exist, so the selector is fine. Now check the <b>ports</b>: <code>kubectl describe svc returns-api</code> (Port, TargetPort, Endpoints).", "Compare with the container: <code>kubectl describe deploy returns-api</code> (Port), or what the app logs when it starts.", "<b>port</b> is what clients call on the Service. <b>targetPort</b> is where the pod actually listens.", "Test inside the cluster with <code>curl returns-api.shop/returns</code>, then through the ingress."],
      hints: ["kubectl describe svc returns-api: what's the TargetPort? Which port does the app say it listens on (kubectl logs deploy/returns-api)?", "TargetPort is 80, but the container listens on 8080 (its port is named http).", "kubectl edit svc returns-api → targetPort: 8080 (or: http) → curl http://shop.parcelwise.test/returns"],
      checks: (s) => { const v = s.k8s.services.find((x) => x.metadata.name === "returns-api"), p = v && (v.spec.ports || [])[0], tp = p && (p.targetPort ?? p.port); return [check("The Service still exposes port 80", p && p.port === 80), check("The Service forwards to the port the app listens on (8080 / http)", tp === 8080 || tp === "8080" || tp === "http"), check("http://shop.parcelwise.test/returns returns 200", http200(s, "http://shop.parcelwise.test/returns"))]; },
      debrief: "A Service has two ports: <b>port</b> (what callers use) and <b>targetPort</b> (where the pod listens). Endpoints only prove that the selector matched some pods, not that anything is listening on that port. Use <b>named ports</b> (<code>targetPort: http</code>) so the Service follows the container if its port ever changes, and run a smoke test against the real URL after every deploy." },

    { id: "PW-308", rank: 2, xp: 150, priority: "Critical", from: "maya", title: "orders-api won't start after node upgrades",
      message: "The cluster nodes were recycled overnight (routine AMI upgrade) and now every <b>orders-api</b> pod is stuck in CreateContainerConfigError, so nobody can see their orders. Jess rotated the orders database password yesterday afternoon, if that's relevant?",
      topic: "Secrets",
      setup: () => k8sHost({
        apps: { "parcelwise/orders-api": { port: 8080, requiredEnv: ["DB_HOST", "DB_PASSWORD"], routes: { "/orders": { status: 200, body: '{"orders_today":1284}' } } } },
        deployments: [dep("orders-api", "parcelwise/orders-api:2.4.1", { replicas: 3, env: [{ name: "DB_HOST", value: "orders-db.cluster-c1x.eu-west-2.rds.amazonaws.com" }, { name: "DB_PASSWORD", valueFrom: { secretKeyRef: { name: "orders-db", key: "password" } } }] })],
        services: [svc("orders-api", { app: "orders-api" })], routes: [["/orders", "orders-api"]],
        secrets: [{ apiVersion: "v1", kind: "Secret", metadata: { name: "orders-db", namespace: "shop", annotations: { "parcelwise.test/rotated-by": "jess", "parcelwise.test/rotated-at": "2026-11-25T16:40:00Z" } }, type: "Opaque", data: { DB_PASSWORD: btoa("0rd3rs-R0tated!-Nov") } }],
      }),
      sop: ["<code>kubectl get pods</code>: <b>CreateContainerConfigError</b> means Kubernetes couldn't build the container's environment, so the app never even started.", "<code>kubectl describe pod …</code>: the Events name the exact problem.", "Compare what the Deployment asks for (<code>kubectl describe deploy orders-api</code>, Environment) with what the Secret holds (<code>kubectl describe secret orders-db</code> shows key names, not values).", "Fix the reference so the names match, keep the password coming from the Secret, and watch the pods come up."],
      hints: ["Describe one of the orders-api pods and read the Events at the bottom.", "The Deployment wants key 'password' from Secret orders-db, but since the rotation the key is called DB_PASSWORD.", "kubectl edit deploy orders-api → in the DB_PASSWORD entry, change secretKeyRef key: password → key: DB_PASSWORD"],
      checks: (s) => { const c = container(s, "orders-api"), e = (c.env || []).find((x) => x.name === "DB_PASSWORD"), ref = e && e.valueFrom && e.valueFrom.secretKeyRef, p = podsOf(s, "orders-api")[0]; return [check("DB_PASSWORD still comes from the orders-db Secret", (ref && ref.name === "orders-db" && !(e && e.value)) || (!e && (c.envFrom || []).some((x) => x.secretRef && x.secretRef.name === "orders-db"))), check("All orders-api pods are Running and Ready", allReady(s, "orders-api")), check("The pods get the rotated password", p && p.ev.env && p.ev.env.DB_PASSWORD === "0rd3rs-R0tated!-Nov"), check("http://shop.parcelwise.test/orders returns 200", http200(s, "http://shop.parcelwise.test/orders"))]; },
      debrief: "Secrets and ConfigMaps are referenced by <b>name and key</b>, and nothing checks they still line up when someone edits one. Running pods keep their old values, so the break only appears when pods are recreated (a deploy, a node upgrade, a crash), often hours later and in the middle of the night. Rotate with a runbook or a tool (such as the External Secrets Operator) that keeps key names stable, and restart the app straight after a rotation so any mistake shows up while you're still watching." },

    { id: "PW-309", rank: 2, xp: 150, priority: "High", from: "maya", title: "Warehouse scanners offline after the move",
      message: "The platform team moved <b>scanner-gateway</b> into its own <b>warehouse</b> namespace last night. Since then the handheld scanners at the depot can't connect. Sam says <code>kubectl get pods</code> doesn't even show it any more?! 🤔",
      topic: "Namespaces",
      setup: () => k8sHost({
        apps: { "parcelwise/scanner-gateway": { port: 8080, requiredEnv: ["SCANNER_API_URL", "SITE_ID"], logs: ['{"level":"info","msg":"scanner-gateway 2.3.0 ready","site":"LHR-02"}'] } },
        deployments: [dep("scanner-gateway", "parcelwise/scanner-gateway:2.3.0", { ns: "warehouse", replicas: 2, envFrom: [{ configMapRef: { name: "scanner-config" } }] })],
        configmaps: [{ apiVersion: "v1", kind: "ConfigMap", metadata: { name: "scanner-config", namespace: "shop" }, data: { SCANNER_API_URL: "https://scanners.parcelwise.internal/api", SITE_ID: "LHR-02", BATCH_SIZE: "50" } }],
      }),
      sop: ["<code>kubectl get pods</code> only looks in your current namespace (shop). Add <code>-n warehouse</code>, or <code>-A</code> for every namespace.", "<code>kubectl describe pod -n warehouse …</code>: read the Events.", "ConfigMaps (and Secrets) are <b>namespaced</b>: a pod can only use ones in its own namespace.", "Copy it across: <code>kubectl get cm scanner-config -n shop -o yaml > /tmp/cm.yaml</code>, change <code>namespace:</code> to warehouse, then <code>kubectl apply -f /tmp/cm.yaml</code>. Or <code>kubectl create configmap … -n warehouse --from-literal=KEY=VALUE</code>."],
      hints: ["kubectl get pods -A: where are the scanner-gateway pods, and what state are they in?", "They're in warehouse with CreateContainerConfigError: configmap \"scanner-config\" not found. It only exists in the shop namespace.", "kubectl get cm scanner-config -n shop -o yaml > /tmp/cm.yaml → nano /tmp/cm.yaml (namespace: warehouse) → kubectl apply -f /tmp/cm.yaml → kubectl get pods -n warehouse"],
      checks: (s) => {
        const d = s.k8s.deployments.find((x) => x.metadata.name === "scanner-gateway" && x.metadata.namespace === "warehouse"), c = d && d.spec.template.spec.containers[0];
        const cm = s.k8s.configmaps.find((x) => x.metadata.name === "scanner-config" && x.metadata.namespace === "warehouse"), ps = podsIn(s, "warehouse", "scanner-gateway");
        return [check("scanner-gateway still runs in the warehouse namespace", d), check("scanner-config exists in warehouse with the same settings", cm && cm.data && cm.data.SCANNER_API_URL === "https://scanners.parcelwise.internal/api" && cm.data.SITE_ID === "LHR-02"), check("scanner-gateway reads its settings from that ConfigMap", c && JSON.stringify([c.env || [], c.envFrom || []]).includes("scanner-config")), check("All scanner-gateway pods are Running and Ready", ps.length > 0 && ps.every((p) => p.ev.ready) && ps.every((p) => p.hash === ps[0].hash))];
      },
      debrief: "Namespaces split one cluster into separate spaces, usually per team or app, so names can repeat and permissions can differ. Almost everything inside them is namespaced, so moving an app means moving its ConfigMaps, Secrets, Services and RBAC too. Keep each app's manifests together (Helm, Kustomize) and deploy them as one unit. And when something seems to have vanished, check <code>-n</code> / <code>-A</code> before you panic." },

    { id: "PW-310", rank: 2, xp: 160, priority: "Critical", from: "sam", title: "Helm: another operation is in progress",
      message: "Our GitLab job deploying <b>storefront 5.5.0</b> (the new gift finder 🎁) died halfway when the CI runner was reclaimed. Now every retry fails with <code>another operation (install/upgrade/rollback) is in progress</code>. Marketing launches the gift finder at noon! The job runs: <code>helm upgrade storefront ~/charts/storefront -f ~/charts/storefront/values-prod.yaml --set image.tag=5.5.0</code>",
      topic: "Helm",
      setup: () => {
        const gift = STORE_HTML.replace("</p>", "</p><p>🎁 New: the Parcelwise gift finder</p>");
        const s = k8sHost({ apps: { "parcelwise/storefront:5.5.0": { ...APPS["parcelwise/storefront"], body: gift } } });
        s.fs.write("/home/ops/charts/storefront/Chart.yaml", "apiVersion: v2\nname: storefront\ndescription: Parcelwise web storefront\nversion: 1.8.0\nappVersion: \"5.4.1\"\n", {}, true);
        s.fs.write("/home/ops/charts/storefront/values.yaml", "image:\n  repository: parcelwise/storefront\n  tag: \"5.4.1\"\nreplicaCount: 2\n", {}, true);
        s.fs.write("/home/ops/charts/storefront/values-prod.yaml", "replicaCount: 2\n", {}, true);
        s.fs.write("/home/ops/charts/storefront/templates/deployment.yaml", "# renders the storefront Deployment from .Values.image and .Values.replicaCount\n", {}, true);
        const rev = (v, st, tag, when, desc) => OD.helmSecret("shop", "storefront", v, st, { chart: "storefront-1.8.0", appVersion: "5.4.1", values: { replicaCount: 2, image: { tag } }, updated: when, description: desc });
        s.k8s.secrets.push(rev(1, "superseded", "5.3.0", "2026-10-02 14:11:09 +0000 UTC", "Install complete"), rev(2, "superseded", "5.3.2", "2026-10-21 10:40:51 +0000 UTC", "Upgrade complete"), rev(3, "superseded", "5.4.0", "2026-11-09 16:02:33 +0000 UTC", "Upgrade complete"), rev(4, "deployed", "5.4.1", "2026-11-18 11:25:12 +0000 UTC", "Upgrade complete"), rev(5, "pending-upgrade", "5.5.0", "2026-11-26 09:58:40 +0000 UTC", "Preparing upgrade"));
        const d = s.k8s.deployments.find((x) => x.metadata.name === "storefront"); d.metadata.annotations = { "meta.helm.sh/release-name": "storefront", "meta.helm.sh/release-namespace": "shop" };
        s.k8s.registry["parcelwise/storefront"] = ["5.4.0", "5.4.1", "5.5.0"];
        return s;
      },
      sop: ["See what Helm thinks: <code>helm list -a</code> and <code>helm history storefront</code>. Look for a revision stuck in <b>pending-upgrade</b>.", "The job died before finishing, so Helm still holds its 'operation in progress' marker and refuses new upgrades.", "Clear it by rolling back to the last good revision: <code>helm rollback storefront N</code> (N = the last <i>deployed</i> one). Helm keeps each revision in a Secret (<code>kubectl get secrets -l owner=helm</code>), so deleting the stuck revision's Secret also works.", "Then run the job's upgrade command again and check the result: <code>helm history</code>, <code>kubectl get pods</code>, the shop."],
      hints: ["helm history storefront: revision 5 is pending-upgrade. That's the lock.", "Roll back to revision 4 (the last deployed one), then rerun the upgrade with image.tag=5.5.0.", "helm rollback storefront 4 && helm upgrade storefront ~/charts/storefront -f ~/charts/storefront/values-prod.yaml --set image.tag=5.5.0 && helm history storefront"],
      checks: (s) => {
        const h = OD.helmRelease(s, "shop", "storefront"), last = h[h.length - 1], r = OD.http(s, "http://shop.parcelwise.test/");
        return [check("No Helm operation is stuck pending", last && !last.status.startsWith("pending")), check("The latest Helm revision is deployed with image tag 5.5.0", last && last.status === "deployed" && ((last.values || {}).image || {}).tag === "5.5.0"), check("storefront runs 5.5.0 and all pods are Ready", container(s, "storefront").image === "parcelwise/storefront:5.5.0" && allReady(s, "storefront")), check("The shop shows the gift finder", !r.error && r.status === 200 && r.body.includes("gift finder"))];
      },
      debrief: "Helm marks a release <i>pending</i> while it works and clears the mark when it finishes. If the process is killed (a CI runner reclaimed, a timeout, Ctrl+C) the mark stays and blocks every later deploy. Rolling back to the last deployed revision is the safe way out. Prevent it with <code>helm upgrade --atomic --timeout 5m</code> (it rolls back by itself on failure) and by not running deploys on spot runners. And don't 'fix' it with <code>kubectl set image</code>: the cluster and Helm's record then disagree, and the next Helm deploy quietly undoes your change." },

    { id: "PW-311", rank: 2, xp: 160, priority: "High", from: "maya", title: "Node drain is stuck",
      message: "AWS has scheduled node <b>ip-10-0-11-42</b> for retirement tonight (degraded hardware). Please drain it so we can terminate it safely. Sam tried <code>kubectl drain</code> and it just keeps retrying something about checkout-api. Checkout must stay up while you do it!",
      topic: "Node maintenance",
      setup: () => {
        const s = k8sHost({ deployments: [dep("checkout-api", "parcelwise/checkout-api:3.2.0", { replicas: 2 })], services: [svc("checkout-api", { app: "checkout-api" })], routes: [["/checkout", "checkout-api"]] });
        s.k8s.pdbs.push({ apiVersion: "policy/v1", kind: "PodDisruptionBudget", metadata: { name: "checkout-api", namespace: "shop", creationTimestamp: "2026-09-14T10:02:00Z" }, spec: { minAvailable: 2, selector: { matchLabels: { app: "checkout-api" } } } });
        return s;
      },
      sop: ["<code>kubectl get nodes</code> and <code>kubectl get pods -o wide</code>: what runs on ip-10-0-11-42?", "<code>kubectl drain NODE --ignore-daemonsets</code> cordons the node, then <b>evicts</b> its pods one by one. An eviction is refused if it would break a <b>PodDisruptionBudget</b>.", "<code>kubectl get pdb</code>: ALLOWED DISRUPTIONS 0 means no pod of that app may be evicted right now. Compare MIN AVAILABLE with the number of replicas.", "Fix the cause (more replicas, or a budget that allows one pod to go), then drain again. Don't bypass the budget with <code>--disable-eviction</code> or by deleting pods by hand."],
      hints: ["kubectl get pdb: checkout-api has MIN AVAILABLE 2 and ALLOWED DISRUPTIONS 0. How many replicas does it have?", "2 replicas with minAvailable 2 means no pod may ever be evicted. Run 3 replicas (or change the PDB to maxUnavailable: 1), then drain.", "kubectl scale deploy checkout-api --replicas=3 && kubectl drain ip-10-0-11-42 --ignore-daemonsets && kubectl get pods -o wide"],
      checks: (s) => {
        const n = "ip-10-0-11-42", left = OD.k8sPods(s, null).filter((p) => p.slot && p.node === n), b = s.k8s.pdbs.find((x) => x.metadata.name === "checkout-api"), reps = (depObj(s, "checkout-api") || { spec: {} }).spec.replicas || 0;
        const protects = b && (b.spec.minAvailable !== undefined ? (String(b.spec.minAvailable).endsWith("%") ? parseInt(b.spec.minAvailable, 10) > 0 : +b.spec.minAvailable >= 1) : String(b.spec.maxUnavailable) !== "100%" && +b.spec.maxUnavailable < reps);
        return [check("ip-10-0-11-42 is cordoned and has no app pods left", s.k8s.cordoned.includes(n) && left.length === 0), check("checkout-api still has a PodDisruptionBudget that protects it", protects), check("…and it now allows one pod to be moved at a time", b && OD.k8sAllowedDisruptions(s, b) >= 1), check("The budget was respected (no --disable-eviction, no deleting pods by hand)", !s.k8s.forcedDrain && !s.k8s.pdbViolated), check("Checkout is up with at least 2 Ready pods", allReady(s, "checkout-api") && podsOf(s, "checkout-api").filter((p) => p.ev.ready).length >= 2 && http200(s, "http://shop.parcelwise.test/checkout"))];
      },
      debrief: "A PodDisruptionBudget limits <i>voluntary</i> disruptions such as drains and node upgrades, so maintenance can't take too many copies of an app down at once. But <code>minAvailable</code> equal to the replica count means no pod may ever be moved, so every drain hangs forever. Prefer <code>maxUnavailable: 1</code>, run at least 3 replicas for anything important, and spread them across zones (topologySpreadConstraints). Managed node-group upgrades in EKS respect PDBs the same way, so a bad budget blocks them too." },

    // ===================================================== SENIOR SRE
    { id: "PW-401", rank: 3, xp: 180, priority: "High", from: "maya", title: "New status page returns 404",
      message: "We launched status.parcelwise.test this morning but it just shows a plain nginx 404. The pods and service are fine according to Sam. Can you get it live before the newsletter goes out at noon?",
      topic: "Ingress",
      setup: () => k8sHost({ apps: { "parcelwise/status-page": { port: 8080, body: "<!doctype html><title>Parcelwise status</title><h1>✅ All systems operational</h1>" } }, deployments: [dep("status-page", "parcelwise/status-page:1.0.1", { replicas: 2 })], services: [svc("status-page", { app: "status-page" })], ingresses: [ing("shop", "shop.parcelwise.test", [["/", "storefront"], ["/track", "tracking-api"]]), ing("status-page", "status.parcelwise.test", [["/", "status-page"]], "nginx-public")] }),
      sop: ["A plain nginx 404 means the request reached the ingress controller, but no rule matched.", "<code>kubectl get ingress</code>: compare CLASS and HOSTS with the working <code>shop</code> ingress.", "<code>kubectl get ingressclass</code> lists the classes that actually exist.", "<code>kubectl edit ingress status-page</code>."],
      hints: ["kubectl get ingress: what CLASS does status-page use? Is there an ADDRESS?", "Its ingressClassName is nginx-public, which doesn't exist. The cluster's class is nginx.", "kubectl edit ingress status-page → ingressClassName: nginx"],
      checks: (s) => [check("status-page uses an existing ingress class", s.k8s.ingressClasses.includes((s.k8s.ingresses.find((i) => i.metadata.name === "status-page") || { spec: {} }).spec.ingressClassName)), check("http://status.parcelwise.test returns 200", http200(s, "http://status.parcelwise.test/"))],
      debrief: "An Ingress is only rules. A controller must claim it through <code>ingressClassName</code>. No matching class means no route (and no ADDRESS in <code>kubectl get ing</code>). Validate manifests in CI (kubeconform, policy checks) to catch this before production." },

    { id: "PW-402", rank: 3, xp: 220, priority: "High", from: "jess", title: "Database password stored in a ConfigMap",
      message: "Audit finding 🔐: checkout-api's DB password is in the ConfigMap <b>checkout-config</b>, which half the company can read. Move it into a Secret called <b>checkout-db</b> and make sure checkout keeps working: no downtime please.",
      topic: "Secrets",
      setup: () => k8sHost({
        apps: { "parcelwise/checkout-api": { ...APPS["parcelwise/checkout-api"], requiredEnv: ["DB_HOST", "DB_PASSWORD"] } },
        deployments: [Object.assign(dep("checkout-api", "parcelwise/checkout-api:3.2.0", { replicas: 3, envFrom: [{ configMapRef: { name: "checkout-config" } }] }), { _lastGood: true })],
        services: [svc("checkout-api", { app: "checkout-api" })], routes: [["/checkout", "checkout-api"]],
        configmaps: [cm("checkout-config", { DB_HOST: "checkout-db.cluster-c1x.eu-west-2.rds.amazonaws.com", DB_USER: "checkout", DB_PASSWORD: "Pw-Ch3ck0ut!-2026", LOG_LEVEL: "info" })],
      }),
      sop: ["See what's there: <code>kubectl get cm checkout-config -o yaml</code>.", "Create the Secret first: <code>kubectl create secret generic checkout-db --from-literal=DB_PASSWORD='…'</code>.", "Reference it from the Deployment (<code>kubectl edit deploy checkout-api</code>): an <code>env</code> entry with <code>valueFrom.secretKeyRef</code>, or <code>envFrom: secretRef</code>.", "Only then remove DB_PASSWORD from the ConfigMap (<code>kubectl edit cm checkout-config</code>) and restart the rollout so pods pick it up.", "Remember: Secrets are only base64-encoded. Protect them with RBAC and encryption at rest."],
      hints: ["Order matters: create the Secret → point the Deployment at it → remove the key from the ConfigMap.", "kubectl create secret generic checkout-db --from-literal=DB_PASSWORD='Pw-Ch3ck0ut!-2026'", "kubectl edit deploy checkout-api → add under the container:\n  env:\n  - name: DB_PASSWORD\n    valueFrom:\n      secretKeyRef: {name: checkout-db, key: DB_PASSWORD}\n→ kubectl edit cm checkout-config (delete DB_PASSWORD) → kubectl rollout restart deploy/checkout-api"],
      checks: (s) => {
        const sec = s.k8s.secrets.find((x) => x.metadata.name === "checkout-db"); const cmap = s.k8s.configmaps.find((x) => x.metadata.name === "checkout-config"); const c = container(s, "checkout-api");
        let val; try { val = sec && atob((sec.data || {}).DB_PASSWORD || ""); } catch { val = null; }
        return [check("Secret checkout-db holds the correct DB_PASSWORD", val === "Pw-Ch3ck0ut!-2026"), check("checkout-config no longer contains DB_PASSWORD", cmap && !("DB_PASSWORD" in (cmap.data || {}))), check("checkout-api reads DB_PASSWORD from the Secret", JSON.stringify([c.env || [], c.envFrom || []]).includes("checkout-db")), check("All checkout-api pods are Ready on the new config", allReady(s, "checkout-api")), check("Checkout still works", http200(s, "http://shop.parcelwise.test/checkout"))];
      },
      debrief: "Plain config goes in ConfigMaps; credentials go in Secrets, with tighter RBAC and encryption at rest. Change in a safe order so there's never a moment the app can't find its password. Even better: keep the source of truth in AWS Secrets Manager and sync it in with the External Secrets Operator, then <b>rotate</b> this password, because it was exposed." },

    { id: "PW-403", rank: 3, xp: 220, priority: "Critical", from: "tom", title: "Black Friday: storefront is crawling",
      message: "The Black Friday promo email just went out 📈 and the storefront is painfully slow (pages 4–5 seconds). Marketing expects traffic to stay high all weekend. Make it fast, and make sure it handles the next spike on its own!",
      topic: "Scaling",
      setup: () => { const s = k8sHost(); s.k8s.apps["parcelwise/storefront"] = { ...APPS["parcelwise/storefront"], cpuLoad: 1400 }; const d = s.k8s.deployments.find((x) => x.metadata.name === "storefront"); d.spec.template.spec.containers[0].resources = { requests: { cpu: "250m", memory: "192Mi" }, limits: { memory: "384Mi" } }; return s; },
      sop: ["Measure: <code>kubectl top pods</code>: how does CPU per pod compare with its request (250m)?", "Short term: add replicas so each pod is under its request.", "Long term: a <b>HorizontalPodAutoscaler</b>: <code>kubectl autoscale deploy storefront --min=3 --max=10 --cpu-percent=60</code>.", "Check: <code>kubectl get hpa</code> and <code>kubectl top pods</code> again."],
      hints: ["kubectl top pods: each storefront pod is using ~700m CPU against a 250m request.", "You need about 6+ pods to bring each under 250m, and an HPA so it adapts by itself.", "kubectl autoscale deploy storefront --min=3 --max=10 --cpu-percent=60 && kubectl get hpa"],
      checks: (s) => { const d = depObj(s, "storefront"); const ready = podsOf(s, "storefront").filter((p) => p.ev.ready).length; const hpa = s.k8s.hpas.find((h) => h.spec.scaleTargetRef.name === "storefront"); return [check("storefront has a HorizontalPodAutoscaler", hpa), check("The HPA keeps at least 3 replicas", hpa && hpa.spec.minReplicas >= 3), check("Enough Ready pods to bring CPU per pod under its 250m request", ready >= 6 && 1400 / ready <= 250)]; },
      debrief: "Scale out on a metric, not a hunch. An HPA adds pods when average CPU (relative to <b>requests</b>) crosses the target, so set accurate requests. It also needs nodes to place pods on: pair it with Cluster Autoscaler or Karpenter, and load-test before the next big campaign." },
    { id: "PW-404", rank: 3, xp: 200, priority: "Critical", from: "tom", title: "Rolled back, still broken",
      message: "🚨 Payments are failing AGAIN. Sam's hotfix <b>4.0.1</b> went out at 14:10 and made it worse, so he ran <code>kubectl rollout undo</code>… and it's STILL failing. He's now on a train with no signal 🚆 Please get payments working!",
      topic: "Rollbacks",
      setup: () => {
        const tpl = (v) => dep("payments-api", `parcelwise/payments-api:${v}`, { replicas: 3 }).spec.template;
        const bad = (v, err) => ({ port: 8080, routes: { "/pay": { status: 500, body: `{"error":"${err}"}` } }, logs: [`{"level":"info","msg":"payments-api ${v} listening"}`, `{"level":"error","msg":"POST /pay 500","err":"${err}"}`, `{"level":"error","msg":"POST /pay 500","err":"${err}"}`] });
        return k8sHost({
          apps: { "parcelwise/payments-api:4.0.0": bad("4.0.0", "TypeError: Cannot read properties of undefined (reading 'currency')"), "parcelwise/payments-api:4.0.1": bad("4.0.1", "RangeError: Invalid currency code : undefined"), "parcelwise/payments-api": { port: 8080, routes: { "/pay": { status: 200, body: '{"ok":true,"payment":"PAY-1182"}' } } } },
          // revisions: 1 = 3.9.2 (good), 2 = 4.0.0, 3 = 4.0.1, and Sam's undo made 4.0.0 current again
          deployments: [Object.assign(dep("payments-api", "parcelwise/payments-api:4.0.0", { replicas: 3 }), { _history: [tpl("3.9.2"), tpl("4.0.0"), tpl("4.0.1")] })],
          services: [svc("payments-api", { app: "payments-api" })], routes: [["/pay", "payments-api"]],
        });
      },
      sop: ["Restore service first, investigate later. <code>kubectl rollout history deploy/payments-api</code> lists every revision and its image.", "<code>rollout undo</code> goes back <b>one</b> revision, which here is just the other broken release.", "Find the last revision that worked (before 4.0.x) and go straight to it: <code>kubectl rollout undo deploy/payments-api --to-revision=N</code>.", "Verify: <code>kubectl rollout status deploy/payments-api</code> and <code>curl http://shop.parcelwise.test/pay</code>."],
      hints: ["kubectl rollout history deploy/payments-api. Which revision ran 3.9.2?", "A plain 'rollout undo' flips between 4.0.0 and 4.0.1, and both are broken. Revision 1 is 3.9.2.", "kubectl rollout undo deploy/payments-api --to-revision=1 && curl http://shop.parcelwise.test/pay"],
      checks: (s) => [check("payments-api runs 3.9.2, the last good version", container(s, "payments-api").image === "parcelwise/payments-api:3.9.2"), check("All payments-api pods are Ready", allReady(s, "payments-api")), check("http://shop.parcelwise.test/pay returns 200", http200(s, "http://shop.parcelwise.test/pay"))],
      debrief: "Under pressure people repeat whatever worked last time. <code>rollout undo</code> means 'the previous revision', not 'the last good version', and after a hotfix and an undo those are very different things. Read the history, pick the known-good revision, and record a change-cause on each deploy (the <code>kubernetes.io/change-cause</code> annotation, or your CD tool) so the history makes sense at 2am. Progressive delivery tools such as Argo Rollouts can roll back automatically when the error rate climbs." },

    { id: "PW-405", rank: 3, xp: 200, priority: "High", from: "maya", title: "The autoscaler never scales",
      message: "Search has been sluggish since the new 'gift finder' launched. We added an autoscaler to <b>search-api</b> after Black Friday, but it's sat at 2 pods all week. Can you find out why it isn't scaling, and fix it?",
      topic: "Autoscaling",
      setup: () => k8sHost({
        apps: { "parcelwise/search-api": { port: 8080, health: "/healthz", cpuLoad: 900, memMi: 210, routes: { "/search": { status: 200, body: '{"results":24,"took_ms":2140}' } }, logs: ['{"level":"info","msg":"search index loaded","docs":182331}', '{"level":"warn","msg":"slow query","took_ms":2140,"q":"gift for dad"}'] } },
        deployments: [dep("search-api", "parcelwise/search-api:1.2.0", { replicas: 2, resources: { requests: { memory: "256Mi" }, limits: { memory: "512Mi" } } })],
        services: [svc("search-api", { app: "search-api" })], routes: [["/search", "search-api"]],
        hpas: [{ _age: "9d", apiVersion: "autoscaling/v2", kind: "HorizontalPodAutoscaler", metadata: { name: "search-api", namespace: "shop" }, spec: { scaleTargetRef: { apiVersion: "apps/v1", kind: "Deployment", name: "search-api" }, minReplicas: 2, maxReplicas: 10, metrics: [{ type: "Resource", resource: { name: "cpu", target: { type: "Utilization", averageUtilization: 60 } } }] } }],
      }),
      sop: ["<code>kubectl get hpa</code>: what does the TARGETS column say?", "<code>kubectl describe hpa search-api</code>: the Conditions and Events say why it can't act.", "An HPA's CPU target is a percentage of each pod's <b>CPU request</b>. No request means no percentage, which means no scaling.", "Add a request (<code>kubectl edit deploy search-api</code>, <code>resources.requests.cpu</code>) sized from <code>kubectl top pods</code>, then watch <code>kubectl get hpa</code>."],
      hints: ["kubectl get hpa shows cpu: <unknown>/60%. Why can't it measure?", "describe hpa: 'missing request for cpu'. The container only requests memory.", "kubectl edit deploy search-api → under resources.requests add cpu: 250m → kubectl get hpa && kubectl top pods"],
      checks: (s) => { const c = container(s, "search-api"), req = cpuM(((c.resources || {}).requests || {}).cpu), hpa = s.k8s.hpas.find((h) => h.spec.scaleTargetRef.name === "search-api"), ready = podsOf(s, "search-api").filter((p) => p.ev.ready).length; return [check("search-api has a CPU request, so the HPA can measure it", req > 0), check("…a realistic one (between 50m and 1 CPU)", req >= 50 && req <= 1000), check("The autoscaler is still in charge", hpa && hpa.spec.maxReplicas >= 4), check("Enough Ready pods to bring CPU per pod under its request", ready > 0 && 900 / ready <= req)]; },
      debrief: "Autoscaling maths runs on requests: utilisation = usage ÷ request. Without a CPU request the HPA shows <code>&lt;unknown&gt;</code> and quietly does nothing, which is why 'the autoscaler never scales' is such a classic. Set requests from real usage on every container (a LimitRange can set defaults, and policy tools such as Kyverno can reject Deployments without them), and alert when an HPA sits at its minimum or maximum for too long." },

    { id: "PW-406", rank: 3, xp: 180, priority: "Normal", from: "lena", title: "Why is the AWS bill up £3,800?",
      message: "Hi! Our AWS bill is up <b>£3,800</b> this month and Cost Explorer blames the Kubernetes nodes 💸 Nobody on the platform team knows why. Sam mentioned a load test 'a few weeks ago'? Please stop whatever is wasting money, but obviously don't touch the live shop!",
      topic: "Cost",
      setup: () => k8sHost({
        apps: { "grafana/k6": { port: 6565, cpuLoad: 28500, memMi: 900, logs: ["running (412h31m02.1s), 30/30 VUs, 18310442 complete and 0 interrupted iterations", "default   [ 100% ] 30 VUs  412h31m02.1s/∞", "     ✓ status is 200"] } },
        deployments: [Object.assign(dep("load-generator", "grafana/k6:0.54.0", { ns: "loadtest", replicas: 30, port: 6565, resources: { requests: { cpu: "1", memory: "1Gi" }, limits: { memory: "2Gi" } } }), { _age: "17d" })],
        hpas: [{ _age: "17d", apiVersion: "autoscaling/v2", kind: "HorizontalPodAutoscaler", metadata: { name: "load-generator", namespace: "loadtest" }, spec: { scaleTargetRef: { apiVersion: "apps/v1", kind: "Deployment", name: "load-generator" }, minReplicas: 30, maxReplicas: 30, metrics: [{ type: "Resource", resource: { name: "cpu", target: { type: "Utilization", averageUtilization: 80 } } }] } }],
      }),
      sop: ["Find it: <code>kubectl get pods -A</code> (every namespace) and <code>kubectl top pods -A</code>.", "Check before you delete: what is it, and does anything in prod depend on it? <code>kubectl get all -n loadtest</code>, <code>kubectl get hpa -A</code>.", "Watch out for an <b>HPA</b>: it will scale a Deployment straight back up to its minimum after a manual <code>kubectl scale</code>.", "Stop it: <code>kubectl delete namespace loadtest</code> removes everything inside, or delete the HPA and the Deployment one by one."],
      hints: ["kubectl get pods -A: which namespace has dozens of pods?", "loadtest/load-generator: 30 k6 pods, each requesting a whole CPU, running for weeks. An HPA holds it at 30.", "kubectl delete namespace loadtest   (or: kubectl delete hpa load-generator -n loadtest && kubectl delete deploy load-generator -n loadtest)"],
      checks: (s) => [check("No load-generator pods are running", podsIn(s, null, "load-generator").length === 0), check("storefront is untouched (all pods Ready)", allReady(s, "storefront") && podsOf(s, "storefront").length >= 2), check("tracking-api is untouched", allReady(s, "tracking-api")), check("The shop still loads", http200(s, "http://shop.parcelwise.test/"))],
      debrief: "Cost is an SRE problem too. Forgotten test workloads are one of the most common sources of cloud waste: here, 30 CPUs kept extra nodes running for weeks. Give every workload an owner label and an expiry date, run load tests as Jobs that finish on their own (k6 with a duration, not forever), and set AWS Budgets alerts so a spike reaches someone within days, not at month-end. With Cluster Autoscaler or Karpenter, the spare nodes disappear once the pods do." },

    { id: "PW-407", rank: 3, xp: 220, priority: "High", from: "maya", title: "Our backups can't be restored",
      message: "Our ISO 27001 auditor arrives Monday and wants evidence of a <b>successful restore test</b>. Omar ran <code>/opt/scripts/restore-test.sh</code> on db-backup-01 and it failed, yet the backup log says 'backup complete' every single night 😰 Jess rotated the database passwords last week (the new ones are in AWS Secrets Manager). Please get us a backup we can actually restore, and the passing test to prove it.",
      topic: "Backups & restore",
      setup: () => {
        const host = "parcelwise-db.cluster-c1x.eu-west-2.rds.amazonaws.com", NEW = "Bk-9f2!Rotated-Nov";
        const files = {
          "/opt/scripts/db-backup.sh": { content: `#!/bin/bash\n# Nightly logical backup of the parcelwise database (run by /etc/cron.d/db-backup)\nset -eu\nOUT=/var/backups/parcelwise-$(date +%F).sql.gz\npg_dump -h ${host} -U backup parcelwise | gzip > "$OUT"\necho "$(date -Is) backup complete: $OUT"\n`, owner: "root", mode: "755" },
          "/opt/scripts/restore-test.sh": { content: "#!/bin/bash\n# Restore drill: loads the newest backup into a scratch database and counts the rows\nset -euo pipefail\nLATEST=$(ls -1t /var/backups/parcelwise-*.sql.gz | head -1)\ncreatedb restore_test\ngunzip -c \"$LATEST\" | psql -q -d restore_test\npsql -d restore_test -tc 'select count(*) from orders'\n", owner: "root", mode: "755" },
          "/etc/cron.d/db-backup": { content: "# m h dom mon dow user command\n15 2 * * * root /opt/scripts/db-backup.sh >> /var/log/db-backup.log 2>&1\n", owner: "root" },
          "/root/.pgpass": { content: `${host}:5432:parcelwise:backup:Bk-2025-Summer!\n`, owner: "root", mode: "600" },
          "/home/ops/README.txt": { content: "db-backup-01: runs the nightly logical backups of the parcelwise RDS database.\nBackups: /var/backups   Scripts: /opt/scripts   Log: /var/log/db-backup.log\nThe backup user's password lives in /root/.pgpass (pg_dump reads it automatically).\n" },
        };
        const log = [];
        for (let d = 16; d <= 26; d++) {
          const date = `2026-11-${d}`, ok = d < 20;
          files[`/var/backups/parcelwise-${date}.sql.gz`] = { content: ok ? "-- PostgreSQL database dump\n-- Dumped from database version 16.4\nCREATE TABLE public.orders (…);\nCOPY public.orders (id, …) FROM stdin;\n…\n" : "", size: ok ? 410 * MB + d * 1100 * 1024 : 20, owner: "root", mtime: `Nov ${d} 02:1${ok ? 9 : 5}` };
          if (!ok) log.push(`pg_dump: error: connection to server at "${host}" (10.0.21.14), port 5432 failed: FATAL:  password authentication failed for user "backup"`);
          log.push(`${date}T02:${ok ? 19 : 15}:0${d % 10}+00:00 backup complete: /var/backups/parcelwise-${date}.sql.gz`);
        }
        files["/var/log/db-backup.log"] = { content: log.join("\n") + "\n", owner: "root", mode: "640" };
        const s = OD.newHost({ host: "db-backup-01", files, dirs: ["/var/backups", "/root"], users: { postgres: { uid: 112, home: "/var/lib/postgresql" } } });
        s.aws = { account: "123456789012", secrets: { "prod/parcelwise/db-backup-user": JSON.stringify({ username: "backup", password: NEW, host, port: 5432, dbname: "parcelwise" }), "prod/parcelwise/checkout-db": JSON.stringify({ username: "checkout", password: "Pw-Ch3ck0ut!-2026" }) } };
        const today = "/var/backups/parcelwise-2026-11-26.sql.gz";
        s.scripts["/opt/scripts/db-backup.sh"] = (st, ctx) => {
          if (!OD.isRoot(ctx)) return { out: `/opt/scripts/db-backup.sh: line 5: ${today}: Permission denied`, code: 1 };
          const script = st.fs.get("/opt/scripts/db-backup.sh").content, pipefail = /^\s*set\s+(-[a-z]*o\s+pipefail|-o\s+pipefail)|^\s*set\s+-[a-z]*\s+-o\s+pipefail/m.test(script) || /set -[a-z]*o pipefail/.test(script);
          const pw = ((st.fs.get("/root/.pgpass") || { content: "" }).content.split("\n").map((l) => l.trim().split(":")).find((f) => f[0] === host && f[3] === "backup") || [])[4];
          if (pw === NEW) { st.fs.write(today, "-- PostgreSQL database dump\n-- Dumped from database version 16.4\nCREATE TABLE public.orders (…);\nCOPY public.orders (id, …) FROM stdin;\n…\n", { owner: "root", size: 424 * MB, mtime: "Nov 26 10:31" }); return `2026-11-26T10:31:07+00:00 backup complete: ${today}`; }
          st.fs.write(today, "", { owner: "root", size: 20, mtime: "Nov 26 10:31" });
          const err = `pg_dump: error: connection to server at "${host}" (10.0.21.14), port 5432 failed: FATAL:  password authentication failed for user "backup"`;
          return pipefail ? { out: err, code: 1 } : `${err}\n2026-11-26T10:31:07+00:00 backup complete: ${today}`;
        };
        s.scripts["/opt/scripts/restore-test.sh"] = (st, ctx) => {
          if (!OD.isRoot(ctx)) return { out: "createdb: error: connection to server on socket \"/var/run/postgresql/.s.PGSQL.5432\" failed: FATAL:  role \"ops\" does not exist", code: 1 };
          const latest = st.fs.list("/var/backups").filter((n) => /^parcelwise-.*\.sql\.gz$/.test(n)).sort().pop(), p = `/var/backups/${latest}`;
          if (!latest || st.fs.size(p) < 1024) return { out: `gzip: ${p}: unexpected end of file\npsql:<stdin>: ERROR:  relation "orders" does not exist\nRESTORE TEST FAILED: ${latest || "no backup"} could not be restored`, code: 1 };
          st.restoreOk = latest;
          return ` 1284113\n\nRESTORE TEST PASSED: ${latest} restored into restore_test (orders: 1,284,113 rows) at 2026-11-26T10:31:09Z`;
        };
        return s;
      },
      sop: ["Look at the evidence: <code>ls -lh /var/backups</code> (how big are the recent files?) and <code>sudo tail /var/log/db-backup.log</code>.", "Read <code>/opt/scripts/db-backup.sh</code>. In <code>pg_dump … | gzip > FILE</code> the pipeline's exit status is <code>gzip</code>'s, so a failing pg_dump still looks like success. <code>set -o pipefail</code> fixes that.", "Get the new password: <code>aws secretsmanager get-secret-value --secret-id prod/parcelwise/db-backup-user --query SecretString --output text</code>, and put it in <code>/root/.pgpass</code> (<code>sudo nano</code>, keep it mode 600).", "Run the backup by hand (<code>sudo /opt/scripts/db-backup.sh</code>), then prove it: <code>sudo /opt/scripts/restore-test.sh</code>."],
      hints: ["ls -lh /var/backups: every file since 20 Nov is 20 bytes, an empty gzip. What does the log say before each 'backup complete'?", "pg_dump fails authentication because .pgpass still has the old password, and without pipefail the script reports success anyway. Fix both, run a backup, then run the restore test.", "aws secretsmanager get-secret-value --secret-id prod/parcelwise/db-backup-user --query SecretString --output text → sudo nano /root/.pgpass (new password) → sudo nano /opt/scripts/db-backup.sh (set -euo pipefail) → sudo /opt/scripts/db-backup.sh → sudo /opt/scripts/restore-test.sh"],
      checks: (s) => {
        const pg = s.fs.get("/root/.pgpass"), script = (s.fs.get("/opt/scripts/db-backup.sh") || { content: "" }).content, today = "/var/backups/parcelwise-2026-11-26.sql.gz";
        return [check("/root/.pgpass has the rotated password", pg && pg.content.includes(":backup:Bk-9f2!Rotated-Nov")), check("…and only root can read it (mode 600)", pg && pg.owner === "root" && pg.mode === "600"), check("The backup script fails loudly if pg_dump fails (pipefail)", /set\s+-[a-z]*o\s+pipefail|set\s+-o\s+pipefail/.test(script)), check("Today's backup is a real dump, not an empty file", s.fs.isFile(today) && s.fs.size(today) > OD.MB), check("The restore test passed on today's backup", s.restoreOk === "parcelwise-2026-11-26.sql.gz")];
      },
      debrief: "A backup you haven't restored is a hope, not a backup. Two classic failures stacked up here: a rotated credential nobody updated, and a pipeline (<code>pg_dump | gzip</code>) whose exit status hid the error, so the job reported success for a week. Start Bash scripts with <code>set -euo pipefail</code>, alert on the <i>output</i> (a backup file below a sane size, or no new file), and run restore drills on a schedule, not just before audits. Better still, have the backup job read credentials straight from Secrets Manager so a rotation can't break it, and keep RDS automated snapshots as a second line of defence." },

    { id: "PW-408", rank: 3, xp: 220, priority: "High", from: "maya", title: "Every deploy burns our error budget",
      message: "Our checkout SLO is <b>99.9%</b> of requests succeeding each month, which allows about 43 minutes of errors. We've already burned 70% of November's error budget, and the dashboards show it's all 30 to 60 second bursts of 503s straight after each <b>checkout-api</b> deploy (Sam ships 5 a day). Please make deploys zero-downtime before the 15:00 release.",
      topic: "SLOs & rollouts",
      setup: () => {
        const d = dep("checkout-api", "parcelwise/checkout-api:3.2.0", { replicas: 3, readiness: false });
        d.spec.strategy = { type: "RollingUpdate", rollingUpdate: { maxUnavailable: "100%", maxSurge: 0 } };
        return k8sHost({ apps: { "parcelwise/checkout-api": { ...APPS["parcelwise/checkout-api"], health: "/healthz", logs: ['{"level":"info","msg":"checkout-api 3.2.0 starting"}', '{"level":"info","msg":"warming payment-provider connections and price cache (about 25s)"}', '{"level":"info","msg":"ready","took_ms":24810}'] } }, deployments: [d], services: [svc("checkout-api", { app: "checkout-api" })], routes: [["/checkout", "checkout-api"]] });
      },
      sop: ["<code>kubectl describe deploy checkout-api</code>: read <b>RollingUpdateStrategy</b>. How many pods may be down at once during a rollout?", "<b>maxUnavailable</b> = pods that may be missing during a rollout. <b>maxSurge</b> = extra pods allowed above the replica count. 100% unavailable and 0 surge means 'kill everything, then start the new ones'.", "Even a gentle rollout causes errors if new pods get traffic before they're ready. The logs show a ~25s warm-up, and there's no <b>readinessProbe</b>, so Kubernetes can't tell.", "<code>kubectl edit deploy checkout-api</code>: set e.g. <code>maxUnavailable: 0</code>, <code>maxSurge: 1</code>, and add a readinessProbe on <code>/healthz</code> port 8080."],
      hints: ["kubectl describe deploy checkout-api: RollingUpdateStrategy is '100% max unavailable, 0 max surge', and Readiness is <none>.", "Two fixes: keep old pods until new ones are ready (maxUnavailable 0, maxSurge 1), and tell Kubernetes when a pod is ready (readinessProbe on /healthz).", "kubectl edit deploy checkout-api → spec.strategy.rollingUpdate: {maxUnavailable: 0, maxSurge: 1} and under the container readinessProbe: {httpGet: {path: /healthz, port: 8080}, periodSeconds: 5}"],
      checks: (s) => { const d = depObj(s, "checkout-api"), r = OD.k8sRolling(d), c = container(s, "checkout-api"), rp = c.readinessProbe && c.readinessProbe.httpGet; return [check("A rollout keeps at least 2 of 3 pods serving", ((d.spec.strategy || {}).type || "RollingUpdate") === "RollingUpdate" && r.maxUnavailable <= 1), check("New pods only get traffic once they're ready (readinessProbe)", rp && rp.path === "/healthz"), check("All checkout-api pods are Running and Ready", allReady(s, "checkout-api")), check("Checkout works", http200(s, "http://shop.parcelwise.test/checkout"))]; },
      debrief: "An SLO turns 'be reliable' into a number, and the error budget tells you when reliability work beats feature work. Here the budget pointed straight at deploys. Zero-downtime rollouts need both halves: a strategy that keeps capacity (<code>maxUnavailable: 0</code>, <code>maxSurge: 1</code>) and a readiness probe so traffic waits for warm-up. Then add a <code>preStop</code> sleep so in-flight requests finish before a pod dies, and <code>minReadySeconds</code> to catch pods that crash just after starting. Measure the SLO from the user's side (load balancer or synthetic checks), not from inside the pod." },

  ];
})();
