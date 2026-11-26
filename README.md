# Ops Desk

**An on-call simulator for DevOps engineers.** You join *Parcelwise*, a fictional parcel-delivery startup, as their newest DevOps hire. Coworkers send you tickets, you fix them in a simulated terminal, and a grader checks the **state of the system** (is the site up? is the pod Ready? is the password out of the ConfigMap?), not the commands you typed. Resolve tickets to earn XP and get promoted.

Everything runs in the browser. There are no real servers, no accounts and no build step.

## Career ladder

| Rank | Area | Tickets |
|---|---|---|
| DevOps Intern | Linux: disk full, broken nginx config, users & groups, cron/permissions, runaway process | 5 |
| Junior DevOps Engineer | Docker: missing env vars, wrong port mapping, multi-stage non-root Dockerfile, image cleanup | 4 |
| Platform Engineer | Kubernetes: ImagePullBackOff, Service selector, CrashLoopBackOff/ConfigMap, OOMKilled, rollback, readiness probe | 6 |
| Senior SRE | Ingress class, moving a password into a Secret, HPA for a traffic spike | 3 |

Each ticket has a briefing (what's being asked, background, and the concepts and commands you need), a runbook, three free hints (nudge, closer, full answer), and a debrief explaining what a senior engineer would want you to take away.

## What's simulated

- **Linux shell:** pipes, `&&`/`||`/`;`, redirects, globs, `sudo`, file permissions, users/groups, systemd services and journal, processes and signals, `df`/`du`/`lsof`, `curl`, and a nano/vim-style editor.
- **Docker:** images, containers, `run` flags (`-p`, `-e`, `--env-file`, `--restart`), logs, `build` with a Dockerfile analyser (multi-stage, base image size, `USER`), prune and `system df`.
- **Kubernetes:** Deployments → pods (ImagePullBackOff, CrashLoopBackOff, OOMKilled, probe failures), rolling updates and revision history, Services/Endpoints by label, Ingress routing by host and class, ConfigMaps, Secrets, HPA, `kubectl get/describe/logs/edit/apply/set/rollout/top/autoscale`.

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
node test/ui.test.js          # plays all 18 tickets through the real UI (needs Playwright + Chromium)
node test/wrong.test.js       # tempting-but-wrong fixes are rejected
```

`test/solutions.js` contains the reference solutions. They're spoilers!

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
vendor/js-yaml.min.js  YAML parser (MIT, see vendor/JS-YAML-LICENSE)
```

## Adding a ticket

Add an object to `OD.TICKETS` in `js/tickets.js` with `setup()` (build a broken world with `OD.newHost`, `OD.addService`, `OD.addDocker`, `OD.addK8s`), `checks(state)` (a list of `{label, ok}`), a `sop`, three `hints` and a `debrief`, plus a briefing in `js/briefs.js`. Then add its solution to `test/solutions.js` and run the tests.

---

Parcelwise, its staff and its incidents are fictional. Ops Desk is an independent learning project.
