// Two "devices" (separate browser contexts) sync progress both ways through a sync link.
const { chromium } = require("playwright");
const URL = process.env.OD_URL || "http://localhost:8765/";
(async () => {
  const b = await chromium.launch(); let fail = 0;
  const device = async () => { const c = await b.newContext(); const p = await c.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message)); await p.goto(URL); await p.click("#start button"); return { p, errs }; };
  const solve = (p, ids) => p.evaluate((ids) => ids.forEach((id) => { OD.game.progress().done[id] = { xp: 100, at: 1 }; }), ids);
  const done = (p) => p.evaluate(() => Object.keys(OD.game.progress().done).sort().join(","));
  const laptop = await device(), phone = await device();
  await solve(laptop.p, ["PW-101", "PW-102", "PW-103"]); await solve(phone.p, ["PW-104"]);
  await laptop.p.evaluate(() => OD.game.render());
  await laptop.p.click("#sync");
  if (!(await laptop.p.locator(".qr svg").count())) { console.log("✗ no QR code"); fail++; }
  const link = await laptop.p.inputValue("#sl");
  if (process.env.SHOTS) await laptop.p.screenshot({ path: process.env.SHOTS + "/sync.png" });
  await phone.p.goto(link); await phone.p.waitForSelector(".toast");
  const toast = await phone.p.locator(".toast").innerText();
  const a = await done(phone.p);
  console.log(a === "PW-101,PW-102,PW-103,PW-104" ? "✓" : "✗", "phone after opening laptop link:", a, "|", toast); if (a !== "PW-101,PW-102,PW-103,PW-104") fail++;
  if (phone.p.url().includes("#sync")) { console.log("✗ hash not cleared"); fail++; }
  // reverse: paste the phone's code into the laptop
  const code = await phone.p.evaluate(() => OD.game.exportCode());
  await laptop.p.click("#sc"); await laptop.p.click("#sync"); await laptop.p.fill("#si", code); await laptop.p.click("#sld");
  const c = await done(laptop.p);
  console.log(c === a ? "✓" : "✗", "laptop after pasting phone code:", c); if (c !== a) fail++;
  // reload keeps it; garbage is rejected
  await laptop.p.reload(); if ((await done(laptop.p)) !== a) { console.log("✗ lost after reload"); fail++; }
  await laptop.p.click("#sync"); await laptop.p.fill("#si", "hello"); await laptop.p.click("#sld");
  console.log((await laptop.p.locator(".toast.bad").count()) ? "✓ bad code rejected" : (fail++, "✗ bad code accepted"));
  const errs = [...laptop.errs, ...phone.errs]; if (errs.length) { console.log("page errors", errs); fail++; }
  console.log("link length:", link.length);
  await b.close(); process.exit(fail ? 1 : 0);
})();
