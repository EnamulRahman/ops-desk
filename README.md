# Ops Desk

**An on-call simulator for DevOps engineers.** You join *Parcelwise*, a fictional parcel-delivery startup, as their newest DevOps hire. Coworkers send you tickets, you fix them in a simulated terminal, and a grader checks the **state of the system** (is the site up? is the pod Ready? is the password out of the ConfigMap?), not the commands you typed. Resolve tickets to earn XP and get promoted.

Everything runs in the browser. There are no real servers, no accounts and no build step.

## Career ladder

| Rank | Area | Tickets |
|---|---|---|
| DevOps Intern | Linux: disk full, broken nginx config, users & groups, cron/permissions, runaway process, service not enabled after a reboot, cron schedule mistake, SSH key permissions, expired TLS certificate, finding a scraper in the access log, a held security patch | 11 |
| Junior DevOps Engineer | Docker: missing env vars, wrong port mapping, multi-stage non-root Dockerfile, image cleanup, database without a volume, AWS key baked into an image, in-place version upgrade, Trivy CVEs in a base image, container logs filling the disk | 9 |
| Platform Engineer | Kubernetes: ImagePullBackOff, Service selector, CrashLoopBackOff/ConfigMap, OOMKilled, rollback, readiness probe, Service targetPort, Secret key renamed in a rotation, ConfigMap missing from a new namespace, Helm release stuck pending, node drain blocked by a PodDisruptionBudget | 11 |
| Senior SRE | Ingress class, moving a password into a Secret, HPA for a traffic spike, rollback to a specific revision, HPA that can't scale without CPU requests, a forgotten load test running up the AWS bill, backups that can't be restored, deploys burning the error budget | 8 |

Every ticket is open from the start, so you can jump to whatever you want to practise. Your rank goes up as you clear each rank's tickets.

Each ticket has a briefing (what's being asked, background, and the concepts and commands you need), a runbook, three free hints (nudge, closer, full answer), and a debrief explaining what a senior engineer would want you to take away.

### Where the scenarios come from

The later tickets are based on what UK employers ask DevOps, platform and SRE engineers to do. They were drawn from current job descriptions at junior to staff level (government digital teams, consultancies, fintech, logistics, energy and consumer tech):

| What the job descriptions ask for | Tickets |
|---|---|
| Linux troubleshooting, Bash, log analysis | PW-106, PW-107, PW-110 |
| OS patching and vulnerability remediation | PW-111, PW-208 |
| Certificate management | PW-109 |
| Container security scanning (Trivy, Snyk), secrets handling | PW-206, PW-208 |
| Production capacity and disk | PW-209 |
| Kubernetes and Helm deployments | PW-307 to PW-310 |
| Patching Kubernetes nodes, high availability | PW-311 |
| PostgreSQL backups and restore drills, ISO 27001 evidence | PW-407 |
| Incident management, SLOs and error budgets, zero downtime | PW-404, PW-408 |
| Autoscaling and cost optimisation (FinOps) | PW-405, PW-406 |

## Playing on more than one device

Progress is saved in your browser. To carry it to another device, press **☁️ Sync**. You can scan the QR code with your phone, or copy the link and send it to yourself. Opening the link on the other device asks you to confirm, then **merges** progress, so you can sync either way as often as you like. It's free and needs no account: the progress travels inside the link itself (`#sync=…`, never sent to a server), and nothing is stored online.

## What's simulated

- **Linux shell:** pipes, `&&`/`||`/`;`, redirects, globs, `sudo`, file permissions, users/groups, systemd services and journal, processes and signals, `df`/`du`/`lsof`, `curl`, `awk`/`cut`/`sort`/`uniq` for log analysis, `apt` (holds, needrestart), `openssl`/`certbot` and systemd timers, a little of the `aws` CLI, and a nano/vim-style editor.
- **Docker:** images, containers, `run` flags (`-p`, `-e`, `--env-file`, `--restart`), logs, `build` with a Dockerfile analyser (multi-stage, base image size, `USER`), prune and `system df`, volumes, `history`, log rotation (`--log-opt`, `daemon.json`), and `trivy image` scanning.
- **Kubernetes:** Deployments → pods (ImagePullBackOff, CrashLoopBackOff, OOMKilled, probe failures), rolling updates and revision history, Services/Endpoints by label, Ingress routing by host and class, ConfigMaps, Secrets, HPA, PodDisruptionBudgets, namespaces, node cordon/drain, rolling-update strategy, `kubectl get/describe/logs/edit/apply/set/rollout/top/autoscale/drain`, and `helm` (list, history, upgrade, rollback, with releases stored as Secrets like Helm 3).

Type `help` in the terminal, or open the 📒 Binder, for the command reference.

## Run it

Open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server 8000   # then visit http://localhost:8000
```

To host it on GitHub Pages: Settings → Pages → *Deploy from a branch* → `main` / root.

## Tests

```bash
node test/engine.test.js      # every ticket starts broken and its reference solution passes the grader
node test/ui.test.js          # plays all 39 tickets through the real UI (needs Playwright + Chromium)
node test/wrong.test.js       # tempting-but-wrong fixes are rejected
node test/sync.test.js        # two browsers sync progress both ways (serve the folder on :8765 first)
node test/security.test.js    # hostile input can't run script, sync links need consent, CSP and frame protection hold
```

`test/solutions.js` contains the reference solutions. They're spoilers!

## Security

Ops Desk has no server, no accounts and makes no network requests, so there's very little to attack. On top of that:

- **Content-Security-Policy** (in `index.html`): only the site's own scripts and styles can run. Inline scripts, inline event handlers, `eval`, network requests, plugins and form submissions are all blocked, so even a future escaping bug couldn't run injected code.
- **Everything shown is escaped:** the player's name, terminal input and output, and file contents are always inserted as text.
- **Sync links are untrusted input:** only known ticket ids are kept, every value is type-checked and clamped, and opening a link asks before merging anything. Saved progress in `localStorage` is validated the same way when it's loaded.
- **No framing:** the page refuses to run inside another site's `<iframe>` (clickjacking protection, since GitHub Pages can't send `X-Frame-Options`).
- **Vendored libraries are pinned:** js-yaml 4.3.2 (no known advisories) and qrcode-generator 1.4.4, both copied into `vendor/`, with no CDN.

## Project layout

```
index.html          page shell
css/style.css       styles
js/core.js          helpers, tokenizer, virtual filesystem, HTTP resolver
js/linux.js         shell + Linux commands, services, processes
js/docker.js        Docker simulator
js/k8s.js           Kubernetes simulator
js/tickets.js       the Parcelwise story: tickets, runbooks, hints, graders, debriefs
js/briefs.js        per-ticket briefings: what's asked, background, helpful info
js/game.js          UI: landing page, desk, terminal, editor, grading, progress
vendor/js-yaml.min.js  YAML parser, v4.3.2 (MIT, see vendor/JS-YAML-LICENSE)
vendor/qrcode-generator.js  QR codes for the Sync link (MIT, see vendor/QRCODE-LICENSE)
```

## Adding a ticket

Add an object to `OD.TICKETS` in `js/tickets.js` with `setup()` (build a broken world with `OD.newHost`, `OD.addService`, `OD.addDocker`, `OD.addK8s`), `checks(state)` (a list of `{label, ok}`), a `sop`, three `hints` and a `debrief`, plus a briefing in `js/briefs.js`. Then add its solution to `test/solutions.js` and run the tests.

---

Parcelwise, its staff and its incidents are fictional. Ops Desk is an independent learning project.
