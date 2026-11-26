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

  // a standard web server: nginx in front of the parcelwise-api app on :8080
  function webHost(opts = {}) {
    const s = OD.newHost({ host: opts.host || "web-01", diskBase: opts.diskBase, diskTotal: opts.diskTotal, files: {
      "/etc/nginx/sites-enabled/parcelwise": { content: opts.site || nginxSite, owner: "root" },
      "/etc/nginx/nginx.conf": { content: "user www-data;\nworker_processes auto;\ninclude /etc/nginx/sites-enabled/*;\n", owner: "root" },
      "/var/log/nginx/parcelwise.access.log": { content: '10.0.1.17 - - [26/Nov/2026:10:12:44 +0000] "GET / HTTP/1.1" 200 5213\n', owner: "root", mode: "640" },
      "/home/ops/README.txt": { content: "Welcome to web-01 (Parcelwise production web).\nApp: parcelwise-api on :8080 behind nginx on :80.\nLogs: /var/log/parcelwise/ and /var/log/nginx/\n" },
      ...(opts.files || {}) }, groups: opts.groups });
    OD.addService(s, "parcelwise-api", { desc: "Parcelwise API", port: 8080, bind: "127.0.0.1", proc: { cmd: "/usr/local/bin/parcelwise-api --port 8080", user: "www", cpu: 2.1, mem: 6.4 }, holds: ["/var/log/parcelwise/app.log"], active: opts.apiActive !== false });
    OD.addService(s, "nginx", { desc: "A high performance web server and a reverse proxy server", port: 80, proc: { cmd: "nginx: master process /usr/sbin/nginx -g daemon on; master_process on;", user: "root", cpu: 0.1, mem: 0.4 }, check: (st) => { const r = OD.nginxCheck(st); return r.ok ? { ok: true } : { ok: false, journal: [r.err, "nginx: configuration file /etc/nginx/nginx.conf test failed"] }; }, active: opts.nginxActive });
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
    "parcelwise/storefront": ["5.4.0", "5.4.1"], "parcelwise/checkout-api": ["3.1.4", "3.2.0"], "parcelwise/tracking-api": ["1.8.0", "1.9.2"],
    "parcelwise/notify": ["0.9.1"], "parcelwise/label-renderer": ["2.0.3"], "parcelwise/payments-api": ["3.9.2", "4.0.0"], "parcelwise/search-api": ["1.2.0"], "parcelwise/status-page": ["1.0.1"],
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
  ];
})();
