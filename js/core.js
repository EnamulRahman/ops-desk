// Ops Desk — core helpers and the virtual filesystem the simulated hosts run on.
(() => {
  "use strict";
  const OD = (window.OD = window.OD || {});

  // ------------------------------------------------------------------ helpers
  OD.KB = 1024; OD.MB = 1024 ** 2; OD.GB = 1024 ** 3;

  OD.human = (n) => {
    if (n < 1024) return `${n}`;
    const u = ["K", "M", "G", "T"]; let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return `${n >= 10 ? Math.round(n) : n.toFixed(1)}${u[i]}`;
  };

  // Pad rows into aligned columns, like most CLI tables.
  OD.table = (rows, gap = 3) => {
    const widths = [];
    rows.forEach((r) => r.forEach((c, i) => { widths[i] = Math.max(widths[i] || 0, String(c).length); }));
    return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? String(c) : String(c).padEnd(widths[i] + gap))).join("").trimEnd()).join("\n");
  };

  OD.hash = (s) => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); };
  const ALNUM = "bcdfghjklmnpqrstvwxz2456789";
  OD.suffix = (seed, n = 5) => { let h = parseInt(OD.hash(seed), 16), out = ""; for (let i = 0; i < n; i++) { out += ALNUM[h % ALNUM.length]; h = Math.floor(h / 7) + 131 * (i + 3); } return out; };

  // Split a command line into tokens, keeping quotes and shell operators.
  // Words come back as {w, q} (q = was quoted, so no glob expansion); operators as {op}.
  OD.tokenize = (line) => {
    const out = []; let cur = "", q = null, has = false, quoted = false;
    const push = () => { if (has) out.push({ w: cur, q: quoted }); cur = ""; has = false; quoted = false; };
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === q) q = null; else cur += c; continue; }
      if (c === "'" || c === '"') { q = c; has = true; quoted = true; continue; }
      if (c === "\\" && i + 1 < line.length) { cur += line[++i]; has = true; continue; }
      if (/\s/.test(c)) { push(); continue; }
      if (c === "|" && line[i + 1] === "|") { push(); out.push({ op: "||" }); i++; continue; }
      if (c === "&" && line[i + 1] === "&") { push(); out.push({ op: "&&" }); i++; continue; }
      if (c === "|") { push(); out.push({ op: "|" }); continue; }
      if (c === ";") { push(); out.push({ op: ";" }); continue; }
      if (c === ">") { push(); if (line[i + 1] === ">") { out.push({ op: ">>" }); i++; } else out.push({ op: ">" }); continue; }
      if (c === "2" && line[i + 1] === ">" && !has) { out.push({ op: "2>" }); i++; continue; }
      cur += c; has = true;
    }
    push();
    return out;
  };

  // Parse "-abc --long=v --flag value" style arguments. `withValue` lists flags that take a value.
  OD.parseArgs = (args, withValue = []) => {
    const flags = {}, pos = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--") { pos.push(...args.slice(i + 1)); break; }
      if (a.startsWith("--")) {
        const [k, v] = a.slice(2).split(/=(.*)/s);
        if (v !== undefined) flags[k] = v;
        else if (withValue.includes(k) && i + 1 < args.length) flags[k] = args[++i];
        else flags[k] = true;
      } else if (a.startsWith("-") && a.length > 1 && !/^-\d/.test(a)) {
        const body = a.slice(1);
        if (withValue.includes(body) && i + 1 < args.length) { flags[body] = args[++i]; continue; }
        for (let j = 0; j < body.length; j++) {
          const f = body[j];
          if (withValue.includes(f)) { flags[f] = body.slice(j + 1) || args[++i]; break; }
          flags[f] = true;
        }
      } else pos.push(a);
    }
    return { flags, pos };
  };

  OD.esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  OD.clone = (o) => JSON.parse(JSON.stringify(o));
  OD.globToRe = (g) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");

  // ------------------------------------------------------------------ virtual filesystem
  class VFS {
    constructor(files = {}, dirs = []) {
      this.files = new Map(); this.dirs = new Set(["/"]);
      dirs.forEach((d) => this.mkdir(d, true));
      Object.entries(files).forEach(([p, f]) => this.write(p, f.content ?? "", f, true));
    }
    norm(cwd, p, home = "/home/ops") {
      if (!p) return cwd;
      if (p === "~" || p.startsWith("~/")) p = home + p.slice(1);
      const parts = (p.startsWith("/") ? p : `${cwd}/${p}`).split("/");
      const out = [];
      for (const s of parts) { if (!s || s === ".") continue; if (s === "..") out.pop(); else out.push(s); }
      return "/" + out.join("/");
    }
    parent(p) { return p.replace(/\/[^/]+$/, "") || "/"; }
    isDir(p) { return this.dirs.has(p); }
    isFile(p) { return this.files.has(p); }
    exists(p) { return this.isDir(p) || this.isFile(p); }
    get(p) { return this.files.get(p); }
    mkdir(p, parents = false) {
      if (this.dirs.has(p)) return true;
      const par = this.parent(p);
      if (!this.dirs.has(par)) { if (!parents) return false; this.mkdir(par, true); }
      this.dirs.add(p); return true;
    }
    list(dir) {
      const pre = dir === "/" ? "/" : dir + "/", names = new Set();
      for (const d of this.dirs) if (d !== dir && d.startsWith(pre) && !d.slice(pre.length).includes("/")) names.add(d.slice(pre.length));
      for (const f of this.files.keys()) if (f.startsWith(pre) && !f.slice(pre.length).includes("/")) names.add(f.slice(pre.length));
      return [...names].sort();
    }
    write(p, content, meta = {}, mkParents = false) {
      const par = this.parent(p);
      if (!this.dirs.has(par)) { if (!mkParents) return false; this.mkdir(par, true); }
      const old = this.files.get(p) || {};
      this.files.set(p, {
        content: String(content), mode: meta.mode || old.mode || "644", owner: meta.owner || old.owner || "ops",
        group: meta.group || old.group || meta.owner || old.owner || "ops",
        size: meta.size !== undefined ? meta.size : undefined, mtime: meta.mtime || old.mtime || "Nov 26 09:14",
      });
      return true;
    }
    size(p) {
      const f = this.files.get(p);
      if (f) return f.size !== undefined ? f.size : f.content.length;
      if (!this.dirs.has(p)) return 0;
      const pre = p === "/" ? "/" : p + "/"; let t = 0;
      for (const [k, v] of this.files) if (k.startsWith(pre)) t += v.size !== undefined ? v.size : v.content.length;
      return t;
    }
    rm(p) {
      if (this.files.delete(p)) return true;
      if (!this.dirs.has(p)) return false;
      const pre = p + "/";
      for (const k of [...this.files.keys()]) if (k.startsWith(pre)) this.files.delete(k);
      for (const d of [...this.dirs]) if (d === p || d.startsWith(pre)) this.dirs.delete(d);
      return true;
    }
    walk(dir) { // every file + dir under dir
      const pre = dir === "/" ? "/" : dir + "/";
      return [...[...this.dirs].filter((d) => d.startsWith(pre)).map((p) => ({ p, dir: true })), ...[...this.files.keys()].filter((f) => f.startsWith(pre)).map((p) => ({ p, dir: false }))].sort((a, b) => a.p.localeCompare(b.p));
    }
  }
  OD.VFS = VFS;

  // ------------------------------------------------------------------ HTTP resolution shared by curl, docker and k8s
  // Each simulator registers resolvers: (state, url) => response | null
  OD.resolvers = [];
  OD.http = (state, raw) => {
    let url;
    try { url = new URL(/^[a-z]+:\/\//.test(raw) ? raw : "http://" + raw); } catch { return { error: 3, msg: `curl: (3) URL rejected: Bad hostname` }; }
    for (const r of OD.resolvers) { const res = r(state, url); if (res) return res; }
    if (["localhost", "127.0.0.1", state.host].includes(url.hostname)) {
      const port = url.port || (url.protocol === "https:" ? 443 : 80);
      return { error: 7, msg: `curl: (7) Failed to connect to ${url.hostname} port ${port} after 0 ms: Couldn't connect to server` };
    }
    return { error: 6, msg: `curl: (6) Could not resolve host: ${url.hostname}` };
  };
})();
