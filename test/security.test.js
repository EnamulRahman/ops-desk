// Security checks: hostile input must never run script, sync links need consent and can't inject junk,
// the page refuses to run in a frame, and the Content-Security-Policy is in force with no violations.
const { chromium } = require("playwright");
const path = require("path");
const PAGE = "file://" + path.join(__dirname, "..", "index.html");
const enc = (o) => "OD1." + Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const XSS = '"><img src=x onerror=pwn()><svg onload=pwn()>';
(async () => {
  const b = await chromium.launch(); let fail = 0;
  const check = (ok, msg) => { console.log(ok ? "✓" : "✗", msg); if (!ok) fail++; };
  const fresh = async () => {
    const c = await b.newContext(), p = await c.newPage(), errs = [], csp = [];
    p.pwned = false; await p.exposeFunction("pwn", () => { p.pwned = true; });
    p.on("pageerror", (e) => errs.push(e.message));
    p.on("console", (m) => { if (m.type() === "error") (/Content Security Policy/i.test(m.text()) ? csp : errs).push(m.text()); });
    p.errs = errs; p.csp = csp; return p;
  };
  const progress = (p) => p.evaluate(() => JSON.parse(JSON.stringify(OD.game.progress())));

  // 1. a sync link only changes anything after you press Merge, and Cancel leaves progress untouched
  let p = await fresh();
  const link = PAGE + "#sync=" + enc({ n: "Friend", c: "PW-102", d: [["PW-101", 100, 1], ["PW-102", 100, 1]] });
  await p.goto(link); await p.waitForSelector("#sa-ok");
  check((await progress(p)).done["PW-101"] === undefined, "nothing merged before consent");
  check(!p.url().includes("#sync"), "sync data removed from the address bar");
  await p.click("#sa-no");
  check(Object.keys((await progress(p)).done).length === 0, "Cancel leaves progress untouched");
  await p.goto(link); await p.waitForSelector("#sa-ok"); await p.keyboard.press("Escape");
  check(Object.keys((await progress(p)).done).length === 0 && !(await p.locator("#sa-ok").count()), "Escape cancels too");
  await p.goto(link); await p.waitForSelector("#sa-ok"); await p.click("#sa-ok");
  check(Object.keys((await progress(p)).done).sort().join() === "PW-101,PW-102", "Merge adds the tickets");

  // 2. hostile sync data: unknown/prototype ids, bad types, huge XP, script in the name
  p = await fresh();
  await p.goto(PAGE + "#sync=" + enc({ n: XSS, c: "constructor", d: [["__proto__", 5, 0], ["constructor", 5, 0], ["toString", 5, 0], ["PW-101", 1e9, "x"], ["PW-102", -50, 0], ["PW-103", "100", 0], ["PW-104", null], "junk", ["PW-101", 3, 0]] }));
  await p.click("#sa-ok"); await p.waitForTimeout(200);
  const g = await progress(p);
  check(Object.keys(g.done).sort().join() === "PW-101,PW-102", "only real tickets with numeric XP are kept: " + Object.keys(g.done).join());
  check(g.done["PW-101"].xp <= 100 && g.done["PW-102"].xp === 0, "XP is clamped to the ticket's range");
  check(await p.evaluate(() => Object.getPrototypeOf(OD.game.progress().done) === Object.prototype && !("polluted" in {})), "no prototype pollution");
  check(g.current !== "constructor", "unknown current ticket ignored");
  check(g.name.length <= 24, "name length capped");
  check(!/NaN/.test(await p.locator(".xpn").innerText()), "XP display is a real number");

  // 3. corrupt or hostile saved progress in localStorage is cleaned on load
  await p.evaluate(() => localStorage.setItem("opsdesk.v1", JSON.stringify({ name: { x: 1 }, started: true, current: "__proto__", done: { __proto__: { xp: 1 }, constructor: { xp: 9 }, "PW-101": { xp: "lots" }, "PW-103": { xp: 40, at: 5 } } })));
  await p.reload(); await p.waitForSelector("#cmd");
  const s = await progress(p);
  check(Object.keys(s.done).sort().join() === "PW-101,PW-103" && s.done["PW-101"].xp === 100 && s.done["PW-103"].xp === 40 && s.name === "", "saved progress is validated on load");

  // 4. HTML in the name and in terminal input/output is shown as text, never run
  p = await fresh(); await p.goto(PAGE);
  await p.fill("#nm", XSS); await p.click("#start button"); await p.waitForSelector("#cmd");
  for (const c of [`echo '${XSS}'`, `echo '${XSS}' > /tmp/x.txt`, "cat /tmp/x.txt", `mkdir '<svg onload=pwn()>'`, "ls", `ls '${XSS}'`, `kubectl get pod '${XSS}'`, `docker logs '${XSS}'`]) { await p.fill("#cmd", c); await p.press("#cmd", "Enter"); }
  await p.fill("#cmd", "nano /tmp/x.txt"); await p.press("#cmd", "Enter"); await p.waitForSelector("#edt"); await p.click("#edc");
  await p.click("#sync"); await p.fill("#si", enc({ n: XSS, d: [["PW-101", 100, 0]] })); await p.click("#sld");
  await p.waitForTimeout(300);
  check(!p.pwned, "no injected script ran (name, terminal, editor, sync box)");

  // 5. the page refuses to run inside a frame
  p = await fresh();
  const parent = path.join(require("os").tmpdir(), "opsdesk-frame-test.html");
  require("fs").writeFileSync(parent, `<iframe src="${PAGE}" width="800" height="400"></iframe>`);
  await p.goto("file://" + parent);
  const fr = p.frameLocator("iframe");
  const framed = await fr.locator("body.framed a").waitFor({ timeout: 5000 }).then(() => true, () => false);
  check(framed && !(await fr.locator("#start, #cmd").count()), "refuses to run inside a frame");
  require("fs").unlinkSync(parent);

  // 6. the CSP is present, the app runs under it, and nothing violates it
  p = await fresh(); await p.goto(PAGE); await p.click("#start button"); await p.click("#binder"); await p.click("#bc");
  const policy = await p.getAttribute('meta[http-equiv="Content-Security-Policy"]', "content");
  check(/script-src 'self'/.test(policy) && !/unsafe/.test(policy), "strict CSP present");
  // inject an inline script and an inline event handler the way an XSS bug would: the CSP must block both
  const ran = await p.evaluate(() => new Promise((res) => {
    const s = document.createElement("script"); s.textContent = "window.__inline = 1"; document.head.appendChild(s);
    const d = document.createElement("div"); d.innerHTML = '<img src="data:," onload="window.__handler = 1">'; document.body.appendChild(d);
    setTimeout(() => res(!!(window.__inline || window.__handler)), 300);
  }));
  check(!ran, "CSP blocks injected inline scripts and event handlers");
  p.csp.length = 0; // those two violations were deliberate
  const w = await p.locator(".xpbar > div").evaluate((el) => el.style.width);
  check(/%$/.test(w), "XP bar still drawn under the CSP: " + w);
  const all = [p, ...b.contexts().flatMap((c) => c.pages())];
  const violations = [...new Set(all.flatMap((x) => x.csp || []))];
  check(!violations.length, "no CSP violations" + (violations.length ? ": " + violations.join(" | ") : ""));
  const errs = [...new Set(all.flatMap((x) => x.errs || []))];
  check(!errs.length, "no page errors" + (errs.length ? ": " + errs.join(" | ") : ""));

  await b.close(); process.exit(fail ? 1 : 0);
})();
