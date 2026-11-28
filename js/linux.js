// Ops Desk — simulated Linux host: the shell (pipes, &&, redirects, globs, sudo) and core commands.
(() => {
  "use strict";
  const OD = window.OD;
  const C = (OD.commands = OD.commands || {});
  const { parseArgs, human, table } = OD;

  // ------------------------------------------------------------------ state helpers
  OD.newHost = (opts = {}) => {
    const s = {
      host: opts.host || "web-01", user: "ops", cwd: "/home/ops", tick: 0,
      fs: new OD.VFS(opts.files || {}, ["/home/ops", "/tmp", "/etc", "/var/log", "/usr/local/bin", "/opt", ...(opts.dirs || [])]),
      disk: { total: opts.diskTotal || 40 * OD.GB, base: opts.diskBase || 6 * OD.GB },
      users: { root: { uid: 0, home: "/root" }, ops: { uid: 1000, home: "/home/ops" }, www: { uid: 33, home: "/var/www" }, ...(opts.users || {}) },
      groups: { root: ["root"], sudo: ["ops"], ops: ["ops"], www: ["www"], ...(opts.groups || {}) },
      procs: [], services: {}, journal: {}, openDeleted: [], history: [], scripts: {}, ns: opts.ns || "default",
    };
    s.fs.write("/etc/hostname", s.host + "\n", { owner: "root", mode: "644" });
    s.fs.write("/etc/os-release", 'PRETTY_NAME="Ubuntu 24.04.1 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\n', { owner: "root" });
    return s;
  };
  OD.addService = (s, name, svc) => {
    s.services[name] = { enabled: true, active: false, failed: false, ...svc };
    if (svc.active !== false) OD.startService(s, name, true);
  };
  OD.startService = (s, name, quiet) => {
    const svc = s.services[name];
    const res = svc.check ? svc.check(s) : { ok: true };
    (s.journal[name] = s.journal[name] || []);
    if (!res.ok) {
      svc.active = false; svc.failed = true;
      s.journal[name].push(...(res.journal || []), `systemd[1]: ${name}.service: Failed with result 'exit-code'.`, `systemd[1]: Failed to start ${name}.service - ${svc.desc}.`);
      return res;
    }
    svc.active = true; svc.failed = false; svc.startedTick = OD.stamp(s);
    if (svc.onStart) svc.onStart(s);
    if (svc.proc && !s.procs.some((p) => p.svc === name)) s.procs.push({ pid: OD.nextPid(s), user: svc.proc.user || "root", cpu: svc.proc.cpu || 0.3, mem: svc.proc.mem || 1.2, cmd: svc.proc.cmd, svc: name, start: "09:02" });
    if (!quiet) s.journal[name].push(`systemd[1]: Started ${name}.service - ${svc.desc}.`);
    // a restart releases deleted-but-open files held by this service
    s.openDeleted = s.openDeleted.filter((d) => d.svc !== name);
    return { ok: true };
  };
  OD.stopService = (s, name) => {
    const svc = s.services[name]; svc.active = false; svc.failed = false;
    if (svc.onStop) svc.onStop(s);
    s.procs = s.procs.filter((p) => p.svc !== name);
    s.openDeleted = s.openDeleted.filter((d) => d.svc !== name);
    (s.journal[name] = s.journal[name] || []).push(`systemd[1]: Stopped ${name}.service - ${svc.desc}.`);
  };
  OD.stamp = (s) => (s._seq = (s._seq || 0) + 1); // strictly increasing, even within one command line
  OD.holdsOf = (s, v) => (typeof v.holds === "function" ? v.holds(s) : v.holds || []);
  OD.nextPid = (s) => { s._pid = (s._pid || 1800) + 37; return s._pid; };
  OD.diskUsed = (s) => s.disk.base + s.fs.size("/") + s.openDeleted.reduce((a, d) => a + d.size, 0) + (s.docker ? s.docker.images.reduce((a, i) => a + i.size, 0) + s.docker.containers.reduce((a, c) => a + (c.rwSize || 0), 0) : 0);
  OD.diskPct = (s) => Math.round((OD.diskUsed(s) / s.disk.total) * 100);
  OD.groupsOf = (s, user) => Object.entries(s.groups).filter(([, m]) => m.includes(user)).map(([g]) => g);

  const isRoot = (ctx) => ctx.root || ctx.state.user === "root";
  const canWrite = (ctx, path) => {
    if (isRoot(ctx)) return true;
    const s = ctx.state;
    const f = s.fs.get(path);
    const owner = f ? f.owner : (s.fs.isDir(path) ? (path.startsWith("/home/ops") || path.startsWith("/tmp") ? "ops" : "root") : null);
    if (f) return f.owner === s.user || f.mode.endsWith("6") || f.mode.endsWith("7");
    if (owner) return owner === s.user;
    const par = s.fs.parent(path);
    return par.startsWith("/home/ops") || par.startsWith("/tmp");
  };
  const denied = (cmd, path, verb = "Permission denied") => `${cmd}: ${path}: ${verb}`;
  OD.canWrite = canWrite; OD.isRoot = isRoot;

  // ------------------------------------------------------------------ the shell
  OD.expand = (s, word) => {
    if (word.q || !/[*?]/.test(word.w)) return [word.w];
    const abs = s.fs.norm(s.cwd, word.w);
    const dir = s.fs.parent(abs), re = OD.globToRe(abs.slice(dir.length + (dir === "/" ? 0 : 1)));
    const hits = s.fs.list(dir).filter((n) => re.test(n));
    if (!hits.length) return [word.w];
    const prefix = word.w.includes("/") ? word.w.slice(0, word.w.lastIndexOf("/") + 1) : "";
    return hits.map((h) => prefix + h);
  };

  OD.run = (s, line) => {
    s.tick++;
    const toks = OD.tokenize(line.trim());
    if (!toks.length) return { out: "" };
    s.history.push(line.trim());
    // split into && / || / ; chains, then pipelines
    const chain = []; let cur = [], op = null;
    for (const t of toks) {
      if (t.op === "&&" || t.op === "||" || t.op === ";") { chain.push({ op, toks: cur }); op = t.op; cur = []; }
      else cur.push(t);
    }
    chain.push({ op, toks: cur });
    let out = [], code = 0, editor = null;
    for (const link of chain) {
      if (link.op === "&&" && code !== 0) continue;
      if (link.op === "||" && code === 0) continue;
      if (!link.toks.length) continue;
      const r = runPipeline(s, link.toks);
      if (r.out) out.push(r.out);
      code = r.code; if (r.editor) editor = r.editor;
    }
    return { out: out.join("\n"), code, editor };
  };

  function runPipeline(s, toks) {
    const stages = [[]];
    for (const t of toks) { if (t.op === "|") stages.push([]); else stages[stages.length - 1].push(t); }
    let stdin = null, res = { out: "", code: 0 };
    for (let i = 0; i < stages.length; i++) {
      // redirects (only meaningful on the last stage, as in practice)
      let redirect = null, words = [];
      const st = stages[i];
      for (let j = 0; j < st.length; j++) {
        const t = st[j];
        if (t.op === ">" || t.op === ">>") { redirect = { mode: t.op, path: st[j + 1] && st[j + 1].w }; j++; continue; }
        if (t.op === "2>") { j++; continue; } // stderr redirects: swallow
        words.push(...OD.expand(s, t));
      }
      res = exec(s, words, stdin);
      if (redirect) {
        if (!redirect.path) return { out: "bash: syntax error near unexpected token `newline'", code: 2 };
        if (redirect.path === "/dev/null") { res = { ...res, out: "" }; }
        else {
          const ctx = { state: s, root: false };
          const p = s.fs.norm(s.cwd, redirect.path);
          if (!canWrite(ctx, p)) return { out: `bash: ${redirect.path}: Permission denied`, code: 1 };
          const old = redirect.mode === ">>" && s.fs.isFile(p) ? s.fs.get(p).content : "";
          const content = old + (res.out ? res.out + "\n" : "");
          const f = s.fs.get(p);
          s.fs.write(p, content, { size: undefined });
          if (f) s.fs.get(p).size = undefined;
          res = { ...res, out: "" };
        }
      }
      stdin = res.out;
    }
    return res;
  }

  function exec(s, words, stdin) {
    if (!words.length) return { out: "", code: 0 };
    let root = false;
    if (words[0] === "sudo") {
      words = words.slice(1); root = true;
      if (words[0] === "-i" || words[0] === "su") return { out: "Tip: stay as ops and prefix single commands with sudo. It's safer and leaves an audit trail.", code: 0 };
      if (!words.length) return { out: "usage: sudo command", code: 1 };
    }
    let [name, ...args] = words;
    if (/^(\.\/|\/).+\.sh$/.test(name) || name === "bash" || name === "sh") return C.__script({ state: s, args: name === "bash" || name === "sh" ? args : [name, ...args], root, stdin, direct: !(name === "bash" || name === "sh") });
    const fn = C[name];
    if (!fn) return { out: `${name}: command not found`, code: 127 };
    const r = fn({ state: s, args, root, stdin, name });
    if (r == null) return { out: "", code: 0 };
    if (typeof r === "string") return { out: r, code: 0 };
    return { out: r.out ?? "", code: r.code ?? 0, editor: r.editor };
  }

  // ------------------------------------------------------------------ navigation and files
  const P = (ctx, p) => ctx.state.fs.norm(ctx.state.cwd, p, ctx.state.users[ctx.state.user].home);
  C.pwd = (ctx) => ctx.state.cwd;
  C.cd = (ctx) => {
    const p = P(ctx, ctx.args[0] || "~");
    if (!ctx.state.fs.isDir(p)) return { out: `bash: cd: ${ctx.args[0]}: No such file or directory`, code: 1 };
    ctx.state.cwd = p; return "";
  };
  const modeStr = (f, dir) => {
    const m = dir ? "755" : f.mode;
    const bits = m.slice(-3).split("").map((d) => { d = +d; return (d & 4 ? "r" : "-") + (d & 2 ? "w" : "-") + (d & 1 ? "x" : "-"); }).join("");
    return (dir ? "d" : "-") + bits;
  };
  C.ls = (ctx) => {
    const { flags, pos } = parseArgs(ctx.args);
    const s = ctx.state, long = flags.l, all = flags.a, h = flags.h;
    const targets = pos.length ? pos : ["."];
    const blocks = [];
    for (const t of targets) {
      const p = P(ctx, t);
      if (s.fs.isFile(p)) { blocks.push(long ? lsLine(s, p, t, h) : t); continue; }
      if (!s.fs.isDir(p)) { blocks.push(`ls: cannot access '${t}': No such file or directory`); continue; }
      let names = s.fs.list(p); if (!all) names = names.filter((n) => !n.startsWith("."));
      const body = long ? [`total ${Math.ceil(s.fs.size(p) / 1024)}`, ...names.map((n) => lsLine(s, (p === "/" ? "" : p) + "/" + n, n, h))].join("\n") : names.join("  ");
      blocks.push(targets.length > 1 ? `${t}:\n${body}` : body);
    }
    return blocks.join("\n\n");
  };
  function lsLine(s, path, name, h) {
    const dir = s.fs.isDir(path), f = dir ? { owner: path.startsWith("/home/ops") ? "ops" : "root", group: path.startsWith("/home/ops") ? "ops" : "root", mtime: "Nov 26 08:00" } : s.fs.get(path);
    const size = dir ? 4096 : s.fs.size(path);
    return [modeStr(f, dir), "1", f.owner.padEnd(5), (f.group || f.owner).padEnd(5), String(h ? human(size) : size).padStart(h ? 5 : 11), f.mtime, name].join(" ");
  }
  C.cat = (ctx) => {
    if (!ctx.args.length) return ctx.stdin || "";
    return ctx.args.map((a) => {
      const p = P(ctx, a), s = ctx.state;
      if (s.fs.isDir(p)) return `cat: ${a}: Is a directory`;
      const f = s.fs.get(p);
      if (!f) return `cat: ${a}: No such file or directory`;
      if (f.mode.slice(-1) === "0" && f.owner !== s.user && !isRoot(ctx)) return `cat: ${a}: Permission denied`;
      if (f.size !== undefined && f.size > 64 * OD.KB) return f.content + (f.content ? "\n" : "") + `… (${human(f.size)} of log lines, truncated)`;
      return f.content.replace(/\n$/, "");
    }).join("\n");
  };
  C.less = C.more = C.cat;
  const readable = (ctx, f) => !(f.mode.slice(-1) === "0" && f.owner !== ctx.state.user && !isRoot(ctx));
  const readInput = (ctx, file) => {
    if (!file) return ctx.stdin || "";
    const f = ctx.state.fs.get(P(ctx, file));
    if (f && !readable(ctx, f)) return { denied: true };
    return f ? f.content.replace(/\n$/, "") : null;
  };
  C.head = C.tail = (ctx) => {
    const { flags, pos } = parseArgs(ctx.args, ["n"]);
    let n = 10; const num = ctx.args.find((a) => /^-\d+$/.test(a)); if (num) n = +num.slice(1); if (flags.n) n = +flags.n;
    const files = pos.filter((p) => !/^-\d+$/.test(p) && (!/^\d+$/.test(p) || flags.n === undefined));
    const txt = readInput(ctx, files[0]);
    if (txt === null) return { out: `${ctx.name}: cannot open '${files[0]}' for reading: No such file or directory`, code: 1 };
    if (txt && txt.denied) return { out: `${ctx.name}: cannot open '${files[0]}' for reading: Permission denied`, code: 1 };
    const lines = txt.split("\n");
    return ctx.name === "head" ? lines.slice(0, n).join("\n") : lines.slice(-n).join("\n");
  };
  C.grep = (ctx) => {
    const { flags, pos } = parseArgs(ctx.args, ["e"]);
    const pat = flags.e || pos[0]; const files = flags.e ? pos : pos.slice(1);
    if (!pat) return { out: "Usage: grep [OPTION]... PATTERNS [FILE]...", code: 2 };
    let re; try { re = new RegExp(pat.replace(/\\\|/g, "|"), flags.i ? "i" : ""); } catch { re = new RegExp(pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags.i ? "i" : ""); }
    const s = ctx.state, results = [];
    const scan = (txt, label) => txt.split("\n").forEach((l, i) => { if (re.test(l) !== !!flags.v) results.push((label ? label + ":" : "") + (flags.n ? i + 1 + ":" : "") + l); });
    if (!files.length) scan(ctx.stdin || "");
    for (const f of files) {
      const p = P(ctx, f);
      if (s.fs.isDir(p)) { if (flags.r || flags.R) s.fs.walk(p).filter((x) => !x.dir).forEach((x) => (readable(ctx, s.fs.get(x.p)) ? scan(s.fs.get(x.p).content, x.p) : results.push(`grep: ${x.p}: Permission denied`))); else results.push(`grep: ${f}: Is a directory`); }
      else if (s.fs.isFile(p)) { if (readable(ctx, s.fs.get(p))) scan(s.fs.get(p).content, files.length > 1 ? f : ""); else results.push(`grep: ${f}: Permission denied`); }
      else results.push(`grep: ${f}: No such file or directory`);
    }
    if (flags.c) return String(results.length);
    return { out: results.join("\n"), code: results.length ? 0 : 1 };
  };
  C.wc = (ctx) => { const { flags, pos } = parseArgs(ctx.args); const r = readInput(ctx, pos[0]); if (r && r.denied) return { out: `wc: ${pos[0]}: Permission denied`, code: 1 }; const t = r || ""; const lines = t ? t.split("\n").length : 0; return flags.l ? String(lines) : `${lines} ${t.split(/\s+/).filter(Boolean).length} ${t.length}`; };
  C.sort = (ctx) => { const { flags } = parseArgs(ctx.args); let l = (ctx.stdin || "").split("\n"); l.sort(flags.n ? (a, b) => parseFloat(a) - parseFloat(b) : undefined); if (flags.r) l.reverse(); return l.join("\n"); };
  C.uniq = (ctx) => { const { flags } = parseArgs(ctx.args); const l = (ctx.stdin || "").split("\n"); const out = []; let prev = null, n = 0; for (const x of [...l, null]) { if (x === prev) { n++; continue; } if (prev !== null) out.push(flags.c ? `${String(n).padStart(7)} ${prev}` : prev); prev = x; n = 1; } return out.join("\n"); };
  // awk: just enough for log analysis: [-F sep] '[/re/ | $N op value] {print $A, $B}'
  C.awk = (ctx) => {
    const { flags, pos } = parseArgs(ctx.args, ["F"]); const prog = pos[0];
    if (!prog) return { out: "usage: awk [-F fs] 'program' [file ...]", code: 2 };
    const m = prog.trim().match(/^(.*?)\s*\{\s*print\s*(.*?)\s*;?\s*\}\s*$/s) || (prog.trim().match(/^(\/.*\/|\$\w+\s*(==|!=|~|>|<|>=|<=)\s*\S+)$/) ? [null, prog.trim(), ""] : null);
    if (!m) return { out: `awk: this simulator understands programs like '{print $1}' or '$9 == 500 {print $7}'`, code: 2 };
    const txt = readInput(ctx, pos[1]); if (txt === null) return { out: `awk: cannot open "${pos[1]}" (No such file or directory)`, code: 2 }; if (txt && txt.denied) return { out: `awk: cannot open "${pos[1]}" (Permission denied)`, code: 2 };
    const sep = flags.F === undefined ? null : flags.F === "\\t" ? "\t" : flags.F;
    const fields = (l) => { const f = sep === null ? l.trim().split(/\s+/) : l.split(sep); return [l, ...f]; };
    const val = (f, ref) => { if (ref === "$0") return f[0]; if (ref === "$NF") return f[f.length - 1]; const n = ref.match(/^\$(\d+)$/); if (n) return f[+n[1]] ?? ""; if (ref === "NF") return String(f.length - 1); return ref.replace(/^"(.*)"$/, "$1"); };
    const cond = m[1].trim();
    const test = (l, f) => {
      if (!cond) return true;
      const re = cond.match(/^\/(.*)\/$/); if (re) return new RegExp(re[1]).test(l);
      const c = cond.match(/^(\$\w+)\s*(==|!=|~|>=|<=|>|<)\s*(.+)$/); if (!c) return true;
      const a = val(f, c[1]), b = c[3].trim();
      if (c[2] === "~") return new RegExp(b.replace(/^\/(.*)\/$/, "$1")).test(a);
      const bv = b.replace(/^"(.*)"$/, "$1"), num = !isNaN(+a) && !isNaN(+bv) && bv !== "";
      return { "==": num ? +a === +bv : a === bv, "!=": num ? +a !== +bv : a !== bv, ">": +a > +bv, "<": +a < +bv, ">=": +a >= +bv, "<=": +a <= +bv }[c[2]];
    };
    const refs = m[2] ? m[2].split(/\s*,\s*/) : ["$0"];
    return (txt || "").split("\n").filter((l) => l !== "").map((l) => [l, fields(l)]).filter(([l, f]) => test(l, f)).map(([, f]) => refs.map((r) => val(f, r)).join(" ")).join("\n");
  };
  C.cut = (ctx) => {
    const { flags, pos } = parseArgs(ctx.args, ["d", "f", "c"]);
    const txt = readInput(ctx, pos[0]); if (txt === null) return { out: `cut: ${pos[0]}: No such file or directory`, code: 1 }; if (txt && txt.denied) return { out: `cut: ${pos[0]}: Permission denied`, code: 1 };
    if (!flags.f) return { out: "cut: you must specify a list of bytes, characters, or fields", code: 1 };
    const d = flags.d === undefined ? "\t" : flags.d, want = String(flags.f).split(",").flatMap((r) => { const [a, b] = r.split("-").map(Number); return b ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [a]; });
    return (txt || "").split("\n").map((l) => { const f = l.split(d); return want.map((i) => f[i - 1]).filter((x) => x !== undefined).join(d); }).join("\n");
  };
  C.zcat = C.gunzip = (ctx) => {
    const files = ctx.args.filter((a) => !a.startsWith("-"));
    if (ctx.name === "gunzip" && !ctx.args.includes("-c")) return { out: "Tip: use gunzip -c FILE (or zcat FILE) to read it without unpacking it on disk.", code: 1 };
    return files.map((a) => { const f = ctx.state.fs.get(P(ctx, a)); if (!f) return `gzip: ${a}: No such file or directory`; if (!readable(ctx, f)) return `gzip: ${a}: Permission denied`; if (ctx.state.fs.size(P(ctx, a)) < 64) return `gzip: ${a}: unexpected end of file`; return f.content.replace(/\n$/, "") || `(${human(ctx.state.fs.size(P(ctx, a)))} of compressed data)`; }).join("\n");
  };
  C.echo = (ctx) => ctx.args.filter((a) => a !== "-e" && a !== "-n").join(" ");
  C.touch = (ctx) => { for (const a of ctx.args) { const p = P(ctx, a); if (!canWrite(ctx, p)) return { out: `touch: cannot touch '${a}': Permission denied`, code: 1 }; if (!ctx.state.fs.isFile(p)) if (!ctx.state.fs.write(p, "")) return { out: `touch: cannot touch '${a}': No such file or directory`, code: 1 }; } return ""; };
  C.mkdir = (ctx) => { const { flags, pos } = parseArgs(ctx.args); for (const a of pos) { const p = P(ctx, a); if (!canWrite(ctx, ctx.state.fs.parent(p)) && !canWrite(ctx, p)) return { out: `mkdir: cannot create directory '${a}': Permission denied`, code: 1 }; if (!ctx.state.fs.mkdir(p, !!flags.p)) return { out: `mkdir: cannot create directory '${a}': No such file or directory`, code: 1 }; } return ""; };
  C.rm = (ctx) => {
    const { flags, pos } = parseArgs(ctx.args); const s = ctx.state, out = [];
    for (const a of pos) {
      const p = P(ctx, a);
      if (p === "/" || p === "/etc" || p === "/usr" || p === "/var") { out.push(`rm: refusing to remove '${a}'. That would destroy the server.`); continue; }
      if (!s.fs.exists(p)) { if (!flags.f) out.push(`rm: cannot remove '${a}': No such file or directory`); continue; }
      if (s.fs.isDir(p) && !(flags.r || flags.R)) { out.push(`rm: cannot remove '${a}': Is a directory`); continue; }
      if (!canWrite(ctx, p)) { out.push(`rm: cannot remove '${a}': Permission denied`); continue; }
      // a file still held open by a running process: the name goes, the space doesn't
      const holder = Object.entries(s.services).find(([, v]) => v.active && OD.holdsOf(s, v).includes(p));
      if (holder) s.openDeleted.push({ path: p, size: s.fs.size(p), svc: holder[0] });
      s.fs.rm(p);
    }
    return { out: out.join("\n"), code: out.length ? 1 : 0 };
  };
  C.truncate = (ctx) => {
    const { flags, pos } = parseArgs(ctx.args, ["s"]);
    if (flags.s === undefined) return { out: "truncate: you must specify either '--size' or '--reference'", code: 1 };
    for (const a of pos) { const p = P(ctx, a); const f = ctx.state.fs.get(p); if (!f) return { out: `truncate: cannot open '${a}' for writing: No such file or directory`, code: 1 }; if (!canWrite(ctx, p)) return { out: `truncate: cannot open '${a}' for writing: Permission denied`, code: 1 }; f.content = ""; f.size = 0; }
    return "";
  };
  C.mv = C.cp = (ctx) => {
    const { pos } = parseArgs(ctx.args); if (pos.length < 2) return { out: `${ctx.name}: missing destination file operand`, code: 1 };
    const s = ctx.state, src = P(ctx, pos[0]); let dst = P(ctx, pos[1]);
    if (!s.fs.isFile(src)) return { out: `${ctx.name}: cannot stat '${pos[0]}': No such file or directory`, code: 1 };
    if (s.fs.isDir(dst)) dst = dst + "/" + src.split("/").pop();
    if (!canWrite(ctx, dst) || (ctx.name === "mv" && !canWrite(ctx, src))) return { out: `${ctx.name}: cannot ${ctx.name === "mv" ? "move" : "create regular file"} '${pos[1]}': Permission denied`, code: 1 };
    const f = s.fs.get(src); s.fs.write(dst, f.content, { mode: f.mode, owner: isRoot(ctx) ? f.owner : s.user, size: f.size });
    if (ctx.name === "mv") s.fs.rm(src);
    return "";
  };
  C.chmod = (ctx) => {
    const [mode, ...files] = ctx.args; const s = ctx.state;
    if (!mode || !files.length) return { out: "chmod: missing operand", code: 1 };
    for (const a of files) {
      const p = P(ctx, a), f = s.fs.get(p);
      if (!f) return { out: `chmod: cannot access '${a}': No such file or directory`, code: 1 };
      if (f.owner !== s.user && !isRoot(ctx)) return { out: `chmod: changing permissions of '${a}': Operation not permitted`, code: 1 };
      if (/^[0-7]{3,4}$/.test(mode)) f.mode = mode.slice(-3);
      else {
        const m = mode.match(/^([ugoa]*)([+-=])([rwx]+)$/); if (!m) return { out: `chmod: invalid mode: '${mode}'`, code: 1 };
        const who = m[1] || "a", bits = { r: 4, w: 2, x: 1 }, val = m[3].split("").reduce((a, c) => a | bits[c], 0);
        const d = f.mode.split("").map(Number);
        [["u", 0], ["g", 1], ["o", 2]].forEach(([w, i]) => { if (who.includes(w) || who.includes("a")) d[i] = m[2] === "+" ? d[i] | val : m[2] === "-" ? d[i] & ~val : val; });
        f.mode = d.join("");
      }
    }
    return "";
  };
  C.chown = (ctx) => {
    const { pos } = parseArgs(ctx.args); const [og, ...files] = pos;
    if (!isRoot(ctx)) return { out: `chown: changing ownership of '${files[0]}': Operation not permitted`, code: 1 };
    const [o, g] = og.split(":");
    for (const a of files) { const f = ctx.state.fs.get(P(ctx, a)); if (!f) return { out: `chown: cannot access '${a}': No such file or directory`, code: 1 }; if (o) f.owner = o; if (g) f.group = g; }
    return "";
  };
  C.find = (ctx) => {
    const a = ctx.args; const start = a[0] && !a[0].startsWith("-") ? a[0] : ".";
    const get = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : null; };
    const name = get("-name"), type = get("-type"), size = get("-size"), s = ctx.state, root = P(ctx, start);
    let items = s.fs.walk(root);
    if (name) { const re = OD.globToRe(name); items = items.filter((x) => re.test(x.p.split("/").pop())); }
    if (type === "f") items = items.filter((x) => !x.dir); if (type === "d") items = items.filter((x) => x.dir);
    if (size) { const m = size.match(/^\+(\d+)([kMG])$/); if (m) { const lim = +m[1] * { k: OD.KB, M: OD.MB, G: OD.GB }[m[2]]; items = items.filter((x) => !x.dir && s.fs.size(x.p) > lim); } }
    return items.map((x) => (start === "." ? "." + x.p.slice(root.length) : x.p)).join("\n");
  };
  C.du = (ctx) => {
    const { flags, pos } = parseArgs(ctx.args); const s = ctx.state;
    const targets = pos.length ? pos : ["."];
    return targets.map((t) => { const p = P(ctx, t); if (!s.fs.exists(p)) return `du: cannot access '${t}': No such file or directory`; const sz = s.fs.size(p) + (p === "/var/lib/docker" && s.docker ? s.docker.images.reduce((a, i) => a + i.size, 0) : 0); return `${flags.h ? human(Math.max(sz, 4096)) : Math.max(4, Math.ceil(sz / 1024))}\t${t}`; }).join("\n");
  };
  C.df = (ctx) => {
    const { flags } = parseArgs(ctx.args); const s = ctx.state, used = OD.diskUsed(s), tot = s.disk.total, f = (n) => (flags.h ? human(n) : Math.round(n / 1024));
    return table([["Filesystem", flags.h ? "Size" : "1K-blocks", "Used", "Avail", "Use%", "Mounted on"], ["/dev/root", f(tot), f(used), f(Math.max(0, tot - used)), Math.min(100, OD.diskPct(s)) + "%", "/"], ["tmpfs", f(2 * OD.GB), "0", f(2 * OD.GB), "0%", "/dev/shm"], ["/dev/nvme0n1p15", f(105 * OD.MB), f(6 * OD.MB), f(99 * OD.MB), "6%", "/boot/efi"]], 2);
  };
  C.free = (ctx) => { const { flags } = parseArgs(ctx.args); const v = flags.h ? ["7.6Gi", "2.9Gi", "1.2Gi", "3.5Gi", "4.4Gi"] : ["7953612", "3046120", "1258208", "3649284", "4614792"]; return table([["", "total", "used", "free", "buff/cache", "available"], ["Mem:", ...v], ["Swap:", flags.h ? "0B" : "0", flags.h ? "0B" : "0", flags.h ? "0B" : "0"]], 2); };
  C.uptime = (ctx) => { const load = ctx.state.procs.some((p) => p.cpu > 90) ? "3.98, 3.91, 3.55" : "0.21, 0.30, 0.28"; return ` 10:31:07 up ${ctx.state.uptime || "41 days,  3:12"},  1 user,  load average: ${load}`; };
  C.whoami = (ctx) => (isRoot(ctx) ? "root" : ctx.state.user);
  C.hostname = (ctx) => ctx.state.host;
  C.date = () => "Thu Nov 26 10:31:07 UTC 2026";
  C.history = (ctx) => ctx.state.history.map((h, i) => `${String(i + 1).padStart(5)}  ${h}`).join("\n");
  C.which = (ctx) => ctx.args.map((a) => (C[a] ? `/usr/bin/${a}` : "")).filter(Boolean).join("\n") || { out: "", code: 1 };
  C.man = (ctx) => `No manual entry here. Try '${ctx.args[0] || "cmd"} --help', or open the Binder for this ticket.`;

  // ------------------------------------------------------------------ editor
  const EDITABLE = (ctx, a) => {
    if (!a) return { out: `${ctx.name}: missing file name`, code: 1 };
    const s = ctx.state, p = P(ctx, a), f = s.fs.get(p);
    if (!f && !s.fs.isDir(s.fs.parent(p))) return { out: `${ctx.name}: ${a}: No such file or directory`, code: 1 };
    const writable = canWrite(ctx, p);
    return { editor: { title: writable ? p : `${p} (read-only: use sudo to edit)`, content: f ? f.content : "", readOnly: !writable,
      save: (text) => { if (!writable) return { out: `${ctx.name}: ${p}: Permission denied`, code: 1 }; s.fs.write(p, text, { size: undefined }); s.fs.get(p).size = undefined; return `Saved ${p}`; } } };
  };
  C.nano = C.vim = C.vi = C.edit = (ctx) => EDITABLE(ctx, ctx.args.filter((a) => !a.startsWith("-"))[0]);

  // ------------------------------------------------------------------ users and groups
  C.id = (ctx) => {
    const s = ctx.state, u = ctx.args[0] || (isRoot(ctx) ? "root" : s.user);
    if (!s.users[u]) return { out: `id: '${u}': no such user`, code: 1 };
    const gs = OD.groupsOf(s, u); const gid = (g) => ({ root: 0, sudo: 27, ops: 1000, www: 33, docker: 999 }[g] ?? 1000 + Object.keys(s.groups).indexOf(g));
    const prim = s.groups[u] ? u : gs[0] || u;
    return `uid=${s.users[u].uid}(${u}) gid=${gid(prim)}(${prim}) groups=${gs.map((g) => `${gid(g)}(${g})`).join(",")}`;
  };
  C.groups = (ctx) => { const s = ctx.state, u = ctx.args[0] || s.user; if (!s.users[u]) return { out: `groups: '${u}': no such user`, code: 1 }; return `${ctx.args[0] ? u + " : " : ""}${OD.groupsOf(s, u).join(" ")}`; };
  C.useradd = C.adduser = (ctx) => {
    if (!isRoot(ctx)) return { out: `${ctx.name}: Permission denied.\n${ctx.name}: cannot lock /etc/passwd; try again later.`, code: 1 };
    const { flags, pos } = parseArgs(ctx.args, ["G", "s", "g", "c"]); const s = ctx.state, u = pos[0];
    if (!u) return { out: "Usage: useradd [options] LOGIN", code: 2 };
    if (s.users[u]) return { out: `useradd: user '${u}' already exists`, code: 9 };
    s.users[u] = { uid: 1001 + Object.keys(s.users).length, home: `/home/${u}`, shell: flags.s || "/bin/sh" };
    s.groups[u] = [u];
    if (flags.m || ctx.name === "adduser") s.fs.mkdir(`/home/${u}`, true);
    if (flags.G) for (const g of flags.G.split(",")) { if (!s.groups[g]) return { out: `useradd: group '${g}' does not exist`, code: 6 }; s.groups[g].push(u); }
    return "";
  };
  C.usermod = (ctx) => {
    if (!isRoot(ctx)) return { out: "usermod: Permission denied.\nusermod: cannot lock /etc/passwd; try again later.", code: 1 };
    const { flags, pos } = parseArgs(ctx.args, ["G", "g", "s"]); const s = ctx.state, u = pos[0];
    if (!s.users[u]) return { out: `usermod: user '${u}' does not exist`, code: 6 };
    if (flags.G) {
      const list = flags.G.split(",");
      for (const g of list) if (!s.groups[g]) return { out: `usermod: group '${g}' does not exist`, code: 6 };
      if (!flags.a) for (const [g, m] of Object.entries(s.groups)) if (g !== u && !list.includes(g)) s.groups[g] = m.filter((x) => x !== u);
      for (const g of list) if (!s.groups[g].includes(u)) s.groups[g].push(u);
    }
    return "";
  };
  C.groupadd = (ctx) => { if (!isRoot(ctx)) return { out: "groupadd: Permission denied.", code: 10 }; const g = ctx.args[0]; if (ctx.state.groups[g]) return { out: `groupadd: group '${g}' already exists`, code: 9 }; ctx.state.groups[g] = []; return ""; };
  C.getent = (ctx) => {
    const [db, key] = ctx.args, s = ctx.state;
    if (db === "group") { const e = Object.entries(s.groups).filter(([g]) => !key || g === key); return e.length ? e.map(([g, m]) => `${g}:x:${1000 + Object.keys(s.groups).indexOf(g)}:${m.join(",")}`).join("\n") : { out: "", code: 2 }; }
    if (db === "passwd") { const e = Object.entries(s.users).filter(([u]) => !key || u === key); return e.length ? e.map(([u, v]) => `${u}:x:${v.uid}:${v.uid}::${v.home}:${v.shell || "/bin/bash"}`).join("\n") : { out: "", code: 2 }; }
    return { out: "Unknown database", code: 1 };
  };
  C.passwd = (ctx) => (isRoot(ctx) ? "New password: \nRetype new password: \npasswd: password updated successfully" : { out: "passwd: You may not view or modify password information for another user.", code: 1 });

  // ------------------------------------------------------------------ processes
  C.ps = (ctx) => {
    const s = ctx.state;
    const base = [{ pid: 1, user: "root", cpu: 0, mem: 0.1, cmd: "/sbin/init", start: "Oct16" }, { pid: 412, user: "root", cpu: 0, mem: 0.2, cmd: "/usr/sbin/sshd -D", start: "Oct16" }, { pid: 418, user: "root", cpu: 0, mem: 0.1, cmd: "/usr/sbin/cron -f", start: "Oct16" }];
    const rows = [...base, ...s.procs].map((p) => [p.user, p.pid, p.cpu.toFixed(1), p.mem.toFixed(1), p.cpu > 50 ? "R" : "S", p.start || "09:02", p.cmd]);
    return table([["USER", "PID", "%CPU", "%MEM", "STAT", "START", "COMMAND"], ...rows], 2);
  };
  C.top = C.htop = (ctx) => {
    const s = ctx.state, procs = [...s.procs].sort((a, b) => b.cpu - a.cpu);
    const load = procs.some((p) => p.cpu > 90) ? "3.98, 3.91, 3.55" : "0.21, 0.30, 0.28";
    return [`top - 10:31:07 up ${s.uptime || "41 days,  3:12"},  1 user,  load average: ${load}`, `Tasks: ${procs.length + 92} total,   ${procs.filter((p) => p.cpu > 50).length + 1} running`, `%Cpu(s): ${procs.reduce((a, p) => a + p.cpu, 0) > 90 ? "99.1 us,  0.6 sy" : " 3.2 us,  0.9 sy"},  0.0 ni`, "", table([["PID", "USER", "%CPU", "%MEM", "COMMAND"], ...procs.map((p) => [p.pid, p.user, p.cpu.toFixed(1), p.mem.toFixed(1), p.cmd])], 2), "", "(snapshot: press q in a real terminal to quit)"].join("\n");
  };
  C.pgrep = (ctx) => { const { flags, pos } = parseArgs(ctx.args); const hits = ctx.state.procs.filter((p) => (flags.f ? p.cmd : p.cmd.split(" ")[0]).includes(pos[0])); return hits.length ? hits.map((p) => (flags.a || flags.l ? `${p.pid} ${p.cmd}` : p.pid)).join("\n") : { out: "", code: 1 }; };
  function killProc(ctx, p, sig) {
    const s = ctx.state;
    if (p.user !== s.user && !isRoot(ctx)) return `bash: kill: (${p.pid}) - Operation not permitted`;
    if ((sig === "15" || sig === "TERM") && p.ignoreTerm) { p.termAttempts = (p.termAttempts || 0) + 1; return ""; }
    s.procs = s.procs.filter((x) => x !== p);
    if (p.svc && s.services[p.svc]) { s.services[p.svc].active = false; s.services[p.svc].failed = true; (s.journal[p.svc] = s.journal[p.svc] || []).push(`systemd[1]: ${p.svc}.service: Main process exited, code=killed, status=${sig === "9" || sig === "KILL" ? "9/KILL" : "15/TERM"}`); }
    if (p.onKill) p.onKill(s);
    return "";
  }
  C.kill = (ctx) => {
    let sig = "15"; const pids = [];
    for (const a of ctx.args) { if (/^-(\d+|[A-Z]+|SIG[A-Z]+)$/.test(a)) sig = a.slice(1).replace("SIG", ""); else if (a === "-s") continue; else pids.push(a); }
    if (!pids.length) return { out: "kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]", code: 2 };
    const out = [];
    for (const id of pids) { const p = ctx.state.procs.find((x) => String(x.pid) === id); if (!p) { out.push(`bash: kill: (${id}) - No such process`); continue; } const r = killProc(ctx, p, sig); if (r) out.push(r); }
    return { out: out.join("\n"), code: out.length ? 1 : 0 };
  };
  C.pkill = (ctx) => { const { flags, pos } = parseArgs(ctx.args); const sig = flags["9"] ? "9" : "15"; const hits = ctx.state.procs.filter((p) => (flags.f ? p.cmd : p.cmd.split(" ")[0]).includes(pos[0])); hits.forEach((p) => killProc(ctx, p, sig)); return { out: "", code: hits.length ? 0 : 1 }; };

  // ------------------------------------------------------------------ services and logs
  C.systemctl = (ctx) => {
    const s = ctx.state; const { pos, flags } = parseArgs(ctx.args);
    const [verb, unitRaw] = pos; const unit = (unitRaw || "").replace(/\.service$/, "");
    if (verb === "list-units" || verb === undefined) {
      const rows = Object.entries(s.services).filter(([, v]) => !flags.failed || v.failed).map(([n, v]) => [`${n}.service`, "loaded", v.active ? "active" : v.failed ? "failed" : "inactive", v.active ? "running" : v.failed ? "failed" : "dead", v.desc]);
      return table([["UNIT", "LOAD", "ACTIVE", "SUB", "DESCRIPTION"], ...rows], 2);
    }
    if (verb === "list-timers") {
      const rows = Object.entries(s.services).filter(([n]) => n.endsWith(".timer")).map(([n, v]) => [v.active ? v.next || "Fri 2026-11-27 00:00:00 UTC" : "-", v.active ? v.left || "13h left" : "-", v.last || "-", v.active ? "-" : "-", n, (v.activates || n.replace(".timer", ".service"))]);
      return rows.length ? table([["NEXT", "LEFT", "LAST", "PASSED", "UNIT", "ACTIVATES"], ...rows], 2) + `\n\n${rows.length} timers listed.` : "0 timers listed.";
    }
    if (verb === "daemon-reload") return isRoot(ctx) ? "" : { out: "Failed to reload daemon: Access denied", code: 1 };
    const svc = s.services[unit];
    if (!svc) return { out: `Unit ${unitRaw || "?"}.service could not be found.`, code: 4 };
    const needRoot = ["start", "stop", "restart", "reload", "enable", "disable"];
    if (needRoot.includes(verb) && !isRoot(ctx)) return { out: `Failed to ${verb} ${unit}.service: Access denied\nSee system logs and 'systemctl status ${unit}.service' for details.`, code: 1 };
    if (verb === "status") {
      const st = svc.active ? "\x1bgactive (running)\x1b0" : svc.failed ? "\x1brfailed\x1b0 (Result: exit-code)" : "inactive (dead)";
      const proc = s.procs.find((p) => p.svc === unit);
      return [`● ${unit}.service - ${svc.desc}`, `     Loaded: loaded (/usr/lib/systemd/system/${unit}.service; ${svc.enabled ? "enabled" : "disabled"}; preset: enabled)`, `     Active: ${st} since Thu 2026-11-26 09:02:11 UTC`, proc ? `   Main PID: ${proc.pid} (${proc.cmd.split(" ")[0].split("/").pop()})` : "", "", ...(s.journal[unit] || []).slice(-6).map((l) => `Nov 26 10:2${Math.min(9, s.tick % 10)}:0${s.tick % 10} ${s.host} ${l}`)].filter((x, i) => x !== "" || i > 3).join("\n");
    }
    if (verb === "is-active") return { out: svc.active ? "active" : svc.failed ? "failed" : "inactive", code: svc.active ? 0 : 3 };
    if (verb === "is-enabled") return { out: svc.enabled ? "enabled" : "disabled", code: svc.enabled ? 0 : 1 };
    if (verb === "enable" || verb === "disable") {
      svc.enabled = verb === "enable";
      if (flags.now) { if (verb === "disable") OD.stopService(s, unit); else if (!svc.active) { const r = OD.startService(s, unit); if (!r.ok) return { out: `Job for ${unit}.service failed because the control process exited with error code.\nSee "systemctl status ${unit}.service" and "journalctl -xeu ${unit}.service" for details.`, code: 1 }; } }
      return verb === "enable" ? `Created symlink /etc/systemd/system/multi-user.target.wants/${unit}.service → /usr/lib/systemd/system/${unit}.service.` : `Removed "/etc/systemd/system/multi-user.target.wants/${unit}.service".`; }
    if (verb === "stop") { OD.stopService(s, unit); return ""; }
    if (verb === "start" || verb === "restart" || verb === "reload") {
      if (verb === "reload" && !svc.active) return { out: `${unit}.service is not active, cannot reload.`, code: 1 };
      if (verb !== "start") OD.stopService(s, unit);
      const r = OD.startService(s, unit);
      if (!r.ok) return { out: `Job for ${unit}.service failed because the control process exited with error code.\nSee "systemctl status ${unit}.service" and "journalctl -xeu ${unit}.service" for details.`, code: 1 };
      return "";
    }
    return { out: `Unknown command verb '${verb}'.`, code: 1 };
  };
  C.service = (ctx) => C.systemctl({ ...ctx, args: [ctx.args[1], ctx.args[0]] });
  C.journalctl = (ctx) => {
    const { flags } = parseArgs(ctx.args, ["u", "n"]); const s = ctx.state;
    const units = flags.u ? [flags.u.replace(/\.service$/, "")] : Object.keys(s.journal);
    let lines = units.flatMap((u) => (s.journal[u] || []).map((l) => `Nov 26 10:${String(10 + (s.tick % 40)).padStart(2, "0")}:12 ${s.host} ${l}`));
    if (flags.n) lines = lines.slice(-+flags.n); else if (flags.e || flags.x) lines = lines.slice(-20);
    return lines.length ? lines.join("\n") : "-- No entries --";
  };

  // ------------------------------------------------------------------ networking
  C.ss = C.netstat = (ctx) => {
    const s = ctx.state, rows = [["State", "Recv-Q", "Send-Q", "Local Address:Port", "Peer Address:Port", "Process"], ["LISTEN", "0", "128", "0.0.0.0:22", "0.0.0.0:*", 'users:(("sshd",pid=412,fd=3))']];
    for (const [n, v] of Object.entries(s.services)) if (v.active && v.port) rows.push(["LISTEN", "0", "511", `${v.bind || "0.0.0.0"}:${v.port}`, "0.0.0.0:*", `users:(("${n}",pid=${(s.procs.find((p) => p.svc === n) || {}).pid || 0},fd=6))`]);
    if (s.docker) for (const c of s.docker.containers) if (c.status === "running") for (const p of c.ports || []) rows.push(["LISTEN", "0", "4096", `0.0.0.0:${p.host}`, "0.0.0.0:*", 'users:(("docker-proxy",pid=2210,fd=4))']);
    return table(rows, 2);
  };
  C.lsof = (ctx) => {
    const s = ctx.state, rows = [["COMMAND", "PID", "USER", "FD", "TYPE", "SIZE/OFF", "NAME"]];
    for (const d of s.openDeleted) { const p = s.procs.find((x) => x.svc === d.svc) || {}; rows.push([(p.cmd || d.svc).split(" ")[0].split("/").pop().slice(0, 9), p.pid || "?", p.user || "root", "3w", "REG", d.size, `${d.path} (deleted)`]); }
    for (const [n, v] of Object.entries(s.services)) if (v.active) for (const h of OD.holdsOf(s, v)) if (s.fs.isFile(h)) { const p = s.procs.find((x) => x.svc === n) || {}; rows.push([(p.cmd || n).split(" ")[0].split("/").pop().slice(0, 9), p.pid || "?", p.user || "root", "3w", "REG", s.fs.size(h), h]); }
    return table(rows, 2);
  };
  C.ping = (ctx) => { const h = ctx.args.filter((a) => !a.startsWith("-") && !/^\d+$/.test(a))[0]; return h ? `PING ${h}: 56 data bytes\n64 bytes from ${h}: icmp_seq=1 ttl=64 time=0.4 ms\n\n--- ${h} ping statistics ---\n1 packets transmitted, 1 received, 0% packet loss` : { out: "ping: usage error: Destination address required", code: 1 }; };
  C.curl = (ctx) => {
    const { flags, pos } = parseArgs(ctx.args, ["o", "w", "X", "H", "d", "m", "max-time"]);
    const url = pos[0]; if (!url) return { out: "curl: try 'curl --help' for more information", code: 2 };
    const r = OD.http(ctx.state, url);
    if (r.error) return { out: flags.s && !flags.S ? (flags.w ? flags.w.replace("%{http_code}", "000") : "") : r.msg, code: r.error };
    const head = `HTTP/1.1 ${r.status} ${r.reason || ({ 200: "OK", 301: "Moved Permanently", 404: "Not Found", 500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable" }[r.status] || "")}\n${Object.entries(r.headers || { "Content-Type": "text/html" }).map(([k, v]) => `${k}: ${v}`).join("\n")}`;
    if (flags.w) return (flags.o === "/dev/null" ? "" : r.body + "\n") + flags.w.replace("%{http_code}", r.status).replace(/\\n/g, "\n");
    if (flags.I) return head;
    if (flags.i || flags.v) return head + "\n\n" + r.body;
    return r.body;
  };

  // tickets describe what host-local web services answer with state.web(url)
  OD.resolvers.push((s, url) => (s.web ? s.web(url, s) : null));

  // ------------------------------------------------------------------ scripts, cron, misc
  C.__script = (ctx) => {
    const s = ctx.state, file = ctx.args[0]; if (!file) return { out: "", code: 0 };
    const p = P(ctx, file), f = s.fs.get(p);
    if (!f) return { out: `bash: ${file}: No such file or directory`, code: 127 };
    if (ctx.direct && !(+f.mode[0] & 1)) return { out: `bash: ${file}: Permission denied`, code: 126 };
    const handler = s.scripts[p];
    const r = handler ? handler(s, ctx) : "";
    return typeof r === "object" && r ? r : { out: r || "", code: 0 };
  };
  C.crontab = (ctx) => { const { flags } = parseArgs(ctx.args); const c = ctx.state.fs.get("/var/spool/cron/crontabs/ops"); if (flags.l) return c ? c.content.trim() : "no crontab for ops"; if (flags.e) return EDITABLE({ ...ctx, root: true, name: "crontab" }, "/var/spool/cron/crontabs/ops"); return "usage: crontab [-l | -e]"; };
  // ------------------------------------------------------------------ packages (apt), only where a ticket sets s.apt
  // s.apt = { updated, pkgs: { name: { installed, available, held, svc, desc } } }
  const aptPkg = (s, n) => s.apt && Object.prototype.hasOwnProperty.call(s.apt.pkgs, n) ? s.apt.pkgs[n] : null;
  const candidate = (s, p) => (s.apt.updated ? p.available || p.installed : p.installed);
  const upgradable = (s) => Object.entries(s.apt.pkgs).filter(([, p]) => candidate(s, p) !== p.installed);
  function aptUpgrade(s, names) {
    const out = [], restart = [];
    for (const n of names) { const p = s.apt.pkgs[n]; out.push(`Unpacking ${n} (${candidate(s, p)}) over (${p.installed}) ...`, `Setting up ${n} (${candidate(s, p)}) ...`); p.installed = candidate(s, p); p.upgradedTick = OD.stamp(s); if (p.svc && s.services[p.svc] && s.services[p.svc].active) restart.push(p.svc); }
    if (restart.length) out.push("", "Restarting services...", "", "Service restarts being deferred:", ...restart.map((x) => ` systemctl restart ${x}.service`), "", "No containers need to be restarted.", "", "No user sessions are running outdated binaries.");
    return out.join("\n");
  }
  C.apt = C["apt-get"] = (ctx) => {
    const s = ctx.state; if (!s.apt) return { out: "This box is managed by its image pipeline: there are no package tasks here.", code: 1 };
    const { flags, pos } = parseArgs(ctx.args); const [verb, ...names] = pos;
    const needRoot = () => (isRoot(ctx) ? null : { out: "E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)\nE: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), are you root?", code: 100 });
    if (verb === "update") { const d = needRoot(); if (d) return d; s.apt.updated = true; const n = upgradable(s).length; return ["Hit:1 http://eu-west-2.ec2.archive.ubuntu.com/ubuntu noble InRelease", "Get:2 http://eu-west-2.ec2.archive.ubuntu.com/ubuntu noble-updates InRelease [126 kB]", "Get:3 http://security.ubuntu.com/ubuntu noble-security InRelease [126 kB]", "Fetched 252 kB in 1s (311 kB/s)", "Reading package lists... Done", "Building dependency tree... Done", n ? `${n} package${n === 1 ? " can" : "s can"} be upgraded. Run 'apt list --upgradable' to see ${n === 1 ? "it" : "them"}.` : "All packages are up to date."].join("\n"); }
    if (verb === "list") { const rows = flags.upgradable ? upgradable(s) : flags.installed ? Object.entries(s.apt.pkgs) : []; return ["Listing... Done", ...rows.map(([n, p]) => `${n}/noble-updates,noble-security ${flags.upgradable ? candidate(s, p) : p.installed} amd64 [${flags.upgradable ? `upgradable from: ${p.installed}` : "installed"}]`)].join("\n"); }
    if (verb === "upgrade" || verb === "full-upgrade" || verb === "dist-upgrade") {
      const d = needRoot(); if (d) return d;
      const up = upgradable(s), kept = up.filter(([, p]) => p.held).map(([n]) => n), go = up.filter(([, p]) => !p.held).map(([n]) => n);
      const plan = ["Reading package lists... Done", "Building dependency tree... Done", "Calculating upgrade... Done", ...(kept.length ? ["The following packages have been kept back:", "  " + kept.join(" ")] : []), ...(go.length ? ["The following packages will be upgraded:", "  " + go.join(" ")] : []), `${go.length} upgraded, 0 newly installed, 0 to remove and ${kept.length} not upgraded.`];
      if (!go.length) return plan.join("\n");
      if (!flags.y && !flags.yes) return plan.concat("Do you want to continue? [Y/n] (re-run with -y to confirm)").join("\n");
      return plan.join("\n") + "\n" + aptUpgrade(s, go);
    }
    if (verb === "install") {
      const d = needRoot(); if (d) return d;
      for (const n of names) if (!aptPkg(s, n)) return { out: `Reading package lists... Done\nE: Unable to locate package ${n}`, code: 100 };
      const go = names.filter((n) => candidate(s, s.apt.pkgs[n]) !== s.apt.pkgs[n].installed), held = go.filter((n) => s.apt.pkgs[n].held);
      if (!go.length) return names.map((n) => `${n} is already the newest version (${s.apt.pkgs[n].installed}).`).join("\n") + "\n0 upgraded, 0 newly installed, 0 to remove.";
      if (held.length && !flags["allow-change-held-packages"]) { const msg = ["Reading package lists... Done", "The following held packages will be changed:", "  " + held.join(" "), "The following packages will be upgraded:", "  " + go.join(" ")]; return flags.y || flags.yes ? { out: msg.concat("E: Held packages were changed and -y was used without --allow-change-held-packages.").join("\n"), code: 100 } : msg.concat("Do you want to continue? [Y/n] (re-run with -y to confirm)").join("\n"); }
      if (!flags.y && !flags.yes) return ["The following packages will be upgraded:", "  " + go.join(" "), "Do you want to continue? [Y/n] (re-run with -y to confirm)"].join("\n");
      return aptUpgrade(s, go);
    }
    return { out: "Usage here: apt update | apt list --upgradable | apt upgrade [-y] | apt install [-y] PKG", code: 1 };
  };
  C["apt-mark"] = (ctx) => {
    const s = ctx.state; if (!s.apt) return { out: "apt-mark: no packages are managed on this box", code: 1 };
    const [verb, ...names] = ctx.args;
    if (verb === "showhold") return Object.entries(s.apt.pkgs).filter(([, p]) => p.held).map(([n]) => n).join("\n");
    if (verb === "hold" || verb === "unhold") { if (!isRoot(ctx)) return { out: "E: Could not create temporary file for /var/lib/dpkg/status - mkstemp (13: Permission denied)", code: 100 }; return names.map((n) => { const p = aptPkg(s, n); if (!p) return `E: Unable to locate package ${n}`; const was = p.held; p.held = verb === "hold"; return verb === "hold" ? (was ? `${n} was already set on hold.` : `${n} set on hold.`) : (was ? `Canceled hold on ${n}.` : `${n} was already not on hold.`); }).join("\n"); }
    return { out: "Usage: apt-mark hold|unhold|showhold PKG", code: 1 };
  };
  C["apt-cache"] = (ctx) => { const s = ctx.state, [verb, n] = ctx.args, p = s.apt && aptPkg(s, n); if (verb !== "policy" || !p) return { out: p ? "Usage here: apt-cache policy PKG" : `N: Unable to locate package ${n}`, code: 1 }; return `${n}:\n  Installed: ${p.installed}\n  Candidate: ${candidate(s, p)}\n  Version table:${s.apt.updated && p.available !== p.installed ? `\n     ${p.available} 500\n        500 http://security.ubuntu.com/ubuntu noble-security/main amd64 Packages` : ""}\n *** ${p.installed} 100\n        100 /var/lib/dpkg/status`; };
  C.dpkg = (ctx) => { const s = ctx.state, n = ctx.args.find((a) => !a.startsWith("-")), p = s.apt && aptPkg(s, n); if (!p) return { out: `dpkg-query: no packages found matching ${n || ""}`, code: 1 }; return `Desired=Unknown/Install/Remove/Purge/Hold\n||/ Name            Version                 Architecture Description\n+++-===============-=======================-============-==================================\n${p.held ? "hi" : "ii"}  ${n.padEnd(15)} ${p.installed.padEnd(23)} amd64        ${p.desc || n}`; };
  C.needrestart = (ctx) => { const s = ctx.state; if (!s.apt) return "No services need to be restarted."; const stale = Object.values(s.apt.pkgs).filter((p) => p.svc && s.services[p.svc] && s.services[p.svc].active && p.upgradedTick !== undefined && (s.services[p.svc].startedTick ?? -1) < p.upgradedTick).map((p) => p.svc); return stale.length ? ["Scanning processes...", "Scanning linux images...", "", "Services to be restarted (they are running an outdated binary):", ...stale.map((x) => ` systemctl restart ${x}.service`)].join("\n") : "Scanning processes...\n\nNo services need to be restarted."; };

  // ------------------------------------------------------------------ TLS certificates, only where a ticket sets s.certs
  const certAt = (ctx, f) => ctx.state.certs && ctx.state.certs[ctx.state.fs.norm(ctx.state.cwd, f)];
  const certLines = (c) => ({ subject: `subject=${c.subject}`, issuer: `issuer=${c.issuer}`, startdate: `notBefore=${c.notBefore}`, enddate: `notAfter=${c.notAfter}`, serial: `serial=${c.serial}` });
  C.openssl = (ctx) => {
    // openssl uses single-dash long options (-noout, -dates, -in FILE)
    const [sub, ...rest] = ctx.args, flags = {};
    for (let i = 0; i < rest.length; i++) { const a = rest[i]; if (!a.startsWith("-")) continue; const k = a.replace(/^-+/, ""); flags[k] = ["in", "connect", "servername"].includes(k) ? rest[++i] : true; }
    if (sub === "x509") {
      const c = flags.in && certAt(ctx, flags.in); if (!flags.in) return { out: "Tip: openssl x509 -in FILE -noout -dates", code: 1 }; if (!c) return { out: `Could not open file or uri for loading certificate from ${flags.in}`, code: 1 };
      const L = certLines(c), want = ["subject", "issuer", "dates", "enddate", "startdate", "serial"].filter((k) => flags[k]);
      if (flags.text || !want.length) return [`Certificate:`, `    Data:`, `        Serial Number: ${c.serial}`, `        Issuer: ${c.issuer}`, `        Validity`, `            Not Before: ${c.notBefore}`, `            Not After : ${c.notAfter}`, `        Subject: ${c.subject}`, `        X509v3 Subject Alternative Name:`, `            ${c.san.map((d) => "DNS:" + d).join(", ")}`].join("\n");
      return want.flatMap((k) => (k === "dates" ? [L.startdate, L.enddate] : [L[k]])).join("\n");
    }
    if (sub === "s_client") {
      const c = ctx.state.tlsServing && ctx.state.tlsServing(); if (!c) return { out: `connect:errno=111\n${(flags.connect || "")}: Connection refused`, code: 1 };
      return [`CONNECTED(00000003)`, `depth=0 ${c.subject}`, c.expired ? "verify error:num=10:certificate has expired" : "verify return:1", `notAfter=${c.notAfter}`, "---", `Server certificate`, `subject=${c.subject}`, `issuer=${c.issuer}`, "---", `Verify return code: ${c.expired ? "10 (certificate has expired)" : "0 (ok)"}`].join("\n");
    }
    return { out: "Supported here: openssl x509 -in FILE -noout -dates|-subject|-text, openssl s_client -connect HOST:443", code: 1 };
  };
  C.certbot = (ctx) => {
    const s = ctx.state; if (!s.letsencrypt) return { out: "certbot: command not found", code: 127 };
    if (!isRoot(ctx)) return { out: "The following error was encountered:\n[Errno 13] Permission denied: '/var/log/letsencrypt/.certbot.lock'\nEither run as root, or set --config-dir, --work-dir, and --logs-dir to writeable paths.", code: 1 };
    const { flags, pos } = parseArgs(ctx.args);
    const list = Object.entries(s.letsencrypt);
    if (pos[0] === "certificates") return ["Found the following certs:", ...list.flatMap(([n, l]) => { const c = s.certs[l.cert]; return [`  Certificate Name: ${n}`, `    Domains: ${c.san.join(" ")}`, `    Expiry Date: ${c.notAfterIso} (${c.expired ? "INVALID: EXPIRED" : "VALID: 89 days"})`, `    Certificate Path: ${l.cert}`, `    Private Key Path: ${l.key}`]; })].join("\n");
    if (pos[0] === "renew") {
      const out = ["Saving debug log to /var/log/letsencrypt/letsencrypt.log", ""];
      for (const [n, l] of list) {
        out.push(`Processing /etc/letsencrypt/renewal/${n}.conf`);
        const c = s.certs[l.cert];
        if (!c.expired && !flags["force-renewal"]) { out.push(`Certificate not yet due for renewal`); continue; }
        if (!s.services.nginx || !s.services.nginx.active) { out.push("Renewing an existing certificate for " + c.san.join(" and "), "Certbot failed to authenticate some domains (authenticator: webroot).", `  Domain: ${c.san[0]}`, "  Type:   connection", "  Detail: Fetching http://" + c.san[0] + "/.well-known/acme-challenge/…: Connection refused"); return { out: out.join("\n"), code: 1 }; }
        if (flags["dry-run"]) { out.push(`Simulating renewal of an existing certificate for ${c.san.join(" and ")}`, "", "Congratulations, all simulated renewals succeeded:", `  ${l.cert} (success)`); continue; }
        Object.assign(c, l.renewed, { expired: false });
        out.push(`Renewing an existing certificate for ${c.san.join(" and ")}`, "", "Congratulations, all renewals succeeded:", `  ${l.cert} (success)`);
      }
      return out.join("\n");
    }
    return { out: "Supported here: certbot certificates, certbot renew [--dry-run]", code: 1 };
  };

  // ------------------------------------------------------------------ a little of the AWS CLI, only where a ticket sets s.aws
  C.aws = (ctx) => {
    const s = ctx.state; if (!s.aws) return { out: "Unable to locate credentials. You can configure credentials by running \"aws configure\".", code: 253 };
    const { flags, pos } = parseArgs(ctx.args, ["secret-id", "query", "output", "region"]);
    if (pos[0] === "sts" && pos[1] === "get-caller-identity") return JSON.stringify({ UserId: "AROAEXAMPLEOPSROLE:ops", Account: s.aws.account, Arn: `arn:aws:sts::${s.aws.account}:assumed-role/OpsOnCall/ops` }, null, 4);
    if (pos[0] === "secretsmanager" && pos[1] === "list-secrets") return JSON.stringify({ SecretList: Object.keys(s.aws.secrets).map((n) => ({ Name: n, ARN: `arn:aws:secretsmanager:eu-west-2:${s.aws.account}:secret:${n}-AbCdEf` })) }, null, 4);
    if (pos[0] === "secretsmanager" && pos[1] === "get-secret-value") {
      const id = flags["secret-id"], v = id && Object.prototype.hasOwnProperty.call(s.aws.secrets, id) ? s.aws.secrets[id] : undefined;
      if (v === undefined) return { out: `An error occurred (ResourceNotFoundException) when calling the GetSecretValue operation: Secrets Manager can't find the specified secret.`, code: 254 };
      if (flags.query === "SecretString") return flags.output === "text" ? v : JSON.stringify(v);
      return JSON.stringify({ ARN: `arn:aws:secretsmanager:eu-west-2:${s.aws.account}:secret:${id}-AbCdEf`, Name: id, VersionId: "6c1f8e2a-2b0d-4a51-9f3c-0d1e2f3a4b5c", SecretString: v, VersionStages: ["AWSCURRENT"], CreatedDate: "2026-11-19T14:02:11+00:00" }, null, 4);
    }
    return { out: "Supported here: aws sts get-caller-identity, aws secretsmanager list-secrets, aws secretsmanager get-secret-value --secret-id ID [--query SecretString --output text]", code: 252 };
  };

  C.clear = () => ({ out: "\x1bclear" });
  C.exit = C.logout = () => "There's nowhere to go. You're on shift! 😄";
  C.true = () => ""; C.false = () => ({ out: "", code: 1 });
})();
