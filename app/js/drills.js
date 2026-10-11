// Driven Golf practice prescriptions. Every recommendation is built only from content/drill-library.md (read at run time):
// Why (my stat) · the drill and its time · numbered Setup · numbered How with its one cue · Score and goal · Make it harder.
// Loaded before app.js; uses app.js helpers at call time.

// ---------------------------------------------------------------- the library (parsed from the Markdown file)
// "Watch how": a short video per drill, chosen by hand. Real public links only, never invented. Empty = the slot stays hidden.
const DRILL_VIDEOS = {
  // "Lag Ladder": "https://…",
};
const LIB = { p: null };
function drillLib() {
  return LIB.p = LIB.p || fetch("../content/drill-library.md").then(r => { if (!r.ok) throw new Error("drill library missing"); return r.text(); }).then(parseLib);
}
// "1) Pick a hole … 2) Put tees …" → steps; plain sentences become one step each
const stepsOf = t => /(^|\s)1\)\s/.test(t) ? t.split(/(?:^|\s)\d+\)\s/).map(x => x.trim()).filter(Boolean) : t.split(/(?<=[.!?])\s+(?=[A-Z0-9])/).map(x => x.trim()).filter(Boolean);
const mdInline = s => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;
function parseLib(md) {
  const lib = { drills: {}, order: [], triggers: [], session: {} };
  md.split(/^### /m).slice(1).forEach(chunk => {
    const lines = chunk.split("\n"), m = lines[0].match(/^(.+?) \((.+), ([^,]+ min)\)\s*$/); if (!m) return;
    const d = { name: m[1].trim(), area: m[2].trim(), time: m[3].trim() };
    const t = d.time.match(/(\d+)(?:–(\d+))? min/); d.minLo = +t[1]; d.minHi = +(t[2] || t[1]);
    lines.slice(1).forEach(l => { const b = l.match(/^- \*\*(Setup|How|Cue|Score|Harder|Course check):\*\* (.+)$/); if (b) d[b[1]] = b[2].trim(); });
    if (!d.Setup || !d.How || !d.Score) return;
    d.setup = stepsOf(d.Setup).map(cap); d.how = stepsOf(d.How).map(cap);
    const g = d.Score.split(/\s*Goal:\s*/); d.scoring = g[0].trim(); d.goalText = (g[1] || "").trim();
    lib.drills[d.name] = d; lib.order.push(d.name);
  });
  const tri = md.split(/^## Triggers.*$/m)[1]?.split(/^## /m)[0] || "";
  tri.split("\n").filter(l => /^\|/.test(l) && !/^\|\s*-/.test(l)).slice(1).forEach(l => {
    const c = l.split("|").slice(1, -1).map(x => x.trim()); if (c.length < 3) return;
    lib.triggers.push({ weakness: c[0], trigger: c[1], drills: c[2].split(/,\s*/).map(x => x.replace(/\s*\(.*\)\s*$/, "").trim()).filter(x => lib.drills[x]) });
  });
  const ses = md.split(/^## Building a session.*$/m)[1]?.split(/^## /m)[0] || "";
  ses.split("\n").forEach(l => { const b = l.match(/^- \*\*(\d+) min:\*\* (.+)$/); if (b) lib.session[b[1]] = cap(b[2].trim()); });
  return lib;
}
const weaknessOf = (lib, drill) => lib.triggers.find(t => t.drills.includes(drill))?.weakness || drill;
// goals, read from the drill's own text: "Goal: 10 of 18 points", "complete the 5-ft ring", "within 3 of par"
function goalOf(d, harder, variant) {
  const txt = d.goalText + (harder ? " " + d.Harder : ""), par = txt.match(/within (\d+) of par/), ring = (harder && d.Harder.match(/complete the (\d+)-ft ring/)) || d.goalText.match(/complete the (\d+)-ft ring/);
  if (par) return { goal: +par[1], lowerBetter: true, text: d.goalText };
  if (ring) return { goal: +ring[1], max: 6, text: harder ? `complete the ${ring[1]}-ft ring` : d.goalText };
  const all = [...d.goalText.matchAll(/(\d+) of (\d+)/g)].map(x => ({ goal: +x[1], max: +x[2] }));
  const pick = d.name === "Up-and-Down Circuit" && variant === 6 ? all[1] : all[0];
  return { ...(pick || { goal: null }), all, text: d.goalText };
}

// ---------------------------------------------------------------- results: drill sessions, progression
// drillLog: [{id, drill, t, score, score2, max, goal, lowerBetter, passed, harder, variant, secs, reps:[{call, label, v, tag}]}]
const drillLog = () => Store.get("drillLog", []);
function saveDrill(e) { const all = drillLog(); all.push(e); Store.set("drillLog", all); }
// "Make it harder" unlocks after passing the goal in 2 sessions in a row (and stays unlocked)
function harderUnlocked(name) { return !!Store.get("drillUnlocked", {})[name]; }
function checkUnlock(name) {
  if (harderUnlocked(name)) return false;
  const last = drillLog().filter(e => e.drill === name).slice(-2);
  if (last.length === 2 && last.every(e => e.passed)) { const u = Store.get("drillUnlocked", {}); u[name] = Date.now(); Store.set("drillUnlocked", u); return true; }
  return false;
}
const scoreText = e => e.drill === "Bunker Line Drill" ? `${e.score}/10 on, ${e.score2}/5 up and down`
  : e.lowerBetter ? `${e.score >= 0 ? "+" : ""}${e.score} to par` : e.drill === "Clock Drill" ? (e.score ? `${e.score}-ft ring` : "no ring") : `${e.score}${e.max ? `/${e.max}` : ""}`;

// ---------------------------------------------------------------- what my rounds and practice say (for triggers and course checks)
const greenGeom = h => h._gg || (h._gg = { type: "Polygon", coordinates: [h.green.map(([a, b]) => [b, a])] });
// the facts of one played hole: green in regulation, scrambling, fairway, wedge and chip proximity, bunker shots, putts, plan
function holeFacts(course, r, n, plan) {
  const h = holeOf(course, n), rh = r.holes[n] || {}, sh = rh.shots || [], pin = pinOrCenter(h, rh.pin), F = { par: h.par };
  if (sh.length < 2 && rh.putts == null) return null;
  const onG = p => Geo.inRing(p, h.green), inBunker = p => polysOf(course, n, ["bunker"]).some(f => Geo.inside(p, f.geometry));
  const gi = sh.findIndex((x, i) => i > 0 && (x.onGreen || onG(x.p)));
  if (gi > 0) { F.gir = gi <= h.par - 2; if (!F.gir && rh.score != null) F.scramble = rh.score <= h.par; }
  if (h.par > 3 && sh[1]) {
    F.fw = inFairway(course, n, sh[1].p);
    if (!F.fw) { const line = centerLine(h), tg = Geo.pointAt(line, Geo.along(line, sh[1].p).m); F.teeMiss = Geo.miss(sh[0].p, tg, sh[1].p).cross > 0 ? "left" : "right"; }
  }
  F.wedge = []; F.chips = []; F.bunker = [];
  for (let i = 1; i < sh.length; i++) {
    const from = sh[i - 1].p, fin = sh[i].p, d = Geo.yd(from, pin); if (onG(from)) continue;
    const ft = i === sh.length - 1 && rh.firstPuttFt != null && onG(fin) ? rh.firstPuttFt : Math.round(Geo.m(fin, pin) * FT);
    const sand = inBunker(from), nearGreen = Geo.distToGeom(from, greenGeom(h)) * YD <= 30;
    if (sand && Geo.distToGeom(from, greenGeom(h)) * YD <= 40) { F.bunker.push({ stayed: inBunker(fin), ft: onG(fin) ? ft : null }); F.sandOpp = true; }
    else if (d >= 40 && d <= 110) F.wedge.push({ ft, along: Geo.miss(from, pin, fin).along });
    else if (nearGreen && d < 50 && onG(fin)) F.chips.push(ft);
  }
  if (F.sandOpp && rh.score != null) F.sandSave = rh.score <= h.par;
  const k = h.par - 2;                                       // the green-in-regulation stroke
  if (k >= 1 && sh[k] && !onG(sh[k].p) && gi !== k) { const m = Geo.miss(sh[k - 1].p, pin, sh[k].p);
    F.apMiss = Math.abs(m.along) > Math.abs(m.cross) ? (m.along > 0 ? "long" : "short") : (m.cross > 0 ? "left" : "right"); }
  if (rh.puttLog?.length && rh.putts != null) { F.putts = rh.puttLog; const p0 = rh.puttLog[0]; if (p0.ft >= 20) F.lagLeave = rh.puttLog[1]?.ft ?? 0; }
  if (rh.putts != null) F.three = rh.putts >= 3;
  if (plan) {                                                // plan vs actual: within 15 yd of target, approach misses to the danger side
    const ph = plan.holes[n] || {}, ks = planKeysFor(h.par); F.planNear = [];
    ks.forEach((key, i) => { const tg = ph[key]; if (!tg?.p) return;
      const idx = key === "approach" ? (gi > 0 ? gi : sh.length - 1) - 1 : i, shot = sh[idx], fin = sh[idx + 1]; if (!shot || !fin) return;
      F.planNear.push(Geo.yd(fin.p, tg.p) <= 15);
      if (key === "approach" && ph.danger) { const mm = Geo.miss(shot.p, pin, fin.p);
        F.dangerMiss = { short: mm.along < -3, long: mm.along > 3, left: mm.cross > 3, right: mm.cross < -3 }[ph.danger]; } });
  }
  return F;
}
async function roundFacts() {
  const rounds = Store.rounds().slice().sort((a, b) => a.date - b.date).filter(r => meta(r.course).name);
  await Promise.all([...new Set(rounds.map(r => r.course))].map(loadCourse));
  const plans = Store.plans();
  return rounds.map(r => { const c = A.courses[r.course], plan = r.planId ? plans.find(p => p.id === r.planId) : null;
    return { date: r.date, holes: c.holes.map(h => holeFacts(c, r, h.n, plan)).filter(Boolean) }; }).filter(x => x.holes.length);
}
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const fx = (holes, f) => holes.flatMap(f);
// course stats a drill's course check watches, over some holes
const CHECKS = {
  "Lag Ladder": { label: "average leave", unit: "ft", lowerBetter: true, v: hs => avg(fx(hs, h => h.lagLeave != null ? [h.lagLeave] : [])) },
  "Clock Drill": { label: "make rate from 3–6 ft", unit: "%", v: hs => { const b = puttStats(fx(hs, h => h.putts ? [h.putts] : [])).buckets[1]; return b.n ? 100 * b.made / b.n : null; } },
  "Start-Line Gate": { label: "make rate from 3–10 ft", unit: "%", v: hs => { const s = puttStats(fx(hs, h => h.putts ? [h.putts] : [])), n = s.buckets[1].n + s.buckets[2].n; return n ? 100 * (s.buckets[1].made + s.buckets[2].made) / n : null; } },
  "Landing Spot Towel": { label: "average chip finish", unit: "ft", lowerBetter: true, v: hs => avg(fx(hs, h => h.chips)) },
  "Up-and-Down Circuit": { label: "scrambling", unit: "%", v: hs => { const o = hs.filter(h => h.scramble != null); return o.length ? 100 * o.filter(h => h.scramble).length / o.length : null; } },
  "Bunker Line Drill": { label: "sand saves", unit: "%", v: hs => { const o = hs.filter(h => h.sandSave != null); return o.length ? 100 * o.filter(h => h.sandSave).length / o.length : null; } },
  "Wedge Ladder": { label: "average finish from 40–110 yd", unit: "ft", lowerBetter: true, v: hs => avg(fx(hs, h => h.wedge.map(w => w.ft))) },
  "Nine-Ball Target Game": { label: "greens in regulation", unit: "%", v: hs => { const o = hs.filter(h => h.gir != null); return o.length ? 100 * o.filter(h => h.gir).length / o.length : null; } },
  "Fairway Corridor": { label: "fairways hit", unit: "%", v: hs => { const o = hs.filter(h => h.fw != null); return o.length ? 100 * o.filter(h => h.fw).length / o.length : null; } },
  "Play the Course on the Range": { label: "shots within 15 yd of the plan's target", unit: "%", v: hs => { const o = fx(hs, h => h.planNear || []); return o.length ? 100 * o.filter(Boolean).length / o.length : null; } },
};
const fmtStat = (v, unit) => v == null ? "–" : unit === "%" ? `${Math.round(v)}%` : `${v.toFixed(1)} ${unit}`;

// ---------------------------------------------------------------- triggers → prescriptions (weakest first)
// each trigger from the library's table, measured on my last 10 rounds plus the practice pages. sev: how far past the line.
async function prescriptions() {
  const lib = await drillLib(), rf = (await roundFacts()).slice(-10), hs = rf.flatMap(r => r.holes), out = [];
  const add = (weakness, sev, why, stat, statLabel) => { const t = lib.triggers.find(x => x.weakness === weakness); if (!t || !t.drills.length || sev <= 0) return;
    out.push({ weakness, drill: t.drills[0], drills: t.drills, time: lib.drills[t.drills[0]].time, sev, why, stat, statLabel }); };
  // putting: rounds + the practice green
  const pseqs = [...fx(hs, h => h.putts ? [h.putts] : []), ...practicePutts().slice(0, 60).map(s => s.putts)];
  const leaves = pseqs.filter(s => s[0]?.ft >= 20).map(s => s[1]?.ft ?? (s[0].made ? 0 : null)).filter(x => x != null), lv = avg(leaves);
  const threes = hs.filter(h => h.three != null), tp = threes.length ? 100 * threes.filter(h => h.three).length / threes.length : null;
  if (leaves.length >= 5 && lv > 4) add("Lag putting", (lv - 4) / 4, `Your first putts from 20+ ft finish ${lv.toFixed(1)} ft away on average (${leaves.length} putts).`, `${lv.toFixed(1)} ft`, "average leave");
  else if (threes.length >= 9 && tp > 10) add("Lag putting", (tp - 10) / 10, `You three-putt ${Math.round(tp)}% of holes (${threes.filter(h => h.three).length} of ${threes.length}).`, `${Math.round(tp)}%`, "three-putts");
  const b36 = puttStats(pseqs).buckets[1], m36 = b36.n ? 100 * b36.made / b36.n : null;
  if (b36.n >= 8 && m36 < 80) add("Short putts", (80 - m36) / 40, `You make ${Math.round(m36)}% of your putts from 3–6 ft (${b36.made} of ${b36.n}).`, `${Math.round(m36)}%`, "made 3–6 ft");
  // chips: round chips from around the green plus the practice pages' chips
  const chips = [...fx(hs, h => h.chips), ...practiceLogs().slice(0, 40).map(e => e.ft)], ca = avg(chips);
  if (chips.length >= 10 && ca > 6) add("Chip distance control", (ca - 6) / 6, `Your chips finish ${ca.toFixed(1)} ft from the hole on average (${chips.length} chips).`, `${ca.toFixed(1)} ft`, "average chip");
  const sc = hs.filter(h => h.scramble != null), sp = sc.length ? 100 * sc.filter(h => h.scramble).length / sc.length : null;
  if (sc.length >= 5 && sp < 50) add("Overall short game / scrambling", (50 - sp) / 50, `You got up and down on ${sc.filter(h => h.scramble).length} of ${sc.length} missed greens (${Math.round(sp)}%).`, `${Math.round(sp)}%`, "scrambling");
  const bk = fx(hs, h => h.bunker), bad = bk.filter(b => b.stayed || (b.ft != null && b.ft > 15)).length;
  if (bk.length >= 3 && bad / bk.length >= 0.34) add("Bunker play", bad / bk.length, `${bad} of your ${bk.length} greenside bunker shots stayed in the sand or finished over 15 ft away.`, `${bad}/${bk.length}`, "bunker shots");
  const wg = fx(hs, h => h.wedge), wa = avg(wg.map(w => w.ft)), sh = wg.filter(w => w.along < -3).length, lo = wg.filter(w => w.along > 3).length;
  if (wg.length >= 5 && (wa > 20 || Math.max(sh, lo) / wg.length >= 0.7)) add("Wedge distances (40–110 yd)", wa > 20 ? (wa - 20) / 20 : 0.4,
    wa > 20 ? `Your wedges from 40–110 yd finish ${Math.round(wa)} ft from the pin on average (${wg.length} shots).` : `${Math.max(sh, lo)} of your ${wg.length} wedges from 40–110 yd finished ${sh > lo ? "short" : "long"}.`, `${Math.round(wa)} ft`, "wedge finish");
  const gr = hs.filter(h => h.gir != null), gp = gr.length ? 100 * gr.filter(h => h.gir).length / gr.length : null, am = fx(hs, h => h.apMiss ? [h.apMiss] : []);
  const amTop = ["left", "right", "short", "long"].map(s => [s, am.filter(x => x === s).length]).sort((a, b) => b[1] - a[1])[0];
  if (gr.length >= 9 && gp < 50) add("Approach accuracy", (50 - gp) / 50, `You hit ${Math.round(gp)}% of greens in regulation (${gr.filter(h => h.gir).length} of ${gr.length}).`, `${Math.round(gp)}%`, "greens hit");
  else if (am.length >= 6 && amTop[1] / am.length >= 0.65) add("Approach accuracy", 0.3, `${amTop[1]} of your ${am.length} missed approaches went ${amTop[0]}.`, `${amTop[1]}/${am.length}`, `misses ${amTop[0]}`);
  const fw = hs.filter(h => h.fw != null), fp = fw.length ? 100 * fw.filter(h => h.fw).length / fw.length : null, tm = fx(hs, h => h.teeMiss ? [h.teeMiss] : []);
  const tl = tm.filter(x => x === "left").length, tr = tm.length - tl;
  if (fw.length >= 7 && fp < 60) add("Tee shot accuracy", (60 - fp) / 60, `You hit ${Math.round(fp)}% of fairways (${fw.filter(h => h.fw).length} of ${fw.length}).`, `${Math.round(fp)}%`, "fairways");
  else if (tm.length >= 5 && Math.max(tl, tr) / tm.length >= 0.7) add("Tee shot accuracy", 0.3, `${Math.max(tl, tr)} of your ${tm.length} missed fairways went ${tl > tr ? "left" : "right"}.`, `${Math.max(tl, tr)}/${tm.length}`, `misses ${tl > tr ? "left" : "right"}`);
  const dm = hs.filter(h => h.dangerMiss != null), dn = dm.filter(h => h.dangerMiss).length;
  if (dm.length >= 5 && dn >= 3 && dn / dm.length >= 0.3) add("Course management", dn / dm.length, `${dn} of your ${dm.length} planned approaches missed to the danger side.`, `${dn}/${dm.length}`, "danger-side misses");
  return { lib, list: out.sort((a, b) => b.sev - a.sev), rounds: rf.length };
}

// ---------------------------------------------------------------- the focus card (Clubhouse, Practice): the top prescription
function focusCard(container) {
  const card = el(`<div class="card focus"><div class="muted it">Reading your rounds…</div></div>`); container.appendChild(card);
  prescriptions().then(({ list }) => {
    const rx = list[0];
    if (!rx) { card.innerHTML = `<div style="text-align:center;min-width:76px"><div class="bigstat">–</div></div><div style="border-left:1px solid var(--rule);padding-left:16px"><b>Play or practice to get a focus</b><small>Log a round (shots and putts) or a practice session, and your top thing to work on shows up here, with a drill.</small></div>`; card.style.cursor = "default"; return; }
    card.innerHTML = `<div style="text-align:center;min-width:76px"><div class="bigstat">${esc(rx.stat)}</div><div class="caps" style="font-size:9.5px;color:var(--claret);margin-top:4px">${esc(rx.statLabel)}</div></div>
      <div style="border-left:1px solid var(--rule);padding-left:16px"><b>${esc(rx.weakness)}</b><small>${esc(rx.drill)} · ${esc(rx.time)}. Tap for the drill.</small></div>`;
    card.onclick = () => prescriptionPage(rx.drill, rx);
  }).catch(() => { card.innerHTML = `<p>Couldn't load the drill library.</p>`; });
}

// ---------------------------------------------------------------- a prescription (six parts, in the library's order)
async function prescriptionPage(name, rx, back) {
  const lib = await drillLib(), d = lib.drills[name]; if (!d) return practicePage();
  if (!rx) rx = (await prescriptions()).list.find(x => x.drills.includes(name)) || null;
  const b = screen("Prescription", back || practicePage, "", { drill: name }, { tab: "practice" });
  const log = drillLog().filter(e => e.drill === name), unlocked = harderUnlocked(name), g = goalOf(d, false), last2 = log.slice(-2);
  const streak = log.length && log.at(-1).passed ? (last2.length === 2 && last2[0].passed ? 2 : 1) : 0;
  const sec = (no, label, html) => `<div class="rxs"><div class="rxh"><span class="rxn">${no}</span>${label}</div>${html}</div>`;
  const ol = items => `<ol class="rxol">${items.map(x => `<li>${mdInline(x)}</li>`).join("")}</ol>`;
  const card = el(`<div class="card rx">
    <div class="caps brass">Prescription · ${esc(weaknessOf(lib, name))}</div>
    ${sec(1, "Why", `<p class="rxwhy">${rx ? esc(rx.why) : "Not triggered by your numbers right now: you picked this drill."}</p>`)}
    ${sec(2, "The drill", `<div class="rxname">${esc(d.name)}</div><div class="muted">${esc(d.time)} · ${esc(d.area)}</div>`)}
    ${sec(3, "Setup", ol(d.setup))}
    ${sec(4, "How to do it", ol(d.how) + (d.Cue ? `<div class="carry">${mdInline(d.Cue)}</div>` : ""))}
    ${sec(5, "Score and goal", `<p>${mdInline(d.scoring)}</p><p><b>Goal:</b> ${mdInline(d.goalText)}</p>`)}
    ${sec(6, "Make it harder", unlocked ? `<div class="pill ok">Unlocked</div><p>${mdInline(d.Harder)}</p>`
      : `<p class="muted">Unlocks after you pass the goal in 2 sessions in a row${streak ? ` (${streak} of 2 so far)` : ""}.</p>`)}
    ${d["Course check"] ? `<div class="rxcheck"><span class="seclbl">Course check</span> ${mdInline(d["Course check"])}<div id="cc" class="it"></div></div>` : ""}
    ${DRILL_VIDEOS[name] ? `<a class="btn alt" href="${esc(DRILL_VIDEOS[name])}" target="_blank" rel="noopener">Watch how</a>` : ""}
    <div class="row"><button class="btn" id="go">Start drill</button>${unlocked ? '<button class="btn alt" id="goH">Start harder</button>' : ""}</div>
    ${log.length ? `<div><div class="seclbl">Your scores</div><div class="scores">${log.slice(-10).map(e => `<span class="sc${e.passed ? " ok" : ""}${e.harder ? " hard" : ""}" title="${new Date(e.t).toLocaleDateString()}">${esc(scoreText(e))}</span>`).join("")}</div></div>` : ""}
  </div>`);
  b.appendChild(card);
  $("#go", card).onclick = () => drillRun(name, { harder: false, back: () => prescriptionPage(name, rx, back) });
  if (unlocked) $("#goH", card).onclick = () => drillRun(name, { harder: true, back: () => prescriptionPage(name, rx, back) });
  if (log.length) courseCheck(name).then(t => { const x = $("#cc", card); if (x && t) x.textContent = t; });
}

// ---------------------------------------------------------------- course check: the drill's course stat, 3 rounds before vs after
async function courseCheck(name) {
  const lib = await drillLib(), d = lib.drills[name], ck = CHECKS[name], first = drillLog().find(e => e.drill === name);
  if (!first) return null;
  const w = weaknessOf(lib, name);
  if (!ck) return `${w}: rounds don't record lies yet, so there's no course stat to compare for the ${d.name}.`;
  const rf = await roundFacts(), before = rf.filter(r => r.date < first.t).slice(-3), after = rf.filter(r => r.date >= first.t).slice(0, 3);
  const vb = ck.v(before.flatMap(r => r.holes)), va = ck.v(after.flatMap(r => r.holes));
  if (vb == null && va == null) return `${w}: no ${ck.label} from your rounds yet. Log shots and putts in your next rounds to compare.`;
  if (va == null) return `${w}: ${ck.label} ${fmtStat(vb, ck.unit)} in the 3 rounds before you started the ${d.name}. Play a round to compare.`;
  if (vb == null) return `${w}: ${ck.label} ${fmtStat(va, ck.unit)} since you started the ${d.name} (no rounds with this stat before it).`;
  return `${w}: ${ck.label} ${fmtStat(vb, ck.unit)} → ${fmtStat(va, ck.unit)} since you started the ${d.name}${after.length < 3 ? ` (${after.length} of 3 rounds so far)` : ""}.`;
}

// ---------------------------------------------------------------- running a drill: steps, scoring buttons, a timer
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
// how each drill is scored, matching its "Score" line in the library
function drillPlan(d, harder, variant) {
  const g = goalOf(d, harder, variant), fixed = (calls, buttons) => ({ next: res => res.length < calls.length ? { call: calls[res.length], buttons, no: res.length + 1, of: calls.length } : null });
  const sum = res => res.reduce((a, r) => a + r.v, 0), base = { goal: g.goal, max: g.max, lowerBetter: !!g.lowerBetter };
  const YN = (yes, no = "Missed") => [[yes, 1], [no, 0]];
  switch (d.name) {
    case "Lag Ladder": return { ...base, ...fixed(Array.from({ length: 9 }, (_, i) => `${[20, 40, 30][i % 3]} ft`), [["Holed", 2], [`In the zone${harder ? " (2 ft)" : ""}`, 1], ["Outside", 0]]), score: sum };
    case "Clock Drill": {
      const rings = [3, 4, 5, 6], at = ["12", "3", "6", "9"];
      const state = res => { let i = 0, made = 0, best = 0;
        res.forEach(r => { if (r.v) { made++; if (made === 4) { best = rings[i]; i++; made = 0; } } else { i = harder ? 0 : Math.max(0, i - 1); made = 0; } });
        return { i, made, best }; };
      return { ...base, max: 6, next: res => { const s = state(res); return s.i >= rings.length ? null : { call: `${rings[s.i]}-ft ring · ${at[s.made]} o'clock (${s.made + 1} of 4)`, buttons: [["Made", 1], ["Missed", 0]], no: res.length + 1 }; },
        score: res => state(res).best, open: true };
    }
    case "Start-Line Gate": return { ...base, ...fixed(Array.from({ length: 10 }, (_, i) => `Putt ${i + 1} · ${harder ? "8" : "6"} ft`), YN("Through the gate and holed")), score: sum };
    case "Rough Chip Circuit": { const lies = ["Sitting up", "Sitting down", "Growing against you"];
      return { ...base, ...fixed(Array.from({ length: 9 }, (_, i) => `${lies[i % 3]} · pin ${((i + Math.floor(i / 3)) % 3) + 1}`), YN("Up and down", "Not")), score: sum }; }
    case "Landing Spot Towel": { const clubs = (d.How.match(/\(([^)]*°[^)]*)\)/)?.[1] || "58°, PW, 8-iron").split(/,\s*/);
      return { ...base, ...fixed(Array.from({ length: 15 }, (_, i) => clubs[i % clubs.length]), YN("On the towel")), score: sum }; }
    case "Up-and-Down Circuit": { const spots = (d.Setup.match(/all different: ([^.]+)\./)?.[1] || "").split(/,\s*|\s+and\s+/).map(s => s.replace(/^(a|an|one)\s+/, "")).filter(Boolean);
      const n = variant === 6 ? 6 : 9;
      return { ...base, ...fixed(shuffle(spots.slice(0, n)).map(s => s[0].toUpperCase() + s.slice(1)), [["Chip-in", 2], ["Up and down", 1], ["Not", 0]]), score: sum, max: n * 2 }; }
    case "Bunker Line Drill": {
      const calls = [...Array(10).fill("No ball: enter on the back line"), ...Array(10).fill("Ball on the front line"), ...Array(10).fill("Balls to a pin"), ...Array(5).fill("Up-and-down")];
      const btn = i => i < 20 ? [["Done", 0, "rep"]] : i < 30 ? [["On the green", 1, "green"], ["Not on", 0, "green"]] : [["Up and down", 1, "ud"], ["Not", 0, "ud"]];
      const cnt = (res, tag) => res.filter(r => r.tag === tag && r.v).length, [g1, g2] = g.all;
      return { ...base, goal: g1?.goal, max: 10, next: res => res.length < calls.length ? { call: calls[res.length], buttons: btn(res.length), no: res.length + 1, of: calls.length } : null,
        score: res => cnt(res, "green"), score2: res => cnt(res, "ud"), passed: res => cnt(res, "green") >= (g1?.goal ?? 8) && cnt(res, "ud") >= (g2?.goal ?? 2) };
    }
    case "Wedge Ladder": {
      let targets = (d.Setup.match(/at ([\d, and]+) yd/)?.[1] || "50, 60, 70, 80, 90 and 100").match(/\d+/g).map(Number);
      if (harder) targets = targets.concat((d.Harder.match(/add ([\d and]+) yd/)?.[1] || "").match(/\d+/g)?.map(Number) || []);
      const calls = []; while (calls.length < 12) { const t = targets[Math.floor(Math.random() * targets.length)]; if (t !== calls.at(-1)) calls.push(t); }
      const tol = harder ? +(d.Harder.match(/within (\d+) yd/)?.[1] || 3) : +(d.scoring.match(/within (\d+) yd/)?.[1] || 5);
      return { ...base, tol, ...fixed(calls.map(c => `${c} yd`), [[`Within ${tol} yd`, 1, "in"], ["Short", 0, "short"], ["Long", 0, "long"]]), score: sum, wedge: true };
    }
    case "Nine-Ball Target Game": return { ...base, ...fixed(Array.from({ length: 9 }, (_, i) => ["Short iron", "Mid iron", "Hybrid or long iron"][i % 3]), [["On the green", 1, "on"], ["Short", 0, "short"], ["Long", 0, "long"], ["Left", 0, "left"], ["Right", 0, "right"]]), score: sum, pattern: true };
    case "Fairway Corridor": { const tc = A.bag.filter(c => c.tee && c.carry > 0).sort((a, b) => b.carry - a.carry).slice(0, 2).map(c => c.name);
      const two = tc.length === 2 ? tc : ["Driver", "3 wood"];
      return { ...base, ...fixed(Array.from({ length: 10 }, (_, i) => two[i % 2]), [["In the corridor", 1, "in"], ["Missed left", 0, "left"], ["Missed right", 0, "right"]]), score: sum, pattern: true }; }
    case "Play the Course on the Range": {
      const plan = Store.plans().slice().sort((a, b) => b.created - a.created)[0], course = plan && A.courses[plan.course];
      const calls = Array.from({ length: harder ? 18 : 9 }, (_, i) => { const n = i + 1, ph = plan?.holes[n] || {}, par = course?.holes[i]?.par;
        const clubs = planKeysFor(par || 4).map(k => ph[k]?.club).filter(Boolean);
        return `Hole ${n}${clubs.length ? ` · ${clubs.join(" → ")}` : ""}`; });
      return { ...base, ...fixed(calls, [["Target hit · par", 0], ["Miss, safe side · bogey", 1], ["Miss, danger side · double", 2]]), score: sum, planName: plan?.name };
    }
  }
  return null;
}
async function drillRun(name, opts = {}) {
  const lib = await drillLib(), d = lib.drills[name];
  if (name === "Play the Course on the Range") { const pl = Store.plans().slice().sort((a, b) => b.created - a.created)[0]; if (pl) await loadCourse(pl.course); }
  let variant = opts.variant || (name === "Up-and-Down Circuit" ? 9 : null);
  const plan = drillPlan(d, !!opts.harder, variant), res = [];
  const b = screen(d.name, opts.back || practicePage, "", { drill: name }, { tab: "practice", tabs: false });
  const t0 = Date.now(); let paused = 0, pauseAt = null;
  const secs = () => Math.floor(((pauseAt || Date.now()) - t0 - paused) / 1000);
  const wrap = el(`<div class="drill">
    <div class="card drun"><div class="dtop"><div><div class="caps brass">${opts.harder ? "Harder version · " : ""}${esc(d.time)}</div><div class="timer" id="tm">0:00</div></div>
      <button class="btn small alt" id="pause">Pause</button></div>
      ${opts.session ? `<div class="muted">Session: drill ${opts.session.i + 1} of ${opts.session.list.length}</div>` : ""}
      ${name === "Up-and-Down Circuit" ? `<div class="seg" id="var"><button data-v="9" class="${variant === 9 ? "on" : ""}" style="flex:1">9 spots</button><button data-v="6" class="${variant === 6 ? "on" : ""}" style="flex:1">6 spots (30 min)</button></div>` : ""}
      <div id="now"></div><div class="tally" id="tally"></div>
      <div class="row"><button class="linkbtn" id="undo">Undo</button><span style="flex:1"></span><button class="linkbtn" id="end">End and save</button></div></div>
    <details class="card dsteps"${res.length ? "" : " open"}><summary class="seclbl">Steps</summary>
      <div class="seclbl">Setup</div><ol class="rxol">${d.setup.map(x => `<li>${mdInline(x)}</li>`).join("")}</ol>
      <div class="seclbl">How</div><ol class="rxol">${d.how.map(x => `<li>${mdInline(x)}</li>`).join("")}</ol>
      ${d.Cue ? `<div class="carry">${mdInline(d.Cue)}</div>` : ""}${opts.harder ? `<div class="warn">${mdInline(d.Harder)}</div>` : ""}</details></div>`);
  b.appendChild(wrap);
  const tick = setInterval(() => { const x = $("#tm", wrap); if (!x || !document.body.contains(x)) return clearInterval(tick);
    const s = secs(); x.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; x.classList.toggle("over", s > d.minHi * 60); }, 500);
  $("#pause", wrap).onclick = e => { if (pauseAt) { paused += Date.now() - pauseAt; pauseAt = null; e.target.textContent = "Pause"; } else { pauseAt = Date.now(); e.target.textContent = "Resume"; } };
  wrap.querySelectorAll("#var [data-v]").forEach(x => x.onclick = () => { if (res.length) return toast("Pick the size before the first spot."); drillRun(name, { ...opts, variant: +x.dataset.v }); });
  const total = () => plan.score(res);
  function draw() {
    const nx = plan.next(res), now = $("#now", wrap);
    const goalTxt = plan.lowerBetter ? `goal: within ${plan.goal} of par` : name === "Clock Drill" ? `goal: the ${plan.goal}-ft ring` : `goal ${plan.goal}${plan.max ? ` of ${plan.max}` : ""}`;
    const tl = name === "Bunker Line Drill" ? `${plan.score(res)}/10 on the green · ${plan.score2(res)}/5 up and down` : plan.lowerBetter ? `${total() >= 0 ? "+" : ""}${total()} to par` : name === "Clock Drill" ? (total() ? `${total()}-ft ring done` : "no ring done yet") : `${total()} so far`;
    $("#tally", wrap).innerHTML = `<b>${esc(tl)}</b> <span class="muted">· ${esc(goalTxt)}</span>${plan.pattern ? `<div class="muted">${["left", "right", "short", "long"].map(t => [t, res.filter(r => r.tag === t).length]).filter(x => x[1]).map(([t, k]) => `${k} ${t}`).join(" · ") || ""}</div>` : ""}`;
    if (!nx) return finish();
    now.innerHTML = `<div class="dnow"><div class="muted">${nx.of ? `${plan.wedge ? "Shot" : name === "Play the Course on the Range" ? "Hole" : "Ball"} ${nx.no} of ${nx.of}` : `Putt ${nx.no}`}</div>
      <div class="dcall">${esc(nx.call)}</div>${plan.wedge ? `<div class="muted">The app called this distance. Pick the club and swing from My Bag.</div>
      <div class="row"><input id="act" type="number" inputmode="numeric" placeholder="Carried (yd, optional)" style="flex:1"><button class="btn small alt" id="actGo">Log</button></div>` : ""}</div>
      <div class="dbtns">${nx.buttons.map(([l, v, tag], i) => `<button class="btn${i ? " alt" : ""}" data-i="${i}">${esc(l)}</button>`).join("")}</div>`;
    now.querySelectorAll("[data-i]").forEach(x => x.onclick = () => { const [l, v, tag] = nx.buttons[+x.dataset.i]; res.push({ call: nx.call, label: l, v, tag }); draw(); });
    const ag = $("#actGo", now); if (ag) ag.onclick = () => { const a = +$("#act", now).value; if (!a) return; const c = parseInt(nx.call), diff = a - c;
      const tag = Math.abs(diff) <= plan.tol ? "in" : diff < 0 ? "short" : "long"; res.push({ call: nx.call, label: `${a} yd`, v: tag === "in" ? 1 : 0, tag, yd: a }); draw(); };
  }
  $("#undo", wrap).onclick = () => { res.pop(); draw(); };
  $("#end", wrap).onclick = () => { if (!res.length) return (opts.back || practicePage)(); finish(true); };
  let done = false;
  function finish(early) {
    if (done) return; done = true; clearInterval(tick);
    const score = plan.score(res), passed = plan.passed ? plan.passed(res) : plan.lowerBetter ? score <= plan.goal : score >= plan.goal;
    const e = { id: Store.id(), drill: name, t: Date.now(), score, score2: plan.score2 ? plan.score2(res) : undefined, max: plan.max, goal: plan.goal, lowerBetter: plan.lowerBetter,
      passed: !!passed, harder: !!opts.harder, variant, secs: secs(), early: !!early, reps: res };
    saveDrill(e); const unlockedNow = checkUnlock(name);
    const nextS = opts.session && opts.session.list[opts.session.i + 1];
    $("#now", wrap).innerHTML = `<div class="dres ${passed ? "ok" : ""}"><div class="caps">${passed ? "Goal passed" : "Goal not reached"}</div><div class="dcall">${esc(scoreText(e))}</div>
      <div class="muted">${Math.max(1, Math.round(e.secs / 60))} min · saved to your practice sessions</div>
      ${unlockedNow ? `<div class="carry">Two passes in a row: <b>Make it harder</b> is unlocked for the ${esc(d.name)}.</div>` : ""}
      ${plan.wedge ? `<div class="muted">${res.filter(r => r.yd).length ? "Logged carries are saved with this session." : ""}</div>` : ""}</div>
      <div class="row">${nextS ? `<button class="btn" id="nextS">Next: ${esc(nextS.name)}</button>` : `<button class="btn" id="fin">Done</button>`}</div>`;
    $("#undo", wrap).hidden = true; $("#end", wrap).hidden = true;
    if (nextS) $("#nextS", wrap).onclick = () => drillRun(nextS.name, { session: { ...opts.session, i: opts.session.i + 1 }, variant: nextS.variant, back: opts.back });
    else $("#fin", wrap).onclick = () => (opts.back || practicePage)();
  }
  draw();
}

