// Ops Desk — simulated Docker engine: images, containers, logs, ports, builds and pruning.
(() => {
  "use strict";
  const OD = window.OD, C = OD.commands, { parseArgs, table, human } = OD;

  // Base images the simulated registry knows about, with realistic sizes.
  const BASES = {
    "node:22": 1130, "node:22-slim": 240, "node:22-alpine": 160, "node:20": 1100, "node:20-alpine": 135,
    "python:3.12": 1020, "python:3.12-slim": 155, "python:3.12-alpine": 58, "golang:1.25": 880, "golang:1.25-alpine": 260,
    "alpine:3.21": 8, "alpine": 8, "nginx:1.27": 190, "nginx:1.27-alpine": 52, "nginx:alpine": 52, "ubuntu:24.04": 78,
    "gcr.io/distroless/nodejs22-debian12": 130, "gcr.io/distroless/static-debian12": 2, "nginxinc/nginx-unprivileged:stable-alpine": 54,
  };

  OD.addDocker = (s, d) => {
    s.docker = { images: [], containers: [], apps: {}, volumes: [], ...d };
    s.docker.images.forEach((i) => { i.id = i.id || OD.hash(i.repo + i.tag).padEnd(12, "0").slice(0, 12); i.size = i.size * OD.MB; });
    s.docker.containers.forEach((c) => { c.id = c.id || OD.hash(c.name).padEnd(12, "a").slice(0, 12); evalContainer(s, c); });
    if (!s.groups.docker) s.groups.docker = ["ops"];
  };
  const app = (s, image) => s.docker.apps[image] || s.docker.apps[image.split(":")[0]] || {};
  const findC = (s, ref) => s.docker.containers.find((c) => c.name === ref || c.id.startsWith(ref));
  const imgRef = (i) => `${i.repo}:${i.tag}`;
  const findImg = (s, ref) => { const [r, t = "latest"] = ref.includes(":") ? ref.split(/:(?=[^:]+$)/) : [ref, "latest"]; return s.docker.images.find((i) => (i.repo === r && i.tag === t) || i.id.startsWith(ref)); };

  function evalContainer(s, c) {
    if (c.status === "created" || c.status === "exited" && c.manualStop) return;
    const a = app(s, c.image);
    const missing = (a.requiredEnv || []).filter((k) => !c.env || !c.env[k]);
    if (missing.length) { c.status = "exited"; c.exitCode = 1; c.logs = [...(a.boot || []), ...(a.missingEnvLog ? a.missingEnvLog(missing) : [`Error: environment variable ${missing[0]} is not set`])]; return; }
    c.status = "running"; c.exitCode = 0; c.logs = [...(a.boot || []), ...(a.ready ? a.ready(c) : [`Listening on 0.0.0.0:${a.port || 80}`])];
  }

  const needDocker = (ctx) => {
    if (OD.isRoot(ctx) || OD.groupsOf(ctx.state, ctx.state.user).includes("docker")) return null;
    return { out: "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get \"http://%2Fvar%2Frun%2Fdocker.sock/v1.47/containers/json\": dial unix /var/run/docker.sock: connect: permission denied", code: 1 };
  };

  const fmtPorts = (c) => (c.status === "running" ? (c.ports || []).map((p) => `0.0.0.0:${p.host}->${p.container}/tcp`).join(", ") : "");
  const statusStr = (c) => (c.status === "running" ? `Up ${c.up || "3 minutes"}` : c.status === "created" ? "Created" : `Exited (${c.exitCode}) ${c.ago || "2 minutes ago"}`);

  C.docker = (ctx) => {
    const s = ctx.state; if (!s.docker) return { out: "docker: command not found", code: 127 };
    const deny = needDocker(ctx); if (deny) return deny;
    let [sub, ...rest] = ctx.args;
    if (sub === "container") sub = rest.shift();
    else if (sub === "image") { const v = rest.shift(); sub = { prune: "image-prune", ls: "images", rm: "rmi" }[v] || v; }
    else if (sub === "system") sub = "system-" + rest.shift();
    else if (sub === "volume") sub = "volume-" + (rest.shift() || "ls");
    const h = D[sub];
    if (!h) return { out: `docker: '${sub || ""}' is not a docker command.\nSee 'docker --help'`, code: 1 };
    return h(s, rest, ctx);
  };

  const D = {};
  D.ps = (s, args) => {
    const { flags } = parseArgs(args); const list = s.docker.containers.filter((c) => flags.a || c.status === "running");
    if (flags.q) return list.map((c) => c.id).join("\n");
    return table([["CONTAINER ID", "IMAGE", "COMMAND", "CREATED", "STATUS", "PORTS", "NAMES"], ...list.map((c) => [c.id, c.image, `"${(c.cmd || app(s, c.image).cmd || "docker-entrypoint.s…").slice(0, 20)}"`, c.created || "5 minutes ago", statusStr(c), fmtPorts(c), c.name])], 3);
  };
  D.ls = D.ps;
  D.logs = (s, args) => { const { pos } = parseArgs(args, ["n", "tail"]); const c = findC(s, pos[0]); if (!c) return { out: `Error response from daemon: No such container: ${pos[0]}`, code: 1 }; return (c.logs || []).join("\n"); };
  D.inspect = (s, args) => {
    const { pos } = parseArgs(args, ["f", "format"]); const c = findC(s, pos[0]);
    if (c) return JSON.stringify([{ Id: c.id + "e1f0c9…", Name: "/" + c.name, State: { Status: c.status, Running: c.status === "running", ExitCode: c.exitCode }, Mounts: (c.volumes || []).map((v) => (v.source.startsWith("/") ? { Type: "bind", Source: v.source, Destination: v.target } : { Type: "volume", Name: v.source, Source: `/var/lib/docker/volumes/${v.source}/_data`, Destination: v.target })), Config: { Image: c.image, User: app(s, c.image).user || "", Env: Object.entries(c.env || {}).map(([k, v]) => `${k}=${v}`), ExposedPorts: { [`${app(s, c.image).port || 80}/tcp`]: {} } }, HostConfig: { PortBindings: Object.fromEntries((c.ports || []).map((p) => [`${p.container}/tcp`, [{ HostIp: "", HostPort: String(p.host) }]])), RestartPolicy: { Name: c.restart || "no" } } }], null, 2);
    const i = findImg(s, pos[0]);
    if (i) return JSON.stringify([{ Id: "sha256:" + i.id, RepoTags: [imgRef(i)], Size: i.size, Config: { User: i.user || "", Env: Object.entries(i.env || {}).map(([k, v]) => `${k}=${v}`), ExposedPorts: { [`${app(s, imgRef(i)).port || 80}/tcp`]: {} }, ...(i.volumes ? { Volumes: Object.fromEntries(i.volumes.map((v) => [v, {}])) } : {}) } }], null, 2);
    return { out: `Error: No such object: ${pos[0]}`, code: 1 };
  };
  D.stop = (s, args) => args.map((r) => { const c = findC(s, r); if (!c) return `Error response from daemon: No such container: ${r}`; c.status = "exited"; c.exitCode = 0; c.manualStop = true; return r; }).join("\n");
  D.start = (s, args) => args.map((r) => { const c = findC(s, r); if (!c) return `Error response from daemon: No such container: ${r}`; c.manualStop = false; c.status = "running"; evalContainer(s, c); return r; }).join("\n");
  D.restart = (s, args) => args.map((r) => { const c = findC(s, r); if (!c) return `Error response from daemon: No such container: ${r}`; c.manualStop = false; c.status = "running"; evalContainer(s, c); return r; }).join("\n");
  D.rm = (s, args) => {
    const { flags, pos } = parseArgs(args); const out = [];
    for (const r of pos) { const c = findC(s, r); if (!c) { out.push(`Error response from daemon: No such container: ${r}`); continue; } if (c.status === "running" && !flags.f) { out.push(`Error response from daemon: cannot remove container "/${c.name}": container is running: stop the container before removing or force remove`); continue; } s.docker.containers = s.docker.containers.filter((x) => x !== c); out.push(r); }
    return out.join("\n");
  };
  D.run = (s, args) => {
    const { flags, pos } = parseArgs(args, ["name", "p", "e", "env", "restart", "v", "env-file", "u", "user", "network"]);
    // collect repeated -p / -e flags manually
    const ports = [], env = {}, volumes = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-p" || args[i] === "--publish") { const [h, c] = String(args[i + 1]).split(":"); ports.push({ host: +h, container: +(c || h) }); i++; }
      else if (/^-p\d/.test(args[i])) { const [h, c] = args[i].slice(2).split(":"); ports.push({ host: +h, container: +(c || h) }); }
      else if (args[i] === "-e" || args[i] === "--env") { const [k, ...v] = String(args[i + 1]).split("="); env[k] = v.join("="); i++; }
      else if (args[i].startsWith("--env=")) { const [k, ...v] = args[i].slice(6).split("="); env[k] = v.join("="); }
      else if (args[i] === "-v" || args[i] === "--volume") { const [src, dst] = String(args[i + 1]).split(":"); if (src && dst) volumes.push({ source: src, target: dst }); i++; }
    }
    if (flags["env-file"]) { const f = s.fs.get(s.fs.norm(s.cwd, flags["env-file"])); if (!f) return { out: `docker: open ${flags["env-file"]}: no such file or directory.`, code: 125 }; f.content.split("\n").forEach((l) => { const m = l.match(/^\s*([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2]; }); }
    const image = pos[0]; if (!image) return { out: '"docker run" requires at least 1 argument.', code: 125 };
    const img = findImg(s, image.includes(":") ? image : image + ":latest");
    if (!img) return { out: `Unable to find image '${image}' locally\ndocker: Error response from daemon: pull access denied for ${image.split(":")[0]}, repository does not exist or may require 'docker login'.`, code: 125 };
    const name = flags.name || ["eager", "brave", "quirky", "sleepy"][s.tick % 4] + "_" + ["turing", "hopper", "lovelace", "torvalds"][s.tick % 4];
    if (findC(s, name)) return { out: `docker: Error response from daemon: Conflict. The container name "/${name}" is already in use by container "${findC(s, name).id}". You have to remove (or rename) that container to be able to reuse that name.`, code: 125 };
    for (const p of ports) { const clash = s.docker.containers.find((c) => c.status === "running" && (c.ports || []).some((x) => x.host === p.host)); if (clash) return { out: `docker: Error response from daemon: driver failed programming external connectivity on endpoint ${name}: Bind for 0.0.0.0:${p.host} failed: port is already allocated.`, code: 125 }; }
    for (const v of volumes) if (!v.source.startsWith("/") && !s.docker.volumes.includes(v.source)) s.docker.volumes.push(v.source);
    const c = { id: OD.hash(name + s.tick).padEnd(12, "c").slice(0, 12), name, image: imgRef(img), ports, env: { ...(img.env || {}), ...env }, volumes, restart: flags.restart, created: "Less than a second ago", up: "Less than a second", status: "running" };
    s.docker.containers.push(c); evalContainer(s, c);
    if (flags.rm && c.status !== "running") s.docker.containers = s.docker.containers.filter((x) => x !== c);
    return flags.d || flags.detach ? c.id + "e1f0c9d2a7b4" : (c.logs || []).join("\n");
  };
  D.exec = (s, args) => {
    const { pos } = parseArgs(args); const c = findC(s, pos[0]); if (!c) return { out: `Error response from daemon: No such container: ${pos[0]}`, code: 1 };
    if (c.status !== "running") return { out: `Error response from daemon: container ${c.id} is not running`, code: 1 };
    const cmd = pos.slice(1).join(" "), a = app(s, c.image), u = a.user || "root";
    if (/^(id|whoami)$/.test(cmd)) return cmd === "whoami" ? u : u === "root" ? "uid=0(root) gid=0(root) groups=0(root)" : `uid=1001(${u}) gid=1001(${u}) groups=1001(${u})`;
    if (cmd === "env" || cmd === "printenv") return Object.entries({ PATH: "/usr/local/bin:/usr/bin:/bin", HOSTNAME: c.id, ...c.env }).map(([k, v]) => `${k}=${v}`).join("\n");
    if (/^(sh|bash)$/.test(cmd)) return "This simulator runs single commands. Try: docker exec <name> env | id | whoami";
    return { out: `OCI runtime exec failed: exec failed: unable to start container process: exec: "${pos[1]}": executable file not found in $PATH: unknown`, code: 126 };
  };
  D.images = (s, args) => { const { flags } = parseArgs(args); return flags.q ? s.docker.images.map((i) => i.id).join("\n") : table([["REPOSITORY", "TAG", "IMAGE ID", "CREATED", "SIZE"], ...s.docker.images.map((i) => [i.repo, i.tag, i.id, i.created || "2 weeks ago", human(i.size) + "B"])], 3); };
  D.rmi = (s, args) => {
    const { flags, pos } = parseArgs(args); const out = [];
    for (const r of pos) { const i = findImg(s, r); if (!i) { out.push(`Error response from daemon: No such image: ${r}`); continue; } const user = s.docker.containers.find((c) => c.image === imgRef(i)); if (user && !flags.f) { out.push(`Error response from daemon: conflict: unable to remove repository reference "${imgRef(i)}" (must force) - container ${user.id} is using its referenced image ${i.id}`); continue; } s.docker.images = s.docker.images.filter((x) => x !== i); out.push(`Untagged: ${imgRef(i)}\nDeleted: sha256:${i.id}…`); }
    return out.join("\n");
  };
  const usedImages = (s, runningOnly) => new Set(s.docker.containers.filter((c) => !runningOnly || c.status === "running").map((c) => c.image));
  function prune(s, { all, containers }) {
    let freed = 0; const out = [];
    if (containers) { const dead = s.docker.containers.filter((c) => c.status !== "running"); dead.forEach((c) => { freed += c.rwSize || 0; out.push(`Deleted Containers:\n${c.id}e1f0c9d2a7b4`); }); s.docker.containers = s.docker.containers.filter((c) => c.status === "running"); }
    const used = usedImages(s, false);
    const gone = s.docker.images.filter((i) => !used.has(imgRef(i)) && (all || i.tag === "<none>"));
    gone.forEach((i) => { freed += i.size; out.push(`deleted: sha256:${i.id}e3b0c44298fc1c149afbf4c8996fb924`); });
    s.docker.images = s.docker.images.filter((i) => !gone.includes(i));
    return out.concat("", `Total reclaimed space: ${human(freed)}B`).join("\n");
  }
  D["image-prune"] = (s, args) => { const { flags } = parseArgs(args); if (!flags.f && !flags.force) return "WARNING! This will remove all dangling images.\nAre you sure you want to continue? [y/N] (re-run with -f to confirm)"; return prune(s, { all: flags.a || flags.all }); };
  D["system-prune"] = (s, args) => { const { flags } = parseArgs(args); if (!flags.f && !flags.force) return "WARNING! This will remove:\n  - all stopped containers\n  - all networks not used by at least one container\n  - all dangling images\n  - unused build cache\n\nAre you sure you want to continue? [y/N] (re-run with -f to confirm)"; return prune(s, { all: flags.a || flags.all, containers: true }); };
  D["system-df"] = (s) => {
    const imgs = s.docker.images, used = usedImages(s, false), tot = imgs.reduce((a, i) => a + i.size, 0), recl = imgs.filter((i) => !used.has(imgRef(i))).reduce((a, i) => a + i.size, 0);
    return table([["TYPE", "TOTAL", "ACTIVE", "SIZE", "RECLAIMABLE"], ["Images", imgs.length, imgs.filter((i) => used.has(imgRef(i))).length, human(tot) + "B", `${human(recl)}B (${Math.round((recl / (tot || 1)) * 100)}%)`], ["Containers", s.docker.containers.length, s.docker.containers.filter((c) => c.status === "running").length, "1.2MB", "0B (0%)"], ["Local Volumes", 2, 1, "212MB", "48MB (22%)"], ["Build Cache", 0, 0, "0B", "0B"]], 3);
  };
  D.pull = (s, args) => { const ref = args[0] || ""; const base = BASES[ref] || BASES[ref + ":latest"]; if (!base) return { out: `Error response from daemon: manifest for ${ref} not found: manifest unknown`, code: 1 }; const [repo, tag = "latest"] = ref.split(":"); if (!findImg(s, ref)) s.docker.images.push({ repo, tag, size: base * OD.MB, id: OD.hash(ref).padEnd(12, "0").slice(0, 12), created: "3 weeks ago" }); return `${tag}: Pulling from library/${repo}\nStatus: Downloaded newer image for ${repo}:${tag}`; };

  D.history = (s, args) => {
    const { pos } = parseArgs(args); const i = pos[0] && findImg(s, pos[0].includes(":") ? pos[0] : pos[0] + ":latest");
    if (!i) return { out: `Error response from daemon: No such image: ${pos[0] || ""}`, code: 1 };
    const rows = [...(i.layers || [])].reverse().map((l, n) => [n ? "<missing>" : i.id, i.created || "2 weeks ago", (/^RUN\b/i.test(l) ? "RUN /bin/sh -c " + l.slice(4) : /^(COPY|ADD)\b/i.test(l) ? l : "/bin/sh -c #(nop) " + l), /^(RUN|COPY|ADD)\b/i.test(l) ? "12.4MB" : "0B"]);
    return table([["IMAGE", "CREATED", "CREATED BY", "SIZE"], ...rows, [rows.length ? "<missing>" : i.id, "3 weeks ago", `FROM ${i.base || "base image"}`, human(Math.max(0, i.size - (i.layers || []).length * 12 * OD.MB)) + "B"]], 3);
  };
  D["volume-ls"] = (s) => table([["DRIVER", "VOLUME NAME"], ...s.docker.volumes.map((v) => ["local", v])], 4);
  D["volume-create"] = (s, args) => { const n = args.find((a) => !a.startsWith("-")); if (!n) return { out: "Tip: docker volume create NAME", code: 1 }; if (!s.docker.volumes.includes(n)) s.docker.volumes.push(n); return n; };
  D["volume-inspect"] = (s, args) => { const n = args[0]; if (!s.docker.volumes.includes(n)) return { out: `Error response from daemon: get ${n}: no such volume`, code: 1 }; return JSON.stringify([{ Driver: "local", Mountpoint: `/var/lib/docker/volumes/${n}/_data`, Name: n, Scope: "local" }], null, 2); };

  // ---- docker build: lint the Dockerfile and estimate the resulting image
  D.build = (s, args) => {
    const { flags, pos } = parseArgs(args, ["t", "f", "tag", "file", "platform"]);
    const dir = s.fs.norm(s.cwd, pos[0] || "."), file = flags.f || flags.file ? s.fs.norm(s.cwd, flags.f || flags.file) : dir + "/Dockerfile";
    const df = s.fs.get(file);
    if (!pos[0]) return { out: 'ERROR: "docker buildx build" requires exactly 1 argument.\nUsage:  docker buildx build [OPTIONS] PATH | URL | -', code: 1 };
    if (!df) return { out: `ERROR: failed to solve: failed to read dockerfile: open Dockerfile: no such file or directory`, code: 1 };
    const tag = flags.t || flags.tag; if (!tag) return { out: "Tip: tag your build with -t name:tag so you can run it.", code: 1 };
    const lines = df.content.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    const stages = []; const out = ["[+] Building 41.2s (12/12) FINISHED"]; let step = 0;
    for (const l of lines) {
      const [ins, ...restArr] = l.split(/\s+/); const rest = restArr.join(" "), I = ins.toUpperCase();
      if (I === "FROM") {
        const m = rest.match(/^(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?$/i); if (!m) return { out: `ERROR: failed to solve: dockerfile parse error on line: ${l}`, code: 1 };
        const prev = stages.find((st) => st.name === m[1]);
        const base = prev ? null : BASES[m[1]] ?? BASES[m[1] + ":latest"];
        if (!prev && base === undefined) return { out: `ERROR: failed to solve: ${m[1]}: failed to resolve source metadata for docker.io/library/${m[1]}: docker.io/library/${m[1]}: not found`, code: 1 };
        stages.push({ name: m[2], base: m[1], size: prev ? prev.size : base, user: prev ? prev.user : "root", env: prev ? { ...prev.env } : {}, lines: [] });
      } else if (!stages.length) return { out: "ERROR: failed to solve: no build stage in current context", code: 1 };
      else {
        const st = stages[stages.length - 1];
        if (I === "USER") st.user = rest;
        if (I === "ENV") { const kv = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:=|\s+)(.*)$/); if (kv) st.env[kv[1]] = kv[2].replace(/^"(.*)"$/, "$1"); }
        if (I === "RUN" && /(npm (ci|install)|pnpm install|yarn)/.test(rest)) st.size += /--omit=dev|--production|--prod/.test(rest) ? 70 : 380;
        if (I === "RUN" && /npm run build|pnpm (run )?build/.test(rest)) st.size += 20;
        if (I === "RUN" && /apt-get install|apk add/.test(rest)) st.size += /--no-cache|rm -rf \/var\/lib\/apt/.test(rest) ? 15 : 60;
        if (I === "COPY") {
          const from = rest.match(/--from=(\S+)/);
          if (from) { const src = stages.find((x) => x.name === from[1]); if (!src) return { out: `ERROR: failed to solve: failed to compute cache key: "/${from[1]}" not found: stage "${from[1]}" does not exist`, code: 1 }; st.size += /node_modules/.test(rest) ? 60 : 25; }
          else st.size += /\s\.\s+\.?/.test(" " + rest + " ") || /^\.\s/.test(rest) ? 45 : 12;
        }
      }
      if (I !== "FROM") stages[stages.length - 1].lines.push(l);
      step++; out.push(` => [${stages.length > 1 ? (stages[stages.length - 1].name || "stage-" + (stages.length - 1)) + " " : ""}${step}/${lines.length}] ${l.slice(0, 70)}`);
    }
    const fin = stages[stages.length - 1];
    const [repo, t = "latest"] = tag.split(":");
    s.docker.images = s.docker.images.filter((i) => !(i.repo === repo && i.tag === t));
    s.docker.images.push({ repo, tag: t, size: Math.round(fin.size) * OD.MB, id: OD.hash(df.content + tag).padEnd(12, "0").slice(0, 12), created: "Less than a second ago", user: fin.user === "root" || fin.user === "0" ? "" : fin.user, stages: stages.length, base: fin.base, env: fin.env, layers: fin.lines });
    s.docker.apps[`${repo}:${t}`] = { ...(s.docker.apps[repo] || {}), user: fin.user === "root" || fin.user === "0" ? "root" : fin.user };
    out.push(` => exporting to image`, ` => => naming to docker.io/library/${repo}:${t}`);
    return out.join("\n");
  };

  // ---- curl localhost:<port> → the container published on that port
  OD.resolvers.push((s, url) => {
    if (!s.docker || !["localhost", "127.0.0.1", s.host].includes(url.hostname)) return null;
    const port = +(url.port || 80);
    const c = s.docker.containers.find((x) => x.status === "running" && (x.ports || []).some((p) => p.host === port));
    if (!c) return null;
    const a = app(s, c.image), map = c.ports.find((p) => p.host === port);
    if ((a.port || 80) !== map.container) return { error: 56, msg: "curl: (56) Recv failure: Connection reset by peer" };
    const route = (a.routes || {})[url.pathname];
    return route || { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" }, body: a.body || "<!doctype html><title>OK</title>" };
  });
})();
