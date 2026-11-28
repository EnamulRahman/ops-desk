// Ops Desk — simulated Kubernetes: Deployments reconcile into pods whose status is computed from
// the template (image, config, memory, probes), Services pick endpoints by label, Ingress routes by host.
(() => {
  "use strict";
  const OD = window.OD, C = OD.commands, { parseArgs, table } = OD;
  const yaml = () => window.jsyaml;

  OD.addK8s = (s, k) => {
    s.k8s = { ns: "default", registry: {}, apps: {}, deployments: [], services: [], configmaps: [], secrets: [], ingresses: [], hpas: [], pdbs: [], pods: [], cordoned: [], drained: [], ingressClasses: ["nginx"], history: {}, lastGood: {}, gen: {}, ...k };
    s.k8s.deployments.forEach((d) => { normalise(d); if (d._lastGood) s.k8s.lastGood[key(d)] = OD.clone(d._lastGood === true ? d.spec.template : d._lastGood); delete d._lastGood; if (d._history) { s.k8s.history[key(d)] = d._history; delete d._history; } });
    ["services", "configmaps", "secrets", "ingresses", "hpas", "pdbs"].forEach((t) => s.k8s[t].forEach(normalise));
    reconcile(s);
  };
  function normalise(o) { o.metadata = o.metadata || {}; o.metadata.namespace = o.metadata.namespace || "default"; o.metadata.creationTimestamp = o.metadata.creationTimestamp || "2026-11-20T09:14:02Z"; }
  const key = (o) => `${o.metadata.namespace}/${o.metadata.name}`;
  const tHash = (t) => OD.hash(JSON.stringify(t)).padEnd(10, "7").slice(0, 10);
  const matches = (sel = {}, labels = {}) => Object.keys(sel).length > 0 && Object.entries(sel).every(([k, v]) => labels[k] === v);
  const parseMem = (v) => { if (!v) return null; const m = String(v).match(/^(\d+(?:\.\d+)?)(Mi|Gi|M|G|Ki)?$/); if (!m) return null; return +m[1] * ({ Gi: 1024, G: 1000, Mi: 1, M: 1, Ki: 1 / 1024 }[m[2]] || 1 / (1024 * 1024)); };
  const parseCpu = (v) => (v ? (String(v).endsWith("m") ? +String(v).slice(0, -1) : +v * 1000) : null);

  function appFor(s, image) { const k = s.k8s; return k.apps[image] || k.apps[image.split(":")[0]] || {}; }
  function imageExists(s, image) {
    const [repo, tag = "latest"] = image.split(/:(?=[^:/]+$)/);
    const tags = s.k8s.registry[repo];
    return tags ? tags.includes(tag) : !!appFor(s, image).port; // unknown public images are fine if we model them
  }

  // ------------------------------------------------------------------ pod status from a template
  function evalTemplate(s, ns, t) {
    const c = (t.spec.containers || [])[0]; if (!c) return { reason: "Error", ready: false, phase: "Failed", events: [] };
    const a = appFor(s, c.image), ev = [];
    const r = { container: c, app: a, image: c.image, env: {}, events: ev, ready: false, phase: "Running", restarts: 0, logs: [], lastState: null, status: "Running" };
    ev.push(["Normal", "Scheduled", `Successfully assigned ${ns}/POD to ${s.k8s.nodeFor || "ip-10-0-11-42"}`]);
    if (!imageExists(s, c.image)) {
      ev.push(["Normal", "Pulling", `Pulling image "${c.image}"`], ["Warning", "Failed", `Failed to pull image "${c.image}": rpc error: code = NotFound desc = failed to pull and unpack image "${c.image}": not found`], ["Warning", "Failed", "Error: ErrImagePull"], ["Normal", "BackOff", `Back-off pulling image "${c.image}"`], ["Warning", "Failed", "Error: ImagePullBackOff"]);
      return Object.assign(r, { phase: "Pending", status: "ImagePullBackOff", waiting: "ImagePullBackOff" });
    }
    ev.push(["Normal", "Pulled", `Container image "${c.image}" already present on machine`]);
    // config references
    const cms = s.k8s.configmaps.filter((x) => x.metadata.namespace === ns), secs = s.k8s.secrets.filter((x) => x.metadata.namespace === ns);
    const find = (list, n) => list.find((x) => x.metadata.name === n);
    const decode = (sec, k) => { const v = (sec.data || {})[k]; try { return v ? atob(v) : (sec.stringData || {})[k]; } catch { return v; } };
    for (const e of c.env || []) {
      if (e.value !== undefined) { r.env[e.name] = String(e.value); continue; }
      const cmr = e.valueFrom && e.valueFrom.configMapKeyRef, sr = e.valueFrom && e.valueFrom.secretKeyRef;
      if (cmr) { const cm = find(cms, cmr.name); if (!cm) return cfgErr(r, `configmap "${cmr.name}" not found`); if (!(cmr.key in (cm.data || {}))) return cfgErr(r, `couldn't find key ${cmr.key} in ConfigMap ${ns}/${cmr.name}`); r.env[e.name] = cm.data[cmr.key]; }
      if (sr) { const sc = find(secs, sr.name); if (!sc) return cfgErr(r, `secret "${sr.name}" not found`); const v = decode(sc, sr.key); if (v === undefined) return cfgErr(r, `couldn't find key ${sr.key} in Secret ${ns}/${sr.name}`); r.env[e.name] = v; }
    }
    for (const ef of c.envFrom || []) {
      if (ef.configMapRef) { const cm = find(cms, ef.configMapRef.name); if (!cm) return cfgErr(r, `configmap "${ef.configMapRef.name}" not found`); Object.assign(r.env, cm.data || {}); }
      if (ef.secretRef) { const sc = find(secs, ef.secretRef.name); if (!sc) return cfgErr(r, `secret "${ef.secretRef.name}" not found`); Object.keys(Object.assign({}, sc.data, sc.stringData)).forEach((k) => (r.env[k] = decode(sc, k))); }
    }
    ev.push(["Normal", "Created", `Created container ${c.name}`], ["Normal", "Started", `Started container ${c.name}`]);
    const missing = (a.requiredEnv || []).filter((k) => !r.env[k]);
    const boot = a.boot || [`{"level":"info","msg":"starting ${c.name}","version":"${c.image.split(":").pop()}"}`];
    if (missing.length) {
      r.logs = [...boot, ...(a.missingLog ? a.missingLog(missing) : [`{"level":"fatal","msg":"config error: required environment variable ${missing[0]} is not set"}`])];
      ev.push(["Warning", "BackOff", `Back-off restarting failed container ${c.name} in pod POD`]);
      return Object.assign(r, { status: "CrashLoopBackOff", waiting: "CrashLoopBackOff", restarts: 4 + (s.tick % 3), lastState: { reason: "Error", exitCode: 1 } });
    }
    if (a.crash) {
      r.logs = [...boot, ...a.crash];
      ev.push(["Warning", "BackOff", `Back-off restarting failed container ${c.name} in pod POD`]);
      return Object.assign(r, { status: "CrashLoopBackOff", waiting: "CrashLoopBackOff", restarts: 5 + (s.tick % 3), lastState: { reason: "Error", exitCode: a.crashCode || 2 } });
    }
    const lim = parseMem(((c.resources || {}).limits || {}).memory);
    if (a.memMi && lim && lim < a.memMi) {
      r.logs = [...boot, ...(a.logs || []).slice(0, 2)];
      ev.push(["Warning", "BackOff", `Back-off restarting failed container ${c.name} in pod POD`]);
      return Object.assign(r, { status: "CrashLoopBackOff", waiting: "CrashLoopBackOff", restarts: 6 + (s.tick % 3), lastState: { reason: "OOMKilled", exitCode: 137 }, oom: true });
    }
    r.logs = [...boot, ...(a.logs || [`{"level":"info","msg":"listening","port":${a.port || 8080}}`])];
    const probeOk = (p) => {
      if (!p || !p.httpGet) return true;
      const port = typeof p.httpGet.port === "string" ? ((c.ports || []).find((x) => x.name === p.httpGet.port) || {}).containerPort : p.httpGet.port;
      if (port !== (a.port || 8080)) return `Get "http://10.0.11.87:${port}${p.httpGet.path}": dial tcp 10.0.11.87:${port}: connect: connection refused`;
      const route = (a.routes || {})[p.httpGet.path];
      const ok = p.httpGet.path === (a.health || "/healthz") || (route && route.status < 400);
      return ok ? true : `HTTP probe failed with statuscode: ${route ? route.status : 404}`;
    };
    const live = probeOk(c.livenessProbe);
    if (live !== true) {
      ev.push(["Warning", "Unhealthy", `Liveness probe failed: ${live}`], ["Normal", "Killing", `Container ${c.name} failed liveness probe, will be restarted`]);
      return Object.assign(r, { status: "CrashLoopBackOff", waiting: "CrashLoopBackOff", restarts: 3 + (s.tick % 3), lastState: { reason: "Error", exitCode: 137 } });
    }
    const rd = probeOk(c.readinessProbe);
    if (rd !== true) { ev.push(["Warning", "Unhealthy", `Readiness probe failed: ${rd}`]); return Object.assign(r, { status: "Running", ready: false }); }
    return Object.assign(r, { ready: true });
  }
  function cfgErr(r, msg) { r.events.push(["Warning", "Failed", `Error: ${msg}`]); return Object.assign(r, { phase: "Pending", status: "CreateContainerConfigError", waiting: "CreateContainerConfigError" }); }

  // ------------------------------------------------------------------ reconcile deployments into pods
  function desiredReplicas(s, d) {
    const h = s.k8s.hpas.find((x) => x.metadata.namespace === d.metadata.namespace && x.spec.scaleTargetRef.name === d.metadata.name);
    if (!h) return d.spec.replicas ?? 1;
    if ((d.spec.replicas ?? 1) === 0) return 0; // like the real HPA: scaling a target to 0 switches autoscaling off
    const a = appFor(s, d.spec.template.spec.containers[0].image), req = cpuRequest(d);
    if (!req) return Math.min(h.spec.maxReplicas, Math.max(h.spec.minReplicas || 1, d.spec.replicas ?? 1)); // no CPU request: utilisation is unknown, so it can't scale
    const target = (h.spec.metrics || [{ resource: { target: { averageUtilization: 80 } } }])[0].resource.target.averageUtilization;
    const want = Math.ceil((a.cpuLoad || 50) / ((req * target) / 100));
    return Math.min(h.spec.maxReplicas, Math.max(h.spec.minReplicas || 1, want));
  }
  const NODES = ["ip-10-0-11-42", "ip-10-0-12-187"], FQDN = ".eu-west-2.compute.internal";
  const nodeName = (n) => String(n || "").replace(FQDN, "");
  // a pod stays where it was scheduled unless its node was drained or it was evicted; new pods avoid cordoned nodes
  function placeNode(s, i, slot) {
    const want = NODES[i % 2], other = NODES.find((n) => n !== want), k = s.k8s, born = (k.seen || {})[slot];
    const off = k.drained.includes(want) || (k.moved || {})[slot] || (k.cordoned.includes(want) && born !== undefined && born >= (k.cordonTick || {})[want]);
    return off && !k.cordoned.includes(other) ? other : want;
  }
  function cpuRequest(d) { return parseCpu((((d.spec.template.spec.containers[0].resources || {}).requests) || {}).cpu); }
  function podAge(s, d, slot) {
    const seen = (s.k8s.seen = s.k8s.seen || {});
    if (!(slot in seen) || s.k8s.gen[slot] !== seen[slot + "#g"]) { seen[slot] = s.tick; seen[slot + "#g"] = s.k8s.gen[slot]; }
    const t = s.tick - seen[slot];
    return seen[slot] === 0 && !s.k8s.gen[slot] ? d._age || "3h" : t < 10 ? `${4 + t * 6}s` : `${Math.floor(t / 2)}m`;
  }
  function podsFor(s, d) {
    const k = key(d), T = d.spec.template, ns = d.metadata.namespace, ev = evalTemplate(s, ns, T);
    if (ev.ready) s.k8s.lastGood[k] = OD.clone(T);
    const G = s.k8s.lastGood[k], n = desiredReplicas(s, d), out = [];
    const mk = (tmpl, e, i) => {
      const h = tHash(tmpl), slot = `${k}|${h}|${i}`, gen = s.k8s.gen[slot] || 0, age = podAge(s, d, slot), node = placeNode(s, i, slot);
      return { name: `${d.metadata.name}-${h}-${OD.suffix(slot + gen)}`, ns, labels: { ...(tmpl.metadata.labels || {}), "pod-template-hash": h }, tmpl, ev: e, slot, owner: d, hash: h, ip: `10.0.${node === NODES[0] ? 11 : 12}.${40 + ((parseInt(h.slice(0, 2), 16) + i * 7) % 200)}`, node, age };
    };
    if (ev.ready) for (let i = 0; i < n; i++) out.push(mk(T, ev, i));
    else if (G && tHash(G) !== tHash(T)) { const gev = evalTemplate(s, ns, G); for (let i = 0; i < n; i++) out.push(mk(G, gev, i)); out.push(mk(T, ev, n)); }
    else for (let i = 0; i < n; i++) out.push(mk(T, ev, i));
    return out;
  }
  function reconcile(s) { s.k8s._pods = s.k8s.deployments.flatMap((d) => podsFor(s, d)).concat(s.k8s.pods.map((p) => ({ ...p, ev: { ready: true, status: "Running", restarts: 0, logs: p.logs || [], events: [] }, labels: p.labels || {}, age: "41d", ip: p.ip || "10.0.11.5", node: "ip-10-0-11-42" }))); return s.k8s._pods; }
  const pods = (s, ns) => reconcile(s).filter((p) => !ns || p.ns === ns);
  OD.k8sPods = pods; OD.k8sEval = evalTemplate;
  const endpoints = (s, svc) => pods(s, svc.metadata.namespace).filter((p) => p.ev.ready && matches(svc.spec.selector, p.labels));
  OD.k8sEndpoints = endpoints;

  // ------------------------------------------------------------------ helpers for commands
  const KINDS = {
    pod: "pods", pods: "pods", po: "pods", deployment: "deployments", deployments: "deployments", deploy: "deployments",
    service: "services", services: "services", svc: "services", endpoints: "endpoints", ep: "endpoints",
    configmap: "configmaps", configmaps: "configmaps", cm: "configmaps", secret: "secrets", secrets: "secrets",
    ingress: "ingresses", ingresses: "ingresses", ing: "ingresses", hpa: "hpas", horizontalpodautoscaler: "hpas", horizontalpodautoscalers: "hpas",
    node: "nodes", nodes: "nodes", no: "nodes", namespace: "namespaces", namespaces: "namespaces", ns: "namespaces",
    replicaset: "replicasets", replicasets: "replicasets", rs: "replicasets", event: "events", events: "events", ev: "events",
    ingressclass: "ingressclasses", ingressclasses: "ingressclasses", all: "all",
    pdb: "pdbs", pdbs: "pdbs", poddisruptionbudget: "pdbs", poddisruptionbudgets: "pdbs",
  };
  const KIND_NAME = { deployments: "deployment.apps", services: "service", configmaps: "configmap", secrets: "secret", ingresses: "ingress.networking.k8s.io", hpas: "horizontalpodautoscaler.autoscaling", pdbs: "poddisruptionbudget.policy", pods: "pod" };
  const API = { Deployment: ["apps/v1", "deployments"], Service: ["v1", "services"], ConfigMap: ["v1", "configmaps"], Secret: ["v1", "secrets"], Ingress: ["networking.k8s.io/v1", "ingresses"], HorizontalPodAutoscaler: ["autoscaling/v2", "hpas"], PodDisruptionBudget: ["policy/v1", "pdbs"] };
  const nsOf = (s, flags) => (flags.A || flags["all-namespaces"] ? null : flags.n || flags.namespace || s.k8s.ns);
  function splitRef(ref, next) { if (ref && ref.includes("/")) { const [k, n] = ref.split("/"); return [KINDS[k], n]; } return [KINDS[ref], next]; }
  const byName = (s, kind, ns, name) => (s.k8s[kind] || []).find((o) => o.metadata.name === name && o.metadata.namespace === ns);
  const notFound = (kind, name) => ({ out: `Error from server (NotFound): ${kind === "pods" ? "pods" : (KIND_NAME[kind] || kind).split(".")[0] + "s"} "${name}" not found`, code: 1 });
  const age = (o) => o._age || (o.metadata && o.metadata._age) || "3h";
  const svcPorts = (svc) => (svc.spec.ports || []).map((p) => `${p.port}${svc.spec.type === "NodePort" ? ":" + (p.nodePort || 30080) : ""}/${p.protocol || "TCP"}`).join(",");

  function podRow(p, wide) {
    const ready = p.ev.ready ? "1/1" : "0/1";
    const row = [p.name, ready, p.ev.status, p.ev.restarts ? `${p.ev.restarts} (${10 + (p.ev.restarts * 7) % 50}s ago)` : "0", p.age];
    return wide ? [...row, p.ev.phase === "Pending" && p.ev.status === "ImagePullBackOff" ? p.ip : p.ip, p.node] : row;
  }

  // ------------------------------------------------------------------ kubectl
  C.kubectl = C.k = (ctx) => {
    const s = ctx.state; if (!s.k8s) return { out: "kubectl: command not found", code: 127 };
    const [verb, ...rest] = ctx.args;
    const h = K[verb];
    if (!h) return { out: verb ? `error: unknown command "${verb}" for "kubectl"\n\nDid you mean this?\n\tget\n\tdescribe\n\tlogs\n\tapply` : "kubectl controls the Kubernetes cluster manager.\n\nBasic Commands: get, describe, logs, apply, edit, delete, create, scale, set, rollout, exec, top, autoscale, config", code: verb ? 1 : 0 };
    const r = h(s, rest, ctx);
    return r;
  };
  const K = {};

  K.get = (s, args) => {
    const { flags, pos } = parseArgs(args, ["n", "namespace", "o", "output", "l", "selector"]);
    const [kind, name] = splitRef(pos[0], pos[1]); const ns = nsOf(s, flags), out = flags.o || flags.output, sel = flags.l || flags.selector;
    if (!kind) return { out: `error: the server doesn't have a resource type "${pos[0] || ""}"`, code: 1 };
    const inNs = (o) => !ns || o.metadata.namespace === ns;
    const lbl = (labels) => !sel || sel.split(",").every((kv) => { const [k, v] = kv.split("="); return (labels || {})[k] === v; });
    const nsCol = (o) => (ns ? [] : [o.metadata ? o.metadata.namespace : o.ns]);
    const head = (h) => (ns ? h : ["NAMESPACE", ...h]);
    if (kind === "all") return [K.get(s, ["pods", ...(ns ? ["-n", ns] : ["-A"])]), K.get(s, ["svc", ...(ns ? ["-n", ns] : ["-A"])]), K.get(s, ["deploy", ...(ns ? ["-n", ns] : ["-A"])])].map((x) => x.out || x).join("\n\n");
    if (kind === "namespaces") return table([["NAME", "STATUS", "AGE"], ...[...new Set(["default", "kube-system", ...s.k8s.deployments.map((d) => d.metadata.namespace)])].map((n) => [n, "Active", "41d"])], 3);
    if (kind === "nodes") return table([["NAME", "STATUS", "ROLES", "AGE", "VERSION"], ...NODES.map((n) => [n + FQDN, s.k8s.cordoned.includes(n) ? "Ready,SchedulingDisabled" : "Ready", "<none>", "41d", "v1.34.1-eks-113cf36"])], 3);
    if (kind === "ingressclasses") return table([["NAME", "CONTROLLER", "PARAMETERS", "AGE"], ...s.k8s.ingressClasses.map((c) => [c, "nginx.org/ingress-controller", "<none>", "41d"])], 3);
    if (kind === "pods") {
      let list = pods(s, ns).filter((p) => lbl(p.labels)); if (name) list = list.filter((p) => p.name === name);
      if (name && !list.length) return notFound("pods", name);
      if (out === "yaml" || out === "json") return dump(podManifest(s, list[0]), out);
      if (!list.length) return `No resources found in ${ns || "any"} namespace.`;
      return table([head(["NAME", "READY", "STATUS", "RESTARTS", "AGE", ...(out === "wide" ? ["IP", "NODE"] : [])]), ...list.map((p) => [...nsCol(p), ...podRow(p, out === "wide")])], 3);
    }
    if (kind === "replicasets") {
      const rows = []; s.k8s.deployments.filter(inNs).forEach((d) => { const ps = pods(s, d.metadata.namespace).filter((p) => p.owner === d); const hashes = [...new Set(ps.map((p) => p.hash))]; hashes.forEach((h) => { const mine = ps.filter((p) => p.hash === h); rows.push([...nsCol(d), `${d.metadata.name}-${h}`, mine.length, mine.length, mine.filter((p) => p.ev.ready).length, "3h"]); }); });
      return table([head(["NAME", "DESIRED", "CURRENT", "READY", "AGE"]), ...rows], 3);
    }
    if (kind === "endpoints") {
      const list = s.k8s.services.filter(inNs).filter((v) => !name || v.metadata.name === name);
      if (name && !list.length) return notFound("endpoints", name);
      return table([head(["NAME", "ENDPOINTS", "AGE"]), ...list.map((v) => { const eps = endpoints(s, v); const tp = targetPortNum(s, v, (v.spec.ports || [])[0]); return [...nsCol(v), v.metadata.name, eps.length ? eps.slice(0, 3).map((p) => `${p.ip}:${tp}`).join(",") + (eps.length > 3 ? ` + ${eps.length - 3} more...` : "") : "<none>", age(v)]; })], 3);
    }
    if (kind === "events") {
      const rows = []; pods(s, ns).forEach((p) => p.ev.events.filter((e) => e[0] === "Warning").forEach((e) => rows.push([...nsCol(p), "12s", e[0], e[1], `pod/${p.name}`, e[2].replace("POD", p.name)])));
      return rows.length ? table([head(["LAST SEEN", "TYPE", "REASON", "OBJECT", "MESSAGE"]), ...rows], 3) : `No resources found in ${ns || "any"} namespace.`;
    }
    let list = (s.k8s[kind] || []).filter(inNs).filter((o) => lbl(o.metadata.labels)); if (name) list = list.filter((o) => o.metadata.name === name);
    if (name && !list.length) return notFound(kind, name);
    if (out === "yaml" || out === "json") return dump(name ? list[0] : { apiVersion: "v1", kind: "List", items: list }, out);
    if (!list.length) return `No resources found in ${ns || "any"} namespace.`;
    if (kind === "deployments") return table([head(["NAME", "READY", "UP-TO-DATE", "AVAILABLE", "AGE"]), ...list.map((d) => { const ps = pods(s, d.metadata.namespace).filter((p) => p.owner === d), want = desiredReplicas(s, d), ready = ps.filter((p) => p.ev.ready).length, upd = ps.filter((p) => p.hash === tHash(d.spec.template)).length; return [...nsCol(d), d.metadata.name, `${Math.min(ready, want)}/${want}`, upd, Math.min(ready, want), age(d)]; })], 3);
    if (kind === "services") return table([head(["NAME", "TYPE", "CLUSTER-IP", "EXTERNAL-IP", "PORT(S)", "AGE"]), ...list.map((v) => [...nsCol(v), v.metadata.name, v.spec.type || "ClusterIP", v.spec.clusterIP || "172.20." + (parseInt(OD.hash(v.metadata.name).slice(0, 2), 16)) + ".19", v.spec.type === "LoadBalancer" ? "a1b2c3d4e5.elb.eu-west-2.amazonaws.com" : "<none>", svcPorts(v), age(v)])], 3);
    if (kind === "configmaps") return table([head(["NAME", "DATA", "AGE"]), ...list.map((c) => [...nsCol(c), c.metadata.name, Object.keys(c.data || {}).length, age(c)])], 3);
    if (kind === "secrets") return table([head(["NAME", "TYPE", "DATA", "AGE"]), ...list.map((c) => [...nsCol(c), c.metadata.name, c.type || "Opaque", Object.keys(Object.assign({}, c.data, c.stringData)).length, age(c)])], 3);
    if (kind === "ingresses") return table([head(["NAME", "CLASS", "HOSTS", "ADDRESS", "PORTS", "AGE"]), ...list.map((i) => [...nsCol(i), i.metadata.name, i.spec.ingressClassName || "<none>", (i.spec.rules || []).map((r) => r.host).join(","), s.k8s.ingressClasses.includes(i.spec.ingressClassName) ? "a1b2c3d4e5.elb.eu-west-2.amazonaws.com" : "", i.spec.tls ? "80, 443" : "80", age(i)])], 3);
    if (kind === "pdbs") return table([head(["NAME", "MIN AVAILABLE", "MAX UNAVAILABLE", "ALLOWED DISRUPTIONS", "AGE"]), ...list.map((b) => [...nsCol(b), b.metadata.name, b.spec.minAvailable ?? "N/A", b.spec.maxUnavailable ?? "N/A", allowedDisruptions(s, b), age(b)])], 3);
    if (kind === "hpas") return table([head(["NAME", "REFERENCE", "TARGETS", "MINPODS", "MAXPODS", "REPLICAS", "AGE"]), ...list.map((h) => { const d = byName(s, "deployments", h.metadata.namespace, h.spec.scaleTargetRef.name); const n = d ? desiredReplicas(s, d) : 0; const a = d ? appFor(s, d.spec.template.spec.containers[0].image) : {}; const req = d ? cpuRequest(d) : null; const util = req && n ? `${Math.round(((a.cpuLoad || 50) / n / req) * 100)}%` : "<unknown>"; return [...nsCol(h), h.metadata.name, `Deployment/${h.spec.scaleTargetRef.name}`, `cpu: ${util}/${h.spec.metrics[0].resource.target.averageUtilization}%`, h.spec.minReplicas, h.spec.maxReplicas, n, h._age || "12s"]; })], 3);
    return { out: `error: listing ${kind} isn't supported in this simulator`, code: 1 };
  };
  function dump(o, fmt) { const clean = OD.clone(o); strip(clean); return fmt === "json" ? JSON.stringify(clean, null, 2) : yaml().dump(clean, { lineWidth: 120, noRefs: true }).trimEnd(); }
  function strip(o) { if (o && typeof o === "object") for (const k of Object.keys(o)) { if (k.startsWith("_")) delete o[k]; else strip(o[k]); } }
  function podManifest(s, p) {
    return { apiVersion: "v1", kind: "Pod", metadata: { name: p.name, namespace: p.ns, labels: p.labels }, spec: OD.clone(p.tmpl ? p.tmpl.spec : p.spec || {}),
      status: { phase: p.ev.phase || "Running", podIP: p.ip, containerStatuses: [{ name: (p.ev.container || {}).name || p.name, ready: !!p.ev.ready, restartCount: p.ev.restarts, image: p.ev.image, state: p.ev.waiting ? { waiting: { reason: p.ev.waiting } } : { running: { startedAt: "2026-11-26T09:58:12Z" } }, ...(p.ev.lastState ? { lastState: { terminated: { reason: p.ev.lastState.reason, exitCode: p.ev.lastState.exitCode } } } : {}) }] } };
  }
  function targetPortNum(s, svc, port) {
    if (!port) return "?"; const tp = port.targetPort ?? port.port;
    if (typeof tp === "number" || /^\d+$/.test(tp)) return +tp;
    const p = pods(s, svc.metadata.namespace).find((x) => matches(svc.spec.selector, x.labels));
    const cp = p && p.tmpl && ((p.tmpl.spec.containers[0].ports || []).find((x) => x.name === tp) || {}).containerPort;
    return cp || tp;
  }

  K.describe = (s, args) => {
    const { flags, pos } = parseArgs(args, ["n", "namespace"]);
    const [kind, name] = splitRef(pos[0], pos[1]); const ns = nsOf(s, flags) || s.k8s.ns;
    if (kind === "pods") {
      const list = pods(s, ns).filter((p) => !name || p.name === name || p.name.startsWith(name)); if (!list.length) return notFound("pods", name);
      return list.map((p) => describePod(s, p)).join("\n\n");
    }
    if (kind === "deployments") {
      const d = byName(s, kind, ns, name); if (!d) return notFound(kind, name);
      const ps = pods(s, ns).filter((p) => p.owner === d), want = desiredReplicas(s, d), ready = ps.filter((p) => p.ev.ready).length, c = d.spec.template.spec.containers[0], newH = tHash(d.spec.template);
      const old = [...new Set(ps.filter((p) => p.hash !== newH).map((p) => p.hash))];
      return [`Name:                   ${d.metadata.name}`, `Namespace:              ${ns}`, `Selector:               ${Object.entries(d.spec.selector.matchLabels || {}).map(([k, v]) => `${k}=${v}`).join(",")}`, `Replicas:               ${want} desired | ${ps.filter((p) => p.hash === newH).length} updated | ${ps.length} total | ${Math.min(ready, want)} available | ${Math.max(0, want - ready)} unavailable`, `StrategyType:           ${(d.spec.strategy || {}).type || "RollingUpdate"}`, `MinReadySeconds:        ${d.spec.minReadySeconds || 0}`, ...(((d.spec.strategy || {}).type || "RollingUpdate") === "RollingUpdate" ? [`RollingUpdateStrategy:  ${rollingOf(d).maxUnavailable} max unavailable, ${rollingOf(d).maxSurge} max surge`] : []), `Pod Template:`, `  Labels:  ${Object.entries(d.spec.template.metadata.labels || {}).map(([k, v]) => `${k}=${v}`).join(",")}`, `  Containers:`, `   ${c.name}:`, `    Image:      ${c.image}`, `    Port:       ${(c.ports || [{}])[0].containerPort || "<none>"}/TCP`, ...containerDetail(c), `Conditions:`, `  Type           Status  Reason`, `  ----           ------  ------`, `  Available      ${ready >= want ? "True " : "False"}   ${ready >= want ? "MinimumReplicasAvailable" : "MinimumReplicasUnavailable"}`, `  Progressing    True    ${old.length ? "ReplicaSetUpdated" : "NewReplicaSetAvailable"}`, `OldReplicaSets:  ${old.length ? old.map((h) => `${d.metadata.name}-${h}`).join(", ") : "<none>"}`, `NewReplicaSet:   ${d.metadata.name}-${newH} (${ps.filter((p) => p.hash === newH).length}/${ps.filter((p) => p.hash === newH).length} replicas created)`, `Events:          <none>`].join("\n");
    }
    if (kind === "services") {
      const v = byName(s, kind, ns, name); if (!v) return notFound(kind, name);
      const eps = endpoints(s, v), p = (v.spec.ports || [])[0] || {}, tp = targetPortNum(s, v, p);
      return [`Name:              ${v.metadata.name}`, `Namespace:         ${ns}`, `Selector:          ${Object.entries(v.spec.selector || {}).map(([k, x]) => `${k}=${x}`).join(",") || "<none>"}`, `Type:              ${v.spec.type || "ClusterIP"}`, `IP:                172.20.${parseInt(OD.hash(v.metadata.name).slice(0, 2), 16)}.19`, `Port:              ${p.name || "<unset>"}  ${p.port}/TCP`, `TargetPort:        ${p.targetPort ?? p.port}/TCP`, `Endpoints:         ${eps.length ? eps.map((x) => `${x.ip}:${tp}`).join(",") : "<none>"}`, `Session Affinity:  None`, `Events:            <none>`].join("\n");
    }
    if (kind === "ingresses") {
      const i = byName(s, kind, ns, name); if (!i) return notFound(kind, name);
      const known = s.k8s.ingressClasses.includes(i.spec.ingressClassName);
      return [`Name:             ${i.metadata.name}`, `Namespace:        ${ns}`, `Address:          ${known ? "a1b2c3d4e5.elb.eu-west-2.amazonaws.com" : ""}`, `Ingress Class:    ${i.spec.ingressClassName || "<none>"}`, `Rules:`, `  Host                 Path  Backends`, `  ----                 ----  --------`, ...(i.spec.rules || []).flatMap((r) => (r.http.paths || []).map((p) => `  ${(r.host || "*").padEnd(20)} ${p.path.padEnd(5)} ${p.backend.service.name}:${p.backend.service.port.number || p.backend.service.port.name} (${(() => { const v = byName(s, "services", ns, p.backend.service.name); return v ? endpoints(s, v).map((x) => x.ip + ":" + targetPortNum(s, v, (v.spec.ports || [])[0])).join(",") || "<none>" : "<error: services \"" + p.backend.service.name + "\" not found>"; })()})`)), `Events:           ${known ? "\n  Type    Reason          Age   From                      Message\n  ----    ------          ----  ----                      -------\n  Normal  AddedOrUpdated  12s   nginx-ingress-controller  Configuration for " + ns + "/" + i.metadata.name + " was added or updated" : "<none>"}`].join("\n");
    }
    if (kind === "configmaps" || kind === "secrets") {
      const o = byName(s, kind, ns, name); if (!o) return notFound(kind, name);
      const data = Object.assign({}, o.data, o.stringData);
      return [`Name:         ${o.metadata.name}`, `Namespace:    ${ns}`, kind === "secrets" ? `Type:         ${o.type || "Opaque"}` : "", "", "Data", "====", ...Object.entries(data).flatMap(([k, v]) => (kind === "secrets" ? [`${k}:  ${(() => { try { return atob(v).length; } catch { return String(v).length; } })()} bytes`] : [`${k}:`, "----", String(v), ""]))].filter((x) => x !== null).join("\n");
    }
    if (kind === "hpas") {
      const h = byName(s, kind, ns, name); if (!h) return notFound(kind, name);
      const d = byName(s, "deployments", ns, h.spec.scaleTargetRef.name), c = d && d.spec.template.spec.containers[0];
      const known = d && cpuRequest(d), p = d && pods(s, ns).find((x) => x.owner === d);
      return [K.get(s, ["hpa", name, "-n", ns]), "", "Conditions:", "  Type            Status  Reason", "  ----            ------  ------",
        `  AbleToScale     True    ${known ? "ReadyForNewScale" : "SucceededGetScale"}`,
        known ? "  ScalingActive   True    ValidMetricFound" : "  ScalingActive   False   FailedGetResourceMetric",
        "Events:", known ? "  <none>" : `  Warning  FailedGetResourceMetric  12s (x41 over 20m)  horizontal-pod-autoscaler  failed to get cpu utilization: missing request for cpu in container ${c ? c.name : "?"} of Pod ${p ? p.name : "?"}`].join("\n");
    }
    if (kind === "nodes") { const n = nodeName(name) || NODES[0]; if (!NODES.includes(n)) return notFound("nodes", name); const here = pods(s, null).filter((p) => p.node === n); return [`Name:               ${n}${FQDN}`, "Roles:              <none>", `Unschedulable:      ${s.k8s.cordoned.includes(n)}`, "Conditions:", "  Ready   True   KubeletReady   kubelet is posting ready status", "Allocatable:", "  cpu:     1930m", "  memory:  7302072Ki", "  pods:    35", `Non-terminated Pods:          (${here.length + 2} in total)`, "  Namespace     Name", "  ---------     ----", `  kube-system   aws-node-${OD.suffix(n)}`, `  kube-system   kube-proxy-${OD.suffix(n + "p")}`, ...here.map((p) => `  ${p.ns.padEnd(13)} ${p.name}`)].join("\n"); }
    return { out: `error: the server doesn't have a resource type "${pos[0] || ""}"`, code: 1 };
  };
  function containerDetail(c) {
    const r = c.resources || {}, env = [...(c.env || []).map((e) => `      ${e.name}:  ${e.value !== undefined ? e.value : e.valueFrom.configMapKeyRef ? `<set to the key '${e.valueFrom.configMapKeyRef.key}' of config map '${e.valueFrom.configMapKeyRef.name}'>` : `<set to the key '${e.valueFrom.secretKeyRef.key}' in secret '${e.valueFrom.secretKeyRef.name}'>`}`), ...(c.envFrom || []).map((e) => `      (all keys from ${e.configMapRef ? "configmap " + e.configMapRef.name : "secret " + e.secretRef.name})`)];
    const probe = (p) => (p && p.httpGet ? `http-get http://:${p.httpGet.port}${p.httpGet.path} delay=${p.initialDelaySeconds || 0}s timeout=1s period=${p.periodSeconds || 10}s #success=1 #failure=3` : "<none>");
    return [r.limits ? `    Limits:\n${Object.entries(r.limits).map(([k, v]) => `      ${k}:  ${v}`).join("\n")}` : "", r.requests ? `    Requests:\n${Object.entries(r.requests).map(([k, v]) => `      ${k}:  ${v}`).join("\n")}` : "", `    Liveness:   ${probe(c.livenessProbe)}`, `    Readiness:  ${probe(c.readinessProbe)}`, `    Environment:${env.length ? "\n" + env.join("\n") : "  <none>"}`].filter(Boolean);
  }
  function describePod(s, p) {
    const e = p.ev, c = p.tmpl ? p.tmpl.spec.containers[0] : { name: p.name, image: p.image || "toolbox" };
    const state = e.waiting ? `Waiting\n      Reason:       ${e.waiting}` : `Running\n      Started:      Thu, 26 Nov 2026 09:58:12 +0000`;
    const last = e.lastState ? `\n    Last State:     Terminated\n      Reason:       ${e.lastState.reason}\n      Exit Code:    ${e.lastState.exitCode}` : "";
    return [`Name:             ${p.name}`, `Namespace:        ${p.ns}`, `Node:             ${p.node}.eu-west-2.compute.internal/10.0.11.42`, `Labels:           ${Object.entries(p.labels).map(([k, v]) => `${k}=${v}`).join("\n                  ")}`, `Status:           ${e.phase || "Running"}`, `IP:               ${p.ip}`, `Containers:`, `  ${c.name}:`, `    Image:          ${c.image}`, `    Port:           ${(c.ports || [{}])[0].containerPort || "<none>"}/TCP`, `    State:          ${state}${last}`, `    Ready:          ${e.ready ? "True" : "False"}`, `    Restart Count:  ${e.restarts}`, ...(p.tmpl ? containerDetail(c) : []), `Conditions:`, `  Type              Status`, `  Ready             ${e.ready ? "True" : "False"}`, `  ContainersReady   ${e.ready ? "True" : "False"}`, `  PodScheduled      True`, `Events:`, `  Type     Reason     Age   From               Message`, `  ----     ------     ----  ----               -------`, ...e.events.map((x) => `  ${x[0].padEnd(8)} ${x[1].padEnd(10)} 30s   ${x[1] === "Scheduled" ? "default-scheduler" : "kubelet          "}  ${x[2].replace("POD", p.name)}`)].join("\n");
  }

  K.logs = (s, args) => {
    const { flags, pos } = parseArgs(args, ["n", "namespace", "c", "tail", "container", "since"]); const ns = nsOf(s, flags) || s.k8s.ns;
    let ref = pos[0]; if (!ref) return { out: "error: expected 'logs [-f] [-p] (POD | TYPE/NAME) [-c CONTAINER]'.", code: 1 };
    let p;
    if (ref.includes("/")) { const [k, n] = splitRef(ref); const d = byName(s, k, ns, n); if (!d) return notFound(k, n); p = pods(s, ns).filter((x) => x.owner === d).sort((a, b) => (b.hash === tHash(d.spec.template)) - (a.hash === tHash(d.spec.template)))[0]; }
    else p = pods(s, ns).find((x) => x.name === ref);
    if (!p) return notFound("pods", ref);
    if (p.ev.waiting === "ImagePullBackOff" || p.ev.waiting === "CreateContainerConfigError") return { out: `Error from server (BadRequest): container "${(p.ev.container || {}).name}" in pod "${p.name}" is waiting to start: ${p.ev.waiting === "ImagePullBackOff" ? "trying and failing to pull image" : "CreateContainerConfigError"}`, code: 1 };
    if (flags.p || flags.previous) { if (!p.ev.lastState) return { out: `Error from server (BadRequest): previous terminated container "${(p.ev.container || {}).name}" in pod "${p.name}" not found`, code: 1 }; return p.ev.logs.join("\n"); }
    let lines = p.ev.logs; if (flags.tail) lines = lines.slice(-+flags.tail);
    return lines.join("\n");
  };

  // ---- writing: apply / edit / create / delete / set / scale / rollout / autoscale
  function upsert(s, obj, verbPast = "configured") {
    if (!obj || !obj.kind) return { out: "error: error validating data: [apiVersion not set, kind not set]", code: 1 };
    const map = API[obj.kind]; if (!map) return { out: `error: resource mapping not found for kind "${obj.kind}": ensure CRDs are installed first`, code: 1 };
    obj.metadata = obj.metadata || {}; if (!obj.metadata.name) return { out: "error: resource name may not be empty", code: 1 };
    normalise(obj); obj.metadata.namespace = obj.metadata.namespace === "default" && s.k8s.ns !== "default" ? s.k8s.ns : obj.metadata.namespace;
    const list = s.k8s[map[1]], i = list.findIndex((o) => o.metadata.name === obj.metadata.name && o.metadata.namespace === obj.metadata.namespace);
    const label = `${KIND_NAME[map[1]]}/${obj.metadata.name}`;
    if (obj.kind === "Deployment") {
      const sel = (obj.spec.selector || {}).matchLabels || {}, tl = ((obj.spec.template || {}).metadata || {}).labels || {};
      if (!matches(sel, tl)) return { out: `The Deployment "${obj.metadata.name}" is invalid: spec.template.metadata.labels: Invalid value: map[string]string{${Object.entries(tl).map(([k, v]) => `"${k}":"${v}"`).join(", ")}}: \`selector\` does not match template \`labels\``, code: 1 };
      if (i >= 0 && JSON.stringify(list[i].spec.selector) !== JSON.stringify(obj.spec.selector)) return { out: `The Deployment "${obj.metadata.name}" is invalid: spec.selector: Invalid value: ... field is immutable`, code: 1 };
      const ru = rollingOf(obj), n = obj.spec.replicas ?? 1;
      if (((obj.spec.strategy || {}).type || "RollingUpdate") === "RollingUpdate" && scaledPods(ru.maxUnavailable, n, false) === 0 && scaledPods(ru.maxSurge, n, true) === 0) return { out: `The Deployment "${obj.metadata.name}" is invalid: spec.strategy.rollingUpdate.maxUnavailable: Invalid value: intstr.IntOrString{…}: may not be 0 when \`maxSurge\` is 0`, code: 1 };
      if (i >= 0 && tHash(list[i].spec.template) !== tHash(obj.spec.template)) recordRevision(s, list[i]);
    }
    if (obj.kind === "Secret" && obj.stringData) { obj.data = { ...(obj.data || {}), ...Object.fromEntries(Object.entries(obj.stringData).map(([k, v]) => [k, btoa(String(v))])) }; delete obj.stringData; }
    if (i >= 0) { const same = JSON.stringify(list[i]) === JSON.stringify(obj); obj.metadata.creationTimestamp = list[i].metadata.creationTimestamp; list[i] = obj; return `${label} ${same ? "unchanged" : verbPast}`; }
    list.push(obj); return `${label} created`;
  }
  // rolling-update maths, as Kubernetes does it: maxUnavailable rounds down, maxSurge rounds up
  function rollingOf(d) { const r = ((d.spec.strategy || {}).rollingUpdate) || {}; return { maxUnavailable: r.maxUnavailable ?? "25%", maxSurge: r.maxSurge ?? "25%" }; }
  function scaledPods(v, n, up) { const m = String(v).match(/^(\d+)%$/); if (m) return up ? Math.ceil((+m[1] * n) / 100) : Math.floor((+m[1] * n) / 100); return +v || 0; }
  OD.k8sRolling = (d) => { const r = rollingOf(d), n = d.spec.replicas ?? 1; return { maxUnavailable: scaledPods(r.maxUnavailable, n, false), maxSurge: scaledPods(r.maxSurge, n, true), replicas: n }; };
  // PodDisruptionBudgets
  function pdbPods(s, b) { return pods(s, b.metadata.namespace).filter((p) => p.owner && matches(b.spec.selector && b.spec.selector.matchLabels, p.labels)); }
  function allowedDisruptions(s, b) {
    const ps = pdbPods(s, b), healthy = ps.filter((p) => p.ev.ready).length, want = ps.length ? desiredReplicas(s, ps[0].owner) : 0;
    if (b.spec.minAvailable !== undefined) return Math.max(0, healthy - scaledPods(b.spec.minAvailable, want, true));
    if (b.spec.maxUnavailable !== undefined) return Math.max(0, scaledPods(b.spec.maxUnavailable, want, false) - (want - healthy));
    return 0;
  }
  OD.k8sAllowedDisruptions = allowedDisruptions;
  function recordRevision(s, d) { const k = key(d); (s.k8s.history[k] = s.k8s.history[k] || []).push(OD.clone(d.spec.template)); }

  K.apply = (s, args, ctx) => {
    const { flags } = parseArgs(args, ["f", "filename", "n"]); const f = flags.f || flags.filename;
    if (!f) return { out: "error: must specify one of -f and -k", code: 1 };
    const paths = s.fs.isDir(s.fs.norm(s.cwd, f)) ? s.fs.list(s.fs.norm(s.cwd, f)).filter((n) => /\.ya?ml$/.test(n)).map((n) => s.fs.norm(s.cwd, f) + "/" + n) : [s.fs.norm(s.cwd, f)];
    const out = [];
    for (const p of paths) {
      const file = s.fs.get(p); if (!file) return { out: `error: the path "${f}" does not exist`, code: 1 };
      let docs; try { docs = yaml().loadAll(file.content).filter(Boolean); } catch (e) { return { out: `error: error parsing ${f}: error converting YAML to JSON: yaml: ${String(e.message).split("\n")[0]}`, code: 1 }; }
      for (const d of docs) { const r = upsert(s, d); if (typeof r !== "string") return r; out.push(r); }
    }
    return out.join("\n");
  };
  K.edit = (s, args) => {
    const { flags, pos } = parseArgs(args, ["n", "namespace"]); const [kind, name] = splitRef(pos[0], pos[1]); const ns = nsOf(s, flags) || s.k8s.ns;
    if (!kind || !API[Object.keys(API).find((k) => API[k][1] === kind)]) return { out: `error: editing ${pos[0] || "that"} isn't supported here. Try deploy, svc, cm, secret, ing, hpa`, code: 1 };
    const o = byName(s, kind, ns, name); if (!o) return notFound(kind, name);
    return { editor: { title: `kubectl edit ${kind.replace(/s$/, "")}/${name} (-n ${ns})`, content: "# Edit the object, then save. Saving applies it to the cluster.\n" + dump(o, "yaml") + "\n",
      save: (text) => { let obj; try { obj = yaml().load(text); } catch (e) { return `error: ${String(e.message).split("\n")[0]}`; } if (!obj || obj.metadata.name !== name) return "error: you can't change the object's name while editing"; obj.metadata.namespace = ns; const r = upsert(s, obj, "edited"); return typeof r === "string" ? r : r.out; } } };
  };
  K.create = (s, args) => {
    const { flags, pos } = parseArgs(args, ["n", "namespace", "image", "from-file"]); const ns = nsOf(s, flags) || s.k8s.ns;
    let [what, a, b] = pos; const lit = args.filter((x) => x.startsWith("--from-literal=")).map((x) => x.slice(15));
    const fromLit = Object.fromEntries(lit.map((kv) => { const [k, ...v] = kv.split("="); return [k, v.join("=")]; }));
    if (what === "configmap" || what === "cm") return upsertNew(s, { apiVersion: "v1", kind: "ConfigMap", metadata: { name: a, namespace: ns }, data: fromLit }, "configmap");
    if (what === "secret") { const name = a === "generic" ? b : a; return upsertNew(s, { apiVersion: "v1", kind: "Secret", metadata: { name, namespace: ns }, type: "Opaque", data: Object.fromEntries(Object.entries(fromLit).map(([k, v]) => [k, btoa(v)])) }, "secret"); }
    if (what === "namespace" || what === "ns") return `namespace/${a} created`;
    if (what === "-f" || flags.f) return K.apply(s, args);
    return { out: `error: creating "${what}" isn't supported in this simulator. Use kubectl apply -f`, code: 1 };
  };
  function upsertNew(s, obj, kindLabel) { const kind = API[obj.kind][1]; if (byName(s, kind, obj.metadata.namespace, obj.metadata.name)) return { out: `error: failed to create ${kindLabel}: ${kindLabel}s "${obj.metadata.name}" already exists`, code: 1 }; normalise(obj); s.k8s[kind].push(obj); return `${kindLabel}/${obj.metadata.name} created`; }
  K.delete = (s, args) => {
    const { flags, pos } = parseArgs(args, ["n", "namespace", "f"]); const ns = nsOf(s, flags) || s.k8s.ns;
    const [kind, name] = splitRef(pos[0], pos[1]);
    if (kind === "pods") {
      const p = pods(s, ns).find((x) => x.name === name); if (!p) return notFound("pods", name);
      const pdb = p.slot && s.k8s.pdbs.find((b) => b.metadata.namespace === p.ns && matches(b.spec.selector && b.spec.selector.matchLabels, p.labels));
      if (pdb && allowedDisruptions(s, pdb) <= 0) s.k8s.pdbViolated = true; // a plain delete ignores PodDisruptionBudgets
      if (p.slot) { s.k8s.gen[p.slot] = (s.k8s.gen[p.slot] || 0) + 1; return `pod "${name}" deleted`; }
      s.k8s.pods = s.k8s.pods.filter((x) => x.name !== name); return `pod "${name}" deleted`;
    }
    if (kind === "namespaces") {
      if (!name) return { out: "error: resource(s) were provided, but no name was specified", code: 1 };
      if (["default", "kube-system", "kube-public", "kube-node-lease"].includes(name)) return { out: `Error from server (Forbidden): namespaces "${name}" is forbidden: this namespace may not be deleted`, code: 1 };
      const kinds = ["deployments", "services", "configmaps", "secrets", "ingresses", "hpas"];
      if (!kinds.some((k) => s.k8s[k].some((o) => o.metadata.namespace === name))) return { out: `Error from server (NotFound): namespaces "${name}" not found`, code: 1 };
      kinds.forEach((k) => { s.k8s[k] = s.k8s[k].filter((o) => o.metadata.namespace !== name); });
      return `namespace "${name}" deleted`;
    }
    const list = s.k8s[kind]; if (!list) return { out: `error: the server doesn't have a resource type "${pos[0] || ""}"`, code: 1 };
    const o = byName(s, kind, ns, name); if (!o) return notFound(kind, name);
    s.k8s[kind] = list.filter((x) => x !== o); return `${KIND_NAME[kind] || kind} "${name}" deleted`;
  };
  K.set = (s, args) => {
    const { flags, pos } = parseArgs(args, ["n", "namespace"]); const ns = nsOf(s, flags) || s.k8s.ns;
    if (pos[0] !== "image") return { out: "error: only 'kubectl set image' is supported here", code: 1 };
    const [kind, name] = splitRef(pos[1]); const d = byName(s, kind, ns, name); if (!d) return notFound(kind || "deployments", name);
    for (const kv of pos.slice(2)) { const [cn, img] = kv.split("="); const c = d.spec.template.spec.containers.find((x) => x.name === cn || cn === "*"); if (!c) return { out: `error: unable to find container named "${cn}"`, code: 1 }; if (c.image !== img) { recordRevision(s, d); c.image = img; } }
    return `deployment.apps/${name} image updated`;
  };
  K.scale = (s, args) => {
    const { flags, pos } = parseArgs(args, ["n", "namespace", "replicas"]); const ns = nsOf(s, flags) || s.k8s.ns;
    const [kind, name] = splitRef(pos[0], pos[1]); const d = byName(s, kind || "deployments", ns, name); if (!d) return notFound("deployments", name);
    if (flags.replicas === undefined) return { out: "error: required flag(s) \"replicas\" not set", code: 1 };
    d.spec.replicas = +flags.replicas; return `deployment.apps/${name} scaled`;
  };
  K.autoscale = (s, args) => {
    const { flags, pos } = parseArgs(args, ["n", "namespace", "min", "max", "cpu-percent"]); const ns = nsOf(s, flags) || s.k8s.ns;
    const [kind, name] = splitRef(pos[0], pos[1]); const d = byName(s, kind || "deployments", ns, name); if (!d) return notFound("deployments", name);
    if (!flags.max) return { out: "error: --max=MAXPODS is required and must be at least 1", code: 1 };
    if (byName(s, "hpas", ns, name)) return { out: `Error from server (AlreadyExists): horizontalpodautoscalers.autoscaling "${name}" already exists`, code: 1 };
    s.k8s.hpas.push({ apiVersion: "autoscaling/v2", kind: "HorizontalPodAutoscaler", metadata: { name, namespace: ns, creationTimestamp: "2026-11-26T10:31:00Z" }, spec: { scaleTargetRef: { apiVersion: "apps/v1", kind: "Deployment", name }, minReplicas: +(flags.min || 1), maxReplicas: +flags.max, metrics: [{ type: "Resource", resource: { name: "cpu", target: { type: "Utilization", averageUtilization: +(flags["cpu-percent"] || 80) } } }] } });
    return `horizontalpodautoscaler.autoscaling/${name} autoscaled`;
  };
  K.rollout = (s, args) => {
    const { flags, pos } = parseArgs(args, ["n", "namespace", "to-revision", "timeout"]); const ns = nsOf(s, flags) || s.k8s.ns;
    const [sub, ref, ref2] = pos; const [kind, name] = splitRef(ref, ref2); const d = byName(s, kind || "deployments", ns, name);
    if (!d) return notFound("deployments", name);
    const k = key(d), hist = s.k8s.history[k] || [];
    if (sub === "status") { const ps = pods(s, ns).filter((p) => p.owner === d), want = desiredReplicas(s, d), newer = ps.filter((p) => p.hash === tHash(d.spec.template)); const readyNew = newer.filter((p) => p.ev.ready).length; if (readyNew >= want) return `deployment "${name}" successfully rolled out`; return { out: `Waiting for deployment "${name}" rollout to finish: ${readyNew} of ${want} updated replicas are available...\nerror: timed out waiting for the condition`, code: 1 }; }
    if (sub === "history") { const revs = [...hist, d.spec.template]; return [`deployment.apps/${name}`, "REVISION  CHANGE-CAUSE", ...revs.map((t, i) => `${String(i + 1).padEnd(9)} ${(t.metadata.annotations || {})["kubernetes.io/change-cause"] || "<none>"}  (image: ${t.spec.containers[0].image})`)].join("\n"); }
    if (sub === "undo") {
      if (!hist.length) return { out: `error: no rollout history found for deployment "${name}"`, code: 1 };
      let target; if (flags["to-revision"]) { target = hist[+flags["to-revision"] - 1]; if (!target) return { out: `error: unable to find specified revision ${flags["to-revision"]} in history`, code: 1 }; } else target = hist[hist.length - 1];
      hist.push(OD.clone(d.spec.template)); d.spec.template = OD.clone(target);
      return `deployment.apps/${name} rolled back`;
    }
    if (sub === "restart") { recordRevision(s, d); d.spec.template.metadata.annotations = { ...(d.spec.template.metadata.annotations || {}), "kubectl.kubernetes.io/restartedAt": `2026-11-26T10:${30 + (s.tick % 29)}:00Z` }; return `deployment.apps/${name} restarted`; }
    return { out: "error: rollout supports status, history, undo and restart here", code: 1 };
  };
  K.cordon = K.uncordon = (s, args, ctx) => {
    const n = nodeName(args.find((a) => !a.startsWith("-"))); if (!NODES.includes(n)) return notFound("nodes", args[0] || "");
    if (ctx.args[0] === "cordon") { if (!s.k8s.cordoned.includes(n)) { s.k8s.cordoned.push(n); (s.k8s.cordonTick = s.k8s.cordonTick || {})[n] = s.tick; } return `node/${n}${FQDN} cordoned`; }
    s.k8s.cordoned = s.k8s.cordoned.filter((x) => x !== n); s.k8s.drained = s.k8s.drained.filter((x) => x !== n); s.k8s.moved = {}; return `node/${n}${FQDN} uncordoned`;
  };
  K.drain = (s, args) => {
    const { flags, pos } = parseArgs(args, ["timeout", "grace-period"]); const n = nodeName(pos[0]);
    if (!NODES.includes(n)) return notFound("nodes", pos[0] || "");
    if (!s.k8s.cordoned.includes(n)) { s.k8s.cordoned.push(n); (s.k8s.cordonTick = s.k8s.cordonTick || {})[n] = s.tick; }
    const out = [`node/${n}${FQDN} cordoned`];
    if (!flags["ignore-daemonsets"]) return { out: out.concat(`error: unable to drain node "${n}${FQDN}" due to error: cannot delete DaemonSet-managed Pods (use --ignore-daemonsets to ignore): kube-system/aws-node-${OD.suffix(n)}, kube-system/kube-proxy-${OD.suffix(n + "p")}, continuing command...`, "There are pending nodes to be drained:", ` ${n}${FQDN}`).join("\n"), code: 1 };
    out.push(`Warning: ignoring DaemonSet-managed Pods: kube-system/aws-node-${OD.suffix(n)}, kube-system/kube-proxy-${OD.suffix(n + "p")}`);
    const blocked = [];
    for (const p of pods(s, null).filter((x) => x.node === n && x.slot)) {
      const pdb = s.k8s.pdbs.find((b) => b.metadata.namespace === p.ns && matches(b.spec.selector && b.spec.selector.matchLabels, p.labels));
      if (pdb && !flags["disable-eviction"] && allowedDisruptions(s, pdb) <= 0) { blocked.push(p); out.push(`error when evicting pods/"${p.name}" -n "${p.ns}" (will retry after 5s): Cannot evict pod as it would violate the pod's disruption budget.`); continue; }
      if (flags["disable-eviction"]) s.k8s.forcedDrain = true;
      out.push(`${flags["disable-eviction"] ? "pod" : "evicting pod"} ${p.ns}/${p.name}${flags["disable-eviction"] ? " deleted" : ""}`);
      // the replacement is scheduled on another node and becomes Ready before the next eviction
      (s.k8s.moved = s.k8s.moved || {})[p.slot] = true;
      s.k8s.gen[p.slot] = (s.k8s.gen[p.slot] || 0) + 1;
    }
    if (blocked.length) { return { out: out.concat(`error: unable to drain node "${n}${FQDN}" due to error: ${blocked.length} pod(s) could not be evicted: their PodDisruptionBudget allows 0 disruptions. Drain gives up here; a real one keeps retrying until you stop it.`, "There are pending nodes to be drained:", ` ${n}${FQDN}`).join("\n"), code: 1 }; }
    if (!s.k8s.drained.includes(n)) s.k8s.drained.push(n);
    return out.concat(`node/${n}${FQDN} drained`).join("\n");
  };
  K.exec = (s, args) => {
    const { flags, pos } = parseArgs(args, ["n", "namespace", "c"]); const ns = nsOf(s, flags) || s.k8s.ns;
    const ref = pos[0]; let p;
    if (ref && ref.includes("/")) { const [k, n] = splitRef(ref); const d = byName(s, k, ns, n); p = d && pods(s, ns).find((x) => x.owner === d && x.ev.ready); }
    else p = pods(s, ns).find((x) => x.name === ref);
    if (!p) return notFound("pods", ref);
    if (!p.ev.ready && p.ev.waiting) return { out: `error: unable to upgrade connection: container not found ("${(p.ev.container || {}).name}")`, code: 1 };
    const cmd = pos.slice(1);
    if (cmd[0] === "env" || cmd[0] === "printenv") return Object.entries({ PATH: "/usr/local/bin:/usr/bin:/bin", HOSTNAME: p.name, ...p.ev.env }).map(([k, v]) => `${k}=${v}`).join("\n");
    if (cmd[0] === "curl" || cmd[0] === "wget") return C.curl({ state: s, args: cmd.slice(1).filter((x) => x !== "-qO-"), name: "curl" });
    if (cmd[0] === "nslookup") { const v = s.k8s.services.find((x) => cmd[1] && cmd[1].split(".")[0] === x.metadata.name); return v ? `Server:\t\t172.20.0.10\nAddress:\t172.20.0.10#53\n\nName:\t${v.metadata.name}.${v.metadata.namespace}.svc.cluster.local\nAddress: 172.20.${parseInt(OD.hash(v.metadata.name).slice(0, 2), 16)}.19` : `** server can't find ${cmd[1]}: NXDOMAIN`; }
    if (cmd[0] === "sh" || cmd[0] === "bash") return "This simulator runs single commands. Try: kubectl exec <pod> -- env | curl <url> | nslookup <name>";
    return { out: `OCI runtime exec failed: exec: "${cmd[0]}": executable file not found in $PATH`, code: 126 };
  };
  K.run = (s, args) => { const i = args.indexOf("--"); if (i >= 0 && ["curl", "wget"].includes(args[i + 1])) return C.curl({ state: s, args: args.slice(i + 2).filter((x) => x !== "-qO-"), name: "curl" }) + (args.includes("--rm") ? `\npod "${args[0]}" deleted` : ""); return { out: "Tip: here you can use kubectl run tmp --rm -it --image=nicolaka/netshoot -- curl <url>", code: 1 }; };
  K.top = (s, args) => {
    const { flags, pos } = parseArgs(args, ["n", "namespace"]); const ns = nsOf(s, flags);
    if ((pos[0] || "").startsWith("no")) return table([["NAME", "CPU(cores)", "CPU(%)", "MEMORY(bytes)", "MEMORY(%)"], ["ip-10-0-11-42.eu-west-2.compute.internal", "1210m", "62%", "3912Mi", "54%"], ["ip-10-0-12-187.eu-west-2.compute.internal", "1105m", "57%", "3604Mi", "50%"]], 3);
    const ps = pods(s, ns).filter((p) => p.ev.ready);
    const rows = ps.map((p) => { const a = p.ev.app || {}; const peers = ps.filter((x) => x.owner === p.owner).length || 1; return [...(ns ? [] : [p.ns]), p.name, `${Math.round((a.cpuLoad || 20) / peers)}m`, `${Math.round((a.memMi || 120) * 0.8)}Mi`]; });
    return table([[...(ns ? [] : ["NAMESPACE"]), "NAME", "CPU(cores)", "MEMORY(bytes)"], ...rows], 3);
  };
  K.config = (s, args) => {
    const [sub] = args;
    if (sub === "set-context") { const m = args.find((a) => a.startsWith("--namespace=")); if (m) { s.k8s.ns = m.split("=")[1]; return `Context "parcelwise-prod" modified.`; } }
    if (sub === "current-context") return "parcelwise-prod";
    if (sub === "get-contexts") return table([["CURRENT", "NAME", "CLUSTER", "AUTHINFO", "NAMESPACE"], ["*", "parcelwise-prod", "parcelwise-prod", "ops", s.k8s.ns]], 3);
    if (sub === "view") return `apiVersion: v1\nkind: Config\ncurrent-context: parcelwise-prod\ncontexts:\n- name: parcelwise-prod\n  context: {cluster: parcelwise-prod, namespace: ${s.k8s.ns}, user: ops}`;
    return { out: "error: supported here: set-context --current --namespace=NS, current-context, get-contexts", code: 1 };
  };
  K.explain = (s, args) => `Use 'kubectl explain ${args[0] || "pod.spec"}' on a real cluster for field docs. Here, check the Binder for this ticket.`;
  K.version = () => "Client Version: v1.34.1\nServer Version: v1.34.1-eks-113cf36";
  K["cluster-info"] = () => "Kubernetes control plane is running at https://A1B2C3D4.gr7.eu-west-2.eks.amazonaws.com\nCoreDNS is running at https://A1B2C3D4.gr7.eu-west-2.eks.amazonaws.com/api/v1/namespaces/kube-system/services/kube-dns:dns/proxy";

  // ------------------------------------------------------------------ helm (v3 keeps each release revision in a Secret)
  const HELM_TYPE = "helm.sh/release.v1";
  const relSecrets = (s, ns, name) => s.k8s.secrets.filter((x) => x.type === HELM_TYPE && x.metadata.namespace === ns && (!name || (x.metadata.labels || {}).name === name)).sort((a, b) => +a.metadata.labels.version - +b.metadata.labels.version);
  const relOf = (x) => ({ ...(x._release || {}), name: x.metadata.labels.name, version: +x.metadata.labels.version, status: x.metadata.labels.status, ns: x.metadata.namespace });
  OD.helmRelease = (s, ns, name) => relSecrets(s, ns, name).map(relOf);
  OD.helmSecret = (ns, name, version, status, rel) => ({ apiVersion: "v1", kind: "Secret", type: HELM_TYPE, metadata: { name: `sh.helm.release.v1.${name}.v${version}`, namespace: ns, labels: { name, owner: "helm", status, version: String(version) } }, data: { release: btoa(`H4sIAAAAAAAC/+y9a3PbOJYw/Fd...${name}.v${version}`) }, _release: rel });
  const deepMerge = (a, b) => { const o = { ...(a || {}) }; for (const [k, v] of Object.entries(b || {})) o[k] = v && typeof v === "object" && !Array.isArray(v) ? deepMerge(o[k], v) : v; return o; };
  const setPath = (o, path, v) => { const ks = path.split("."); let c = o; ks.slice(0, -1).forEach((k) => { c[k] = c[k] && typeof c[k] === "object" ? c[k] : {}; c = c[k]; }); c[ks[ks.length - 1]] = /^\d+$/.test(v) ? +v : v === "true" ? true : v === "false" ? false : v; };
  function helmApply(s, ns, name, values) {
    // the chart renders one Deployment named after the release
    const d = byName(s, "deployments", ns, name); if (!d) return `deployment "${name}" not found`;
    const c = d.spec.template.spec.containers[0], img = values.image || {};
    const before = OD.clone(d.spec.template);
    if (img.repository && img.tag) c.image = `${img.repository}:${img.tag}`;
    if (values.replicaCount !== undefined) d.spec.replicas = +values.replicaCount;
    if (values.resources) c.resources = OD.clone(values.resources);
    d.metadata.annotations = { ...(d.metadata.annotations || {}), "meta.helm.sh/release-name": name, "meta.helm.sh/release-namespace": ns };
    if (tHash(before) !== tHash(d.spec.template)) (s.k8s.history[key(d)] = s.k8s.history[key(d)] || []).push(before);
    return null;
  }
  C.helm = (ctx) => {
    const s = ctx.state; if (!s.k8s) return { out: "helm: command not found", code: 127 };
    const { flags, pos } = parseArgs(ctx.args, ["n", "namespace", "f", "values", "set", "revision", "timeout", "o", "output"]);
    const ns = flags.n || flags.namespace || s.k8s.ns, now = "2026-11-26 10:31:07.412 +0000 UTC";
    const [verb, name, arg] = pos[0] === "get" ? [pos[0], pos[2], pos[1]] : pos; // helm get values RELEASE
    const sets = []; ctx.args.forEach((a, i) => { if (a === "--set") sets.push(ctx.args[i + 1]); else if (a.startsWith("--set=")) sets.push(a.slice(6)); });
    const all = relSecrets(s, ns), latestOf = (n) => { const r = relSecrets(s, ns, n); return r.length ? relOf(r[r.length - 1]) : null; };
    const row = (r) => [r.name, r.ns, r.version, r.updated || now, r.status, r.chart, r.appVersion];
    if (verb === "version") return 'version.BuildInfo{Version:"v3.16.3", GitCommit:"cfd07493f46efc9debd9cc1b02a0961186df7fdf", GoVersion:"go1.22.7"}';
    if (verb === "list" || verb === "ls") {
      const names = [...new Set(all.map((x) => x.metadata.labels.name))], rows = names.map(latestOf).filter((r) => flags.a || flags.all || flags.pending ? true : ["deployed", "failed"].includes(r.status));
      return table([["NAME", "NAMESPACE", "REVISION", "UPDATED", "STATUS", "CHART", "APP VERSION"], ...rows.map(row)], 1);
    }
    if (!name && verb) return { out: `Error: "helm ${verb}" requires a release name`, code: 1 };
    const hist = relSecrets(s, ns, name).map(relOf);
    if (["status", "history", "get", "rollback", "uninstall"].includes(verb) && !hist.length) return { out: `Error: release: not found`, code: 1 };
    if (verb === "status") { const r = hist[hist.length - 1]; return [`NAME: ${r.name}`, `LAST DEPLOYED: ${r.updated || now}`, `NAMESPACE: ${ns}`, `STATUS: ${r.status}`, `REVISION: ${r.version}`, `DESCRIPTION: ${r.description || ""}`].join("\n"); }
    if (verb === "history") return table([["REVISION", "UPDATED", "STATUS", "CHART", "APP VERSION", "DESCRIPTION"], ...hist.map((r) => [r.version, r.updated || now, r.status, r.chart, r.appVersion, r.description || ""])], 1);
    if (verb === "get") { const r = flags.revision ? hist.find((x) => x.version === +flags.revision) : hist[hist.length - 1]; if (!r) return { out: "Error: release: not found", code: 1 }; return arg !== "values" ? { out: "Supported here: helm get values RELEASE [--revision N]", code: 1 } : `USER-SUPPLIED VALUES:\n${yaml().dump(r.values || {}).trimEnd()}`; }
    const setStatus = (r, st) => { const x = s.k8s.secrets.find((y) => y.metadata.name === `sh.helm.release.v1.${r.name}.v${r.version}` && y.metadata.namespace === ns); if (x) x.metadata.labels.status = st; };
    const next = (hist.length ? hist[hist.length - 1].version : 0) + 1;
    if (verb === "rollback") {
      const target = arg ? hist.find((r) => r.version === +arg) : hist[hist.length - 2];
      if (!target) return { out: arg ? `Error: release has no ${arg} version` : "Error: release has no previous version to roll back to", code: 1 };
      const err = helmApply(s, ns, name, target.values || {}); if (err) return { out: `Error: ${err}`, code: 1 };
      hist.forEach((r) => setStatus(r, r.status === "deployed" ? "superseded" : r.status.startsWith("pending") ? "failed" : r.status));
      s.k8s.secrets.push(OD.helmSecret(ns, name, next, "deployed", { chart: target.chart, appVersion: target.appVersion, values: OD.clone(target.values || {}), updated: now, description: `Rollback to ${target.version}` }));
      return "Rollback was a success! Happy Helming!";
    }
    if (verb === "upgrade" || verb === "install") {
      const last = hist[hist.length - 1];
      if (last && last.status.startsWith("pending")) return { out: `Error: UPGRADE FAILED: another operation (install/upgrade/rollback) is in progress`, code: 1 };
      if (verb === "install" && last) return { out: `Error: INSTALLATION FAILED: cannot re-use a name that is still in use`, code: 1 };
      if (!arg) return { out: `Error: "helm ${verb}" requires 2 arguments\n\nUsage:  helm ${verb} [RELEASE] [CHART] [flags]`, code: 1 };
      const dir = s.fs.norm(s.cwd, arg), chartF = s.fs.get(dir + "/Chart.yaml");
      if (!chartF) return { out: `Error: path "${arg}" not found`, code: 1 };
      let chart, values; try { chart = yaml().load(chartF.content) || {}; values = yaml().load((s.fs.get(dir + "/values.yaml") || { content: "" }).content) || {}; } catch (e) { return { out: `Error: ${String(e.message).split("\n")[0]}`, code: 1 }; }
      let user = {};
      for (const f of [flags.f, flags.values].filter(Boolean)) { const vf = s.fs.get(s.fs.norm(s.cwd, f)); if (!vf) return { out: `Error: open ${f}: no such file or directory`, code: 1 }; try { user = deepMerge(user, yaml().load(vf.content) || {}); } catch (e) { return { out: `Error: failed to parse ${f}: ${String(e.message).split("\n")[0]}`, code: 1 }; } }
      for (const kv of sets) { const [p, ...v] = String(kv).split("="); setPath(user, p, v.join("=")); }
      const merged = deepMerge(values, user), err = helmApply(s, ns, name, merged); if (err) return { out: `Error: UPGRADE FAILED: ${err}`, code: 1 };
      hist.forEach((r) => setStatus(r, r.status === "deployed" ? "superseded" : r.status));
      s.k8s.secrets.push(OD.helmSecret(ns, name, next, "deployed", { chart: `${chart.name}-${chart.version}`, appVersion: String(chart.appVersion || (merged.image || {}).tag || ""), values: user, updated: now, description: verb === "install" ? "Install complete" : "Upgrade complete" }));
      return [`Release "${name}" has been upgraded. Happy Helming!`, `NAME: ${name}`, `LAST DEPLOYED: Thu Nov 26 10:31:07 2026`, `NAMESPACE: ${ns}`, "STATUS: deployed", `REVISION: ${next}`].join("\n");
    }
    if (verb === "uninstall") { s.k8s.deployments = s.k8s.deployments.filter((d) => !(d.metadata.name === name && d.metadata.namespace === ns)); s.k8s.secrets = s.k8s.secrets.filter((x) => !(x.type === HELM_TYPE && x.metadata.labels.name === name)); return `release "${name}" uninstalled`; }
    return { out: "Supported here: helm list [-a], status, history, get values, upgrade RELEASE CHART [-f values.yaml] [--set k=v], rollback RELEASE [REVISION], uninstall", code: 1 };
  };

  // ------------------------------------------------------------------ in-cluster HTTP: Services and Ingress
  function serveFromService(s, svc, url) {
    const port = +(url.port || 80), sp = (svc.spec.ports || []).find((p) => p.port === port);
    if (!sp) return { error: 28, msg: `curl: (28) Failed to connect to ${url.hostname} port ${port} after 10001 ms: Timeout was reached` };
    const eps = endpoints(s, svc);
    if (!eps.length) return { error: 7, msg: `curl: (7) Failed to connect to ${url.hostname} port ${port} after 2 ms: Couldn't connect to server` };
    const pod = eps[s.tick % eps.length], a = pod.ev.app || {}, tp = targetPortNum(s, svc, sp);
    if (tp !== (a.port || 8080)) return { error: 7, msg: `curl: (7) Failed to connect to ${url.hostname} port ${port} after 1 ms: Couldn't connect to server` };
    const route = (a.routes || {})[url.pathname];
    if (route) return { ...route, headers: route.headers || { "Content-Type": "application/json", "X-Served-By": pod.name } };
    if (url.pathname === (a.health || "/healthz")) return { status: 200, headers: { "Content-Type": "application/json", "X-Served-By": pod.name }, body: '{"status":"ok"}' };
    return { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "X-Served-By": pod.name }, body: a.body || `<!doctype html><title>${svc.metadata.name}</title><h1>${svc.metadata.name} OK</h1>` };
  }
  OD.resolvers.push((s, url) => {
    if (!s.k8s) return null;
    const h = url.hostname;
    // Ingress hosts (served by the nginx ingress controller's load balancer)
    const ingHosts = s.k8s.ingresses.flatMap((i) => (i.spec.rules || []).map((r) => ({ i, r }))), known = s.k8s.knownHosts || [];
    const ing = ingHosts.filter((x) => x.r.host === h);
    if (ing.length || known.includes(h)) {
      const live = ing.find((x) => s.k8s.ingressClasses.includes(x.i.spec.ingressClassName));
      if (!live) return { status: 404, headers: { "Content-Type": "text/html", Server: "nginx" }, body: "<html><head><title>404 Not Found</title></head><body><center><h1>404 Not Found</h1></center><hr><center>nginx</center></body></html>" };
      const path = (live.r.http.paths || []).filter((p) => url.pathname.startsWith(p.path)).sort((a, b) => b.path.length - a.path.length)[0];
      if (!path) return { status: 404, headers: { Server: "nginx" }, body: "<html><body><center><h1>404 Not Found</h1></center><hr><center>nginx</center></body></html>" };
      const svc = byName(s, "services", live.i.metadata.namespace, path.backend.service.name);
      if (!svc) return { status: 503, headers: { Server: "nginx" }, body: "<html><body><center><h1>503 Service Temporarily Unavailable</h1></center></body></html>" };
      const r = serveFromService(s, svc, new URL(`http://${svc.metadata.name}:${path.backend.service.port.number || 80}${url.pathname}`));
      if (r.error) return { status: 503, headers: { Server: "nginx" }, body: "<html><body><center><h1>503 Service Temporarily Unavailable</h1></center><hr><center>nginx</center></body></html>" };
      return r;
    }
    // Service DNS: name, name.ns, name.ns.svc, name.ns.svc.cluster.local
    const parts = h.split("."); const name = parts[0], ns = parts[1] && parts[1] !== "svc" ? parts[1] : s.k8s.ns;
    if (parts.length > 1 && !(parts[2] === "svc" || parts.length === 2)) return null;
    const svc = byName(s, "services", ns, name);
    if (!svc) return parts.length >= 2 && (parts[2] === "svc" || parts.length === 2) && s.k8s.services.some((v) => v.metadata.name === name) ? { error: 6, msg: `curl: (6) Could not resolve host: ${h}` } : null;
    return serveFromService(s, svc, url);
  });
})();