// ---------------------------------------------------------------- session builder (15 / 30 / 60 min), weakest area first
function buildSession(mins, rxs, lib) {
  const has = n => !!lib.drills[n], putt = ["Clock Drill", "Start-Line Gate"].filter(has);
  const top = rxs[0], second = rxs[1], list = [];
  const push = (name, why, variant) => { if (name && has(name) && !list.some(x => x.name === name)) list.push({ name, why, variant, min: lib.drills[name].minHi }); };
  if (!top) return list;
  push(top.drill, top.why);
  if (mins === 30) push(putt.find(p => p !== top.drill), "Finish under pressure with short putts.");
  if (mins === 60) {
    push(top.drills[1], top.why);                            // a second drill for the top weakness, if the library has one
    if (second) push(second.drill, second.why);
    if (list.length < 3) push(putt.find(p => !list.some(x => x.name === p)), "Short putts to round it out.");
    push("Up-and-Down Circuit", "Finish with 9 balls of the Up-and-Down Circuit.", 9);
    const ud = list.find(x => x.name === "Up-and-Down Circuit"); if (ud) ud.min = 15;
  }
  return list;
}
async function sessionBuilder(container) {
  const card = el(`<div class="card"><div class="caps brass">Build my session</div>
    <div class="seg" id="mins">${[15, 30, 60].map(m => `<button data-m="${m}" style="flex:1" class="${m === 30 ? "on" : ""}">${m} min</button>`).join("")}</div>
    <div id="sesOut"><div class="muted it">Reading your rounds…</div></div></div>`);
  container.appendChild(card);
  let mins = Store.get("sessionMins", 30), data = null;
  try { data = await prescriptions(); } catch { $("#sesOut", card).innerHTML = "<p>Couldn't load the drill library.</p>"; return; }
  const draw = () => {
    card.querySelectorAll("[data-m]").forEach(x => x.classList.toggle("on", +x.dataset.m === mins));
    const out = $("#sesOut", card), list = buildSession(mins, data.list, data.lib), rule = data.lib.session[mins];
    if (!list.length) { out.innerHTML = `<p class="muted">Log a round (shots and putts) or a practice session first. Sessions are built from your weakest area, so they need your numbers.</p>`; return; }
    out.innerHTML = `<div class="muted it">${esc(rule || "")} Weakest area first.</div>
      <ol class="seslist">${list.map((x, i) => `<li data-i="${i}"><div class="grow"><b>${esc(x.name)}</b><small>${esc(x.why)}</small></div><span class="num">${x.min} min</span></li>`).join("")}</ol>
      <div class="muted">About ${list.reduce((a, x) => a + x.min, 0)} minutes.</div><button class="btn" id="startS">Start session</button>`;
    out.querySelectorAll("li[data-i]").forEach(li => li.onclick = () => { const x = list[+li.dataset.i]; prescriptionPage(x.name, data.list.find(r => r.drills.includes(x.name))); });
    $("#startS", out).onclick = () => drillRun(list[0].name, { session: { list, i: 0 }, variant: list[0].variant, back: practicePage });
  };
  card.querySelectorAll("[data-m]").forEach(x => x.onclick = () => { mins = +x.dataset.m; Store.set("sessionMins", mins); draw(); });
  draw();
}
// the Practice tab's drill sections: prescriptions, progress per drill, and the course check for drills I've practiced
async function drillSections(b) {
  b.appendChild(el(`<h2>Your prescriptions</h2>`));
  const pl = el(`<div class="list"><p class="muted it">Reading your rounds…</p></div>`); b.appendChild(pl);
  const prog = el(`<div></div>`); b.appendChild(prog);
  let data; try { data = await prescriptions(); } catch { pl.innerHTML = "<p>Couldn't load the drill library.</p>"; return; }
  pl.innerHTML = data.list.length ? "" : `<p class="muted">Nothing stands out yet. Log shots and putts in a round, or use a practice page, and prescriptions show up here, each with a drill.</p>`;
  data.list.slice(0, 4).forEach(rx => { const d = data.lib.drills[rx.drill];
    const it = el(`<div class="item"><div class="grow"><b>${esc(rx.weakness)}</b><small>${esc(rx.why)}</small><small class="brass">${esc(d.name)} · ${esc(d.time)}</small></div><span>›</span></div>`);
    it.onclick = () => prescriptionPage(rx.drill, rx); pl.appendChild(it); });
  const practiced = [...new Set(drillLog().map(e => e.drill))].filter(n => data.lib.drills[n]);
  if (!practiced.length) return;
  prog.appendChild(el(`<h2>Drill progress</h2>`));
  const pg = el(`<div class="list"></div>`); prog.appendChild(pg);
  practiced.forEach(n => { const log = drillLog().filter(e => e.drill === n), last = log.at(-1);
    const it = el(`<div class="item"><div class="grow"><b>${esc(n)}</b><small>${log.length} session${log.length > 1 ? "s" : ""} · last ${esc(scoreText(last))}${last.passed ? " (passed)" : ""}${harderUnlocked(n) ? " · Make it harder unlocked" : ""}</small>
      <div class="scores">${log.slice(-8).map(e => `<span class="sc${e.passed ? " ok" : ""}${e.harder ? " hard" : ""}">${esc(scoreText(e))}</span>`).join("")}</div></div><span>›</span></div>`);
    it.onclick = () => prescriptionPage(n, data.list.find(r => r.drills.includes(n))); pg.appendChild(it); });
  prog.appendChild(el(`<h2>Course check</h2>`));
  const cc = el(`<div class="card"></div>`); prog.appendChild(cc);
  for (const n of practiced) { const t = await courseCheck(n); if (t) cc.appendChild(el(`<p class="cc">${esc(t)}</p>`)); }
}
