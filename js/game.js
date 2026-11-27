// Ops Desk — the game shell: landing page, desk UI, terminal, editor, grading, ranks and saved progress.
(() => {
  "use strict";
  const OD = window.OD, C = OD.commands, esc = OD.esc;
  const $ = (sel, el = document) => el.querySelector(sel);
  const SAVE_KEY = "opsdesk.v1";

  // ------------------------------------------------------------------ progress (localStorage, best effort)
  const blank = () => ({ name: "", done: {}, hints: {}, current: null, started: false });
  let P = blank();
  try { P = { ...blank(), ...JSON.parse(localStorage.getItem(SAVE_KEY) || "{}") }; } catch { /* private mode etc. */ }
  const save = () => { try { localStorage.setItem(SAVE_KEY, JSON.stringify(P)); } catch { /* ignore */ } };

  const T = OD.TICKETS, byId = Object.fromEntries(T.map((t) => [t.id, t]));
  const xp = () => Object.values(P.done).reduce((a, d) => a + d.xp, 0);
  const ticketsOfRank = (r) => T.filter((t) => t.rank === r);
  const rankDone = (r) => ticketsOfRank(r).every((t) => P.done[t.id]);
  const rank = () => { let r = 0; while (r < OD.RANKS.length - 1 && rankDone(r)) r++; return r; };
  const unlocked = (t) => t.rank <= rank();
  const xpFor = (t) => t.xp;

  // worlds live in memory for this visit; "Reset" rebuilds a ticket's world
  const worlds = {};
  const world = (t) => {
    if (!worlds[t.id]) { const s = t.setup(); if (s.k8s) OD.k8sPods(s, s.k8s.ns); worlds[t.id] = { s, lines: [] }; }
    return worlds[t.id];
  };

  // ------------------------------------------------------------------ extra shell commands
  const HELP = {
    Linux: "ls cd cat less head tail grep find wc sort uniq echo touch mkdir rm mv cp chmod chown nano/vim truncate du df free uptime ps top pgrep kill pkill systemctl journalctl ss lsof curl ping id groups useradd usermod groupadd getent crontab history clear",
    Docker: "docker ps|logs|inspect|run|exec|stop|start|restart|rm|images|rmi|build|pull|image prune|system df|system prune",
    Kubernetes: "kubectl get|describe|logs|apply -f|edit|create|delete|set image|scale|autoscale|rollout status|history|undo|restart|exec|run|top|explain|config",
  };
  C.help = () => ["Commands that work on this desk:", ...Object.entries(HELP).map(([k, v]) => `\n  ${k}\n    ${v}`), "\nTips: ↑/↓ for history, Tab to complete, Ctrl+L to clear, sudo for admin commands.", "Open the Guide (right) for the briefing, runbook and hints."].join("\n");

  // ------------------------------------------------------------------ rendering helpers
  const ansi = (txt) => esc(txt).replace(/\x1bg(.*?)\x1b0/g, '<span class="g">$1</span>').replace(/\x1br(.*?)\x1b0/g, '<span class="r">$1</span>');
  const prompt = (s) => `ops@${s.host}:${s.cwd === "/home/ops" ? "~" : s.cwd.replace(/^\/home\/ops/, "~")}$`;
  const person = (k) => OD.PEOPLE[k];
  const prio = (p) => `<span class="prio prio-${p.toLowerCase()}">${p}</span>`;

  // ------------------------------------------------------------------ views
  const app = $("#app");
  function render() { if (!P.started) landing(); else desk(); }

  function landing() {
    document.body.className = "landing";
    app.innerHTML = `
      <header class="lhead"><div class="logo"><span class="logo-mark">▣</span> Ops Desk</div></header>
      <main class="hero">
        <div class="hero-copy">
          <p class="kicker">An on-call simulator for DevOps engineers</p>
          <h1>Your pager just went off.</h1>
          <p class="lede">You've joined <b>Parcelwise</b>, a parcel-delivery startup, as their newest DevOps hire. Coworkers send you tickets. You fix them in a real-feeling terminal (Linux, Docker, Kubernetes), and a grader checks the <i>state of the system</i>, not the commands you typed. Solve tickets to earn XP and get promoted.</p>
          <form id="start" class="start"><input id="nm" maxlength="24" placeholder="Your name (optional)" value="${esc(P.name)}" aria-label="Your name"><button class="btn primary">Start your first shift →</button></form>
          <p class="fine">Runs entirely in your browser. Nothing to install, no real servers touched. Progress is saved on this device.</p>
        </div>
        <div class="hero-term" aria-hidden="true"><div class="tbar"><i></i><i></i><i></i><span>ops@web-01</span></div><pre>${esc(`$ df -h /
Filesystem  Size  Used Avail Use%
/dev/root    40G   38G  1.8G  96%

$ sudo du -sh /var/log/* | sort -h | tail -1
28G   /var/log/parcelwise

$ sudo rm /var/log/parcelwise/app.log.*
$ curl -s localhost/health
{"status":"ok"}`)}\n<span class="g">✓ PW-101 resolved · +100 XP</span></pre></div>
      </main>
      <section class="ladder">${OD.RANKS.map((r, i) => `<div class="rung"><span class="rn">${i + 1}</span><h3>${r.title}</h3><p>${r.blurb}</p><small>${ticketsOfRank(i).length} tickets</small></div>`).join("")}</section>
      <section class="how"><div><h3>🎫 Real tickets</h3><p>Disk full, crashlooping pods, a broken nginx config, a leaked password. These are the problems on-call engineers actually get paged for.</p></div><div><h3>🖥️ Real tools</h3><p>A simulated shell with pipes, sudo, systemd, Docker and kubectl. Read logs, edit configs in an editor, and roll deployments back.</p></div><div><h3>✅ Graded on outcomes</h3><p>Hit <b>Resolve</b> and the grader inspects the world: is the site up, is the pod Ready, is the secret out of the ConfigMap?</p></div></section>
      <footer class="lfoot">Parcelwise and its staff are fictional. Ops Desk is an independent learning project.</footer>`;
    $("#start").onsubmit = (e) => { e.preventDefault(); P.name = $("#nm").value.trim(); P.started = true; save(); render(); };
  }

  let pane = "ticket"; // mobile tab
  function desk() {
    document.body.className = "desk";
    const r = rank(), cur = Object.hasOwn(byId, P.current) && unlocked(byId[P.current]) ? byId[P.current] : T.find((t) => unlocked(t) && !P.done[t.id]) || T[0];
    P.current = cur.id; save();
    const nextNeed = ticketsOfRank(r).filter((t) => !P.done[t.id]).length;
    const total = T.reduce((a, t) => a + t.xp, 0);
    app.innerHTML = `
      <header class="top">
        <div class="logo"><span class="logo-mark">▣</span> Ops Desk <small>· Parcelwise</small></div>
        <div class="me"><span class="rank">${OD.RANKS[r].title}</span><div class="xpbar" title="${xp()} / ${total} XP"><div style="width:${Math.round((xp() / total) * 100)}%"></div></div><span class="xpn">${xp()} XP</span></div>
        <div class="acts"><button class="btn sm" id="sync" title="Continue on another device">☁️ <span class="bl">Sync</span></button><button class="btn sm" id="binder" title="Command reference">📒 <span class="bl">Binder</span></button><button class="btn sm ghost" id="menu" title="Back to the start page">⌂</button></div>
      </header>
      <nav class="tabs" role="tablist">${["queue", "ticket", "runbook"].map((k) => `<button role="tab" data-p="${k}" class="${pane === k ? "on" : ""}">${{ queue: "Inbox", ticket: "Terminal", runbook: "Guide" }[k]}</button>`).join("")}</nav>
      <div class="grid" data-pane="${pane}">
        <aside class="queue">
          <h2>Inbox</h2>
          ${OD.RANKS.map((rk, i) => `<div class="grp ${i > r ? "locked" : ""}"><h4>${i > r ? "🔒 " : ""}${rk.title}</h4>${ticketsOfRank(i).map((t) => `<button class="tk ${t.id === cur.id ? "on" : ""} ${P.done[t.id] ? "done" : ""}" data-id="${t.id}" ${i > r ? "disabled" : ""}><span class="tk-id">${t.id}</span><span class="tk-t">${esc(t.title)}</span><span class="tk-m">${P.done[t.id] ? `✓ ${P.done[t.id].xp} XP` : `${person(t.from).avatar} ${t.topic}`}</span></button>`).join("")}</div>`).join("")}
          ${r < OD.RANKS.length - 1 ? `<p class="promo">Resolve ${nextNeed} more ticket${nextNeed === 1 ? "" : "s"} to be promoted to <b>${OD.RANKS[r + 1].title}</b>.</p>` : ""}
        </aside>
        <main class="work">
          <article class="ticket">
            <div class="t-head"><span class="tk-id">${cur.id}</span>${prio(cur.priority)}<span class="topic">${cur.topic}</span><span class="host">🖥️ ${esc(world(cur).s.host)}</span></div>
            <h2>${esc(cur.title)}</h2>
            <div class="msg" id="msg" title="Tap to expand"><span class="av">${person(cur.from).avatar}</span><div><b>${person(cur.from).name}</b> <small>${person(cur.from).role}</small><p>${cur.message}</p></div></div>
          </article>
          <section class="term" id="term" aria-label="Terminal">
            <div class="tbar"><i></i><i></i><i></i><span>ops@${esc(world(cur).s.host)}</span><button class="link" id="reset" title="Rebuild this ticket's broken world from scratch">↺ Reset world</button></div>
            <div class="out" id="out" tabindex="-1"></div>
            <form class="in" id="cmdf" autocomplete="off"><label id="pr" for="cmd"></label><input id="cmd" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="Command"></form>
          </section>
        </main>
        <aside class="runbook">
          ${cur.brief ? `<div class="rb brief">
            <h3>📋 Briefing</h3>
            <h4>What's being asked</h4><p>${cur.brief.what}</p>
            <h4>Background</h4><p>${cur.brief.context}</p>
            <h4>Helpful to know</h4><ul>${cur.brief.info.map((x) => `<li>${x}</li>`).join("")}</ul>
          </div>` : ""}
          <div class="rb">
            <h3>🧭 Runbook · ${cur.topic}</h3>
            <ol>${cur.sop.map((x) => `<li>${x}</li>`).join("")}</ol>
          </div>
          <div class="rb hints">
            <h3>💡 Hints <small>(free: from a nudge to the full answer)</small></h3>
            ${cur.hints.map((h, i) => `<p class="hint"><b>${["Nudge", "Closer", "Answer"][i] || i + 1}:</b> <span>${esc(h).replace(/\n/g, "<br>")}</span></p>`).join("")}
          </div>
          <div class="rb resolve">
            <button class="btn primary wide" id="resolve">${P.done[cur.id] ? "Re-check" : "Resolve ticket"} <small>(${xpFor(cur)} XP)</small></button>
            <div id="grade"></div>
          </div>
        </aside>
      </div>
      <div id="modal" class="modal" hidden></div>`;

    // wiring
    app.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => { pane = b.dataset.p; $(".grid").dataset.pane = pane; app.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("on", x === b)); if (pane === "ticket") $("#cmd").focus(); }));
    app.querySelectorAll(".tk").forEach((b) => (b.onclick = () => { P.current = b.dataset.id; pane = "ticket"; save(); render(); }));
    $("#menu").onclick = () => { P.started = false; save(); render(); };
    $("#sync").onclick = syncSheet;
    $("#binder").onclick = binder;
    $("#msg").onclick = () => $("#msg").classList.toggle("open");
    $("#reset").onclick = () => { delete worlds[cur.id]; render(); flash("World rebuilt. Everything is broken again. 😈"); };
    $("#resolve").onclick = () => grade(cur);
    terminal(cur);
  }

  // ------------------------------------------------------------------ terminal
  function terminal(t) {
    const W = world(t), s = W.s, out = $("#out"), input = $("#cmd"), pr = $("#pr");
    const greet = () => [`<span class="dim">Connected to ${esc(s.host)} · Ubuntu 24.04 LTS · type <b>help</b> for commands</span>`, `<span class="dim">${esc((s.fs.get("/home/ops/README.txt") || { content: "" }).content.trim()).replace(/\n/g, "<br>")}</span>`];
    if (!W.lines.length) W.lines.push(...greet());
    const paint = () => { out.innerHTML = W.lines.join("\n"); out.scrollTop = out.scrollHeight; pr.textContent = prompt(s); };
    paint();
    let hi = s.history.length;
    const exec = (line) => {
      W.lines.push(`<span class="pr">${esc(prompt(s))}</span> ${esc(line)}`);
      const r = OD.run(s, line);
      if (r.out === "\x1bclear") W.lines.length = 0;
      else if (r.out) W.lines.push(`<span class="${r.code ? "err" : ""}">${ansi(r.out)}</span>`);
      if (W.lines.length > 600) W.lines.splice(0, W.lines.length - 600);
      hi = s.history.length; paint();
      if (r.editor) editor(r.editor, (msg) => { if (msg) W.lines.push(ansi(msg)); paint(); input.focus(); });
    };
    $("#cmdf").onsubmit = (e) => { e.preventDefault(); const v = input.value; input.value = ""; if (v.trim()) exec(v); else { W.lines.push(`<span class="pr">${esc(prompt(s))}</span>`); paint(); } };
    input.onkeydown = (e) => {
      if (e.key === "ArrowUp") { e.preventDefault(); if (hi > 0) input.value = s.history[--hi]; }
      else if (e.key === "ArrowDown") { e.preventDefault(); if (hi < s.history.length - 1) input.value = s.history[++hi]; else { hi = s.history.length; input.value = ""; } }
      else if (e.key === "Tab") { e.preventDefault(); complete(s, input, (opts) => { W.lines.push(`<span class="pr">${esc(prompt(s))}</span> ${esc(input.value)}`, esc(opts.join("  "))); paint(); }); }
      else if (e.key === "l" && e.ctrlKey) { e.preventDefault(); W.lines.length = 0; paint(); }
      else if (e.key === "c" && e.ctrlKey && !window.getSelection().toString()) { e.preventDefault(); W.lines.push(`<span class="pr">${esc(prompt(s))}</span> ${esc(input.value)}^C`); input.value = ""; paint(); }
    };
    $("#term").onclick = () => { if (!window.getSelection().toString()) input.focus(); };
    if (pane === "ticket" && window.matchMedia("(min-width: 900px)").matches) input.focus({ preventScroll: true });
  }

  const SUB = {
    docker: ["ps", "logs", "inspect", "run", "exec", "stop", "start", "restart", "rm", "images", "rmi", "build", "pull", "image", "system", "container"],
    kubectl: ["get", "describe", "logs", "apply", "edit", "create", "delete", "set", "scale", "autoscale", "rollout", "exec", "run", "top", "explain", "config"],
    systemctl: ["status", "start", "stop", "restart", "reload", "enable", "disable", "is-active", "list-units", "daemon-reload"],
  };
  function complete(s, input, show) {
    const v = input.value, parts = v.split(/\s+/), word = parts[parts.length - 1], first = parts.length === 1;
    let cands;
    const base = parts[0] === "sudo" ? parts[1] : parts[0];
    if (first || (parts[0] === "sudo" && parts.length === 2)) cands = Object.keys(C).filter((k) => !k.startsWith("_") && k.length > 1);
    else if (SUB[base] && parts.length === (parts[0] === "sudo" ? 3 : 2)) cands = SUB[base];
    else {
      const slash = word.lastIndexOf("/"), dirPart = slash >= 0 ? word.slice(0, slash + 1) : "", dir = s.fs.norm(s.cwd, dirPart || ".");
      if (!s.fs.isDir(dir)) return;
      cands = s.fs.list(dir).map((n) => dirPart + n + (s.fs.isDir(dir === "/" ? "/" + n : dir + "/" + n) ? "/" : ""));
    }
    const hits = cands.filter((c) => c.startsWith(word));
    if (!hits.length) return;
    let pre = hits[0]; for (const h of hits) while (!h.startsWith(pre)) pre = pre.slice(0, -1);
    if (hits.length === 1) pre = hits[0] + (hits[0].endsWith("/") ? "" : " ");
    if (pre.length > word.length) input.value = v.slice(0, v.length - word.length) + pre;
    else if (hits.length > 1) show(hits.slice(0, 40).map((h) => h.replace(/^.*\/(?=.)/, "")));
  }

  // ------------------------------------------------------------------ editor modal
  function editor(ed, done) {
    const m = $("#modal"); m.hidden = false;
    m.innerHTML = `<div class="sheet ed" role="dialog" aria-modal="true" aria-label="Editor"><div class="ed-h"><b>${esc(ed.title)}</b>${ed.readOnly ? ' <span class="r">[ read-only ]</span>' : ""}</div><textarea id="edt" spellcheck="false">${esc(ed.content)}</textarea><div class="ed-f"><span class="dim">Ctrl+S save · Esc cancel</span><span class="sp"></span><button class="btn sm ghost" id="edc">Cancel</button>${ed.readOnly ? "" : '<button class="btn sm primary" id="eds">Save</button>'}</div></div>`;
    const ta = $("#edt"); ta.focus(); ta.setSelectionRange(0, 0); ta.scrollTop = 0;
    const close = (msg) => { m.hidden = true; m.innerHTML = ""; done(msg); };
    const doSave = () => { if (ed.readOnly) return; const r = ed.save(ta.value); const msg = typeof r === "string" ? r : r && r.out; if (r && r.code) { flash(msg || "Could not save", true); return; } close(msg); };
    $("#edc").onclick = () => close();
    const sb = $("#eds"); if (sb) sb.onclick = doSave;
    ta.onkeydown = (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "o")) { e.preventDefault(); doSave(); }
      else if (e.key === "Escape" || ((e.ctrlKey) && e.key === "x")) { e.preventDefault(); close(); }
      else if (e.key === "Tab") { e.preventDefault(); const a = ta.selectionStart; ta.setRangeText("  ", a, ta.selectionEnd, "end"); }
    };
  }

  // ------------------------------------------------------------------ grading
  function grade(t) {
    const s = world(t).s, res = t.checks(s), ok = res.every((c) => c.ok), g = $("#grade");
    g.innerHTML = `<ul class="checks">${res.map((c) => `<li class="${c.ok ? "ok" : "no"}">${c.ok ? "✓" : "✗"} ${esc(c.label)}</li>`).join("")}</ul>` + (ok ? "" : `<p class="dim">Not quite. Keep going. The grader checks the system, so try the commands in the runbook to see what's still wrong.</p>`);
    if (!ok) { pane = "runbook"; return; }
    const first = !P.done[t.id], before = rank();
    if (first) { P.done[t.id] = { xp: xpFor(t), at: Date.now() }; save(); }
    const after = rank();
    const m = $("#modal"); m.hidden = false;
    const next = T.find((x) => unlocked(x) && !P.done[x.id]);
    m.innerHTML = `<div class="sheet win" role="dialog" aria-modal="true">
      ${after > before ? `<div class="promo-big">🎉 Promoted to <b>${OD.RANKS[after].title}</b>!<br><small>${OD.RANKS[after].blurb}</small></div>` : ""}
      <h2>✓ ${t.id} resolved${first ? ` · +${P.done[t.id].xp} XP` : ""}</h2>
      <p class="thanks">${person(t.from).avatar} <b>${person(t.from).name.split(" ")[0]}:</b> ${["Amazing, thank you!! 🙌", "You're a lifesaver.", "That was quick, nice one!", "Legend. Owe you a coffee ☕"][OD.TICKETS.indexOf(t) % 4]}</p>
      <h3>Debrief: what a senior would want you to know</h3><p>${t.debrief}</p>
      <div class="row">${next ? `<button class="btn primary" id="nx">Next ticket: ${next.id} →</button>` : `<p><b>You've cleared the whole queue${P.name ? `, ${esc(P.name)}` : ""}.</b> 🏆 That's every Parcelwise incident. Reset any ticket to practise it again.</p>`}<button class="btn ghost" id="cl">Stay here</button></div></div>`;
    $("#cl").onclick = () => { m.hidden = true; render(); };
    const nx = $("#nx"); if (nx) nx.onclick = () => { P.current = next.id; pane = "ticket"; save(); render(); };
  }

  // ------------------------------------------------------------------ binder (command reference)
  function binder() {
    const m = $("#modal"); m.hidden = false;
    const sec = [
      ["Linux: look around", [["df -h", "disk space per filesystem"], ["du -sh /var/log/*", "size of each item"], ["ls -lah", "long listing incl. hidden"], ["tail -n 50 FILE", "end of a file"], ["grep -i error FILE", "search text"], ["find / -size +1G", "big files"]]],
      ["Linux: services & processes", [["systemctl status NAME", "is it running? recent logs"], ["sudo systemctl restart NAME", "restart a service"], ["sudo journalctl -u NAME -n 50", "service logs"], ["top / ps aux", "what's using CPU and memory"], ["kill PID / kill -9 PID", "stop a process (gently / forcefully)"], ["sudo lsof +L1", "deleted files still held open"], ["ss -tlnp", "what's listening on which port"]]],
      ["Linux: users & permissions", [["sudo useradd -m -s /bin/bash -G grp user", "new user"], ["sudo usermod -aG grp user", "add to a group (-a!)"], ["id user", "uid and groups"], ["chmod 755 FILE", "rwx owner, r-x others"], ["sudo chown user:grp FILE", "change owner"]]],
      ["Docker", [["docker ps -a", "all containers incl. stopped"], ["docker logs NAME", "container output"], ["docker run -d --name N -p H:C --env-file F IMG", "start a container"], ["docker rm -f NAME", "remove a container"], ["docker build -t name:tag DIR", "build an image"], ["docker system df", "disk used by Docker"], ["docker image prune -a -f", "delete unused images"]]],
      ["Kubernetes", [["kubectl get pods -o wide", "pods and where they run"], ["kubectl describe pod NAME", "details + Events (read these!)"], ["kubectl logs POD --previous", "logs from the crashed container"], ["kubectl get endpoints SVC", "which pods a Service routes to"], ["kubectl edit deploy NAME", "change a live object"], ["kubectl set image deploy/N c=img:tag", "deploy a new image"], ["kubectl rollout undo deploy/N", "go back a revision"], ["kubectl top pods", "CPU and memory use"], ["kubectl autoscale deploy N --min=3 --max=10 --cpu-percent=60", "create an HPA"]]],
    ];
    m.innerHTML = `<div class="sheet binder" role="dialog" aria-modal="true" aria-label="Binder"><div class="ed-h"><b>📒 The Binder</b><span class="sp"></span><button class="btn sm ghost" id="bc">Close</button></div><div class="bbody">${sec.map(([h, rows]) => `<h3>${h}</h3><table>${rows.map(([c, d]) => `<tr><td><code>${esc(c)}</code></td><td>${d}</td></tr>`).join("")}</table>`).join("")}<p class="dim">Type <code>help</code> in the terminal for every supported command.</p></div></div>`;
    const close = () => { m.hidden = true; };
    $("#bc").onclick = close; m.onclick = (e) => { if (e.target === m) close(); };
  }

  // ------------------------------------------------------------------ sync between devices (no server: progress travels in a link)
  const b64 = { enc: (str) => btoa(unescape(encodeURIComponent(str))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
    dec: (str) => decodeURIComponent(escape(atob(str.replace(/-/g, "+").replace(/_/g, "/")))) };
  const exportCode = () => "OD1." + b64.enc(JSON.stringify({ n: P.name, c: P.current, d: Object.entries(P.done).map(([id, d]) => [id, d.xp, d.at || 0]) }));
  const syncLink = () => `${location.origin}${location.pathname}#sync=${exportCode()}`;
  // Merge another device's progress into this one. Returns how many tickets were new here, or -1 if the code is invalid.
  function importCode(raw) {
    const m = String(raw).trim().match(/OD1\.([A-Za-z0-9_-]+)/); if (!m) return -1;
    let data; try { data = JSON.parse(b64.dec(m[1])); } catch { return -1; }
    if (!data || !Array.isArray(data.d)) return -1;
    let added = 0;
    for (const [id, x, at] of data.d) {
      if (!Object.hasOwn(byId, id) || typeof x !== "number" || !(x >= 0)) continue;
      const mine = Object.hasOwn(P.done, id) ? P.done[id] : undefined;
      if (!mine) added++;
      if (!mine || x > mine.xp) P.done[id] = { xp: Math.min(x, byId[id].xp), at: at || Date.now() };
    }
    if (!P.name && typeof data.n === "string") P.name = data.n.slice(0, 24);
    if (Object.hasOwn(byId, data.c)) P.current = data.c; // pick up where the other device left off
    P.started = true; save(); return added;
  }
  function syncSheet() {
    const m = $("#modal"); m.hidden = false;
    const link = syncLink(), web = /^https?:$/.test(location.protocol);
    let qr = "";
    if (web && window.qrcode) { try { const q = window.qrcode(0, "L"); q.addData(link); q.make(); qr = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); } catch { qr = ""; } }
    const n = Object.keys(P.done).length;
    m.innerHTML = `<div class="sheet sync" role="dialog" aria-modal="true" aria-label="Sync progress"><div class="ed-h"><b>☁️ Continue on another device</b><span class="sp"></span><button class="btn sm ghost" id="sc">Close</button></div>
      <div class="bbody">
        <p>Your progress (${n} ticket${n === 1 ? "" : "s"}, ${xp()} XP) lives in this browser. To carry it over, open this link on your other device. Progress <b>merges</b>, so nothing is lost and you can sync in either direction as often as you like. It's free and private: no account, and nothing is stored on a server.</p>
        ${qr ? `<div class="qr">${qr}<p class="dim">Scan with your phone's camera.</p></div>` : ""}
        <h3>1 · Send yourself this link</h3>
        <div class="cp"><input id="sl" readonly value="${esc(web ? link : exportCode())}" aria-label="Sync link"><button class="btn sm primary" id="scp">Copy</button></div>
        <p class="dim">${web ? "Paste it into a note, email or message to yourself, then open it on the other device." : "You're running from a local file, so this is a code rather than a link. Paste it into the box below on the other device."}</p>
        <h3>2 · Or paste a link/code from another device</h3>
        <div class="cp"><input id="si" placeholder="https://…#sync=OD1.…  or  OD1.…" aria-label="Paste a sync link or code"><button class="btn sm" id="sld">Load</button></div>
      </div></div>`;
    const close = () => { m.hidden = true; render(); };
    $("#sc").onclick = close; m.onclick = (e) => { if (e.target === m) close(); };
    $("#scp").onclick = async () => { const v = $("#sl").value; try { await navigator.clipboard.writeText(v); } catch { $("#sl").select(); document.execCommand("copy"); } flash("Copied. Now open it on your other device."); };
    $("#sld").onclick = () => { const r = importCode($("#si").value); if (r < 0) { flash("That doesn't look like an Ops Desk sync link or code.", true); return; } m.hidden = true; render(); flash(r ? `Synced: ${r} ticket${r === 1 ? "" : "s"} added from your other device.` : "Synced. You were already up to date."); };
  }
  // opening a sync link: merge, then tidy the address bar
  function syncFromHash(rerender) {
    if (!/^#sync=/.test(location.hash)) return;
    const r = importCode(location.hash);
    try { history.replaceState(null, "", location.pathname + location.search); } catch { /* ignore */ }
    if (rerender) { const m = $("#modal"); if (m) m.hidden = true; render(); }
    setTimeout(() => flash(r < 0 ? "That sync link looks damaged. Try copying it again." : r ? `Synced: ${r} ticket${r === 1 ? "" : "s"} added from your other device.` : "Synced. You were already up to date.", r < 0), 300);
  }
  syncFromHash(false);
  window.addEventListener("hashchange", () => syncFromHash(true));

  function flash(msg, bad) { const d = document.createElement("div"); d.className = "toast" + (bad ? " bad" : ""); d.textContent = msg; document.body.appendChild(d); setTimeout(() => d.remove(), 3200); }
  document.addEventListener("keydown", (e) => { const m = $("#modal"); if (e.key === "Escape" && m && !m.hidden && !$("#edt")) { m.hidden = true; render(); } });

  OD.game = { render, progress: () => P, exportCode, importCode, reset: () => { P = blank(); save(); Object.keys(worlds).forEach((k) => delete worlds[k]); render(); }, world: (id) => world(byId[id]).s };
  render();
})();
