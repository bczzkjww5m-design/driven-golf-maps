// Koan Golf (formerly Driven Golf): courses, tees, pins, hazards, round plans, rounds and plan-vs-actual. Saved on this phone.
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const el = html => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };
function toast(msg, ms = 2200) { const t = el(`<div class="toast">${esc(msg)}</div>`); document.body.appendChild(t); setTimeout(() => t.remove(), ms); }
const app = $("#app");
const A = { index: [], courses: {}, settings: Store.settings(), bag: Store.bag(), profile: Store.profile(), gps: null, gpsWatch: null };

// ---------------------------------------------------------------- data
async function loadIndex() { A.index = await (await fetch("data/index.json")).json(); }
// green slopes (lidar), loaded when first needed; null if a course has none
async function loadSlopes(slug) {
  if (!(slug in (A.slopes = A.slopes || {}))) { try { const r = await fetch(`data/${slug}/slopes.json`); A.slopes[slug] = r.ok ? await r.json() : null; } catch { A.slopes[slug] = null; } }
  return A.slopes[slug];
}
async function loadCourse(slug) {
  if (!A.courses[slug]) A.courses[slug] = await (await fetch(`data/${slug}.json`)).json();
  return A.courses[slug];
}
const meta = slug => A.index.find(c => c.slug === slug) || {};
const holeOf = (course, n) => course.holes[n - 1];
const cardYards = (course, tee, n) => course.tees[tee]?.[n - 1];

// ---- hazard types: name, short name (panel), default severity (red = penalty or lost ball: the bigger Auto-plan margin
// and carry warnings; yellow = costly but playable: smaller-margin warnings, fine to carry), the hazard editor's group,
// the lie a ball in it has, and where it comes from in OpenStreetMap. A hazard's own "sev" (the editor's switch) wins.
const HZ_GROUPS = ["Water and penalty areas", "Sand", "Grass and natural", "Trees and rocks", "Boundaries", "My zones"];
const HZT = {
  "water:water":      { name: "Water", short: "Water", sev: "red", group: 0, lie: "Penalty area", osm: "natural=water, golf=water_hazard" },
  "water:lateral":    { name: "Red penalty area", short: "Red penalty area", sev: "red", group: 0, lie: "Penalty area", osm: "golf=lateral_water_hazard" },
  "water:yellow":     { name: "Yellow penalty area", short: "Yellow penalty area", sev: "red", group: 0, lie: "Penalty area", osm: "" },
  wetland:            { name: "Wetland or marsh", short: "Wetland", sev: "red", group: 0, lie: "Penalty area", osm: "natural=wetland" },
  esa:                { name: "Environmentally sensitive (no play)", short: "ESA", sev: "red", group: 0, lie: "Penalty area", osm: "" },
  "bunker:fairway":   { name: "Fairway bunker", short: "Bunker", sev: "yellow", group: 1, lie: "Sand", osm: "golf=bunker" },
  "bunker:greenside": { name: "Greenside bunker", short: "Greenside bunker", sev: "yellow", group: 1, lie: "Sand", osm: "golf=bunker" },
  "bunker:pot":       { name: "Pot bunker", short: "Pot bunker", sev: "red", group: 1, lie: "Sand", osm: "golf=bunker" },
  waste:              { name: "Waste area", short: "Waste area", sev: "yellow", group: 1, lie: "Waste area", osm: "natural=sand, golf=waste_area" },
  native:             { name: "Native area", short: "Native area", sev: "yellow", group: 2, lie: "Native area", osm: "natural=scrub, heath, grassland; landuse=meadow" },
  grass_bunker:       { name: "Grass bunker or hollow", short: "Grass bunker", sev: "yellow", group: 2, lie: "Rough", osm: "" },
  heavy_rough:        { name: "Heavy rough", short: "Heavy rough", sev: "yellow", group: 2, lie: "Heavy rough", osm: "" },
  trees:              { name: "Trees and woods", short: "Trees", sev: "yellow", group: 3, lie: "Trees", osm: "natural=wood, tree_row" },
  rocks:              { name: "Rocks", short: "Rocks", sev: "red", group: 3, lie: "Penalty area", osm: "natural=bare_rock, natural=stone" },
  desert:             { name: "Desert or arroyo", short: "Desert", sev: "red", group: 3, lie: "Desert", osm: "natural=scree, intermittent streams" },
  ob_area:            { name: "Out of bounds", short: "OB", sev: "red", group: 4, lie: "Out of bounds", osm: "the course boundary and fences" },
  fence:              { name: "Fence (OB)", short: "OB", sev: "red", group: 4, osm: "" },
  ob_line:            { name: "Course boundary (OB)", short: "OB", sev: "red", group: 4, osm: "" },
  avoid:              { name: "Avoid zone", short: "Avoid zone", sev: "yellow", group: 5, osm: "" },
};
const HAZARD_KINDS = ["water", "bunker", "trees", "ob_area", "fence", "ob_line", "avoid", "wetland", "esa", "waste", "native", "grass_bunker", "heavy_rough", "rocks", "desert"];
const hzType = f => { const p = f.properties; return HZT[`${p.kind}:${p.sub || (p.kind === "bunker" ? "fairway" : p.kind === "water" ? "water" : "")}`] || HZT[p.kind] || { name: p.kind, short: p.kind, sev: "yellow", group: 3 }; };
function sevOf(f) {
  const p = f.properties;
  if (p.kind === "avoid") return p.color === "red" ? "red" : "yellow";
  if (p.sev) return p.sev;
  if (p.kind === "native" && p.pa) return "red";              // native area played as a penalty area
  return hzType(f).sev;
}
function hazardName(f) {
  const p = f.properties;
  if (p.kind === "avoid") return p.name || "Avoid zone";
  if (p.kind === "native" && sevOf(f) === "red") return "Native area (penalty area)";
  return hzType(f).name;
}
const isRed = f => sevOf(f) === "red";
// hazards a shot has to fly over when its line crosses them: everything but trees and heavy rough (you play through those)
const carryKind = f => HAZARD_KINDS.includes(f.properties.kind) && !["trees", "heavy_rough", "fence", "ob_line"].includes(f.properties.kind);
// course features for a hole with the golfer's hazard edits and avoid zones applied
function holeFeatures(course, n) {
  const ed = (Store.hazardEdits(course.slug)[n]) || {};
  const del = new Set(ed.deleted || []), re = ed.retyped || {};
  const base = holeOf(course, n).features.features.filter(f => !del.has(f.properties.id)).map(f =>
    re[f.properties.id] ? { ...f, properties: { ...f.properties, ...re[f.properties.id] } } : f);
  const added = (ed.added || []);
  const avoid = ((Store.avoid(course.slug))[n] || []).map(z => ({ type: "Feature",
    properties: { id: z.id, kind: "avoid", color: z.color, name: z.name },
    geometry: { type: "Polygon", coordinates: [z.ring.map(([la, lo]) => [lo, la])] } }));
  return base.concat(added, avoid);
}
const hazards = (course, n) => holeFeatures(course, n).filter(f => HAZARD_KINDS.includes(f.properties.kind));

// ---------------------------------------------------------------- yardage helpers
function teePoint(course, n, tee) { const h = holeOf(course, n); return h.tees[tee] || h.tees[course.teeOrder[0]]; }
// USGA tee-to-green yards: horizontal straight lines from p to the green center, through the hole's dogleg pivots that
// are ahead of p and more than ~10 yd off the straight line (the same rule that placed the course's tee markers)
function usgaYd(h, p) {
  const path = h.path.slice().reverse(), s0 = Geo.along(path, p).m, pts = [p];
  (h.pivots || []).filter(q => Geo.along(path, q).m > s0 + 10).forEach(q => { if (Geo.along([pts.at(-1), h.greenCenter], q).lateralM > 9) pts.push(q); });
  pts.push(h.greenCenter);
  return Geo.length(pts) * YD;
}
const pinOrCenter = (h, pin) => pin || h.greenCenter;
const FT = 3.28084;
const ftTo = (a, b) => Math.round(Geo.m(a, b) * FT);   // feet, nearest foot (on the green)

// ---------------------------------------------------------------- putting stats (rounds + practice green)
// a putt: {ft, made, miss: short|long|left|right|null, up: uphill|downhill|level|null, brk: left-to-right|right-to-left|straight|null, pct}
const puttSlopeWords = p => !p.up ? "" : `${p.up[0].toUpperCase() + p.up.slice(1)}, ${p.brk === "straight" ? "straight" : `breaks ${p.brk}`}${p.pct != null ? ` · ${Math.max(1, Math.round(p.pct))}% slope` : ""}`;
const PUTT_BUCKETS = [[0, 3], [3, 6], [6, 10], [10, 20]];
// putting sequences saved by the practice pages: [{id, t, green, putts:[...]}] under driven-practice:<page>:putts
function practicePutts() {
  const out = [];
  try { Object.keys(localStorage).filter(k => k.startsWith("driven-practice:") && k.endsWith(":putts"))
    .forEach(k => JSON.parse(localStorage.getItem(k) || "[]").forEach(sq => out.push(sq))); } catch {}
  return out.sort((a, b) => b.t - a.t);
}
// seqs: one array of putts per hole (or per practice try), in order. Make % by distance, lag putts from over 30 ft that
// finish inside 3 ft (or go in), and three-putts among the holed-out sequences
function puttStats(seqs) {
  const all = seqs.flatMap(sq => sq.map((p, i) => ({ ...p, next: sq[i + 1]?.ft ?? (p.made ? 0 : null) })));
  const buckets = PUTT_BUCKETS.map(([a, b]) => { const xs = all.filter(p => (a === 0 || p.ft > a) && p.ft <= b);
    return { label: `${a}–${b} ft`, n: xs.length, made: xs.filter(p => p.made).length }; });
  const lag = all.filter(p => p.ft > 30 && p.next != null), done = seqs.filter(sq => sq.length && sq.at(-1).made);
  return { n: all.length, buckets, lagN: lag.length, lagIn: lag.filter(p => p.next <= 3).length, holes: done.length, three: done.filter(sq => sq.length >= 3).length };
}
const roundPuttSeqs = holes => holes.filter(h => h.puttLog?.length && h.putts != null).map(h => h.puttLog);
const pctOf = (a, b) => b ? Math.round(100 * a / b) : null;
// line of play from a spot to the pin: through planned targets still ahead; with no plan, the USGA way (the same rule
// that set the scorecard markers): straight to the pin, bending only at the hole's pivot when it's ahead of you, well
// short of the pin, and the hole really bends there (more than ~10 yd off the straight line)
function playLine(h, from, pin, targets = []) {
  const path = h.path.slice().reverse();                      // tee ... green center
  const s0 = Geo.along(path, from).m;
  const pinP = pinOrCenter(h, pin);
  const ahead = targets.filter(t => t && Geo.along(path, t).m > s0 + 10 && Geo.yd(t, pinP) > 30 && !Geo.inRing(t, h.green));   // targets on or by the green add nothing
  if (ahead.length) return [from, ...ahead, pinP];
  const pts = [from];
  (h.pivots || []).filter(q => Geo.along(path, q).m > s0 + 10 && Geo.yd(q, pinP) > 30).forEach(q => {
    if (Geo.along([pts.at(-1), pinP], q).lateralM > 9) pts.push(q);
  });
  return [...pts, pinP];
}
// ---- club picks from My Bag: total yards for tee shots and fairway layups, carry yards for approaches and any shot over
// a hazard. Returns the club plus the next club up and down, a note when the yardage falls between two clubs, and a
// warning when no club reaches. Yardages here are already plays-like where that applies.
const clubVal = (c, use) => use === "total" ? (c.total || c.carry) : c.carry;
function clubPick(yards, use = "carry", teeOnly = false) {
  if (!yards) return null;
  let bag = A.bag.filter(c => c.carry > 0);
  if (teeOnly && bag.some(c => c.tee)) bag = bag.filter(c => c.tee);
  if (!bag.length) return null;
  bag = bag.slice().sort((a, b) => clubVal(b, use) - clubVal(a, use));          // longest first
  const v = x => clubVal(x, use), noReach = yards > v(bag[0]) + 3;
  const reach = bag.map((x, k) => k).filter(k => v(bag[k]) >= yards - 3);       // clubs that get there (3 yd slack)
  const i = noReach ? 0 : reach.length ? reach.at(-1) : bag.length - 1;          // the shortest one that does
  const c = bag[i], lower = bag[i + 1];
  const between = !noReach && v(c) - yards > 3 && lower && v(lower) < yards ? [lower, c] : null;
  return { club: c, name: c.name, use, yards: Math.round(yards), up: bag[i - 1] || null, down: bag[i + 1] || null, between, noReach, longest: bag[0] };
}
const clubFor = (yards, use = "carry", teeOnly = false) => clubPick(yards, use, teeOnly)?.name || null;
// "7i · 165 carry / 172 total"
const clubLine = c => `${c.name} · ${c.carry} carry${c.total ? ` / ${c.total} total` : ""}`;
function pickNote(pk) {
  if (!pk) return "";
  if (pk.noReach) return `No club reaches ${pk.yards}: your longest is ${clubLine(pk.longest)}.`;
  if (pk.between) return `${pk.yards} is between ${pk.between[0].name} (${clubVal(pk.between[0], pk.use)}) and ${pk.between[1].name} (${clubVal(pk.between[1], pk.use)}).`;
  return "";
}
const playsLikeOn = slug => { const e = meta(slug).elevationFt; return e != null && Math.abs(e - A.settings.homeElevationFt) >= 1000; };
const plays = (slug, yd) => playsLikeOn(slug) ? Geo.playsLike(yd, meta(slug).elevationFt, A.settings.homeElevationFt) : yd;
const playsTxt = (slug, yd) => playsLikeOn(slug) ? ` · plays like ~${plays(slug, yd)} (est.)` : "";
const swatch = f => ({ water: f.properties.sub === "lateral" ? "#c62828" : "#3d8bd4", bunker: "#e6cf86", trees: "#2f6b34",
  ob_area: "#ffffff", fence: "#111", ob_line: "#eee", avoid: f.properties.color === "red" ? "#c62828" : "#e0a800" })[f.properties.kind] || "#999";
// ---- automatic carry yardages: every bunker and hazard near my line (within ~30 yd either side of the line from me to
// the pin or my next planned target) and within reach (longest club + 20), nearest first. Reach and carry are
// straight-line yards from me to where my line enters and leaves the hazard, or, if my line misses it, to its nearest
// and farthest points near my line. pF / pB are those points (the map labels sit there). A boundary line has reach only.
const PANEL_SIDE_YD = 30, PANEL_KINDS = HAZARD_KINDS.filter(k => k !== "trees");
function lineSide(line, p) {          // distance (m) from my line and which side: +1 left, -1 right
  const o = line[0], P = Geo.xy(p, o); let best = null;
  for (let i = 0; i < line.length - 1; i++) {
    const A = Geo.xy(line[i], o), B = Geo.xy(line[i + 1], o), dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy || 1e-9;
    const t = Math.max(0, Math.min(1, ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / L2));
    const ex = P[0] - (A[0] + t * dx), ey = P[1] - (A[1] + t * dy), d = Math.hypot(ex, ey);
    if (!best || d < best.d) best = { d, s: Math.sign(dx * ey - dy * ex) };
  }
  return best;
}
function densify(pts, stepM = 2) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const k = Math.max(1, Math.ceil(Geo.m(pts[i], pts[i + 1]) / stepM));
    for (let j = 0; j < k; j++) out.push([pts[i][0] + (pts[i + 1][0] - pts[i][0]) * j / k, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * j / k]);
  }
  return out.concat([pts.at(-1)]);
}
const panelName = f => f.properties.kind === "avoid" ? (f.properties.name || "Avoid zone") : hzType(f).name;
// where my line first runs into a hazard area and comes out again (1 m steps, a gap of 3 m ends the stretch)
function crossPts(line, g) {
  const total = Geo.length(line); let a = null, b = null;
  for (let d = 0; d <= total; d += 1) { const p = Geo.pointAt(line, d);
    if (Geo.inside(p, g)) { if (!a) a = { d, p }; b = { d, p }; } else if (b && d - b.d > 3) break; }
  return a ? { a: a.p, b: b.p } : null;
}
function hazardPanel(course, n, line) {
  const from = line[0], reach = (A.bag.length ? Math.max(...A.bag.map(c => c.total || c.carry || 0)) : 250) + 20, rows = [];   // no bag yet: about 250   // in plays-like yards (altitude)
  hazards(course, n).filter(f => PANEL_KINDS.includes(f.properties.kind)).forEach(f => {
    const g = f.geometry, poly = g.type.includes("Polygon");
    const dir = Geo.xy(line[1], from);                     // which way I'm hitting: parts behind me aren't in play
    const ahead = p => { const v = Geo.xy(p, from); return v[0] * dir[0] + v[1] * dir[1] > -3 * Math.hypot(...dir); };
    const near = Geo.linesOf(g).flatMap(r => densify(r)).filter(ahead).map(p => ({ p, sd: lineSide(line, p), d: Geo.yd(from, p) }))
      .filter(x => x.sd.d * YD <= PANEL_SIDE_YD);
    if (!near.length) return;
    const lo = near.reduce((a, x) => x.d < a.d ? x : a), hi = near.reduce((a, x) => x.d > a.d ? x : a);
    const cr = poly ? crossPts(line, g) : null, pF = cr ? cr.a : lo.p, pB = cr ? cr.b : hi.p;
    const F = poly && Geo.inside(from, g) ? 0 : Geo.yd(from, pF), B = Geo.yd(from, pB);
    if (plays(course.slug, F) > reach || B < 5) return;
    const crosses = !!cr || (!poly && Geo.crossings(line, g, 1).length > 0), nl = near.filter(x => x.sd.s > 0).length;
    const side = crosses ? "crossing" : nl >= near.length - nl ? "L" : "R";
    rows.push({ f, F: Math.round(F), B: Math.round(B), carry: poly ? Math.round(B) : null, pF, pB, side, red: isRed(f) });
  });
  return rows.sort((a, b) => a.F - b.F);
}
// the club that carries the back edge of the nearest hazard area my line crosses (shortest club in My Bag that gets
// there). Only areas you fly over: an OB line or fence is a boundary, not something to carry.
function carryClub(rows, slug) {
  const r = rows.find(x => x.side === "crossing" && x.B > 0 && x.f.geometry.type.includes("Polygon")); if (!r) return null;
  const need = plays(slug, r.B), bag = A.settings.bag.filter(c => c[1] > 0).slice().sort((a, b) => a[1] - b[1]);
  if (!bag.length) return null;                               // no bag numbers yet
  const club = bag.find(([, d]) => d >= need);
  return { r, txt: club ? `Carry ${panelName(r.f).toLowerCase()} ${r.B} → ${club[0]} (${club[1]} carry)` : `Carry ${panelName(r.f).toLowerCase()} ${r.B} → beyond your longest club (${bag.at(-1)[0]} ${bag.at(-1)[1]})` };
}
const chipName = f => f.properties.kind === "avoid" ? (f.properties.name || "Avoid zone") : hzType(f).short;
const hzSide = r => r.side === "crossing" ? "" : ` ${r.side}`;
const hzYards = r => r.carry == null ? `${r.F} reach` : r.F > 0 ? `${r.F} reach / ${r.carry} carry` : `in it · ${r.carry} carry`;
function panelHTML(rows, slug) {
  const pl = playsLikeOn(slug), cc = carryClub(rows, slug);
  const list = rows.length ? `<div class="hzlist">${rows.map(r => `<div class="hl${r.red ? " red" : ""}"><span>${esc(chipName(r.f))}${hzSide(r)}</span><span class="lead"></span><b>${hzYards(r)}</b></div>${pl ? `<div class="muted" style="font-size:12px;text-align:right">plays ${plays(slug, r.F)}${r.carry != null ? ` / ${plays(slug, r.carry)}` : ""}</div>` : ""}`).join("")}</div>`
    : '<div class="muted it">No hazards in play from here.</div>';
  return { chips: `<div class="hzp"><div class="hzh"><b>Hazards in play</b><span class="muted">reach / carry</span></div>${list}</div>`, carry: cc ? `<div class="carry">${esc(cc.txt)}</div>` : "" };
}
function pinHazardsHTML(course, n, pin) {
  const near = hazards(course, n).filter(f => f.properties.kind !== "trees").map(f => ({ f, d: Geo.distToGeom(pin, f.geometry) * YD })).filter(x => x.d <= 15);
  if (!near.length) return "";
  return `<div class="muted">From the pin: ${near.sort((a, b) => a.d - b.d).map(x => `${esc(hazardName(x.f))} ${Math.round(x.d)} yd`).join(" · ")}</div>`;
}
function targetWarnings(course, n, from, target) {
  const out = [];
  hazards(course, n).forEach(f => {
    const red = isRed(f), yellow = !red && f.properties.kind !== "trees";
    if (!red && !yellow) return;
    const d = Geo.distToGeom(target, f.geometry) * YD;
    if (red ? d <= 15 : d <= 6 && (f.properties.kind === "avoid" || !Geo.inRing(target, holeOf(course, n).green))) out.push({ red, msg: `${Math.round(d)} yd from ${hazardName(f)}` });
    else if (from && red) {
      const rc = Geo.reachCarry([from, target], f.geometry, 2);
      if (rc && rc.carry < Geo.yd(from, target) - 3) out.push({ red, msg: `line carries ${hazardName(f)} (${rc.reach} to reach, ${rc.carry} to carry)` });
    }
  });
  return out;
}

// ---------------------------------------------------------------- planning: club picks, plan by club, Auto-plan
const planKeysFor = par => par === 3 ? ["approach"] : par === 5 ? ["teeTarget", "layup", "approach"] : ["teeTarget", "approach"];
// club for a planned shot: total yards for the tee shot (tee clubs on par 4/5) and layups, carry for approaches.
// If the line crosses a bunker, red hazard or avoid zone, only clubs whose carry clears its far edge by 5+ yards
// count; of those, the one whose total (carry if the target is on the green) is closest to the target.
function pickShot(course, n, k, from, p) {
  const h = holeOf(course, n), slug = course.slug;
  const dist = Geo.yd(from, p), yd = plays(slug, dist), teeOnly = k === "teeTarget" && h.par > 3;
  let hz = null;                                   // the crossed hazard with the farthest far edge short of the target
  hazards(course, n).forEach(f => {
    const kd = f.properties.kind;
    if (!carryKind(f) || !f.geometry.type.includes("Polygon")) return;
    const rc = Geo.reachCarry([from, p], f.geometry, 1);
    if (rc && rc.carry < dist - 3 && (!hz || rc.carry > hz.carry)) hz = { f, ...rc };
  });
  if (!hz) return clubPick(yd, k === "approach" ? "carry" : "total", teeOnly);
  let bag = A.bag.filter(c => c.carry > 0); if (teeOnly && bag.some(c => c.tee)) bag = bag.filter(c => c.tee);
  if (!bag.length) return null;                            // no bag numbers yet
  bag = bag.slice().sort((a, b) => b.carry - a.carry);
  const need = Math.round(plays(slug, hz.carry) + 5), name = panelName(hz.f).toLowerCase();
  const info = { name, need, edge: Math.round(hz.carry), front: Math.round(hz.reach), longest: bag[0] };
  const clears = bag.filter(c => c.carry >= need);
  if (!clears.length) return { ...clubPick(yd, "carry", teeOnly), hz: { ...info, clears: false } };
  const use = Geo.inRing(p, h.green) ? "carry" : "total";
  const best = clears.reduce((a, c) => Math.abs(clubVal(c, use) - yd) < Math.abs(clubVal(a, use) - yd) ? c : a);
  const i = bag.indexOf(best);
  return { club: best, name: best.name, use, yards: Math.round(yd), up: bag[i - 1] || null, down: bag[i + 1] || null, between: null, noReach: false,
    longest: bag[0], hz: { ...info, clears: true, past: Math.round(clubVal(best, use) - yd) } };
}
// the side to miss away from: bunkers, water, OB and avoid zones within 20 yd of the pin, red ones count triple
function dangerSide(course, n, from, pin) {
  const tally = { short: 0, long: 0, left: 0, right: 0 };
  hazards(course, n).forEach(f => {
    if (!HAZARD_KINDS.includes(f.properties.kind) || ["trees", "heavy_rough"].includes(f.properties.kind)) return;
    const d = Geo.distToGeom(pin, f.geometry) * YD; if (d > 20) return;
    let best = null; Geo.linesOf(f.geometry).forEach(l => l.forEach(q => { const dd = Geo.yd(pin, q); if (!best || dd < best.d) best = { d: dd, q }; }));
    if (!best) return;
    const mm = Geo.miss(from, pin, best.q), w = isRed(f) ? 3 : 1;
    if (Math.abs(mm.along) > Math.abs(mm.cross)) tally[mm.along > 0 ? "long" : "short"] += w; else tally[mm.cross > 0 ? "left" : "right"] += w;
  });
  const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
  return top[1] > 0 ? top[0] : null;
}
// a club's yards at this course: My Bag numbers are at home; up high the ball flies ~2% farther per 1,000 ft
const reachYd = (slug, yd) => playsLikeOn(slug) ? Math.round(yd * (1 + 0.02 * (meta(slug).elevationFt - A.settings.homeElevationFt) / 1000)) : yd;
const shotUse = k => k === "approach" ? "carry" : "total";
const centerLine = h => h.path.slice().reverse();          // tee … fairway middle … green center
const toward = (from, to, dM) => { const d = Geo.xy(to, from), L0 = Math.hypot(d[0], d[1]) || 1; return Geo.ll([d[0] * dM / L0, d[1] * dM / L0], from); };
// where a club sends the ball from `from`. Tee shots and layups: its total yards, straight-line, finishing on the fairway
// center line (on a dogleg that's where that distance meets the center line, so a long club can reach through the corner).
// Approaches: where it lands at its carry yards, on the line to the pin.
function clubSpot(course, n, k, from, club, pin) {
  const h = holeOf(course, n), dM = reachYd(course.slug, clubVal(club, shotUse(k))) / YD;
  if (k === "approach") return toward(from, pinOrCenter(h, pin), dM);
  const line = centerLine(h), total = Geo.length(line);
  let prev = from, prevD = 0;
  for (let s = Math.max(0, Geo.along(line, from).m); s <= total; s += 1) {
    const p = Geo.pointAt(line, s), d = Geo.m(from, p);
    if (d >= dM) { const t = d - prevD > 1e-6 ? (dM - prevD) / (d - prevD) : 1; return [prev[0] + (p[0] - prev[0]) * t, prev[1] + (p[1] - prev[1]) * t]; }
    prev = p; prevD = d;
  }
  return toward(from, line.at(-1), dM);                    // past the green center: straight on
}
// "finishes 6 short of the pin" / "8 long" for an approach planned by club (its total vs the pin)
function finishWords(course, n, from, club, pin) {
  const h = holeOf(course, n), d = Math.round(reachYd(course.slug, clubVal(club, "total")) - Geo.yd(from, pinOrCenter(h, pin)));
  return Math.abs(d) <= 2 ? "finishes at the pin" : `finishes ${Math.abs(d)} ${d < 0 ? "short of" : "past"} the pin`;
}
const polysOf = (course, n, kinds) => holeFeatures(course, n).filter(f => kinds.includes(f.properties.kind) && f.geometry.type.includes("Polygon"));
const inFairway = (course, n, p) => polysOf(course, n, ["fairway"]).some(f => Geo.inside(p, f.geometry));
// how far down the center line the fairway runs (fairway outline points near the line)
function fairwayEnd(course, n) {
  const line = centerLine(holeOf(course, n)); let end = 0;
  polysOf(course, n, ["fairway"]).forEach(f => Geo.ringsOf(f.geometry).forEach(r => r.forEach(q => { const a = Geo.along(line, q); if (a.lateralM < 40) end = Math.max(end, a.m); })));
  return end;
}
// where a planned spot lands badly: rough, a hazard, trees, out of bounds, or past the end of the fairway
function spotWarnings(course, n, k, from, p) {
  const h = holeOf(course, n), out = [];
  polysOf(course, n, HAZARD_KINDS).filter(f => Geo.inside(p, f.geometry)).forEach(f => {
    const kd = f.properties.kind;
    out.push({ red: isRed(f), msg: kd === "trees" ? "Lands in the trees" : kd === "ob_area" ? "Lands out of bounds" : `Lands in the ${hazardName(f).toLowerCase()}` });
  });
  holeFeatures(course, n).filter(f => ["ob_line", "fence"].includes(f.properties.kind)).forEach(f => {
    if (Geo.crossings([from, p], f.geometry, 1).length) out.push({ red: true, msg: "Crosses the out-of-bounds line" });
  });
  if (!out.length && k !== "approach" && !Geo.inRing(p, h.green) && !inFairway(course, n, p)) {
    const pastEnd = Geo.along(centerLine(h), p).m > fairwayEnd(course, n) + 3;
    out.push({ red: false, msg: pastEnd ? "Runs past the end of the fairway" : "Finishes in the rough" });
  }
  return out;
}
// ---- the lie: where a ball sits, read from the map. Green, Sand, Penalty area (water), Out of bounds, Fringe (within ~3 yd of the green),
// Tee, Fairway, Trees (a wood or tree row), else Rough. Shots saved before lies existed count as "unknown".
const LIES = ["Tee", "Fairway", "Rough", "Fringe", "Sand", "Trees", "Green", "Waste area", "Native area", "Heavy rough", "Desert", "Penalty area", "Out of bounds"];
const ROUGHISH = ["Rough", "Waste area", "Native area", "Heavy rough", "Desert"];    // "Rough & native" in stats
function lieOf(course, n, p) {
  const h = holeOf(course, n), hit = polysOf(course, n, HAZARD_KINDS.concat(["tee_box", "fairway"])).filter(f => Geo.inside(p, f.geometry)), has = k => hit.some(f => f.properties.kind === k);
  if (Geo.inRing(p, h.green)) return "Green";
  if (has("bunker")) return "Sand";
  // red hazard areas are penalty areas (water, wetland, rocks, a native area played as one...); OB is its own
  if (has("ob_area")) return "Out of bounds";
  if (hit.some(f => f.properties.kind !== "avoid" && isRed(f) && hzType(f).lie !== "Desert")) return "Penalty area";
  if (Geo.distToGeom(p, greenGeom(h)) * YD <= 3) return "Fringe";
  if (has("tee_box")) return "Tee";
  if (has("fairway")) return "Fairway";
  for (const k of ["waste", "desert", "native", "heavy_rough", "trees"]) if (has(k)) return hzType({ properties: { kind: k } }).lie;
  return "Rough";
}
// near an edge (within ~5 yd, where GPS or a tap could be off): the guess plus the other lies close by
function lieGuess(course, n, p) {
  const lie = lieOf(course, n, p), alts = [];
  for (let a = 0; a < 360; a += 30) { const r = a * Math.PI / 180, q = Geo.ll([Math.sin(r) * 5 / YD, Math.cos(r) * 5 / YD], p), l = lieOf(course, n, q);
    if (l !== lie && !alts.includes(l)) alts.push(l); }
  return { lie, lieAlt: alts.slice(0, 3) };
}
const lieOfShot = x => x?.lie || "unknown";
// ---- penalties. A shot can end "ob" (out of bounds: +1, the next shot is played from the previous spot, stroke and
// distance; prov = played as a provisional) or "pa" (penalty area: +1, the next shot is played from the drop spot I
// tapped). Other penalties are the plain count rh.penalties (older rounds only have that).
function playFrom(sh, i) {                                   // where the shot after shot i is played from
  const x = sh[i]; if (!x) return null;
  if (x.out === "ob") return i > 0 ? playFrom(sh, i - 1) : x.p;
  if (x.out === "pa" && x.drop) return x.drop;
  return x.p;
}
function startLie(sh, i) {                                   // the lie the shot after shot i is played from
  const x = sh[i]; if (!x) return "unknown"; if (i === 0) return "Tee";
  if (x.out === "ob") return startLie(sh, i - 1);
  if (x.out === "pa") return x.dropLie || "unknown";
  return lieOfShot(x);
}
const strokeNo = (sh, i) => i + sh.slice(1, i).filter(x => x.out).length;   // shot i's stroke number, counting penalty strokes before it
const penOf = rh => { const sh = rh?.shots || []; return { ob: sh.filter(x => x.out === "ob").length, pa: sh.filter(x => x.out === "pa").length, other: rh?.penalties || 0 }; };
const penWords = p => [p.ob && `${p.ob} OB`, p.pa && `${p.pa} penalty area`, p.other && `${p.other} other penalty`].filter(Boolean).join(" · ");
// a club that doesn't carry a hazard on its line (bunker, red hazard, avoid zone): the hazard and the carry it needs
function carryShort(course, n, from, p, club) {
  let worst = null; const dist = Geo.yd(from, p), carry = reachYd(course.slug, club.carry);
  hazards(course, n).forEach(f => {
    if (!carryKind(f) || !f.geometry.type.includes("Polygon")) return;
    const rc = Geo.reachCarry([from, p], f.geometry, 1);
    if (rc && rc.carry < dist - 3 && carry < rc.carry + 5 && (!worst || rc.carry + 5 > worst.need)) worst = { name: panelName(f).toLowerCase(), need: rc.carry + 5 };
  });
  return worst;
}

// ---- Auto-plan: a whole round from My Bag, the hazards, the tees and a middle pin
const STRATEGIES = { safe: { label: "Safe", margin: 25, blurb: "Wide of trouble, lay up more" },
  balanced: { label: "Balanced", margin: 15, blurb: "Longest club that stays safe" },
  aggressive: { label: "Aggressive", margin: 8, blurb: "Tighter lines, go for par 5s" } };
// what the safety margin is measured from: red hazards, OB and avoid zones need the full margin, yellow hazards (bunkers,
// waste and native areas...) half of it; trees and heavy rough none. gap < 0 = too close.
function nearestTrouble(course, n, p, margin = 15) {
  let best = null;
  holeFeatures(course, n).filter(f => HAZARD_KINDS.includes(f.properties.kind) && !["trees", "heavy_rough"].includes(f.properties.kind)).forEach(f => {
    const need = isRed(f) || f.properties.kind === "avoid" ? margin : margin / 2, d = Geo.distToGeom(p, f.geometry) * YD;
    if (!best || d - need < best.gap) best = { d, f, gap: d - need };
  });
  return best;
}
const troubleName = f => ["ob_area", "fence", "ob_line"].includes(f.properties.kind) ? "out of bounds" : f.properties.kind === "avoid" ? (f.properties.name || "the avoid zone").toLowerCase() : `the ${hazardName(f).toLowerCase()}`;
// the favorite full wedge: the wedge that carries closest to 100 yards
function favWedge() {
  const ws = A.bag.filter(c => c.carry > 0 && isWedge(c.name)), all = ws.length ? ws : A.bag.filter(c => c.carry > 0 && c.carry <= 130);
  return all.reduce((a, c) => !a || Math.abs(c.carry - 100) < Math.abs(a.carry - 100) ? c : a, null);
}
// is this spot safe for a shot from `from` with this club: in the fairway, margin from trouble, carries what it crosses
function spotCheck(course, n, k, from, p, club, margin) {
  const nt = nearestTrouble(course, n, p, margin), cs = carryShort(course, n, from, p, club), h = holeOf(course, n);
  if (cs) return { ok: false, why: `doesn't carry the ${cs.name}`, trouble: `the ${cs.name}` };
  if (nt && nt.gap < 0) return { ok: false, why: `brings ${troubleName(nt.f)} into play`, trouble: troubleName(nt.f) };
  if (k !== "approach" && Geo.yd(p, h.greenCenter) < 40 && !Geo.inRing(p, h.green)) return { ok: false, why: "runs up by the green" };
  if (k !== "approach" && !inFairway(course, n, p)) return { ok: false, why: spotWarnings(course, n, k, from, p)[0]?.msg.toLowerCase().replace("finishes", "finishes") || "misses the fairway" };
  return { ok: true, clear: nt ? Math.round(nt.d) : null };
}
// aim at the middle of the green; Safe and Balanced lean away from a bunker or water guarding one side
function aimSpot(course, n, from, strat) {
  const h = holeOf(course, n), c = h.greenCenter;
  if (strat === "aggressive") return { p: c, note: "" };
  const side = { left: 0, right: 0 }, what = { left: "", right: "" };
  hazards(course, n).filter(f => carryKind(f) && f.properties.kind !== "avoid").forEach(f => {
    if (Geo.distToGeom(c, f.geometry) * YD > 25) return;
    let best = null; Geo.linesOf(f.geometry).forEach(l => l.forEach(q => { const d = Geo.m(c, q); if (!best || d < best.d) best = { d, q }; }));
    const mm = Geo.miss(from, c, best.q), sd = mm.cross > 0 ? "left" : "right";
    if (Math.abs(mm.cross) > Math.abs(mm.along) * 0.6) { side[sd] += isRed(f) ? 3 : 1; if (!what[sd] || isRed(f)) what[sd] = f.properties.kind === "bunker" ? "bunker" : hazardName(f).toLowerCase(); }
  });
  if (!side.left === !side.right) return { p: c, note: "" };              // both sides guarded or neither: the middle
  const away = side.left ? -1 : 1, d = Geo.xy(c, from), L0 = Math.hypot(d[0], d[1]) || 1, perp = [-d[1] / L0 * away, d[0] / L0 * away];  // +1 = left
  for (let yd = 5; yd >= 2; yd--) { const p = Geo.ll([perp[0] * yd / YD, perp[1] * yd / YD], c);
    if (Geo.inRing(p, h.green)) return { p, note: `${yd} yd ${side.left ? "right" : "left"} of center, away from the ${what[side.left ? "left" : "right"]} on the ${side.left ? "left" : "right"}` }; }
  return { p: c, note: "" };
}
function autoPlanHole(course, n, tees, strat) {
  const h = holeOf(course, n), slug = course.slug, M = STRATEGIES[strat].margin, tee = teePoint(course, n, tees), out = { score: h.par };
  const bag = A.bag.filter(c => c.carry > 0).slice().sort((a, b) => clubVal(b, "total") - clubVal(a, "total"));
  const why = [];
  let from = tee;
  if (h.par > 3) {
    // tee shot: the longest tee club whose spot stays in the fairway with the margin; step down (into irons if need be)
    const teeClubs = bag.some(c => c.tee) ? bag.filter(c => c.tee) : bag, rest = bag.filter(c => !teeClubs.includes(c) && clubVal(c, "total") < clubVal(teeClubs.at(-1), "total"));
    const tries = [...teeClubs, ...rest.slice(0, 4)].map(c => { const p = clubSpot(course, n, "teeTarget", tee, c); return { c, p, ...spotCheck(course, n, "teeTarget", tee, p, c, M) }; });
    const pick = tries.find(t => t.ok) || tries.slice().sort((a, b) => (nearestTrouble(course, n, b.p, M)?.gap ?? 999) - (nearestTrouble(course, n, a.p, M)?.gap ?? 999))[0];
    out.teeTarget = { p: pick.p, club: pick.c.name, clubSet: true, byClub: true };
    const first = tries[0];
    why.push(pick === first ? `${pick.c.name} finds the fairway${pick.clear != null && pick.clear < 40 ? `, ${pick.clear} yd from trouble` : ""}`
      : !pick.ok ? `${pick.c.name} is the safest tee shot (no club stays clear: ${first.c.name} ${first.why})`
      : first.trouble ? `${pick.c.name} keeps ${first.trouble} out of play` : `${pick.c.name} stays in the fairway (${first.c.name} ${first.why})`);
    from = pick.p;
  }
  if (h.par === 5) {
    // in two: only Balanced/Aggressive, a club (not the driver) that gets there and carries what guards the green with margin
    const D = Geo.yd(from, h.greenCenter);
    const goer = strat === "safe" ? null : bag.filter(c => !/driver/i.test(c.name)).reverse()
      .find(c => reachYd(slug, clubVal(c, "total")) >= D - 10 && !carryShort(course, n, from, h.greenCenter, { ...c, carry: c.carry - M + 5 }));   // carry - margin still clears
    if (goer) { why.push(`go for it in two with ${goer.name}`); out.goer = goer.name; }
    else {
      // lay up to the favorite full-wedge distance, on the center line, nudged to a safe fairway spot
      const w = favWedge(), want = w ? reachYd(slug, w.carry) : 100, line = centerLine(h), total = Geo.length(line);
      let s = total; while (s > 0 && Geo.yd(Geo.pointAt(line, s), h.greenCenter) < want) s -= 1;
      const near = [0, -5, 5, -10, 10, -15, 15, -20, 20, -30, 30].map(dy => Geo.pointAt(line, s + dy / YD))
        .filter(p => Geo.along(line, p).m > Geo.along(line, from).m + 20);
      const safe = near.find(p => inFairway(course, n, p) && (nearestTrouble(course, n, p, M)?.gap ?? 999) >= 0) || near[0];
      let lp = safe, club = safe ? pickShot(course, n, "layup", from, safe)?.club : null, byClub = false;
      const longest = bag.filter(c => !/driver/i.test(c.name))[0];
      if (!lp || (longest && Geo.yd(from, lp) > reachYd(slug, clubVal(longest, "total")) + 5)) {   // can't get that far: the longest layup
        club = longest; lp = clubSpot(course, n, "layup", from, longest); byClub = true;
        why.push(`lay up with ${longest.name}, leaving ${Math.round(Geo.yd(lp, h.greenCenter))}`);
      } else why.push(`lay up to ${Math.round(Geo.yd(lp, h.greenCenter))} for a full ${w ? w.name : "wedge"}`);
      if (lp) { out.layup = { p: lp, club: club?.name || null, clubSet: byClub, byClub }; from = lp; }
    }
  }
  // approach: the middle of the green, leaning away from a guarded side on Safe and Balanced
  const aim = aimSpot(course, n, from, strat), ak = out.goer || pickShot(course, n, "approach", from, aim.p)?.name;
  out.approach = { p: aim.p, club: ak || null, clubSet: !!out.goer, byClub: false }; delete out.goer;
  why.push(out.approach.clubSet ? (aim.note ? `aim ${aim.note}` : "") : `${ak ? ak + " " : ""}${aim.note || "to the middle of the green"}`);
  out.danger = dangerSide(course, n, from, h.greenCenter);
  const s = why.filter(Boolean).join("; "); out.reason = s[0].toUpperCase() + s.slice(1) + ".";
  out.auto = strat;
  return out;
}
function autoPlan(slug, tees, strat) {
  const course = A.courses[slug], st = STRATEGIES[strat];
  const p = { id: Store.id(), course: slug, tees, name: `${meta(slug).name} · ${tees} · Auto-plan (${st.label}) · ${new Date().toLocaleDateString()}`, created: Date.now(), holes: {}, strategy: strat };
  course.holes.forEach(h => { p.holes[h.n] = autoPlanHole(course, h.n, tees, strat); });
  Store.savePlan(p); return p;
}

// ---------------------------------------------------------------- screens
// ---- feedback: a pre-filled email with the app version and where the tester was
A.where = { screen: "Home" };
function feedbackHref() {
  const w = A.where || {}, m = w.course ? meta(w.course) : null;
  const body = [`App version: ${APP_VERSION}`, `Screen: ${w.screen || "?"}`, m ? `Course: ${m.name} · ${m.course}` : "Course: —", `Hole: ${w.hole || "—"}`,
    `Phone: ${navigator.userAgent}`, "", "What happened, and what did you expect?", ""].join("\n");
  return `mailto:aaronweinard@gmail.com?subject=${encodeURIComponent(`Koan Golf feedback (${APP_VERSION})`)}&body=${encodeURIComponent(body)}`;
}
const feedbackLink = () => `<a class="fb" href="${feedbackHref()}">Feedback</a>`;
function screen(title, back, body, where = {}, opts = {}) {
  const sc = shell({ screen: title, ...where }, opts.tab || A.tab || "home", opts.tabs !== false);
  const s = el(`<div class="bar">${back ? '<button class="back" aria-label="Back">‹</button>' : ""}<h1>${esc(title)}</h1></div>`);
  const bd = el(`<div class="body"></div>`); sc.append(s, bd);
  if (back) $(".back", s).onclick = back;
  if (typeof body === "string") bd.innerHTML = body; return bd;
}

// ---------------------------------------------------------------- brand pieces
// the Enso: an open brush circle in brass with a flagstick and a claret flag (the designer's drawing, used exactly).
// On dark: ivory stick and the cup; on light: hunter stick, no cup.
const ENSO = (px = 120, light = false) => `<svg class="enso" width="${px}" height="${px}" viewBox="0 0 170 170" role="img" aria-label="Koan Golf">
  <path d="M118 28 C88 10 40 18 24 58 C8 98 34 146 80 150 C122 154 152 122 150 84 C149 66 142 52 132 42" fill="none" stroke="#B08D57" stroke-width="13" stroke-linecap="round"/>
  <path d="M126 36 C100 20 52 24 34 60" fill="none" stroke="#B08D57" stroke-width="5" stroke-linecap="round" opacity="0.55"/>
  <path d="M30 104 C40 132 64 146 90 146" fill="none" stroke="#C9A773" stroke-width="3" stroke-linecap="round" opacity="0.6"/>
  <path d="M85 112 V58" stroke="${light ? "#1E3A2B" : "#F6F1E4"}" stroke-width="3" stroke-linecap="round"/>
  <path d="M85 58 L104 65 L85 72 Z" fill="#9E2A38"/>${light ? "" : `
  <ellipse cx="85" cy="113" rx="9" ry="3" fill="#F6F1E4" opacity="0.9"/>`}</svg>`;
// the small mark (Clubhouse, member card, course header): the app-icon version, the Enso on a rounded hunter square
// with a thicker circle and stick, a brighter flag and only the main circle stroke
const ENSO_MARK = (px = 34) => `<svg class="crest" width="${px}" height="${px}" viewBox="0 0 170 170" role="img" aria-label="Koan Golf">
  <rect width="170" height="170" rx="38" fill="#1E3A2B"/><g transform="translate(85 85) scale(.8) translate(-87 -84)">
  <path d="M118 28 C88 10 40 18 24 58 C8 98 34 146 80 150 C122 154 152 122 150 84 C149 66 142 52 132 42" fill="none" stroke="#B08D57" stroke-width="15" stroke-linecap="round"/>
  <path d="M85 112 V58" stroke="#F6F1E4" stroke-width="6" stroke-linecap="round"/><path d="M85 58 L104 65 L85 72 Z" fill="#C2414F"/></g></svg>`;
const CREST = ENSO_MARK, LOGO = ENSO_MARK;
// the wordmark: KOAN (Plus Jakarta Sans Light, spaced capitals) over GOLF (Jost, small, widely spaced)
const WORDMARK_FULL = (light = false, size = 34) => `<span class="kwm${light ? " light" : ""}" style="--kw:${size}px"><b>KOAN</b><i>GOLF</i></span>`;
const TAGLINE = "Forever unsolved. Never perfected. Endlessly pursued.";
const WORDMARK = `<span class="wordmark"><b>Koan Golf</b><i>${TAGLINE}</i></span>`;
const initials = name => (name || "").trim().split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase() || "KG";
const greeting = () => { const h = new Date().getHours(); return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"; };
const TEE_COLORS = { gold: "#D4A72C", black: "#111111", duncan: "#111111", championship: "#111111", blue: "#2F80ED", white: "#FFFFFF",
  red: "#FF5A3C", green: "#2E8B57", silver: "#B8BEC5", long: "#145440" };
const TEE_FALLBACK = ["#111111", "#2F80ED", "#FFFFFF", "#D4A72C", "#FF5A3C", "#2E8B57", "#8E44AD"];
const teeColor = (name, i) => TEE_COLORS[name.toLowerCase()] || TEE_FALLBACK[i % TEE_FALLBACK.length];
// a simple illustrated strip: layered fairway hills and a flag, varied per course
function stripSVG(seed = "x", h = 86) {
  let k = 0; for (const ch of seed) k = (k * 31 + ch.charCodeAt(0)) % 997;
  const a = 20 + k % 30, b = 45 + k % 25, f = 60 + k % 25;
  return `<svg class="strip" viewBox="0 0 300 ${h}" preserveAspectRatio="none" width="100%" height="${h}" aria-hidden="true">
    <rect width="300" height="${h}" fill="#145440"/><path d="M0 ${h * .55} Q ${a * 3} ${h * .25} ${b * 3} ${h * .5} T 300 ${h * .4} V ${h} H0Z" fill="#1E6B51"/>
    <path d="M0 ${h * .8} Q ${b * 2} ${h * .55} ${f * 3} ${h * .72} T 300 ${h * .66} V ${h} H0Z" fill="#2E8B57"/>
    <ellipse cx="${f * 3.2}" cy="${h * .7}" rx="26" ry="7" fill="#7FC96B"/><rect x="${f * 3.2}" y="${h * .28}" width="2" height="${h * .42}" fill="#fff"/>
    <path d="M${f * 3.2 + 2} ${h * .28} l14 4 -14 4z" fill="#C5F04A"/></svg>`;
}
const TAB_ICONS = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M4 11 12 4l8 7v9h-5v-6H9v6H4z"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M7 21V3"/><path d="M7 4l11 3.5L7 11" fill="currentColor"/><ellipse cx="10" cy="20.5" rx="6" ry="1.6"/></svg>',
  practice: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r=".8" fill="currentColor"/></svg>',
  stats: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 20V12M12 20V5M19 20v-9"/></svg>',
};
function tabBar(active) {
  const t = el(`<nav class="tabs" aria-label="Main">${[["home", "Clubhouse"], ["play", "Play"], ["practice", "Practice"], ["stats", "Record"]].map(([k, l]) =>
    `<button data-tab="${k}" class="${k === active ? "on" : ""}" ${k === active ? 'aria-current="page"' : ""}>${TAB_ICONS[k]}<span>${l.toUpperCase()}</span><i class="dot"></i></button>`).join("")}</nav>`);
  t.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => ({ home, play: playPage, practice: practicePage, stats: statsPage })[b.dataset.tab]());
  return t;
}
// a page frame with the tab bar (most screens) or without it (setup)
function shell(where, tab = A.tab || "home", tabs = true) {
  app.innerHTML = ""; A.where = where; if (tabs) A.tab = tab; stopMap();
  const sc = el(`<div class="screen${tabs ? "" : " notabs"}"></div>`); app.appendChild(sc);
  if (tabs) app.appendChild(tabBar(tab));
  return sc;
}

// ---------------------------------------------------------------- practice sessions (saved by the practice pages)
function practiceLogs() {
  const out = [];
  try { Object.keys(localStorage).filter(k => k.startsWith("driven-practice:") && k.endsWith(":log")).forEach(k => {
    const title = k.slice("driven-practice:".length, -":log".length), entries = JSON.parse(localStorage.getItem(k) || "[]");
    const m = A.index.find(c => c.practice && title.startsWith(c.name.split(" ")[0]));
    entries.forEach(e => out.push({ ...e, title, url: m?.practice, course: m?.slug }));
  }); } catch {}
  return out.sort((a, b) => b.t - a.t);
}
function practiceSessions() {           // one session = one practice page on one day
  const by = {};
  practiceLogs().forEach(e => { const day = new Date(e.t).toDateString(), k = e.title + "|" + day;
    (by[k] = by[k] || { title: e.title, url: e.url, t: e.t, shots: [] }).shots.push(e); });
  return Object.values(by).sort((a, b) => b.t - a.t);
}
// "Your focus": the top practice prescription, always with a drill (js/drills.js: focusCard)
// the courses as a ruled list grouped by club
function clubList(container) {
  const clubs = [...new Set(A.index.map(c => c.name))].map(name => ({ name, courses: A.index.filter(c => c.name === name) }));
  clubs.forEach(club => {
    const one = club.courses.length === 1, c0 = club.courses[0];
    if (one) { const it = el(`<div class="item"><div class="grow"><b>${esc(club.name)}</b><small>${esc(c0.course)} · ${esc(c0.city)}</small></div><span>›</span></div>`);
      it.onclick = () => coursePage(c0.slug); container.appendChild(it); return; }
    container.appendChild(el(`<div class="item" style="cursor:default"><div class="grow"><b>${esc(club.name)}</b><small>${esc(c0.city)}</small></div></div>`));
    club.courses.forEach(c => { const sub = el(`<div class="item sub"><div class="grow"><b style="font-size:15px">${esc(c.course)}</b></div><span>›</span></div>`);
      sub.onclick = () => coursePage(c.slug); container.appendChild(sub); });
  });
}
async function home() {
  if (!A.index.length) await loadIndex();
  const sc = shell({ screen: "Clubhouse" }, "home"), pr = A.profile, age = daysSince(pr.hcpDate);
  // today's round: a plan I haven't played yet, else my last round, else my home course
  const lastR = Store.rounds().sort((a, b) => b.date - a.date)[0], lastP = Store.plans().sort((a, b) => b.created - a.created)[0];
  let next;
  if (lastP && (!lastR || lastP.created > lastR.date) && meta(lastP.course).name) next = { slug: lastP.course, tees: lastP.tees, why: `Planned · ${lastP.name}` };
  else if (lastR && meta(lastR.course).name) next = { slug: lastR.course, tees: lastR.tees, why: "Last played" };
  else { const slug = pr.homeCourse || A.index[0].slug, c = await loadCourse(slug); next = { slug, tees: pr.prefTees?.[slug] || c.teeOrder[0], why: "Your home course" }; }
  const nm = meta(next.slug), hc = pr.homeCourse ? meta(pr.homeCourse) : null;
  sc.appendChild(el(`<div class="hero"><div class="top">${ENSO_MARK(34)}<div class="grow"><span class="wordmark"><b>Koan Golf</b></span></div><button class="avatar" id="av" aria-label="Member Profile">${esc(initials(pr.name))}</button></div>
    <div class="caps eyebrow">The Clubhouse</div>
    <h1>${greeting()}${pr.name ? `, ${esc(pr.name.split(" ")[0])}` : ""}.</h1>
    <div class="caps hcpline">${pr.hcp !== "" && pr.hcp != null ? `Handicap ${esc(pr.hcp)}` : "Handicap —"}${hc ? ` · ${esc(hc.name)}` : ""}</div></div>`));
  $("#av", sc).onclick = profilePage;
  const b = el(`<div class="body"></div>`); sc.appendChild(b);
  tourNote(b);                                              // existing members: "New: take the tour", once
  b.appendChild(el(`<h2>Today's round</h2>`));
  const nu = el(`<div class="card nextup"><div class="muted it">${esc(next.why)}</div><div class="cname">${esc(nm.name)}</div>
    <div class="muted">${esc(nm.course)} · ${esc(next.tees)} tees</div>
    <button class="btn" id="go">Tee off</button>
    <div class="row"><button class="btn alt" id="pl">Plan a round</button><button class="btn alt" id="pr">Practice</button></div></div>`);
  $("#go", nu).onclick = () => startRound(next.slug, next.tees);
  $("#pl", nu).onclick = planWizard;
  $("#pr", nu).onclick = () => nm.practice ? (location.href = nm.practice) : practicePage();
  b.appendChild(nu);
  if (age != null && age >= 14) b.appendChild(el(`<div class="warn">Your index was last updated ${age} days ago. <a href="https://www.ghin.com/" target="_blank" rel="noopener">Look up on GHIN</a>, then update it in your profile.</div>`));
  const lastEx = daysSince(Store.get("lastExport", null));
  if (Store.rounds().length && (lastEx == null || lastEx >= 30)) {
    const bk = el(`<div class="warn">Back up your rounds: ${lastEx == null ? "you haven't exported yet" : `last backup ${lastEx} days ago`}. <button class="linkbtn" id="bk">Export my data</button></div>`);
    $("#bk", bk).onclick = exportData; b.appendChild(bk);
  }
  b.appendChild(el(`<h2>From the practice tee</h2>`));
  focusCard(b);
  b.appendChild(el(`<h2>The courses</h2>`));
  const cl = el(`<div class="list"></div>`); clubList(cl); b.appendChild(cl);
  b.appendChild(el(`<h2>Recent</h2>`));
  const items = Store.rounds().map(r => ({ t: r.date, kind: "r", r })).concat(practiceSessions().map(p => ({ t: p.t, kind: "p", p }))).sort((a, b) => b.t - a.t).slice(0, 6);
  const rl = el(`<div class="list"></div>`);
  if (!items.length) rl.appendChild(el(`<p class="muted it">No rounds or practice yet.</p>`));
  items.forEach(x => {
    if (x.kind === "r") { const r = x.r, tot = Object.values(r.holes).reduce((s2, h) => s2 + (h.score || 0), 0);
      const it = el(`<div class="item"><div class="grow"><b>${esc(meta(r.course).name || r.course)}</b><small>Round · ${esc(meta(r.course).course || "")} · ${new Date(r.date).toLocaleDateString()} · ${esc(r.tees)} tees</small></div><b class="num" style="font:300 22px var(--head)">${tot || "–"}</b><span>›</span></div>`);
      it.onclick = () => roundSummary(r.id); rl.appendChild(it);
    } else { const p = x.p, in6 = p.shots.filter(e => e.ft <= 6).length;
      const it = el(`<div class="item"><div class="grow"><b>${esc(p.title)}</b><small>Practice · ${new Date(p.t).toLocaleDateString()} · ${p.shots.length} shots, ${in6} inside 6 ft</small></div><span>›</span></div>`);
      it.onclick = () => { if (p.url) location.href = p.url; }; rl.appendChild(it); }
  });
  b.appendChild(rl);
}

// ---------------------------------------------------------------- Play: plan, or find a club / course
async function playPage() {
  if (!A.index.length) await loadIndex();
  const b = screen("Play", null, "", {}, { tab: "play" });
  const pl = el(`<button class="btn go">Plan a round</button>`); pl.onclick = planWizard; b.appendChild(pl);
  b.appendChild(el(`<h2>Courses</h2>`));
  const search = el(`<input type="search" placeholder="Search clubs or courses" aria-label="Search clubs or courses">`);
  const list = el(`<div class="card list"></div>`);
  b.append(search, list);
  const clubsOf = () => [...new Set(A.index.map(c => c.name))].map(name => ({ name, courses: A.index.filter(c => c.name === name) }));
  const open = new Set();
  function drawCourses() {
    const q = search.value.trim().toLowerCase(); list.innerHTML = "";
    let shown = 0;
    clubsOf().forEach(club => {
      const clubHit = q && club.name.toLowerCase().includes(q), hits = club.courses.filter(c => q && c.course.toLowerCase().includes(q));
      if (q && !clubHit && !hits.length) return;
      shown++;
      const one = club.courses.length === 1, c0 = club.courses[0];
      const it = el(`<div class="item"><div class="grow"><b>${esc(club.name)}</b><small>${esc(c0.city)} · ${one ? esc(c0.course) : `${club.courses.length} courses`}</small></div><span>${one ? "›" : open.has(club.name) || hits.length ? "▾" : "▸"}</span></div>`);
      it.onclick = () => { if (one) return coursePage(c0.slug); open.has(club.name) ? open.delete(club.name) : open.add(club.name); drawCourses(); };
      list.appendChild(it);
      if (!one && (open.has(club.name) || hits.length)) club.courses.forEach(c => {
        const sub = el(`<div class="item sub${hits.includes(c) ? " hit" : ""}"><div class="grow"><b>${esc(c.course)}</b></div><span>›</span></div>`);
        sub.onclick = () => coursePage(c.slug); list.appendChild(sub);
      });
    });
    if (!shown) list.appendChild(el(`<p class="muted">No club or course matches “${esc(search.value)}”.</p>`));
  }
  search.oninput = drawCourses; drawCourses();
}

// ---------------------------------------------------------------- Practice: the practice areas and recent sessions
async function practicePage() {
  if (!A.index.length) await loadIndex();
  const b = screen("Practice", null, "", {}, { tab: "practice" });
  b.appendChild(el(`<h2>From the practice tee</h2>`)); focusCard(b);
  sessionBuilder(b);
  setTimeout(() => tipOnce("practice", [{ sel: ".focus", text: "Your focus comes from your rounds, with a drill to fix it. Build a session for the time you have, or open a practice area to log chips and putts." }]), 900);
  const drillsBox = el(`<div style="display:contents"></div>`); b.appendChild(drillsBox);
  b.appendChild(el(`<h2>Practice areas</h2>`));
  const seen = new Set(), list = el(`<div class="list"></div>`);
  A.index.filter(c => c.practice && !seen.has(c.practice) && seen.add(c.practice)).forEach(c => {
    const n = practiceLogs().filter(e => e.url === c.practice).length;
    list.appendChild(el(`<a class="item" style="text-decoration:none;color:inherit" href="${esc(c.practice)}"><div class="grow"><b>${esc(c.name)}</b><small>Short-game area · ${esc(c.city)}${n ? ` · ${n} shots logged` : ""}</small></div><span>›</span></a>`));
  });
  b.appendChild(list);
  b.appendChild(el(`<h2>Recent sessions</h2>`));
  const rs = el(`<div class="list"></div>`), ses = practiceSessions().slice(0, 10);
  drillLog().slice(-10).reverse().forEach(e => { const it = el(`<div class="item"><div class="grow"><b>${esc(e.drill)}${e.harder ? " (harder)" : ""}</b><small>${new Date(e.t).toLocaleDateString()} · drill · ${esc(scoreText(e))}${e.passed ? " · goal passed" : ""} · ${Math.max(1, Math.round(e.secs / 60))} min</small></div><span>›</span></div>`);
    it.onclick = () => prescriptionPage(e.drill); rs.appendChild(it); });
  if (!ses.length && !drillLog().length) rs.appendChild(el(`<p>No practice logged yet. Build a session above, or open a practice area, place your ball, hit, then Mark finish.</p>`));
  ses.forEach(p => { const in6 = p.shots.filter(e => e.ft <= 6).length, avg = Math.round(p.shots.reduce((a, e) => a + e.ft, 0) / p.shots.length);
    const it = el(`<div class="item"><div class="grow"><b>${esc(p.title)}</b><small>${new Date(p.t).toLocaleDateString()} · ${p.shots.length} shots · average ${avg} ft left · ${in6} inside 6 ft</small></div><span>›</span></div>`);
    it.onclick = () => { if (p.url) location.href = p.url; }; rs.appendChild(it); });
  b.appendChild(rs);
  drillSections(drillsBox);
}

// ---------------------------------------------------------------- Stats: rounds (filtered per course group) and putting
async function statsPage() {
  if (!A.index.length) await loadIndex();
  const b = screen("Record", null, "", {}, { tab: "stats" });
  const groups = ["All", ...new Set(A.index.map(c => c.group))];
  let gsel = Store.get("roundFilter", "All"); if (!groups.includes(gsel)) gsel = "All";
  const rounds = Store.rounds().sort((a, b2) => b2.date - a.date).filter(r => gsel === "All" || meta(r.course).group === gsel);
  const fl = el(`<div class="chips">${groups.map(g => `<button class="chip${g === gsel ? " on" : ""}" data-g="${esc(g)}">${g === "18" ? "Full courses" : esc(g)}</button>`).join("")}</div>`);
  fl.querySelectorAll("[data-g]").forEach(x => x.onclick = () => { Store.set("roundFilter", x.dataset.g); statsPage(); });
  b.appendChild(fl);
  const holes = rounds.flatMap(r => Object.values(r.holes)), avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  const pp = holes.filter(h => h.putts != null).map(h => h.putts), fp = holes.filter(h => h.firstPuttFt != null).map(h => h.firstPuttFt), lv = holes.filter(h => h.leaveFt != null && h.putts >= 2).map(h => h.leaveFt);
  const ps = practiceLogs(), in6 = ps.length ? Math.round(100 * ps.filter(e => e.ft <= 6).length / ps.length) : null;
  b.appendChild(el(`<div class="card"><div class="stat">
    <div><b>${rounds.length}</b><span>rounds${gsel !== "All" ? ` (${gsel === "18" ? "full courses" : esc(gsel)})` : ""}</span></div>
    <div><b>${avg(pp) != null ? avg(pp).toFixed(1) : "–"}</b><span>putts per hole</span></div>
    <div><b>${avg(fp) != null ? Math.round(avg(fp)) + " ft" : "–"}</b><span>average first putt</span></div>
    <div><b>${avg(lv) != null ? Math.round(avg(lv)) + " ft" : "–"}</b><span>first-putt leave</span></div>
    <div><b>${in6 != null ? in6 + "%" : "–"}</b><span>practice chips inside 6 ft</span></div></div></div>`));
  // putting: rounds (this filter) beside the practice green
  const rs = puttStats(roundPuttSeqs(holes)), pr = puttStats(practicePutts().map(sq => sq.putts));
  const counted = holes.filter(h => h.putts != null), three = counted.filter(h => h.putts >= 3).length;
  const cell = (a, n2) => n2 ? `${pctOf(a, n2)}% <small class="muted">${a}/${n2}</small>` : "–";
  b.appendChild(el(`<h2>Putting</h2>`));
  b.appendChild(el(`<div class="card"><div class="tablewrap"><table class="t"><tr><th></th><th>Rounds</th><th>Practice</th></tr>
    <tr><td>Three-putts</td><td>${cell(three, counted.length)}</td><td>${cell(pr.three, pr.holes)}</td></tr>
    ${rs.buckets.map((x, i) => `<tr><td>Made from ${x.label}</td><td>${cell(x.made, x.n)}</td><td>${cell(pr.buckets[i].made, pr.buckets[i].n)}</td></tr>`).join("")}
    <tr><td>Lags from 30+ ft inside 3 ft</td><td>${cell(rs.lagIn, rs.lagN)}</td><td>${cell(pr.lagIn, pr.lagN)}</td></tr></table></div>
    <p class="muted">Log each putt with Log putts on the green, or on a practice page's putting green. Lag = a putt from over 30 ft that goes in or finishes within 3 ft.</p></div>`));
  const pens = rounds.map(r => Object.values(r.holes).reduce((t, hh) => { const p = penOf(hh); t.ob += p.ob; t.pa += p.pa; t.other += p.other; return t; }, { ob: 0, pa: 0, other: 0 }));
  const pRow = (lab, k) => `<tr><td>${lab}</td><td class="num">${pens.reduce((a, p) => a + p[k], 0)}</td><td class="num">${rounds.length ? (pens.reduce((a, p) => a + p[k], 0) / rounds.length).toFixed(1) : "–"}</td></tr>`;
  b.appendChild(el(`<h2>Penalty strokes</h2>`));
  b.appendChild(el(`<div class="card"><div class="tablewrap"><table class="t"><tr><th></th><th>Total</th><th>Per round</th></tr>
    ${pRow("Out of bounds", "ob")}${pRow("Penalty area", "pa")}${pens.some(p => p.other) ? pRow("Other", "other") : ""}</table></div>
    <p class="muted">Out of bounds is stroke and distance: one stroke, then you play again from where you hit it. A penalty area (water, red or yellow stakes) is one stroke, then you play from your drop.${pens.some(p => p.other) ? " Other = Other penalty +1, plus all penalties in rounds logged before version 0.9.7." : ""}</p></div>`));
  b.appendChild(el(`<h2>By lie</h2>`)); lieStatsCard(b);
  b.appendChild(el(`<h2>Rounds</h2>`));
  const rl = el(`<div class="card list"></div>`);
  if (!rounds.length) rl.appendChild(el(`<p>No rounds here yet. Pick a course on Play, then Start a round.</p>`));
  rounds.slice(0, 30).forEach(r => {
    const tot = Object.values(r.holes).reduce((s2, h) => s2 + (h.score || 0), 0);
    const it = el(`<div class="item"><div class="grow"><b>${esc(meta(r.course).name || r.course)}</b><small>${esc(meta(r.course).course || "")} · ${new Date(r.date).toLocaleDateString()} · ${esc(r.tees)} tees${r.planId ? " · with plan" : ""}</small></div><b class="num">${tot || "–"}</b><span>›</span></div>`);
    it.onclick = () => roundSummary(r.id); rl.appendChild(it);
  });
  b.appendChild(rl);
}

// ---------------------------------------------------------------- course page
async function coursePage(slug) {
  const course = await loadCourse(slug); const m = meta(slug);
  const sc = shell({ screen: "Course", course: slug });
  const prefTee = A.settings.prefTees?.[slug];
  let tee = [prefTee, Store.get("lastTee:" + slug, null), course.teeOrder[0]].find(t => t && course.teeOrder.includes(t));
  const [city, st] = m.city.split(",").map(x => x.trim());
  sc.appendChild(el(`<div class="chead"><div style="display:flex;align-items:center;gap:10px"><button class="iconbtn" id="bk" aria-label="Back">‹</button><span style="flex:1"></span>${ENSO_MARK(26)}</div>
    <h1>${esc(m.name)}</h1><div class="caps sub2">${esc(city)}${st ? `, ${esc(st)}` : ""} · Par ${course.par.reduce((a, c) => a + c, 0)}${m.course && !/^Championship|^18 holes/.test(m.course) ? ` · ${esc(m.course)}` : ""}</div></div>`));
  $("#bk", sc).onclick = () => (A.tab === "play" ? playPage() : home());
  const b = el(`<div class="body"></div>`); sc.appendChild(b);
  b.appendChild(el(`<h2>Select your tees</h2>`));
  const tc = el(`<div class="card" style="padding:6px"><table class="teetable"></table></div>`); b.appendChild(tc);
  const strip = el(`<div class="tablewrap"></div>`); b.appendChild(strip);
  const dock = el(`<div class="dock"><button class="btn" id="startRound"></button></div>`);
  const drawTees = () => {
    const box = $(".teetable", tc); box.innerHTML = "";
    course.teeOrder.forEach((t, i) => { const r = el(`<tr class="${t === tee ? "on" : ""}" aria-selected="${t === tee}"><td style="width:28px"><span class="sq" style="background:${teeColor(t, i)}"></span></td>
      <td class="tn">${esc(t)}${t === prefTee ? "<i>your tees</i>" : ""}</td><td class="yd">${course.tees[t].reduce((a, c) => a + c, 0).toLocaleString()}</td></tr>`);
      r.onclick = () => { tee = t; Store.set("lastTee:" + slug, t); drawTees(); }; box.appendChild(r); });
    // front nine from the selected tees
    const nine = course.holes.slice(0, 9), y = nine.map(h => course.tees[tee][h.n - 1]), pr = nine.map(h => h.par);
    strip.innerHTML = `<table class="scorecard"><tr><th>Hole</th>${nine.map(h => `<th>${h.n}</th>`).join("")}<th>Out</th></tr>
      <tr><td>Yds</td>${y.map(v => `<td>${v}</td>`).join("")}<td class="out">${y.reduce((a, c) => a + c, 0).toLocaleString()}</td></tr>
      <tr><td>Par</td>${pr.map(v => `<td>${v}</td>`).join("")}<td class="out">${pr.reduce((a, c) => a + c, 0)}</td></tr></table>`;
    $("#startRound", dock).textContent = `Tee off from the ${tee} tees`;
  };
  const nav = el(`<div class="list">
    <div class="navrow" id="plan"><div class="grow"><b>Plan this round</b><small>Targets, clubs and a planned score</small></div><span>›</span></div>
    <div class="navrow" id="browse"><div class="grow"><b>The yardage book</b><small>Every hole: yardages, hazards and greens</small></div><span>›</span></div>
    ${m.practice ? `<a class="navrow" style="text-decoration:none;color:inherit" href="${esc(m.practice)}"><div class="grow"><b>Practice area</b><small>Short-game greens</small></div><span>›</span></a>` : ""}</div>`);
  b.appendChild(nav);
  if (m.unconfirmedTees) b.appendChild(el('<div class="warn">These yardages are measured from the map, not the scorecard. Check them against the card at the course.</div>'));
  if (m.teeShots === "shortgame") b.appendChild(el('<div class="muted it">Tee shots here count as short-game shots in your record.</div>'));
  else if (m.teeShots === "approach") b.appendChild(el('<div class="muted it">Par-3 tee shots here count as approach shots in your record.</div>'));
  drawTees();
  $("#startRound", dock).onclick = () => startRound(slug, tee);
  $("#plan", nav).onclick = () => newPlan(slug, tee);
  $("#browse", nav).onclick = () => holeView({ mode: "browse", slug, tees: tee, n: 1, pins: {} });
  const plans = Store.plans().filter(p => p.course === slug).sort((a, b2) => b2.created - a.created);
  b.appendChild(el(`<h2>Plans</h2>`));
  const pl = el(`<div class="list"></div>`);
  if (!plans.length) pl.appendChild(el(`<p class="muted it">No plans yet for this course.</p>`));
  plans.forEach(p => { const it = el(`<div class="item"><div class="grow"><b>${esc(p.name)}</b><small>${esc(p.tees)} tees · planned ${planTotal(p) || "–"}</small></div><span>›</span></div>`);
    it.onclick = () => planSummary(p.id); pl.appendChild(it); });
  b.appendChild(pl);
  b.appendChild(el(`<div style="height:70px"></div>`));
  sc.appendChild(dock);
}

// Plan a round: club -> course (when the club has more than one) -> tees (my preferred tees first) -> hole-by-hole plan
// Plan a round: plan it myself, or Auto-plan (Safe / Balanced / Aggressive) builds every hole from My Bag; then club → course → tees
function planWizard() {
  const md = modal(`<h3 style="margin:0">Plan a round</h3>
    <div class="card" style="gap:8px"><b class="head" style="font:500 17px var(--head)">Auto-plan</b><p>Every hole planned from your bag, the hazards and your tees, with a middle pin. You can change anything after.</p>
      <div class="seg" id="strat">${Object.entries(STRATEGIES).map(([k, v]) => `<button data-s="${k}" class="${k === "balanced" ? "on" : ""}" style="flex:1;text-align:center">${v.label}</button>`).join("")}</div>
      <div class="muted" id="sblurb">${STRATEGIES.balanced.blurb}</div>
      <button class="btn" id="auto">Auto-plan</button></div>
    <button class="btn alt" id="self">Plan it myself</button><button class="linkbtn" id="wx0" style="align-self:center">Cancel</button>`);
  let strat = "balanced";
  md.querySelectorAll("[data-s]").forEach(b => b.onclick = () => { strat = b.dataset.s; md.querySelectorAll("[data-s]").forEach(x => x.classList.toggle("on", x === b)); $("#sblurb", md).textContent = STRATEGIES[strat].blurb; });
  $("#wx0", md).onclick = () => md.remove();
  $("#self", md).onclick = () => { md.remove(); pickCourse(null); };
  setTimeout(() => tipOnce("autoplan", [{ sel: "#strat", text: "Auto-plan plans all 18 holes from your bag: Safe stays wide of trouble and lays up more, Balanced takes the longest club that stays safe, Aggressive takes tighter lines. Or plan it yourself, hole by hole." }], md), 300);
  $("#auto", md).onclick = () => {
    if (A.bag.filter(c => c.carry > 0).length < 3) return toast("Auto-plan needs your club yardages. Add them in My Bag (Member Profile).", 3500);
    md.remove(); pickCourse(strat);
  };
}
function pickCourse(strat) {
  const clubs = [...new Set(A.index.map(c => c.name))];
  const step = (title, items, pick) => {
    const md = modal(`<h3 style="margin:0">${esc(title)}</h3><div class="list" id="wl"></div><button class="btn alt" id="wx">Cancel</button>`);
    items.forEach(([label, sub, v]) => { const it = el(`<div class="item"><div class="grow"><b>${esc(label)}</b>${sub ? `<small>${esc(sub)}</small>` : ""}</div><span>›</span></div>`);
      it.onclick = () => { md.remove(); pick(v); }; $("#wl", md).appendChild(it); });
    $("#wx", md).onclick = () => md.remove();
  };
  const tees = async slug => {
    const course = await loadCourse(slug), pref = A.settings.prefTees?.[slug];
    const order = pref && course.teeOrder.includes(pref) ? [pref, ...course.teeOrder.filter(t => t !== pref)] : course.teeOrder;
    step(`${meta(slug).name} · ${meta(slug).course} · tees`, order.map(t => [t, `${course.tees[t].reduce((a, c) => a + c, 0).toLocaleString()} yd${t === pref ? " · your preferred tees" : ""}`, t]),
      t => strat ? planSummary(autoPlan(slug, t, strat).id) : newPlan(slug, t));
  };
  step(strat ? `Auto-plan (${STRATEGIES[strat].label}) · club` : "Plan a round · club", clubs.map(n => [n, A.index.find(c => c.name === n).city, n]), name => {
    const courses = A.index.filter(c => c.name === name);
    if (courses.length === 1) return tees(courses[0].slug);
    step(`${name} · course`, courses.map(c => [c.course, null, c.slug]), tees);
  });
}

// ---------------------------------------------------------------- Player Profile (with My Bag)
const isWedge = name => /wedge|^(pw|gw|aw|sw|lw)$|\d\d\s*°/i.test(name.trim());
const daysSince = t => t ? Math.floor((Date.now() - t) / 86400000) : null;
// only speak up when something looks off, one plain sentence each
function bagWarnings(bag) {
  const out = [], b = bag.filter(c => c.carry > 0).slice().sort((x, y) => y.carry - x.carry);
  b.forEach((c, i) => {
    const nx = b[i + 1];
    if (nx && c.carry - nx.carry > 20) out.push(`Big gap: ${c.name} to ${nx.name} is ${c.carry - nx.carry} yards.`);
    if (nx && c.carry - nx.carry < 5) out.push(`Your ${c.name} and ${nx.name} go about the same distance.`);
    if (c.total && c.total < c.carry) out.push(`Your ${c.name} total (${c.total}) is shorter than its carry (${c.carry}).`);
  });
  if (bag.length > 14) out.push(`That's ${bag.length} clubs; the rules allow 14.`);
  return out;
}
// learning: where my logged shots finished vs my bag numbers, full swings only (at least 75% of the bag number), 5+
// shots, suggested when the typical shot differs by 5+ yards. A logged shot ends where the ball stopped, so all shots
// estimate total; shots that finished on the green barely roll, so those also estimate carry.
function bagLearning() {
  const tot = {}, car = {};
  Store.rounds().forEach(r => Object.values(r.holes).forEach(hh => {
    const sh = hh.shots || [];
    for (let i = 0; i < sh.length - 1; i++) {
      const c = sh[i].club; if (!c || c === "Putter") continue;
      const d = Geo.yd(playFrom(sh, i), sh[i + 1].p);
      (tot[c] = tot[c] || []).push(d);
      if (sh[i + 1].onGreen) (car[c] = car[c] || []).push(d);
    }
  }));
  const dismissed = Store.get("bagDismiss", {}), out = [];
  const median = ds => Math.round(ds[Math.floor(ds.length / 2)]);
  A.bag.forEach(c => {
    [["total", tot, c.total || c.carry], ["carry", car, c.carry]].forEach(([field, by, now]) => {
      if (!now) return;
      const ds = (by[c.name] || []).filter(d => d >= 0.75 * now).sort((a, b) => a - b);
      if (ds.length < 5) return;
      const med = median(ds);
      if (Math.abs(med - now) < 5 || dismissed[`${c.name}:${field}`] === med || (field === "total" && dismissed[c.name] === med)) return;
      out.push({ c, med, n: ds.length, field });
    });
  });
  return out;
}
// ---------------------------------------------------------------- first-time setup: name, home course, tees, My Bag
function setupWizard() {
  const p = Store.profile(), d = { name: p.name, homeCourse: p.homeCourse || undefined, prefTees: { ...p.prefTees } };   // undefined = not chosen yet
  let bag = Store.bag(); bag = bag.length ? JSON.parse(JSON.stringify(bag)) : Store.starterBag();
  const steps = ["name", "course", "tees", "bag"];
  const go = async i => {
    const b = screen(`Welcome · step ${i + 1} of ${steps.length}`, i ? () => go(i - 1) : null, "", {}, { tabs: false });
    const card = el(`<div class="card"></div>`); b.appendChild(card);
    const next = el(`<button class="btn">${i === steps.length - 1 ? "Finish" : "Next"}</button>`);
    const step = steps[i];
    if (step === "name") {
      card.innerHTML = `<h3>What's your name?</h3><label class="f">Name<input id="n" value="${esc(d.name)}" placeholder="e.g. Sam" autocomplete="name"></label>`;
      const inp = $("#n", card); const ok = () => next.disabled = !inp.value.trim(); inp.oninput = ok; ok();
      next.onclick = () => { d.name = inp.value.trim(); go(i + 1); };
    } else if (step === "course") {
      card.innerHTML = `<h3>Your home course</h3><p class="muted">Where you play most. You can change it later.</p><div class="list" id="l"></div>`;
      const pick = slug => { d.homeCourse = slug; card.querySelectorAll("[data-s]").forEach(x => x.classList.toggle("hit", x.dataset.s === slug)); next.disabled = false; };
      A.index.concat([{ slug: "", name: "None of these", course: "" }]).forEach(c => {
        const it = el(`<div class="item" data-s="${c.slug}"><div class="grow"><b>${esc(c.name)}</b>${c.course ? `<small>${esc(c.course)} · ${esc(c.city)}</small>` : ""}</div></div>`);
        it.onclick = () => pick(c.slug); $("#l", card).appendChild(it); });
      next.disabled = d.homeCourse === undefined; if (d.homeCourse !== undefined) pick(d.homeCourse);
      next.onclick = () => go(d.homeCourse ? i + 1 : i + 2);
    } else if (step === "tees") {
      if (!d.homeCourse) return go(i - 1);                 // "None of these": no home tees to pick
      const course = await loadCourse(d.homeCourse), m = meta(d.homeCourse);
      card.innerHTML = `<h3>Your usual tees at ${esc(m.name)}</h3><p class="muted">Plans and rounds start here. Other courses: set them later in your profile.</p><div class="chips" id="t"></div>`;
      course.teeOrder.forEach(t => { const c = el(`<button class="chip${d.prefTees[d.homeCourse] === t ? " on" : ""}">${esc(t)} · ${course.tees[t].reduce((a, x) => a + x, 0).toLocaleString()} yd</button>`);
        c.onclick = () => { d.prefTees[d.homeCourse] = t; card.querySelectorAll(".chip").forEach(x => x.classList.toggle("on", x === c)); next.disabled = false; };
        $("#t", card).appendChild(c); });
      next.disabled = !d.prefTees[d.homeCourse];
      next.onclick = () => go(i + 1);
    } else {
      card.innerHTML = `<h3>My Bag</h3><p class="muted">For each club: <b>carry</b> (where it lands) and <b>total</b> (where it stops), in yards.
        Example: 7 iron · carry 150 · total 158. Leave out clubs you don't carry; you can edit everything later.</p><div class="bag" id="rows"></div>
        <button class="btn alt" id="add">Add a club</button><div id="msg"></div>`;
      const num = v => v === "" ? null : Math.max(0, Math.round(+v));
      const draw = () => { const rows = $("#rows", card); rows.innerHTML = "";
        bag.forEach((c, k) => { const r = el(`<div class="bagrow"><div class="r1"><input data-f="name" value="${esc(c.name)}" aria-label="Club name"><button class="btn small alt" data-del>✕</button></div>
          <div class="r2"><label>Carry<input data-f="carry" type="number" inputmode="numeric" placeholder="carry" value="${c.carry ?? ""}"></label>
          <label>Total<input data-f="total" type="number" inputmode="numeric" placeholder="total" value="${c.total ?? ""}"></label>
          <label class="chk"><input type="checkbox" data-f="tee" ${c.tee ? "checked" : ""}>Tee club</label></div></div>`);
          r.querySelectorAll("[data-f]").forEach(x => x.onchange = () => { const f = x.dataset.f; c[f] = f === "name" ? x.value.trim() : f === "tee" ? x.checked : num(x.value); });
          $("[data-del]", r).onclick = () => { bag.splice(k, 1); draw(); }; rows.appendChild(r); });
        $("#add", card).disabled = bag.length >= 14; };
      $("#add", card).onclick = () => { bag.push({ id: Store.id(), name: "", carry: null, total: null, tee: false, swings: {} }); draw(); };
      draw();
      next.onclick = () => {
        const keep = bag.filter(c => c.name && c.carry);
        if (!keep.length) { $("#msg", card).innerHTML = '<div class="warn">Enter a carry for at least one club.</div>'; return; }
        Object.assign(p, d); Store.saveProfile(p); Store.saveBag(keep);
        A.profile = Store.profile(); A.bag = Store.bag(); A.settings = Store.settings();
        toast(`Welcome, ${p.name}!`); home();
      };
    }
    b.appendChild(next);
  };
  go(0);
}

// ---------------------------------------------------------------- backups: export / import everything on this phone
async function exportData() {
  const file = Store.exportAll(), name = `koan-golf-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const blob = new Blob([JSON.stringify(file, null, 1)], { type: "application/json" });
  const f = new File([blob], name, { type: "application/json" });
  try {
    if (navigator.canShare && navigator.canShare({ files: [f] })) await navigator.share({ files: [f], title: "Koan Golf backup" });   // text, email, AirDrop
    else { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); }
    Store.set("lastExport", Date.now()); toast("Backup saved");
  } catch (e) { if (e.name !== "AbortError") toast("Couldn't share the file: " + e.message); }
}
function importData() {
  const inp = document.createElement("input"); inp.type = "file"; inp.accept = ".json,application/json";
  inp.onchange = async () => {
    let file; try { file = JSON.parse(await inp.files[0].text()); if (!["Koan Golf", "Driven Golf"].includes(file.app)) throw 0; } catch { return toast("That isn't a Koan Golf backup file."); }
    const n = k => Array.isArray(file.data[k]) ? file.data[k].length : 0;
    const ps = Object.values(file.practice || {}).reduce((t, v) => t + (Array.isArray(v) ? v.length : 0), 0);
    const md = modal(`<h3 style="margin:0">Restore this backup?</h3><p>From ${new Date(file.exportedAt).toLocaleString()} (version ${esc(file.appVersion)}): ${n("rounds")} rounds, ${n("plans")} plans, ${ps} practice shots, profile and bag.</p>
      <p class="warn">This replaces what's on this phone now. A copy of the current data is kept, just in case.</p><div class="row"><button class="btn alt" id="no">Cancel</button><button class="btn" id="yes">Restore</button></div>`);
    $("#no", md).onclick = () => md.remove();
    $("#yes", md).onclick = () => { try { Store.importAll(file); md.remove(); toast("Restored"); setTimeout(() => location.reload(), 600); } catch (e) { toast(e.message); } };
  };
  inp.click();
}

function profileEdit(section) {
  const p = Store.profile(); let bag = JSON.parse(JSON.stringify(Store.bag()));
  const b = screen(section === "bag" ? "Edit clubs" : "Edit profile", profilePage, "", { screen: "Member Profile" });
  const age = daysSince(p.hcpDate);
  const prof = el(`<div class="card"><h3>You</h3>
    <label class="f">Name<input id="pn" value="${esc(p.name)}" autocomplete="name"></label>
    <label class="f">Home course<select id="phc"><option value="">—</option>${A.index.map(c => `<option value="${c.slug}" ${c.slug === p.homeCourse ? "selected" : ""}>${esc(c.name)} · ${esc(c.course)}</option>`).join("")}</select></label>
    <label class="f">Home elevation (feet)<input id="pel" type="number" inputmode="numeric" value="${p.homeElevationFt}"></label>
    <p class="muted" style="margin:0">Used for "plays like" yardages on high-altitude courses (about 2% more carry per 1,000 ft). Twin Cities is about 900 ft.</p>
    <div class="muted">Plays</div><div class="chips" id="phand">${[["R", "Right-handed"], ["L", "Left-handed"]].map(([v, l]) => `<button class="chip${p.hand === v ? " on" : ""}" data-hand="${v}">${l}</button>`).join("")}</div>
    <label class="f">GHIN number<input id="pgh" inputmode="numeric" value="${esc(p.ghin)}"></label>
    <label class="f">Handicap index<input id="phi" inputmode="decimal" value="${esc(p.hcp)}" placeholder="e.g. 12.4"></label>
    <div class="muted">${p.hcpDate ? `Index last updated ${new Date(p.hcpDate).toLocaleDateString()}${age >= 14 ? ` · <b>${age} days ago: time to refresh it</b>` : ""}` : "Type your index from GHIN; the date is saved when you change it."}
      · <a href="https://www.ghin.com/" target="_blank" rel="noopener">Look up on GHIN</a></div></div>`);
  prof.querySelectorAll("[data-hand]").forEach(x => x.onclick = () => { p.hand = x.dataset.hand; prof.querySelectorAll("[data-hand]").forEach(y => y.classList.toggle("on", y === x)); });
  // preferred tees per course
  const pt = el(`<div class="card"><h3>Preferred tees</h3><p class="muted" style="margin:0">Plans and rounds start on these.</p><div id="pt" class="list"></div></div>`);
  A.index.forEach(async m => {
    const course = await loadCourse(m.slug);
    const r = el(`<div class="item" style="cursor:default;flex-wrap:wrap"><div class="grow"><b>${esc(m.name)}</b><small>${esc(m.course)}</small></div><div class="chips"></div></div>`);
    const draw = () => { const box = $(".chips", r); box.innerHTML = "";
      course.teeOrder.forEach(t => { const ch = el(`<button class="chip${p.prefTees[m.slug] === t ? " on" : ""}">${esc(t)}</button>`);
        ch.onclick = () => { p.prefTees[m.slug] = t; draw(); }; box.appendChild(ch); }); };
    draw(); $("#pt", pt).appendChild(r);
  });
  // My Bag
  const bagCard = el(`<div class="card"><h3>My Bag</h3><p class="muted" style="margin:0">Carry = where the ball lands; total = where it stops (rollout = total − carry). Tee shots and layups use total; approaches and shots over a hazard use carry.</p>
    <div id="warn"></div><div id="learn"></div><div id="rows" class="bag"></div><button class="btn alt" id="add">Add a club</button></div>`);
  const num = v => v === "" || v == null ? null : Math.max(0, Math.round(+v));
  function drawBag() {
    const rows = $("#rows", bagCard); rows.innerHTML = "";
    bag.forEach((c, i) => {
      const roll = c.total && c.carry ? c.total - c.carry : null, sw = c.swings || {};
      const r = el(`<div class="bagrow">
        <div class="r1"><input data-f="name" value="${esc(c.name)}" aria-label="Club name"><button class="btn small alt" data-mv="-1" ${i ? "" : "disabled"}>↑</button><button class="btn small alt" data-mv="1" ${i < bag.length - 1 ? "" : "disabled"}>↓</button><button class="btn small alt" data-del>✕</button></div>
        <div class="r2"><label>Carry<input data-f="carry" type="number" inputmode="numeric" value="${c.carry ?? ""}"></label><label>Total<input data-f="total" type="number" inputmode="numeric" value="${c.total ?? ""}" placeholder="—"></label>
          <span class="roll">${roll != null ? `rollout ${roll}` : "rollout —"}</span><label class="chk"><input type="checkbox" data-f="tee" ${c.tee ? "checked" : ""}>Tee club</label></div>
        ${isWedge(c.name) ? `<details ${sw.half || sw.threeq ? "open" : ""}><summary>Partial swings (optional)</summary>
          ${[["half", "½"], ["threeq", "¾"]].map(([k, l]) => `<div class="r2"><span class="sl">${l} swing</span><label>Carry<input data-sw="${k}.carry" type="number" inputmode="numeric" value="${sw[k]?.carry ?? ""}"></label><label>Total<input data-sw="${k}.total" type="number" inputmode="numeric" value="${sw[k]?.total ?? ""}"></label></div>`).join("")}
          <div class="muted" style="font-size:12px">Full swing uses the carry and total above.</div></details>` : ""}</div>`);
      r.querySelectorAll("[data-f]").forEach(x => x.onchange = () => {
        const f = x.dataset.f; c[f] = f === "name" ? x.value.trim() : f === "tee" ? x.checked : num(x.value); drawBag(); });
      r.querySelectorAll("[data-sw]").forEach(x => x.onchange = () => { const [k, f] = x.dataset.sw.split("."); c.swings = c.swings || {}; c.swings[k] = c.swings[k] || {}; c.swings[k][f] = num(x.value); drawBag(); });
      r.querySelectorAll("[data-mv]").forEach(x => x.onclick = () => { const j = i + +x.dataset.mv; [bag[i], bag[j]] = [bag[j], bag[i]]; drawBag(); });
      $("[data-del]", r).onclick = () => { bag.splice(i, 1); drawBag(); };
      rows.appendChild(r);
    });
    $("#add", bagCard).disabled = bag.length >= 14;
    $("#add", bagCard).textContent = bag.length >= 14 ? "14 clubs: the most the rules allow" : "Add a club";
    const w = bagWarnings(bag);
    $("#warn", bagCard).innerHTML = w.map(t => `<div class="warn">${esc(t)}</div>`).join("");
  }
  $("#add", bagCard).onclick = () => { bag.push({ id: Store.id(), name: "New club", carry: null, total: null, tee: false, swings: {} }); drawBag(); };
  function drawLearn() {
    const box = $("#learn", bagCard); box.innerHTML = "";
    bagLearning().forEach(sg => {
      const msg = sg.field === "carry"
        ? `Estimate: your ${esc(sg.c.name)} carries about <b>${sg.med}</b> yards, from ${sg.n} approaches that finished on the green (they barely roll). Update its carry from ${sg.c.carry} to ${sg.med}?`
        : `Your ${esc(sg.c.name)} finishes about <b>${sg.med}</b> yards over ${sg.n} logged shots (where the ball stopped, so that's total). Update its total from ${sg.c.total ?? "—"} to ${sg.med}?`;
      const it = el(`<div class="learn">${msg}<div class="row"><button class="btn small">Update</button><button class="btn small alt">Not now</button></div></div>`);
      const [yes, no] = it.querySelectorAll("button");
      yes.onclick = () => { const c = bag.find(x => x.name === sg.c.name); if (c) c[sg.field] = sg.med; drawBag(); it.remove(); toast("Updated. Save your profile to keep it."); };
      no.onclick = () => { const d = Store.get("bagDismiss", {}); d[`${sg.c.name}:${sg.field}`] = sg.med; Store.set("bagDismiss", d); it.remove(); };
      box.appendChild(it);
    });
  }
  drawBag(); drawLearn();
  const save = el(`<button class="btn">Save profile</button>`);
  save.onclick = () => {
    const hcp = $("#phi", prof).value.trim();
    if (hcp !== String(p.hcp ?? "")) p.hcpDate = hcp ? Date.now() : null;
    Object.assign(p, { name: $("#pn", prof).value.trim(), homeCourse: $("#phc", prof).value, homeElevationFt: +$("#pel", prof).value || 0,
      ghin: $("#pgh", prof).value.trim(), hcp });
    bag = bag.filter(c => c.name);
    Store.saveProfile(p); Store.saveBag(bag);
    A.profile = Store.profile(); A.bag = Store.bag(); A.settings = Store.settings();
    toast("Profile saved"); profilePage();
  };
  const last = daysSince(Store.get("lastExport", null));
  const data = el(`<div class="card"><h3>Your data</h3><p class="muted" style="margin:0">Everything is saved on this phone only. Export a backup about once a month${last == null ? " (no backup yet)" : ` (last one ${last} day${last === 1 ? "" : "s"} ago)`}: it holds your rounds, plans, pins, profile and bag in one file you can text, email or AirDrop to yourself.</p>
    <div class="row"><button class="btn alt" id="ex">Export my data</button><button class="btn alt" id="im">Import data</button></div>
    <p class="muted" style="margin:0">Koan Golf ${APP_VERSION}</p></div>`);
  $("#ex", data).onclick = exportData; $("#im", data).onclick = importData;
  b.append(prof, bagCard, pt, save, data);
  if (section === "bag") requestAnimationFrame(() => bagCard.scrollIntoView({ block: "start" }));
}

// Member Profile (the only way in: the initials button on the Clubhouse)
function profilePage() {
  const p = A.profile, b = screen("Member Profile", home, ""), hc = p.homeCourse ? meta(p.homeCourse) : null, age = daysSince(p.hcpDate);
  const card = el(`<div class="member"><div style="display:flex;align-items:flex-start;gap:12px"><div style="flex:1"><div class="caps brass">Koan Golf · Member</div>
    <div class="mname">${esc(p.name || "Your name")}</div><div class="msub">${[hc ? hc.name : null, p.hand === "L" ? "left-handed" : "right-handed", `${(p.homeElevationFt || 0).toLocaleString()} ft`].filter(Boolean).map(esc).join(" · ")}</div></div>${ENSO_MARK(40)}</div>
    <div class="divider"></div><div class="caps brass">Handicap index</div><div class="ix">${p.hcp !== "" && p.hcp != null ? esc(p.hcp) : "—"}</div>
    <div class="msub">${p.ghin ? `GHIN ${esc(p.ghin)}` : "No GHIN number yet"}${p.hcpDate ? ` · updated ${new Date(p.hcpDate).toLocaleDateString()}` : ""}${age >= 14 ? ` · ${age} days ago` : ""}</div>
    <div class="row"><a class="btn alt" href="https://www.ghin.com/" target="_blank" rel="noopener" style="text-align:center;text-decoration:none;display:grid;place-items:center">Look up on GHIN</a><button class="btn alt" id="ed">Edit profile</button></div></div>`);
  $("#ed", card).onclick = () => profileEdit("profile"); b.appendChild(card);
  b.appendChild(el(`<h2>My bag</h2>`));
  const bag = A.bag.filter(c => c.carry > 0);
  const tbl = el(`<div class="tablewrap"><table class="bagtbl"><tr><th>Club</th><th>Carry</th><th>Total</th><th>Roll</th><th>Tee</th></tr>
    ${bag.map(c => `<tr><td>${esc(c.name)}</td><td>${c.carry}</td><td>${c.total ?? "–"}</td><td>${c.total ? c.total - c.carry : "–"}</td><td>${c.tee ? '<i class="tdot" title="Tee club"></i>' : ""}</td></tr>`).join("")}
    ${bag.length ? "" : '<tr><td colspan="5" class="muted">No clubs yet. Tap Edit clubs to add your distances.</td></tr>'}</table></div>`);
  b.appendChild(tbl);
  const notes = bagWarnings(A.bag);
  if (notes.length) b.appendChild(el(`<div>${notes.map(t => `<div class="gapnote">${esc(t)}</div>`).join("")}</div>`));
  const acts = el(`<div class="row"><button class="btn alt" id="ec">Edit clubs</button><button class="btn alt" id="ex">Export data</button></div>`);
  $("#ec", acts).onclick = () => profileEdit("bag"); $("#ex", acts).onclick = exportData; b.appendChild(acts);
  b.appendChild(el(`<h2>Help</h2>`));
  const help = el(`<div class="list"><div class="item" id="hw"><div class="grow"><b>How Koan Golf works</b><small>The five welcome cards again</small></div><span>›</span></div>
    <div class="item" id="rt"><div class="grow"><b>Reset tips</b><small>Show the one-time tips again on the hole, plan and practice screens</small></div><span>›</span></div>
    <a class="item" style="color:inherit" href="${feedbackHref()}"><div class="grow"><b>Send feedback</b><small>An email to the team, with your app version and screen filled in</small></div><span>›</span></a></div>`);
  $("#hw", help).onclick = async () => { await welcomeCards("Back to my profile"); profilePage(); };
  $("#rt", help).onclick = resetTips; b.appendChild(help);
  b.appendChild(el(`<h2>Mapping</h2>`));
  b.appendChild(el(`<div class="list"><a class="item" style="text-decoration:none;color:inherit" href="../handmap/great28.html"><div class="grow"><b>Map the Great 28</b><small>Tap each hole's tee and green on the aerial, then send Claude the file</small></div><span>›</span></a></div>`));
  const about = el(`<div class="list"><div class="item" id="ab"><div class="grow"><b>About & data</b><small>Koan Golf ${APP_VERSION} · backups and import</small></div><span>›</span></div></div>`);
  $("#ab", about).onclick = aboutPage; b.appendChild(about);
}
// About & data: the version, where data lives, backups (export / import)
function aboutPage() {
  const b = screen("About & data", profilePage, "", { screen: "About & data" }), last = daysSince(Store.get("lastExport", null));
  const card = el(`<div class="card"><div style="display:flex;align-items:center;gap:12px">${ENSO_MARK(40)}<div><b style="font:500 18px var(--head)">Koan Golf</b><div class="muted">Version ${APP_VERSION}</div></div></div>
    <p class="muted it" style="margin:0">${TAGLINE}</p></div>`);
  const data = el(`<div class="card"><h3 style="margin:0">Your data</h3><p style="margin:0">Everything is saved on this phone only. Export a backup about once a month${last == null ? " (no backup yet)" : ` (last one ${last} day${last === 1 ? "" : "s"} ago)`}.</p>
    <div class="row"><button class="btn alt" id="ex">Export data</button><button class="btn alt" id="im">Import data</button></div></div>`);
  $("#ex", data).onclick = exportData; $("#im", data).onclick = importData;
  b.append(card, data);
}

// ---------------------------------------------------------------- rounds & plans: create
function startRound(slug, tees) {
  const plans = Store.plans().filter(p => p.course === slug);
  const go = plan => {
    const r = { id: Store.id(), course: slug, tees, date: Date.now(), planId: plan?.id || null, holes: {} };
    if (plan) Object.entries(plan.holes).forEach(([n, ph]) => { if (ph.pin) r.holes[n] = { pin: ph.pin }; });
    Store.saveRound(r); holeView({ mode: "round", slug, tees, n: 1, roundId: r.id });
  };
  if (!plans.length) return go(null);
  const m = modal(`<h3 style="margin:0">Play with a plan?</h3><div class="list" id="pl"></div><button class="btn alt" id="none">No plan</button>`);
  plans.forEach(p => { const it = el(`<div class="item"><div class="grow"><b>${esc(p.name)}</b><small>${esc(p.tees)} tees${p.tees !== tees ? ` (you picked ${esc(tees)})` : ""}</small></div><span>›</span></div>`);
    it.onclick = () => { m.remove(); go(p); }; $("#pl", m).appendChild(it); });
  $("#none", m).onclick = () => { m.remove(); go(null); };
}
function newPlan(slug, tees) {
  const p = { id: Store.id(), course: slug, tees, name: `${meta(slug).name} · ${tees} · ${new Date().toLocaleDateString()}`, created: Date.now(), holes: {} };
  Store.savePlan(p); holeView({ mode: "plan", slug, tees, n: 1, planId: p.id });
}
const planTotal = p => Object.values(p.holes).reduce((s, h) => s + (h.score || 0), 0);   // holes you actually planned
function modal(html) {
  const m = el(`<div class="modal"><div class="inner">${html}</div></div>`);
  m.onclick = e => { if (e.target === m) m.remove(); };
  document.body.appendChild(m); return m;
}

// ---------------------------------------------------------------- map
let MAP = null, L_ = {}, loupe = null;
function stopMap() {
  if (A.gpsWatch !== null) { navigator.geolocation.clearWatch(A.gpsWatch); A.gpsWatch = null; }
  if (MAP) { MAP.remove(); MAP = null; }
}
function makeMap(container) {
  const map = L.map(container, { zoomControl: false, maxZoom: 22, zoomSnap: 0.25, zoomDelta: 0.5, doubleClickZoom: false,
    rotate: true, bearing: 0, touchRotate: false, shiftKeyRotate: false, rotateControl: false });
  map.attributionControl.setPrefix("").addAttribution("Imagery: USDA NAIP · Map data © OpenStreetMap");
  // layering: aerial photo at the bottom, illustrated fills above it, hazard outlines, then lines and markers on top
  // panes go inside the rotating container so the photo, drawings and markers turn together
  const parent = map.getPane("rotatePane") || map.getPane("mapPane");
  [["aerial", 250], ["fills", 350], ["treesh", 352], ["trees", 354], ["greens", 356], ["slopes", 357], ["hz", 420], ["lines", 460]].forEach(([nm, z]) => { map.createPane(nm, parent); map.getPane(nm).style.zIndex = z; });
  ["aerial", "fills", "treesh", "trees", "greens", "slopes"].forEach(nm => map.getPane(nm).style.pointerEvents = "none");
  map.getPane("treesh").style.opacity = ".16";                // tree shadows: one soft layer, no darker overlaps
  return map;
}
// the drawn map, like a caddie's yardage book. Features are told apart by texture and lightness, not only color: rough
// with faint grain, fairway with mowing stripes, rounded tees, greens with a fringe band, stippled bunkers with a brass
// edge, water with faint waves, penalty areas with dashed red or yellow edges, OB as a white line with stakes, cart
// paths as thin warm-gray lines, trees as lumpy canopies that merge into clusters. On the aerial only outlines show.
const MAP_DEFS = `<svg id="mapdefs" width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
  <pattern id="pt-rough" width="7" height="7" patternUnits="userSpaceOnUse"><rect width="7" height="7" fill="#C9D3AE"/><circle cx="1.5" cy="2" r=".55" fill="#B3BF94"/><circle cx="5" cy="5.5" r=".5" fill="#BAC59B"/></pattern>
  <pattern id="pt-heavy" width="6" height="6" patternUnits="userSpaceOnUse"><rect width="6" height="6" fill="#B8C494"/><path d="M1 4.5l.6-1.6.6 1.6M4 2l.6-1.6.6 1.6" stroke="#93A06F" stroke-width=".6" fill="none"/></pattern>
  <pattern id="pt-fairway" width="26" height="26" patternUnits="userSpaceOnUse" patternTransform="rotate(55)"><rect width="26" height="26" fill="#DCE4C3"/><rect width="13" height="26" fill="#D7DFBD"/></pattern>
  <pattern id="pt-sand" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill="#F1E6C8"/><circle cx="2" cy="2" r=".55" fill="#D7C59A"/><circle cx="6" cy="3.5" r=".45" fill="#DCCBA2"/><circle cx="3.5" cy="6.5" r=".5" fill="#D7C59A"/></pattern>
  <pattern id="pt-waste" width="14" height="14" patternUnits="userSpaceOnUse"><rect width="14" height="14" fill="#EFE6CF"/><circle cx="3" cy="4" r="1.1" fill="#CDBE97"/><circle cx="10" cy="10" r=".9" fill="#D3C49E"/></pattern>
  <pattern id="pt-water" width="18" height="10" patternUnits="userSpaceOnUse"><rect width="18" height="10" fill="#A9C2D3"/><path d="M1 5q2.2-2 4.4 0t4.4 0" stroke="#C4D6E2" stroke-width=".8" fill="none"/></pattern>
  <pattern id="pt-native" width="14" height="12" patternUnits="userSpaceOnUse"><rect width="14" height="12" fill="#CFCC9F"/><path d="M2 5.5l1-2.5 1 2.5M2.9 5.5V2.6M9 11l1-2.5 1 2.5M9.9 11V8.1" stroke="#9C9864" stroke-width=".7" fill="none"/></pattern>
  <pattern id="pt-grassb" width="7" height="7" patternUnits="userSpaceOnUse"><rect width="7" height="7" fill="#BDC99D"/><circle cx="3.5" cy="3.5" r=".5" fill="#A2AF80"/></pattern>
  <pattern id="pt-desert" width="28" height="16" patternUnits="userSpaceOnUse"><rect width="28" height="16" fill="#E3D3B0"/><path d="M0 8q7-4 14 0t14 0" stroke="#CDB88C" stroke-width=".8" fill="none"/><circle cx="20" cy="3" r=".7" fill="#C9B386"/></pattern>
  <pattern id="pt-rocks" width="12" height="12" patternUnits="userSpaceOnUse"><rect width="12" height="12" fill="#CBC6B9"/><path d="M2 4l2-1.5 2 .8-.6 2-2.4.4zM7.5 9.5l1.6-1.2 1.8.6-.5 1.6-2 .2z" fill="#A49D8F"/></pattern>
  <pattern id="pt-wetland" width="14" height="12" patternUnits="userSpaceOnUse"><rect width="14" height="12" fill="#B8CBB8"/><path d="M1 9h4M8 4h4" stroke="#8FB0B0" stroke-width=".8"/><path d="M9 10l.7-2 .7 2M2 4l.7-2 .7 2" stroke="#6F8F6A" stroke-width=".6" fill="none"/></pattern>
  <pattern id="pt-esa" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="7" height="7" fill="#D3DDBA"/><rect width="1.6" height="7" fill="#6E9A62"/></pattern>
  <pattern id="pt-ob" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><rect width="8" height="8" fill="#FFFFFF" fill-opacity=".18"/><rect width="1" height="8" fill="#FFFFFF" fill-opacity=".6"/></pattern>
</defs></svg>`;
function ensureMapDefs() { if (!document.getElementById("mapdefs")) document.body.insertAdjacentHTML("beforeend", MAP_DEFS); }
const RED_EDGE = "#B3261E", YEL_EDGE = "#C99A1E";
// a polygon drawn as a lumpy canopy ("cloud": bumps every few pixels) or with rounded corners ("round": tee boxes)
const ShapePoly = L.Polygon.extend({
  _updatePath() {
    if (!this._renderer._setPath) return L.Polygon.prototype._updatePath.call(this);
    const m = this._map, ppm = m && m._loaded ? Math.pow(2, m.getZoom() + 8) / (40075016.686 * Math.cos(m.getCenter().lat * Math.PI / 180)) : 2;
    this._renderer._setPath(this, shapePath(this._parts, this.options.shape, Math.max(5, Math.min(14, (this.options.stepM || 2.6) * ppm))));   // bumps ~2.6 m apart
  } });
function shapePath(parts, mode, step) {
  let d = "";
  parts.forEach(ring => {
    const n = ring.length; if (n < 3) return;
    if (mode === "round") {
      for (let i = 0; i < n; i++) {
        const p = ring[i], a = ring[(i + n - 1) % n], b = ring[(i + 1) % n], la = p.distanceTo(a), lb = p.distanceTo(b), r = Math.min(5, la / 2.5, lb / 2.5);
        const pa = p.add(a.subtract(p).multiplyBy(r / (la || 1))), pb = p.add(b.subtract(p).multiplyBy(r / (lb || 1)));
        d += `${i ? "L" : "M"}${pa.x.toFixed(1)} ${pa.y.toFixed(1)}Q${p.x.toFixed(1)} ${p.y.toFixed(1)} ${pb.x.toFixed(1)} ${pb.y.toFixed(1)}`;
      }
      d += "Z"; return;
    }
    // cloud: walk the outline in equal steps; each step is an arc that bulges outward
    let per = 0, area = 0; for (let i = 0; i < n; i++) { const p = ring[i], q = ring[(i + 1) % n]; per += p.distanceTo(q); area += p.x * q.y - q.x * p.y; }
    const k = Math.max(6, Math.round(per / step)), seg = per / k, sweep = area > 0 ? 1 : 0, pts = [];
    let i = 0, t = 0;
    for (let j = 0; j < k; j++) {
      let want = j * seg;
      while (i < n) { const p = ring[i], q = ring[(i + 1) % n], L0 = p.distanceTo(q); if (t + L0 >= want) { const f = L0 ? (want - t) / L0 : 0; pts.push(L.point(p.x + (q.x - p.x) * f, p.y + (q.y - p.y) * f)); break; } t += L0; i++; }
    }
    const r = (seg * 0.62).toFixed(1);
    pts.forEach((p, j) => { const q = pts[(j + 1) % pts.length]; d += (j ? "" : `M${p.x.toFixed(1)} ${p.y.toFixed(1)}`) + `A${r} ${r} 0 0 ${sweep} ${q.x.toFixed(1)} ${q.y.toFixed(1)}`; });
    d += "Z";
  });
  return d || "M0 0";
}
const llRings = f => Geo.ringsOf(f.geometry).map(r => r.map(([la, lo]) => [la, lo]));
// a hazard's look on the drawn map: its fill (a texture) and its edge
function hzLook(f) {
  const p = f.properties, k = p.kind, red = sevOf(f) === "red", dashed = c => ({ color: c, weight: 1.8, dashArray: "6 4" });
  if (k === "water") return { fillColor: "url(#pt-water)", ...(p.sub === "lateral" ? dashed(RED_EDGE) : p.sub === "yellow" ? dashed(YEL_EDGE) : { color: "#3E6E8E", weight: 1.2 }) };
  if (k === "bunker") return { fillColor: "url(#pt-sand)", color: "#B08D57", weight: p.sub === "pot" ? 1.8 : 1.1 };
  if (k === "waste") return { fillColor: "url(#pt-waste)", ...(red ? dashed(RED_EDGE) : { color: "#0000", weight: 0 }) };
  if (k === "native") return { fillColor: "url(#pt-native)", ...(red ? dashed(RED_EDGE) : { color: "#A39E6A", weight: .8 }) };
  if (k === "grass_bunker") return { fillColor: "url(#pt-grassb)", ...(red ? dashed(RED_EDGE) : { color: "#8E9A6E", weight: .9, dashArray: "1.5 3" }) };
  if (k === "heavy_rough") return { fillColor: "url(#pt-heavy)", ...(red ? dashed(RED_EDGE) : { color: "#0000", weight: 0 }) };
  if (k === "desert") return { fillColor: "url(#pt-desert)", ...(red ? dashed(RED_EDGE) : dashed(YEL_EDGE)) };
  if (k === "rocks") return { fillColor: "url(#pt-rocks)", ...(red ? dashed(RED_EDGE) : dashed(YEL_EDGE)) };
  if (k === "wetland") return { fillColor: "url(#pt-wetland)", ...(red ? dashed(RED_EDGE) : dashed(YEL_EDGE)) };
  if (k === "esa") return { fillColor: "url(#pt-esa)", ...dashed(RED_EDGE) };
  if (k === "ob_area") return { fillColor: "url(#pt-ob)", color: "#FFFFFF", weight: 0 };
  return null;
}
// OB: a white line with stake marks (and a soft dark halo so it reads on the light map)
function obLine(f, g, M) {
  const o = { pane: "hz", interactive: false, fill: false };
  L.geoJSON(f, { ...o, style: { color: "#1B1B18", opacity: M ? .35 : .5, weight: 4.5 } }).addTo(g);
  L.geoJSON(f, { ...o, style: { color: "#FFFFFF", weight: 2.4 } }).addTo(g);
  L.geoJSON(f, { ...o, style: { color: "#1B1B18", opacity: .55, weight: 10, dashArray: "4 26", lineCap: "butt" } }).addTo(g);
  L.geoJSON(f, { ...o, style: { color: "#FFFFFF", weight: 8, dashArray: "2 28", dashOffset: "-1", lineCap: "butt" } }).addTo(g);
}
function drawFeatures(map, feats, base, opts = {}) {
  ensureMapDefs();
  const g = L.layerGroup(), M = base === "map", kd = f => f.properties.kind;
  const poly = (f, style, pane = "fills") => L.geoJSON(f, { pane, interactive: false, style: { stroke: true, fillOpacity: 1, ...style } }).addTo(g);
  if (M) {
    const order = ["rough", "heavy_rough", "native", "desert", "rocks", "wetland", "esa", "waste", "fairway", "grass_bunker", "tee_box", "cartpath", "building", "water", "bunker", "ob_area", "green"];
    feats.filter(f => order.includes(kd(f))).sort((a, b) => order.indexOf(kd(a)) - order.indexOf(kd(b))).forEach(f => {
      const k = kd(f);
      if (k === "rough") return poly(f, { fillColor: "url(#pt-rough)", color: "#0000", weight: 0 });
      if (k === "fairway") return poly(f, { fillColor: "url(#pt-fairway)", color: "#00000012", weight: .5 });
      if (k === "tee_box") return llRings(f).forEach(r => new ShapePoly(r, { shape: "round", pane: "fills", interactive: false, color: "#1E3A2B", weight: 1.2, fillColor: "#DCE4C3", fillOpacity: 1 }).addTo(g));
      if (k === "green") { poly(f, { fill: false, color: "#D2DDB4", weight: 9, lineJoin: "round" }, "greens"); return poly(f, { fillColor: "#BFD49A", color: "#1E3A2B", weight: 1.1 }, "greens"); }   // above the trees
      if (k === "cartpath") return L.geoJSON(f, { pane: "fills", interactive: false, style: { color: "#B8AE98", weight: 3, lineCap: "round", lineJoin: "round" } }).addTo(g);
      if (k === "building") return poly(f, { fillColor: "#D9D6CF", color: "#C2BDB2", weight: .6 });
      const lk = hzLook(f); if (lk) poly(f, lk);
      if (k === "esa") { const c = llRings(f)[0]; if (c) L.marker(c.reduce((a, q) => [a[0] + q[0] / c.length, a[1] + q[1] / c.length], [0, 0]), { interactive: false, keyboard: false,
        icon: L.divIcon({ className: "", iconSize: [0, 0], html: '<span class="esatag">ESA</span>' }) }).addTo(g); }
    });
    // trees: a soft shadow, then every canopy's darker edge, then every canopy's fill on top, so canopies that touch or
    // nearly touch (within ~2 m) merge into one cluster with one outline
    const trees = feats.filter(f => kd(f) === "trees").flatMap(llRings), gap = 2.5;
    const tp = (r, st) => new ShapePoly(r, { shape: "cloud", interactive: false, lineJoin: "round", fillOpacity: 1, ...st }).addTo(g);
    trees.forEach(r => tp(r, { pane: "treesh", className: "tsh", color: "#1B1B18", weight: 2 * gap, fillColor: "#1B1B18" }));
    trees.forEach(r => tp(r, { pane: "trees", color: "#55724A", weight: 2 * gap + 1.8, fillColor: "#55724A" }));
    trees.forEach(r => tp(r, { pane: "trees", color: "#7E9C6B", weight: 2 * gap, fillColor: "#7E9C6B" }));
  } else {
    feats.filter(f => ["green", "fairway"].includes(kd(f))).forEach(f =>
      L.geoJSON(f, { pane: "hz", interactive: false, style: { color: "#FFFDF7", weight: 1, opacity: .6, fill: false } }).addTo(g));
  }
  // hazard edges that matter in both views, and the selection highlight (the editor)
  feats.forEach(f => {
    const k = kd(f), sel = opts.selected === f.properties.id, red = sevOf(f) === "red";
    if (k === "fence" || k === "ob_line") return obLine(f, g, M);
    let st = null;
    if (k === "ob_area") st = { color: "#FFFFFF", weight: 2.2, fillOpacity: 0, ...(M ? {} : { fillColor: "#FFFFFF", fillOpacity: .12 }) };
    else if (!M && k === "water") st = { color: f.properties.sub === "lateral" ? "#FF8A80" : f.properties.sub === "yellow" ? "#FFE08A" : "#A9C2D3", weight: 2.2, dashArray: f.properties.sub && f.properties.sub !== "water" ? "6 4" : null, fillColor: "#A9C2D3", fillOpacity: .25 };
    else if (!M && k === "bunker") st = { color: "#F6F1E4", weight: 1.6, fill: false };
    else if (!M && HAZARD_KINDS.includes(k) && !["trees", "avoid"].includes(k)) st = { color: red ? "#FF8A80" : "#FFE08A", weight: 1.8, dashArray: "5 4", fill: false };
    else if (k === "avoid") st = { color: f.properties.color === "red" ? "#7A1F2B" : "#A8862F", weight: 2, fillColor: f.properties.color === "red" ? "#7A1F2B" : "#A8862F", fillOpacity: .16 };
    if (sel) st = { ...(st || {}), color: "#7A1F2B", weight: 4, fill: true, fillColor: "#7A1F2B", fillOpacity: .2, dashArray: null };
    if (st) L.geoJSON(f, { pane: "hz", interactive: !!opts.onSelect, style: st }).on("click", () => opts.onSelect && opts.onSelect(f)).addTo(g);
  });
  return g;
}
// a small sample of a feature's look (Map key, hazard editor): the same textures as the map
function keySwatch(kind, sub, extra = {}) {
  ensureMapDefs();
  const f = { properties: { kind, sub, ...extra } }, w = 34, hh = 22, rect = (fill, st = "") => `<rect x="2" y="2" width="${w - 4}" height="${hh - 4}" rx="${kind === "tee_box" ? 4 : 2}" fill="${fill}" ${st}/>`;
  let body;
  if (kind === "rough") body = rect("url(#pt-rough)");
  else if (kind === "fairway") body = rect("url(#pt-fairway)");
  else if (kind === "tee_box") body = rect("#DCE4C3", 'stroke="#1E3A2B" stroke-width="1.2"');
  else if (kind === "green") body = `<rect x="1" y="1" width="${w - 2}" height="${hh - 2}" rx="7" fill="#D2DDB4"/><rect x="5" y="5" width="${w - 10}" height="${hh - 10}" rx="5" fill="#BFD49A" stroke="#1E3A2B"/>`;
  else if (kind === "cartpath") body = `<path d="M2 16C12 4 22 18 32 6" stroke="#B8AE98" stroke-width="3" fill="none" stroke-linecap="round"/>`;
  else if (kind === "building") body = rect("#D9D6CF", 'stroke="#C2BDB2" stroke-width=".6"');
  else if (kind === "trees") body = `<path d="M6 14a5 5 0 0 1 4-8a6 6 0 0 1 10-1a5 5 0 0 1 8 5a4 4 0 0 1-3 7h-15a4 4 0 0 1-4-3z" fill="#7E9C6B" stroke="#55724A" stroke-width="1.4"/>`;
  else if (kind === "ob_line" || kind === "fence" || kind === "ob_area") body = `<rect width="${w}" height="${hh}" fill="#C9D3AE"/><path d="M2 11H32" stroke="#1B1B18" stroke-opacity=".35" stroke-width="4.5"/><path d="M2 11H32" stroke="#fff" stroke-width="2.4"/><path d="M9 4v14M24 4v14" stroke="#fff" stroke-width="2.4"/>`;
  else if (kind === "avoid") body = rect(extra.color === "red" ? "#7A1F2B33" : "#A8862F33", `stroke="${extra.color === "red" ? "#7A1F2B" : "#A8862F"}" stroke-width="2"`);
  else { const lk = hzLook(f) || { fillColor: "#ccc" };
    body = rect(lk.fillColor, lk.weight ? `stroke="${lk.color}" stroke-width="${lk.weight}" ${lk.dashArray ? `stroke-dasharray="${lk.dashArray}"` : ""}` : "");
    if (kind === "esa") body += `<text x="${w / 2}" y="15" text-anchor="middle" font-size="8" font-weight="700" fill="#2F5B2A">ESA</text>`; }
  return `<svg class="ksw" width="${w}" height="${hh}" viewBox="0 0 ${w} ${hh}" aria-hidden="true">${body}</svg>`;
}
// the Map key: every look on the drawn map, hazards grouped as in the editor with their default severity
function mapKey() {
  const row = (sw, name, note = "") => `<div class="krow">${sw}<div class="grow"><b>${esc(name)}</b>${note ? `<small>${note}</small>` : ""}</div></div>`;
  const sevChip = s => `<span class="sev ${s}">${s === "red" ? "Red" : "Yellow"}</span>`;
  const course = [["rough", "Rough"], ["fairway", "Fairway"], ["tee_box", "Tee"], ["green", "Green and fringe"], ["cartpath", "Cart path"], ["building", "Building"]];
  const hz = HZ_GROUPS.map((gname, gi) => {
    const items = Object.entries(HZT).filter(([, t]) => t.group === gi && !(gi === 4 && t.name.startsWith("Fence")));
    return `<div class="seclbl">${esc(gname)}</div>` + items.map(([key, t]) => { const [kind, sub] = key.split(":");
      return row(keySwatch(kind, sub, kind === "avoid" ? { color: "red" } : {}), t.name, `${sevChip(t.sev)}${kind === "native" ? " · red when played as a penalty area" : ""}${kind === "avoid" ? " · red or yellow, your choice" : ""}${t.osm ? ` · ${kind === "ob_area" ? "from" : "OpenStreetMap:"} ${esc(t.osm)}` : kind === "avoid" ? "" : " · added by hand"}`); }).join("");
  }).join("");
  const md = modal(`<h3 style="margin:0">Map key</h3><div class="mkey"><div class="seclbl">The course</div>${course.map(([k, nm]) => row(keySwatch(k), nm)).join("")}${hz}
    <p class="muted" style="font-size:12px">Red = a penalty or lost ball: Auto-plan keeps its full safety margin from it and warns when a line has to carry it. Yellow = costly but playable: half the margin, and fine to carry. Change a hazard's color in Hazards and avoid zones (the ⋯ menu on a hole).</p></div>
    <button class="btn" id="kx">Close</button>`);
  $("#kx", md).onclick = () => md.remove();
}
const pinIcon = (moved) => L.divIcon({ className: "", iconSize: [30, 30], iconAnchor: [4, 28],
  html: `<div class="pinm"><svg width="26" height="30" viewBox="0 0 26 30"><line x1="4" y1="2" x2="4" y2="29" stroke="#1B1B18" stroke-width="2"/><path d="M5 3 L23 8 L5 13 Z" fill="#7A1F2B" stroke="#FFFDF7" stroke-width="1"/><circle cx="4" cy="28" r="2.5" fill="#1B1B18"/></svg></div>` });
const ballIcon = L.divIcon({ className: "", iconSize: [16, 16], html: '<div class="ballm"></div>' });
// planned targets: lime rings labelled with the distance and club, e.g. "192 · 5W"
const clubAbbr = c => !c ? "" : /driver/i.test(c) ? "Dr" : c.replace(/^(\d+)\s*wood$/i, "$1W").replace(/^(\d+)\s*iron$/i, "$1i").replace(/^(\d+)\s*hybrid$/i, "$1H");
const tgtIcon = (t, plan, label) => L.divIcon({ className: "", iconSize: [30, 30], iconAnchor: [15, 15], html: `<div class="tgt${plan ? " plan" : ""}">${esc(t)}</div>${label ? `<span class="tgtlbl">${esc(label)}</span>` : ""}` });
const teeIcon = L.divIcon({ className: "", iconSize: [14, 14], html: '<div style="width:14px;height:14px;background:#F6F1E4;border:2px solid #1E3A2B"></div>' });

// magnifier (loupe): a round zoomed view of the aerial shown above the finger; one shared loupe for the whole app
let loupeMap = null;
const LOUPE_LIFT = 95;
function loupeOpen(getBaseLayer) {
  if (!loupe) { loupe = el('<div class="loupe" hidden><div class="lm"></div></div>'); document.body.appendChild(loupe); }
  if (loupeMap) loupeMap.remove();
  loupeMap = L.map(loupe.firstChild, { zoomControl: false, attributionControl: false, dragging: false, touchZoom: false, scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false, maxZoom: 25, zoomSnap: 0 });
  getBaseLayer().addTo(loupeMap); loupe.hidden = false; loupeMap.invalidateSize({ animate: false });
}
function loupeShow(clientX, clientY, ll, zoom) {
  loupe.style.left = (clientX - 65) + "px"; loupe.style.top = Math.max(4, clientY - 65 - LOUPE_LIFT) + "px";
  loupeMap.setView(ll, Math.min(zoom + 2, 23), { animate: false });
}
const loupeClose = () => { if (loupe) loupe.hidden = true; };
// loupe that follows a marker while it's dragged (the pin)
function dragLoupe(map, getBaseLayer) {
  let open = false;
  return {
    move(ll) {
      if (!open) { loupeOpen(getBaseLayer); open = true; }
      const r = map.getContainer().getBoundingClientRect(), pt = map.latLngToContainerPoint(ll);
      loupeShow(r.left + pt.x, r.top + pt.y, ll, map.getZoom());
    },
    end() { if (open) loupeClose(); open = false; },
  };
}

// press-and-hold magnifier: a loupe above the finger, the marker drops where you let go
function attachHold(map, getBaseLayer, onDrop, enabled) {
  const HOLD = 350, MOVE = 10; let hold = null, suppress = 0;
  const box = map.getContainer();
  const show = e => { const ll = map.mouseEventToLatLng(e); hold.ll = ll; loupeShow(e.clientX, e.clientY, ll, map.getZoom()); };
  const start = e => {
    hold.active = true; map.dragging.disable(); map.touchZoom.disable();
    loupeOpen(getBaseLayer); show(e);
    if (navigator.vibrate) navigator.vibrate(10);
  };
  const end = () => { if (!hold) return; clearTimeout(hold.t); if (hold.active) { loupeClose(); map.dragging.enable(); map.touchZoom.enable(); } hold = null; };
  const pts = new Map();
  box.addEventListener("pointerdown", e => {
    pts.set(e.pointerId, 1);
    if (!enabled() || e.target.closest(".leaflet-marker-icon") || e.target.closest(".fl")) return;
    if (pts.size > 1) return end();
    hold = { s: [e.clientX, e.clientY], last: e, active: false };
    hold.t = setTimeout(() => hold && start(hold.last), HOLD);
  }, true);
  box.addEventListener("pointermove", e => {
    if (!hold) return; hold.last = e;
    if (!hold.active) { if (Math.hypot(e.clientX - hold.s[0], e.clientY - hold.s[1]) > MOVE) end(); return; }
    e.preventDefault(); e.stopPropagation(); show(e);
  }, true);
  box.addEventListener("pointerup", e => {
    pts.delete(e.pointerId);
    if (hold?.active) { e.preventDefault(); e.stopPropagation(); const ll = hold.ll; suppress = Date.now() + 500; end(); onDrop([ll.lat, ll.lng]); } else end();
  }, true);
  box.addEventListener("pointercancel", e => { pts.delete(e.pointerId); end(); }, true);
  box.addEventListener("contextmenu", e => e.preventDefault());
  return () => Date.now() < suppress;
}

// ---------------------------------------------------------------- hole view (browse, plan, round)
async function holeView(ctx) {
  const course = await loadCourse(ctx.slug); const m = meta(ctx.slug);
  stopMap(); app.innerHTML = "";
  const plan = ctx.planId ? Store.plans().find(p => p.id === ctx.planId) : null;
  const round = ctx.roundId ? Store.rounds().find(r => r.id === ctx.roundId) : null;
  const roundPlan = round?.planId ? Store.plans().find(p => p.id === round.planId) : null;
  const n = ctx.n, h = holeOf(course, n), NH = course.holes.length;
  const rh = round ? (round.holes[n] = round.holes[n] || {}) : null;
  const ph = plan ? (plan.holes[n] = plan.holes[n] || {}) : null;
  const tee = (rh?.tee) || (ph?.tee) || ctx.tees;
  const teeP = teePoint(course, n, tee);
  const getPin = () => (rh ? rh.pin : ph ? ph.pin : ctx.pins?.[n]) || null;
  const setPin = p => { if (rh) rh.pin = p; else if (ph) ph.pin = p; else (ctx.pins = ctx.pins || {})[n] = p; persist(); if (ph) afterPlanChange(null); };
  const persist = () => { if (round) Store.saveRound(round); if (plan) Store.savePlan(plan); };
  // keep the pin on the green: a drop off the green goes to the nearest point 1 m inside its edge
  const onGreen = p => {
    if (!p || Geo.inRing(p, h.green)) return p;
    let best = null;
    for (let i = 0; i < h.green.length - 1; i++) {
      const A = Geo.xy(h.green[i], p), B = Geo.xy(h.green[i + 1], p), dx = B[0] - A[0], dy = B[1] - A[1];
      const t = Math.max(0, Math.min(1, -(A[0] * dx + A[1] * dy) / (dx * dx + dy * dy || 1e-9)));
      const q = [A[0] + t * dx, A[1] + t * dy], d = Math.hypot(q[0], q[1]);
      if (!best || d < best.d) best = { d, q };
    }
    const c = Geo.xy(h.greenCenter, p), k = 1 / (Math.hypot(c[0] - best.q[0], c[1] - best.q[1]) || 1);
    return Geo.ll([best.q[0] + (c[0] - best.q[0]) * k, best.q[1] + (c[1] - best.q[1]) * k], p);
  };
  const prefs = Store.get("viewPrefs", { base: "map" });
  let view = "hole", tapMode = null, selectedHz = null, trace = null;
  const modeTitle = ctx.mode === "plan" ? "Plan" : ctx.mode === "round" ? "Round" : "Browse";
  A.where = { screen: `${modeTitle} · hole view`, course: ctx.slug, hole: n };

  const IC = {
    aerial: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3 3 8l9 5 9-5z"/><path d="M3 12l9 5 9-5M3 16l9 5 9-5"/></svg>',
    green: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21"/><ellipse cx="10.5" cy="12" rx="3.5" ry="1.6"/></svg>',
    pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M7 21V3"/><path d="M7 4l11 4-11 4" fill="currentColor"/><path d="M4 21h6"/></svg>',
    me: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>',
    slope: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 18c4-6 8-9 18-11"/><path d="M14 14l3 3 3-3M17 9v8"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>' };
  const s = el(`<div class="hole">
    <div class="hhead"><button class="iconbtn back" aria-label="Back">${IC.back}</button>
      <div class="mid"><button class="nav" id="prev" aria-label="Previous hole">‹</button>
        <button class="ttl" id="teeBtn" aria-label="Hole ${n}, par ${h.par}, ${esc(tee)} tees${ctx.mode === "browse" ? "" : ". Tap to change tees for this hole"}"><b>Hole ${n}</b><span class="caps">Par ${h.par} · ${esc(tee)} tees${tee !== ctx.tees ? "*" : ""}</span></button>
        <button class="nav" id="next" aria-label="Next hole">›</button></div>
      <button class="iconbtn" id="menu" aria-label="More">⋯</button></div>
    <div class="mapwrap"><div id="map"></div>
      <div class="fl rcol">
        <button class="rbtn" id="bAerial" data-b="aerial" aria-label="Map layers and key" title="Layers">${IC.aerial}</button>
        <button class="rbtn" id="pinBtn" aria-label="Green view: see the green and move the pin" title="Green view">${IC.pin}</button>
        <button class="rbtn" id="reset" aria-label="Center on me" title="Center on me">${IC.me}</button>
      </div>
      <div class="fl pinlabel" id="pinLabel" style="left:12px;top:12px"></div>
      <div class="fl slopecap" id="slopeCap" hidden></div>
      <div class="fl undobar" id="undoBar" hidden></div>
      <div class="fl hint" id="hint" hidden><span id="hintText"></span><button id="hintDone">Done</button></div>
      <span id="ydHead" hidden></span>
    </div>
    <div class="sheet" id="sheet"></div></div>`);
  app.appendChild(s);
  $(".back", s).onclick = () => view === "green" ? ($("#pinBtn", s).onclick()) : ctx.mode === "plan" ? planSummary(plan.id) : ctx.mode === "round" ? roundSummary(round.id) : coursePage(ctx.slug);
  $("#prev", s).onclick = () => holeView({ ...ctx, n: n > 1 ? n - 1 : NH });
  $("#next", s).onclick = () => holeView({ ...ctx, n: n < NH ? n + 1 : 1 });
  $("#teeBtn", s).onclick = () => {
    if (ctx.mode === "browse") return;
    const md = modal(`<h3 style="margin:0">Tees for hole ${n}</h3><p class="muted">Changes only this hole. The ${esc(ctx.tees)} tees stay for the rest.</p><div class="chips" id="tc"></div>`);
    course.teeOrder.forEach(t => { const c = el(`<button class="chip${t === tee ? " on" : ""}">${esc(t)} · ${cardYards(course, t, n)}</button>`);
      c.onclick = () => { const tgt = rh || ph; if (t === ctx.tees) delete tgt.tee; else tgt.tee = t; persist(); md.remove(); holeView(ctx); }; $("#tc", md).appendChild(c); });
  };

  const map = MAP = makeMap($("#map", s));
  let base = prefs.base;
  const aerial = L.imageOverlay(h.aerial.img, h.aerial.bounds, { pane: "aerial", interactive: false });
  let featLayer = null; const top = L.layerGroup().addTo(map);
  const hzLayer = L.layerGroup().addTo(map);               // front/middle/back labels on the hazards in play
  const slopeLayer = L.layerGroup().addTo(map);            // green slopes (Green view, "Slopes" toggle)
  let slopes = null; loadSlopes(ctx.slug).then(d => { slopes = d; drawAll(false); });
  let sheetMin = 160;                                      // folded sheet height (set from its contents)
  // what the map frames: the green (Green view); in a round, from where I am now to the green; otherwise tee to green
  function framePts() {
    if (view === "green") return h.green;
    if (ctx.mode === "round") {
      const P = roundPlan?.holes[n], from = measureFrom();
      return [from, ...playLine(h, from, getPin(), P ? planKeys.map(k => P[k]?.p) : []).slice(1, -1), ...h.green];
    }
    const P = ph || null;
    return [teeP, ...h.path.slice(1, -1), ...(P ? planKeys.map(k => P[k]?.p).filter(Boolean) : []), ...h.green];
  }
  // fit those points into the map above the collapsed sheet with a small margin. Measured on screen after the turn
  // (bounds-based fitting is unreliable on a turned map), then zoomed and moved up into that space.
  const frame = () => {
    map.invalidateSize({ animate: false });
    if (!map._loaded) map.setView(h.greenCenter, 17, { animate: false });
    const sz = map.getSize(), green = view === "green";
    const topPad = 10, below = sheetMin + 10, side = green ? 22 : 14;
    // computed, not measured: project the points, turn them by the map's bearing, fit and center them (screen reads can
    // be stale right after a tap or a turn)
    const pts = framePts(), th = (map.getBearing ? map.getBearing() : 0) * Math.PI / 180, cs = Math.cos(th), sn = Math.sin(th);
    const rot = q => L.point(q.x * cs - q.y * sn, q.x * sn + q.y * cs), unrot = q => L.point(q.x * cs + q.y * sn, -q.x * sn + q.y * cs);
    const box = z => { const r = pts.map(p => rot(map.project(p, z))); return { x0: Math.min(...r.map(q => q.x)), x1: Math.max(...r.map(q => q.x)), y0: Math.min(...r.map(q => q.y)), y1: Math.max(...r.map(q => q.y)) }; };
    const b0 = box(18), fit = Math.min((sz.x - 2 * side) / Math.max(b0.x1 - b0.x0, 1), (sz.y - topPad - below) / Math.max(b0.y1 - b0.y0, 1));
    const z = Math.min(Math.floor((18 + Math.log2(fit)) * 4) / 4, green ? 22 : 19.5), b = box(z);
    const want = L.point(sz.x / 2, topPad + (sz.y - topPad - below) / 2);   // the middle of the space above the sheet
    const c = L.point((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2).subtract(want.subtract(L.point(sz.x / 2, sz.y / 2)));
    map.setView(map.unproject(unrot(c), z), z, { animate: false });
  };
  const setBase = b => { base = b; prefs.base = b; Store.set("viewPrefs", prefs);
    s.querySelectorAll("[data-b]").forEach(x => x.classList.toggle("on", x.dataset.b === b));
    if (b === "aerial") aerial.addTo(map); else aerial.remove(); drawAll(); };
  const setView = v => { view = v; $("#pinBtn", s).classList.toggle("on", v === "green"); drawAll(); aim(); };   // draw (sheet height) first, then frame
  s.querySelectorAll("[data-b]").forEach(x => x.onclick = () => setBase(x.dataset.b));
  $("#bAerial", s).onclick = () => {                       // layers: drawn map or aerial photo, and the Map key
    const md = modal(`<h3 style="margin:0">Map layers</h3><div class="seg" style="display:flex"><button data-l="map" class="${base === "map" ? "on" : ""}" style="flex:1">Drawn map</button><button data-l="aerial" class="${base === "aerial" ? "on" : ""}" style="flex:1">Aerial photo</button></div>
      <div class="list"><div class="item" id="mk"><div class="grow">Map key</div><span>›</span></div></div>`);
    md.querySelectorAll("[data-l]").forEach(b => b.onclick = () => { md.remove(); setBase(b.dataset.l); });
    $("#mk", md).onclick = () => { md.remove(); mapKey(); };
  };
  // center on me: my GPS spot if I have a fresh fix, otherwise the whole hole (or green) again
  $("#reset", s).onclick = () => { if (A.gps && Date.now() - A.gps.t < 30000) map.setView(A.gps.p, Math.max(map.getZoom(), 18)); else frame(); };
  // one flag button: Green view, where the pin is always movable (drag the flag, tap the green, or a preset). The flag
  // button again, or the back arrow, returns to the hole; the pin stays where I put it.
  $("#pinBtn", s).onclick = () => { if (tapMode === "green") setTap(null); setView(view === "green" ? "hole" : "green"); };
  const loupeBase = () => L.imageOverlay(h.aerial.img, h.aerial.bounds);
  const wasHold = attachHold(map, loupeBase, ll => tapMode ? onTap(ll) : (setPin(onGreen(ll)), drawAll(false)), () => !!tapMode || view === "green");
  const pinLoupe = dragLoupe(map, loupeBase);
  map.on("click", e => { if (wasHold()) return; const p = [e.latlng.lat, e.latlng.lng];
    if (!tapMode && view === "green" && Geo.distToGeom(p, greenGeom(h)) * YD <= 2) { setPin(onGreen(p)); drawAll(false); return; }   // Green view: tap the green to place the pin
    if (!tapMode) return setSheet("min"); onTap(p); });   // otherwise a plain tap on the map folds the sheet

  // ---- what a tap does
  const HINTS = { teeTarget: "Tap where you want your tee shot to finish.", layup: "Tap your layup target.", approach: "Tap your approach target.",
    ball: "Tap where your ball is. Press and hold to magnify.", green: "Tap where your ball finished on the green.",
    drop: "Tap where you dropped: within 2 club-lengths of where it crossed into the penalty area, or back on the line.",
    trace: "Tap around the area to outline it, then press Done." };
  function setTap(mode) {
    tapMode = mode;
    $("#hint", s).hidden = !mode; $("#hintText", s).textContent = mode ? HINTS[mode] : "";
    if (mode === "green") setView("green");
    else drawAll();
  }
  $("#hintDone", s).onclick = () => { if (tapMode === "trace") finishTrace(); else { setTap(null); if (view === "green") setView("hole"); } };
  function onTap(p) {
    if (!tapMode) return;
    if (["teeTarget", "layup", "approach"].includes(tapMode)) {
      const k = tapMode; const from = planOrigin(k); const yd = Geo.yd(from, p);
      ph[k] = { p, club: pickFor(k, from, p)?.name || null, clubSet: false, byClub: false };   // dropped by hand: the club is picked for me
      if (!ph.score) ph.score = h.par;
      setTap(null); afterPlanChange(k); return;
    }
    if (tapMode === "ball") { addBall(p, "tap"); setTap(null); return; }
    if (tapMode === "green") { addBall(p, "tap", true); setTap(null); askPutts(); return; }
    if (tapMode === "drop") { const sh = rh.shots, b = sh.at(-1), b0 = snap(), l = lieOf(course, n, p);
      b.drop = p; b.dropLie = ["Penalty area", "Out of bounds"].includes(l) ? "Rough" : l; rh.nextClub = null; rh.clubFor = null; tapMode = null; setTap(null); persist(); aim();
      undoBar(`Dropped · hit ${strokeNo(sh, sh.length - 1) + 2} from the ${b.dropLie.toLowerCase()}`, b0); return; }
    if (tapMode === "trace") { trace.push(p); drawAll(); return; }
  }

  // ---- pins
  const pinMoved = () => !!getPin();
  // where yardages are measured from right now (same as the sheet): in a round the tee (GPS on the tee), you (GPS) or
  // your last ball; otherwise the tee. Presets are laid out along the line from here, so Front/Back move the pin
  // straight along my line and the front/back of the green stay put.
  function measureFrom() {
    if (ctx.mode !== "round") return teeP;
    if (!rh.shots?.length) return teeToday();
    return gpsNear() && !rh.shots.at(-1).onGreen ? A.gps.p : ballSpot();   // a ball placed on the green beats GPS
  }
  function approachFrom() {
    const P = ph || (roundPlan ? roundPlan.holes[n] : null);
    const mf = measureFrom(), from = Geo.yd(mf, h.greenCenter) > 40 ? mf : teeP;   // on or near the green: the hole's own way in
    const line = playLine(h, from, null, P ? planKeys.map(k => P[k]?.p) : []);
    let i = line.length - 2; while (i > 0 && Geo.yd(line[i], h.greenCenter) < 30) i--;
    return line[i];
  }
  // pin presets: a small 3x3 grid in the panel, laid out like the green as I see it (back row on top, left to right
  // along my line in), the current spot highlighted. Nothing goes on the green itself.
  const PRESETS = ["Back Left", "Back Center", "Back Right", "Middle Left", "Middle Center", "Middle Right", "Front Left", "Front Center", "Front Right"];
  const presetSpots = () => Geo.pinPresets(h.green, approachFrom(), h.greenCenter);
  function presetGridHTML() {
    const pre = presetSpots(), cur = getPin();
    const on = k => k === "Middle Center" ? !cur : !!(cur && pre[k] && Geo.m(cur, pre[k]) < 2);
    return `<div class="pgrid"><div class="pgl"><span class="seclbl">Pin</span><small>Back</small><span></span></div>
      <div class="pgd">${PRESETS.map(k => `<button class="pdot${on(k) ? " on" : ""}" data-preset="${k}" aria-label="Pin ${k === "Middle Center" ? "center" : k.toLowerCase()}" title="${k === "Middle Center" ? "Center" : k}"></button>`).join("")}</div>
      <small class="pgf">Front</small></div>`;
  }

  // ---- plan helpers
  const planKeys = planKeysFor(h.par);
  const KEYNAME = { teeTarget: "Tee shot", layup: "Layup", approach: h.par === 3 ? (m.teeShots === "shortgame" ? "Tee shot (short game)" : "Tee shot (approach)") : "Approach" };
  const pickFor = (k, from, p) => pickShot(course, n, k, from, p);
  // a planned shot's club, two ways that stay in sync: drop a target and the club is picked for me, or tap a club in the
  // strip (tee clubs first on tee shots) and the target goes where that club sends it, with the club locked
  function clubPickHTML(k, from, t) {
    const pk = t.p ? pickFor(k, from, t.p) : null, cur = t.p ? A.bag.find(c => c.name === t.club) || pk?.club : null, use = shotUse(k);
    let order = A.bag.filter(c => c.carry > 0).sort((a, b) => clubVal(b, use) - clubVal(a, use));
    if (k === "teeTarget" && h.par > 3) order = [...order.filter(c => c.tee), ...order.filter(c => !c.tee)];
    const strip = `<div class="clubstrip">${order.map(c => `<button class="chip${cur?.name === c.name ? " on" : ""}${t.byClub && cur?.name === c.name ? " lock" : ""}" data-byclub="${k}|${esc(c.name)}">${esc(clubAbbr(c.name) || c.name)}</button>`).join("")}</div>`;
    if (!cur) return strip;
    const here = v => playsLikeOn(ctx.slug) ? `${v} (~${reachYd(ctx.slug, v)} here)` : `${v}`;
    const what = k === "approach" ? `${here(cur.carry)} carry · ${finishWords(course, n, from, cur, getPin())}` : `${here(clubVal(cur, "total"))} total`;
    let note = "";
    if (t.byClub) { const cs = carryShort(course, n, from, t.p, cur); if (cs) note = `${cur.name} doesn't carry the ${cs.name} (needs ${Math.round(cs.need)}).`; }
    else if (pk?.hz) {   // the line has to carry a hazard: what it takes and what this club does
      const hz = pk.hz, past = clubVal(cur, pk.use) - pk.yards;
      note = !hz.clears ? `No club carries the ${hz.name} (${hz.need} needed; your longest carry is ${hz.longest.name} ${hz.longest.carry}). Lay up short of it: keep this shot under ${hz.front} yards.`
        : cur.carry < hz.need ? `${cur.name} doesn't clear the ${hz.name} (${hz.need} needed). ${pk.name} does.`
        : past > 10 ? `${cur.name} clears the ${hz.name} but finishes ${past} past your target. Move the target or lay up short of the ${hz.name}.` : "";
    } else note = pickNote(pk);
    return `<div class="pinfo"><b>${esc(cur.name)}</b> · ${esc(what)}</div>${strip}
      ${t.byClub ? `<div class="lockrow">Club locked: drag the target to aim left or right <button class="linkbtn" data-unlock="${k}">Unlock</button></div>`
        : `<div class="muted">Picked for this target by ${pk?.use === "total" ? "total" : "carry"} yards. Tap a club to place it by club instead.</div>`}
      ${note ? `<div class="warn">${esc(note)}</div>` : ""}`;
  }
  function placeByClub(k, name) {
    const c = A.bag.find(x => x.name === name); if (!c) return;
    ph[k] = { ...(ph[k] || {}), p: clubSpot(course, n, k, planOrigin(k), c, getPin()), club: name, clubSet: true, byClub: true };
    if (!ph.score) ph.score = h.par;
    if (tapMode === k) setTap(null);
    afterPlanChange(k);
  }
  // something earlier changed (a target, or the pin): targets set by club re-place from their new start with the same
  // club; targets I dropped by hand stay put and re-pick their club (unless I picked one)
  function afterPlanChange(k) {
    if (k) ph.edited = true;                                 // Auto-plan's reason no longer tells the whole story
    planKeys.slice(planKeys.indexOf(k) + 1).forEach(j => { const t = ph[j]; if (!t?.p) return;
      const c = A.bag.find(x => x.name === t.club);
      if (t.byClub && c) t.p = clubSpot(course, n, j, planOrigin(j), c, getPin());
      else if (!t.clubSet) t.club = pickFor(j, planOrigin(j), t.p)?.name || null; });
    if (!ph.dangerSet && ph.approach?.p) ph.danger = suggestDanger();
    persist(); drawAll(false);
  }
  function planOrigin(k) {
    const i = planKeys.indexOf(k);
    for (let j = i - 1; j >= 0; j--) if (ph?.[planKeys[j]]?.p) return ph[planKeys[j]].p;
    return teeP;
  }
  const suggestDanger = () => dangerSide(course, n, planOrigin("approach"), pinOrCenter(h, getPin()));

  // ---- round helpers
  const shots = () => (rh.shots = rh.shots || []);
  // turn the map so the hole plays up the screen (tee at the bottom, green at the top), then frame it. In a round once
  // I've hit, it turns from where I am now to the green, so the shot ahead fills the screen.
  function aim() {
    const from = ctx.mode === "round" && rh.shots?.length ? measureFrom() : teeP;
    // Green view: turned along my way into the green, so its back is at the top (like the pin preset grid)
    A.holeBearing = view === "green" ? bearingTo(approachFrom(), h.greenCenter) : bearingTo(Geo.yd(from, h.greenCenter) > 40 ? from : teeP, h.greenCenter);
    if (map.setBearing) map.setBearing(-A.holeBearing * (A.bearingSign || 1));
    frame();
  }
  function ballSpot() { const sh = rh?.shots || []; return sh.length ? playFrom(sh, sh.length - 1) : teeToday(); }
  function addBall(p, src, onGreen = false) {
    const sh = shots();
    if (!sh.length) {                                        // where you really teed off
      const gpsTee = onTeeGPS();
      sh.push({ p: teeToday(), club: rh.nextClub || null, src: gpsTee ? "gps tee" : "tee", lie: "Tee" });
      if (gpsTee) Store.logTee({ course: ctx.slug, hole: n, tee, p: A.gps.p, acc: Math.round(A.gps.acc), marker: teeP, t: Date.now() });
    }
    else if (rh.nextClub) sh.at(-1).club = rh.nextClub;
    const before = snap();
    sh.push({ p, club: null, src, onGreen, ...(onGreen ? { lie: "Green", lieAlt: [] } : lieGuess(course, n, p)) });
    rh.nextClub = null; persist(); drawAll(); if (view === "hole") aim();
    const x = sh.at(-1); undoBar(`Shot ${strokeNo(sh, sh.length - 1)} logged · ${x.lie}${x.lieAlt?.length ? "?" : ""}`, before);
  }
  // ---- undo right away: a snapshot of the hole before a shot, putts or a score change, and a 6-second "Undo" bar
  const snap = () => JSON.stringify(rh);
  function undoBar(msg, before) {
    const bar = $("#undoBar", s); clearTimeout(undoBar.t);
    bar.innerHTML = `<span>${esc(msg)}</span><button id="undoGo">Undo</button>`; bar.hidden = false; placeFloats();
    $("#undoGo", bar).onclick = () => { Object.keys(rh).forEach(k => delete rh[k]); Object.assign(rh, JSON.parse(before)); bar.hidden = true;
      persist(); drawAll(); if (view === "hole") aim(); toast("Undone"); };
    undoBar.t = setTimeout(() => { bar.hidden = true; }, 6000);
  }
  // ---- putting, one putt at a time: the first putt's length is my ball on the green to the pin; after a miss, the
  // next one is a quick tap (1–10+ ft). Uphill/downhill and break come from the green's slope map along each putt.
  // Saved per hole as puttLog [{ft, made, miss, up, brk, pct, src}], plus putts / firstPuttFt / leaveFt as before.
  const firstPuttFt = () => { const b = rh.shots?.at(-1); return b?.onGreen ? ftTo(b.p, pinOrCenter(h, getPin())) : null; };
  // the slope along a putt's line: averaged from the slope map's arrows near the line
  function slopeAlong(from, to) {
    const sh = slopeHole(), len = Geo.m(from, to); if (!sh || len < 0.3) return null;
    const N = Math.max(2, Math.ceil(len / 0.5)); let gx = 0, gy = 0, k = 0;
    for (let i = 0; i <= N; i++) {
      const p = [from[0] + (to[0] - from[0]) * i / N, from[1] + (to[1] - from[1]) * i / N];
      let best = null; sh.arrows.forEach(a => { const d = Geo.m(p, a); if (!best || d < best.d) best = { d, a }; });
      if (!best || best.d > 1.5) continue;
      const r = best.a[2] * Math.PI / 180; gx += best.a[3] * Math.sin(r); gy += best.a[3] * Math.cos(r); k++;
    }
    if (!k) return null;
    const d = Geo.xy(to, from), ux = d[0] / len, uy = d[1] / len; gx /= k; gy /= k;
    const along = gx * ux + gy * uy, cross = ux * gy - uy * gx;     // + along: falls toward the hole; + cross: falls to my left
    return { up: along > 0.75 ? "downhill" : along < -0.75 ? "uphill" : "level", brk: cross > 0.75 ? "right-to-left" : cross < -0.75 ? "left-to-right" : "straight",
      pct: Math.round(Math.hypot(gx, gy) * 10) / 10 };
  }
  // where putt i was hit from: my ball for the first; after that, estimated from the miss before (short = back down my
  // line, long = past the hole, left/right = beside it) at the distance I tapped
  function puttSpot(log, i) {
    const pin = pinOrCenter(h, getPin()), ball = rh.shots?.at(-1)?.onGreen ? rh.shots.at(-1).p : null;
    if (i === 0) return ball;
    const prev = log[i - 1], from = puttSpot(log, i - 1) || approachFrom(); if (!prev?.miss || !log[i]) return null;
    const d = Geo.xy(pin, from), l0 = Math.hypot(d[0], d[1]) || 1, ux = d[0] / l0, uy = d[1] / l0, m = log[i].ft / FT;
    const dir = { short: [-ux, -uy], long: [ux, uy], left: [-uy, ux], right: [uy, -ux] }[prev.miss];
    return Geo.ll([dir[0] * m, dir[1] * m], pin);
  }
  function askPutts() {
    const before = snap(), log = rh.puttLog = (rh.puttLog || []).filter(p => p.made != null);
    const md = modal(`<div class="pflow" id="pf"></div>`), box = $("#pf", md);
    let cur = null;
    const finish = () => { rh.putts = log.length; rh.firstPuttFt = log[0]?.ft ?? null; rh.leaveFt = log.length >= 2 ? log[1].ft : log.length ? 0 : null;
      rh.score = scoreOf(); persist(); md.remove(); drawAll(); undoBar(`${log.length} putt${log.length === 1 ? "" : "s"} logged · score ${rh.score}`, before); };
    const distChips = (fts, more) => fts.map(f => `<button class="chip" data-ft="${f}">${f}</button>`).join("") + (more ? '<button class="chip" data-more="1">10+</button>' : "");
    function askDist(i, long = false) {
      box.innerHTML = `<h3 style="margin:0">Putt ${i + 1}: how far?</h3><p class="muted">Feet from the hole${i ? "" : ". Place your ball on the green and the first putt is measured for you."}</p>
        <div class="chips">${long || !i ? distChips([10, 12, 15, 20, 25, 30, 40, 50, 60], false) : distChips([1, 2, 3, 4, 5, 6, 7, 8, 9], true)}</div>
        ${!i ? `<div class="chips">${distChips([1, 2, 3, 4, 5, 6, 7, 8, 9], false)}</div>` : ""}
        <div class="row">${i ? '<button class="linkbtn" id="pu">Undo last putt</button>' : ""}</div>`;
      box.querySelectorAll("[data-ft]").forEach(b => b.onclick = () => { cur = { ft: +b.dataset.ft, src: "tap" }; step(); });
      const more = $("[data-more]", box); if (more) more.onclick = () => askDist(i, true);
      const pu = $("#pu", box); if (pu) pu.onclick = () => { log.pop(); persist(); step(); };
    }
    function step() {
      const i = log.length;
      if (!cur && i === 0 && firstPuttFt() != null) cur = { ft: firstPuttFt(), src: "ball" };
      if (!cur) return askDist(i);
      const spot = puttSpot([...log, cur], i), sl = spot ? slopeAlong(spot, pinOrCenter(h, getPin())) : null;
      Object.assign(cur, { up: sl?.up || null, brk: sl?.brk || null, pct: sl?.pct ?? null });
      box.innerHTML = `<h3 style="margin:0">Putt ${i + 1} · ${cur.ft} ft</h3>
        <p class="muted">${cur.src === "ball" ? "Your ball to the pin. " : ""}${sl ? esc(puttSlopeWords(cur)) : slopes?.holes?.[n] ? "No slope reading on this line." : "No slope map for this green."}</p>
        <button class="btn" data-r="made">Made it</button>
        <div class="seclbl">Missed</div><div class="row">${["short", "long", "left", "right"].map(m => `<button class="btn alt small" data-r="${m}">${m}</button>`).join("")}</div>
        <div class="row" style="gap:16px">${i ? '<button class="linkbtn" id="pu">Undo last putt</button>' : '<button class="linkbtn" id="pc">Just count putts</button><button class="linkbtn" id="p0">Holed from off the green</button>'}
          ${cur.src === "tap" ? '<button class="linkbtn" id="pd">Change distance</button>' : ""}</div>`;
      box.querySelectorAll("[data-r]").forEach(b => b.onclick = () => { const r = b.dataset.r;
        log.push({ ...cur, made: r === "made", miss: r === "made" ? null : r }); cur = null; persist();
        if (r === "made") finish(); else step(); });
      const on2 = (id, f) => { const x = $("#" + id, box); if (x) x.onclick = f; };
      on2("pu", () => { log.pop(); cur = null; persist(); step(); });
      on2("pd", () => { cur = null; askDist(i); });
      on2("p0", () => { log.length = 0; finish(); });
      on2("pc", () => {                                  // the quick way: just the number of putts
        const fp = firstPuttFt();
        box.innerHTML = `<h3 style="margin:0">Putts on hole ${n}</h3>${fp != null ? `<p class="muted">First putt: <b>${fp} ft</b></p>` : ""}<div class="chips">${[0, 1, 2, 3, 4].map(k => `<button class="chip" data-k="${k}">${k}</button>`).join("")}</div>`;
        box.querySelectorAll("[data-k]").forEach(c => c.onclick = () => { const k = +c.dataset.k; delete rh.puttLog;
          rh.putts = k; rh.firstPuttFt = k ? fp : null; rh.leaveFt = k === 1 ? 0 : null; rh.score = scoreOf(); persist(); md.remove(); drawAll(); undoBar(`${k} putt${k === 1 ? "" : "s"} · score ${rh.score}`, before); });
      });
    }
    step();
  }
  const scoreOf = () => { const sh = rh.shots || []; const strokes = Math.max(0, sh.length - 1) || (sh.length ? 1 : 0); const pn = penOf(rh); return strokes + (rh.putts || 0) + pn.other + pn.ob + pn.pa; };

  // ---- GPS (round): live position for yardages
  function startGPS() {
    if (!("geolocation" in navigator) || !window.isSecureContext) { toast("Location needs the https:// address on your phone."); return; }
    if (A.gpsWatch !== null) return;
    if (!Store.get("locOk", false)) return locationCard().then(ok => ok && startGPS());   // first time: what location is for
    A.gpsWatch = navigator.geolocation.watchPosition(pos => {
      A.gps = { p: [pos.coords.latitude, pos.coords.longitude], acc: pos.coords.accuracy * YD, t: Date.now() }; drawAll(false);
    }, err => { toast(err.code === 1 ? "Location is blocked for this site. Allow it in your browser settings." : "No GPS fix yet."); }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
  }
  function bestFix(cb) {
    if (!("geolocation" in navigator) || !window.isSecureContext) return toast("Location needs the https:// address on your phone.");
    if (!Store.get("locOk", false)) return locationCard().then(ok => ok && bestFix(cb));
    let best = null; toast("Finding you…", 1500);
    const id = navigator.geolocation.watchPosition(p => { if (!best || p.coords.accuracy < best.coords.accuracy) best = p; if (best.coords.accuracy <= 4) done(); },
      () => done(), { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
    const t = setTimeout(done, 6000);
    function done() { navigator.geolocation.clearWatch(id); clearTimeout(t); if (best) cb([best.coords.latitude, best.coords.longitude], best.coords.accuracy * YD); else toast("Couldn't get a GPS fix. Tap your ball instead."); }
  }
  const gpsNear = () => A.gps && Date.now() - A.gps.t < 30000 && Geo.yd(A.gps.p, h.greenCenter) < 700;
  // ---- today's tee (round): standing on the tee, your GPS spot is the real tee for this hole; no signal = the course marker
  const TEE_ZONE_YD = 35;
  const onTeeGPS = () => ctx.mode === "round" && !rh.shots?.length && gpsNear() && Geo.yd(A.gps.p, teeP) <= TEE_ZONE_YD;
  const teeToday = () => rh?.shots?.length ? rh.shots[0].p : onTeeGPS() ? A.gps.p : teeP;
  const card = cardYards(course, tee, n);
  const playsToday = () => Math.round(card + usgaYd(h, teeToday()) - usgaYd(h, teeP));   // the card, plus how far the tee moved

  // ---- hazard editing + avoid zones
  function finishTrace() {
    const pts = trace; trace = null; setTap(null);
    if (!pts || pts.length < 3) { toast("Tap at least 3 points to outline an area."); drawAll(); return; }
    const kindOf = ctxTrace.kind;
    if (kindOf === "avoid") {
      const md = modal(`<h3 style="margin:0">Name this avoid zone</h3><label class="f">Name<input id="nm" placeholder="e.g. dead short-sided spot left"></label>
        <div class="row"><button class="btn red" id="r">Red · penalty or lost ball</button><button class="btn" style="background:#A8862F;border-color:#A8862F" id="y">Yellow · costly but playable</button></div>`);
      const save = color => { const all = Store.avoid(ctx.slug); (all[n] = all[n] || []).push({ id: "a" + Store.id(), name: $("#nm", md).value.trim() || "Avoid zone", color, ring: pts }); Store.saveAvoid(ctx.slug, all); md.remove(); drawAll(); toast("Avoid zone saved"); };
      $("#r", md).onclick = () => save("red"); $("#y", md).onclick = () => save("yellow");
    } else {
      typePicker(t => { const ed = Store.hazardEdits(ctx.slug); const e = (ed[n] = ed[n] || {}); (e.added = e.added || []).push({ type: "Feature",
        properties: { id: "u" + Store.id(), ...t }, geometry: { type: "Polygon", coordinates: [pts.concat([pts[0]]).map(([a, b]) => [b, a])] } });
        Store.saveHazardEdits(ctx.slug, ed); drawAll(); toast("Hazard added"); });
    }
  }
  let ctxTrace = {};
  // the types you can trace by hand, grouped like the Map key (boundary lines and avoid zones have their own tools)
  function typePicker(cb) {
    const md = modal(`<h3 style="margin:0">What is it?</h3><div id="tp" class="mkey"></div>`);
    HZ_GROUPS.slice(0, 5).forEach((gname, gi) => {
      const items = Object.entries(HZT).filter(([k, t]) => t.group === gi && !["fence", "ob_line"].includes(k));
      $("#tp", md).insertAdjacentHTML("beforeend", `<div class="seclbl">${esc(gname)}</div>`);
      items.forEach(([key, t]) => { const [kind, sub] = key.split(":");
        const it = el(`<div class="krow tap">${keySwatch(kind, sub)}<div class="grow"><b>${esc(t.name)}</b><small><span class="sev ${t.sev}">${t.sev === "red" ? "Red" : "Yellow"}</span></small></div><span>›</span></div>`);
        it.onclick = () => { md.remove(); cb(sub ? { kind, sub } : { kind }); }; $("#tp", md).appendChild(it); });
    });
  }
  // a hazard's severity: red (penalty or lost ball) or yellow (costly but playable). Saved as one of my hazard edits;
  // a native area's switch is "played as a penalty area"; an avoid zone keeps its color.
  function setSev(f, sev) {
    const id = f.properties.id, nat = f.properties.kind === "native";
    if (f.properties.kind === "avoid") { const all = Store.avoid(ctx.slug); const z = (all[n] || []).find(x => x.id === id); if (z) z.color = sev; Store.saveAvoid(ctx.slug, all); return; }
    const ed = Store.hazardEdits(ctx.slug), e2 = (ed[n] = ed[n] || {}), patch = nat ? { pa: sev === "red", sev: null } : { sev };
    if (id.startsWith("u")) { const x = (e2.added || []).find(x => x.properties.id === id); if (x) { Object.assign(x.properties, patch); if (x.properties.sev == null) delete x.properties.sev; } }
    else { const r = (e2.retyped = e2.retyped || {}); r[id] = { ...(r[id] || {}), ...patch }; }
    Store.saveHazardEdits(ctx.slug, ed);
  }
  function hazardMenu() {
    const md = modal(`<h3 style="margin:0">Hazards on hole ${n}</h3><p class="muted">Tap one to see it on the map. Red = penalty or lost ball (Auto-plan's full margin, carry warnings); yellow = costly but playable. Your edits are saved on this phone.</p>
      <div class="row"><button class="btn small" id="tr">Trace a new hazard</button><button class="btn small red" id="az">Draw an avoid zone</button></div><div id="hl" class="mkey"></div>
      <button class="btn small alt" id="mk">Map key</button><button class="btn small alt" id="undoAll">Undo all hazard edits on this hole</button>`);
    const all = hazards(course, n), groups = HZ_GROUPS.map((gname, gi) => [gname, all.filter(f => (f.properties.kind === "avoid" ? 5 : hzType(f).group) === gi)]);
    groups.forEach(([gname, list]) => {
      if (!list.length) return;
      $("#hl", md).insertAdjacentHTML("beforeend", `<div class="seclbl">${esc(gname)} · ${list.length}</div>`);
      // trees come in many small pieces: one line for all of them
      const rows = list[0].properties.kind === "trees" && list.every(f => f.properties.kind === "trees") ? [list[0]] : list;
      rows.forEach(f => {
        const p = f.properties, sv = sevOf(f), mine = p.id.startsWith("u") || p.id.startsWith("a"), many = rows !== list;
        const sw = p.kind === "native" ? `<label class="tog"><input type="checkbox" data-pa ${sv === "red" ? "checked" : ""}> Played as penalty area</label>`
          : ["ob_area", "fence", "ob_line"].includes(p.kind) || many ? `<span class="sev ${sv}">${many ? `${list.length} areas · ` : ""}${sv === "red" ? "Red" : "Yellow"}</span>`
          : `<span class="seg sevseg"><button data-sev="red" class="${sv === "red" ? "on" : ""}">Red</button><button data-sev="yellow" class="${sv === "yellow" ? "on" : ""}">Yellow</button></span>`;
        const it = el(`<div class="krow">${keySwatch(p.kind, p.sub, { ...p })}<div class="grow"><b>${esc(hazardName(f))}</b>${mine ? ' <span class="pill blue">yours</span>' : ""}${p.src === "osm" ? ' <small>OpenStreetMap</small>' : ""}
          <div class="hzctl">${sw}${many ? "" : `<button class="linkbtn" data-a="re">Retype</button><button class="linkbtn" data-a="del">Delete</button>`}</div></div></div>`);
        it.onclick = e => {
          const a = e.target.dataset.a; selectedHz = p.id; drawAll();
          if (e.target.dataset.sev) { setSev(f, e.target.dataset.sev); md.remove(); drawAll(); renderSheet(); hazardMenu(); return; }
          if (e.target.matches("[data-pa]")) { setSev(f, e.target.checked ? "red" : "yellow"); md.remove(); drawAll(); renderSheet(); hazardMenu(); return; }
          if (a === "del") {
            if (p.kind === "avoid") { const av = Store.avoid(ctx.slug); av[n] = (av[n] || []).filter(z => z.id !== p.id); Store.saveAvoid(ctx.slug, av); }
            else { const ed = Store.hazardEdits(ctx.slug); const e2 = (ed[n] = ed[n] || {});
              if (p.id.startsWith("u")) e2.added = (e2.added || []).filter(x => x.properties.id !== p.id); else (e2.deleted = e2.deleted || []).push(p.id);
              Store.saveHazardEdits(ctx.slug, ed); }
            md.remove(); selectedHz = null; drawAll(); hazardMenu(); toast("Deleted");
          } else if (a === "re") {
            md.remove(); typePicker(t => { const ed = Store.hazardEdits(ctx.slug); const e2 = (ed[n] = ed[n] || {});
              if (p.id.startsWith("u")) { const x = (e2.added || []).find(x => x.properties.id === p.id); Object.assign(x.properties, t, t.sub ? {} : { sub: undefined }); }
              else (e2.retyped = e2.retyped || {})[p.id] = { sub: null, ...t };
              Store.saveHazardEdits(ctx.slug, ed); drawAll(); hazardMenu(); });
          }
        };
        $("#hl", md).appendChild(it);
      });
    });
    $("#tr", md).onclick = () => { md.remove(); ctxTrace = { kind: "hazard" }; trace = []; setTap("trace"); };
    $("#az", md).onclick = () => { md.remove(); ctxTrace = { kind: "avoid" }; trace = []; setTap("trace"); };
    $("#mk", md).onclick = () => mapKey();
    $("#undoAll", md).onclick = () => { const ed = Store.hazardEdits(ctx.slug); delete ed[n]; Store.saveHazardEdits(ctx.slug, ed); md.remove(); drawAll(); toast("Back to the original hazards"); };
    md.addEventListener("click", e => { if (e.target === md) { selectedHz = null; drawAll(); } });
  }
  $("#menu", s).onclick = () => {
    const md = modal(`<h3 style="margin:0">Hole ${n}</h3><div class="list">
      <div class="item" id="mh"><div class="grow">Hazards and avoid zones</div><span>›</span></div>
      ${ctx.mode === "round" ? '<div class="item" id="ms"><div class="grow">Round summary</div><span>›</span></div>' : ""}
      ${ctx.mode === "plan" ? '<div class="item" id="mp"><div class="grow">Plan summary</div><span>›</span></div>' : ""}
      <div class="item" id="mc"><div class="grow">Course page</div><span>›</span></div></div>`);
    $("#mh", md).onclick = () => { md.remove(); hazardMenu(); };
    if ($("#ms", md)) $("#ms", md).onclick = () => { md.remove(); roundSummary(round.id); };
    if ($("#mp", md)) $("#mp", md).onclick = () => { md.remove(); planSummary(plan.id); };
    $("#mc", md).onclick = () => { md.remove(); coursePage(ctx.slug); };
  };

  // ---- green slopes: soft shading flat -> steep, downhill arrows, contours every 2 in, tiers / false fronts
  // hidden if I hid it; greens whose lidar looks wrong start hidden until I choose to show them
  const slopeHidden = () => { const v = Store.get("slopeHide:" + ctx.slug, {})[n]; return v === undefined ? !!slopes?.holes?.[n]?.suspect : v; };
  const slopeHole = () => slopes?.holes?.[n] && !slopeHidden() ? slopes.holes[n] : null;
  const bearingTo = (a, b2) => { const d = Geo.xy(b2, a); return (Math.atan2(d[0], d[1]) * 180 / Math.PI + 360) % 360; };
  function slopeWords(down) {                              // as I see it, coming from where I'm playing from
    const d = ((down - bearingTo(h.greenCenter, approachFrom()) + 540) % 360) - 180;
    return Math.abs(d) <= 45 ? "back-to-front" : Math.abs(d) >= 135 ? "front-to-back" : d < 0 ? "left-to-right" : "right-to-left";
  }
  function pinSlope() {
    const sh = slopeHole(); if (!sh) return null;
    const pinP = pinOrCenter(h, getPin());
    let best = null; sh.arrows.forEach(a => { const d = Geo.m(pinP, a); if (!best || d < best.d) best = { d, a }; });
    if (!best || best.d > 4) return "No slope reading right at the pin (too close to the edge).";
    const [, , down, pct] = best.a;
    return pct < 0.75 ? "Pin on a flat spot (under 1%)." : `Pin on a ${slopeWords(down)} slope, about ${Math.max(1, Math.round(pct))}%.`;
  }
  const slopesOn = () => prefs.slopes !== false;           // on unless I turned them off
  function drawSlopes() {
    slopeLayer.clearLayers();
    // the pin's slope, as a small caption on the map (Green view only)
    const cap = $("#slopeCap", s), read = view === "green" ? pinSlope() : null; cap.hidden = !read; cap.textContent = read || "";
    const sh = slopeHole(); if (!sh || view !== "green" || !slopesOn()) return;
    L.imageOverlay("data/" + sh.img, sh.bounds, { pane: "slopes", interactive: false, opacity: 0.6 }).addTo(slopeLayer);
    slopeArrows(sh);
  }
  // downhill arrows on an even grid: about every 5 ft (Santa Fe's coarser lidar: about 6.5 ft), every 2.5-3 ft zoomed
  // in, sparser zoomed out. Longer and darker = steeper; under 0.5 % has no arrow. A clear circle around the pin and my ball.
  function slopeArrows(sh) {
    const g = sh.grid; if (!g) return;
    const z = map.getZoom(), mpp = 40075016.686 * Math.cos(h.greenCenter[0] * Math.PI / 180) / Math.pow(2, z + 8);
    const step = g.step_ft / 3.28084, k = [1, 2, 4, 8, 16].find(m => step * m / mpp >= 11) || 16, sp = step * k;
    const clear = [pinOrCenter(h, getPin())]; if (ctx.mode === "round" && Geo.inRing(measureFrom(), h.green)) clear.push(measureFrom());
    const R = Math.PI / 180, at = (o, b2, m) => Geo.ll([Math.sin(b2 * R) * m, Math.cos(b2 * R) * m], o);
    const buckets = [[], [], [], []];                         // by steepness: up to 1 %, 2 %, 3 %, steeper
    g.pts.forEach(([i, j, down, t10]) => {
      if (i % k || j % k) return;
      const o = [g.lat0 + j * g.dlat, g.lng0 + i * g.dlng], pct = t10 / 10;
      if (clear.some(c => Geo.m(c, o) < 1.1)) return;
      const f = Math.min(pct, 4) / 4, len = sp * (0.28 + 0.34 * f), tip = at(o, down, len / 2), tail = at(o, down + 180, len / 2), hd = Math.max(len * 0.32, sp * 0.12);
      buckets[Math.min(3, Math.floor(pct))].push([tail, tip], [at(tip, down + 150, hd), tip, at(tip, down - 150, hd)]);
    });
    const ink = base === "map" ? "#1E3A2B" : "#FFFDF7";
    buckets.forEach((paths, b2) => { if (paths.length) L.polyline(paths, { pane: "hz", color: ink, weight: 1, opacity: [0.32, 0.5, 0.68, 0.88][b2], interactive: false }).addTo(slopeLayer); });
  }
  map.on("zoomend", () => { if (view === "green") drawSlopes(); });
  function slopeHTML() {
    if (!slopes?.holes?.[n]) return "";
    if (slopeHidden()) return `<div class="muted">${slopes.holes[n].suspect && Store.get("slopeHide:" + ctx.slug, {})[n] === undefined ? `Slopes hidden: ${esc(slopes.holes[n].suspect)}` : "Slopes hidden for this green."}
      <button class="linkbtn" id="slopeShow">Show anyway</button></div>`;
    const sh = slopes.holes[n], steep = sh.steep?.length ? `<div>Steep spots: ${sh.steep.map(z => esc(z.label)).join(", ")}.</div>` : "";
    if (view === "green") return `<div class="slope"><div class="row" style="align-items:center"><span style="flex:1">Slope shading and arrows</span><button class="chip${slopesOn() ? " on" : ""}" id="slopeTog">${slopesOn() ? "On" : "Off"}</button></div>${slopesOn() ? steep : ""}
      ${slopesOn() ? `<div class="muted" style="font-size:12px">Arrows point downhill; longer and darker is steeper. Estimated from public lidar (${esc(slopes.year)}). Greens can change; trust what you see. ${esc(slopes.credit)}.
      <button class="linkbtn" id="slopeHide">Hide slopes for this green</button></div>` : ""}</div>`;
    return "";
  }

  // ---- draw everything
  function drawAll(redrawFeatures = true) {
    if (redrawFeatures) { if (featLayer) featLayer.remove(); featLayer = drawFeatures(map, holeFeatures(course, n), base, { selected: selectedHz }).addTo(map); }
    drawSlopes();
    top.clearLayers();
    const pin = pinOrCenter(h, getPin());
    const ballOnGreen = ctx.mode === "round" && rh.shots?.length && Geo.inRing(measureFrom(), h.green);
    $("#pinLabel", s).textContent = ballOnGreen ? `Pin: ${ftTo(measureFrom(), pin)} ft` : pinMoved() ? "Pin: moved" : "Pin: center (default)";
    L.marker(teeP, { icon: teeIcon, interactive: false, keyboard: false }).addTo(top);   // marker pane: placed and drawn upright on the turned map
    const pm = L.marker(pin, { icon: pinIcon(pinMoved()), draggable: view === "green", zIndexOffset: 800 }).addTo(top);
    pm.on("drag", e => pinLoupe.move(e.target.getLatLng()));
    pm.on("dragend", e => { pinLoupe.end(); const ll = e.target.getLatLng(); setPin(onGreen([ll.lat, ll.lng])); drawAll(false); });
    pm.on("click", () => { if (view !== "green") setView("green"); });
    const LC = base === "map" ? "#1E3A2B" : "#FFFDF7";      // lines: hunter on the drawn map, light on the aerial
    if (view === "green") [3, 6, 10].forEach(ft => L.circle(pin, { radius: ft / 3.28084, color: LC, weight: 1, opacity: .6, fill: false, interactive: false, pane: "lines" }).addTo(top));
    // planned targets + planned line
    const P = ph || (roundPlan ? roundPlan.holes[n] : null);
    const planned = P ? planKeys.map(k => P[k]?.p).filter(Boolean) : [];
    if (planned.length && view !== "green") {
      L.polyline([teeToday(), ...planned, pin], { pane: "lines", color: LC, weight: 1.6, dashArray: "6 6", interactive: false }).addTo(top);
      planKeys.forEach((k, ki) => { if (!P[k]?.p) return;
        let o = teeToday(); for (let j = ki - 1; j >= 0; j--) if (P[planKeys[j]]?.p) { o = P[planKeys[j]].p; break; }
        const lbl = `${Math.round(Geo.yd(o, P[k].p))}${P[k].club ? ` ${clubAbbr(P[k].club)}` : ""}`;
        // club locked: the target slides along an arc at that club's distance, so I can aim left or right
        const arc = ll => { const c = ph?.[k]?.byClub && A.bag.find(x => x.name === ph[k].club);
          return c ? toward(planOrigin(k), [ll.lat, ll.lng], reachYd(ctx.slug, clubVal(c, shotUse(k))) / YD) : [ll.lat, ll.lng]; };
        L.marker(P[k].p, { icon: tgtIcon(k === "teeTarget" ? "T" : k === "layup" ? "L" : "A", true, lbl), draggable: ctx.mode === "plan", zIndexOffset: 600 }).addTo(top)
        .on("drag", e => { if (ph?.[k]?.byClub) e.target.setLatLng(arc(e.target.getLatLng()));
          if (ctx.mode !== "plan" || hzLabels.raf) return;            // hazard yardages follow the target as I drag it
          hzLabels.raf = requestAnimationFrame(() => { hzLabels.raf = 0; const ll = e.target.getLatLng(); ph[k].p = [ll.lat, ll.lng]; hzLabels(hazardPanel(course, n, panelLine())); }); })
        .on("dragend", e => { if (ctx.mode !== "plan") return; ph[k].p = arc(e.target.getLatLng());
          if (!ph[k].clubSet) ph[k].club = pickFor(k, planOrigin(k), ph[k].p)?.name || null; afterPlanChange(k); }); });
    } else if (ctx.mode !== "round" && view !== "green") {
      L.polyline(playLine(h, teeP, getPin()), { pane: "lines", color: LC, weight: 1.6, dashArray: "6 6", opacity: .9, interactive: false }).addTo(top);
    }
    // round: actual shots + GPS
    if (rh?.shots?.length) {
      const sh = rh.shots, ink = base === "map" ? "#1B1B18" : "#FFFFFF";
      if (view !== "green") sh.slice(1).forEach((x, i) => { L.polyline([playFrom(sh, i), x.p], { pane: "lines", color: x.out ? "#C62828" : ink, weight: 2, dashArray: x.out ? "5 5" : null, interactive: false }).addTo(top);
        if (x.drop) L.circleMarker(x.drop, { radius: 5, color: "#FFFDF7", weight: 2, fillColor: "#C62828", fillOpacity: 1, interactive: false }).addTo(top)
          .bindTooltip("Drop", { permanent: true, direction: "left", className: "lbl" }); });
      rh.shots.slice(1).forEach((x, i) => {
        const last = i === rh.shots.length - 2 && x.onGreen;      // my ball on the green: drag it into place (GPS is only good to a few yards)
        if (view === "green" && !Geo.inRing(x.p, h.green) && i < rh.shots.length - 2) return;   // earlier balls stay off the green view
        const mk = L.marker(x.p, { icon: ballIcon, interactive: last, draggable: last, zIndexOffset: last ? 850 : 0 }).addTo(top);
        if (view !== "green") mk.bindTooltip(`${strokeNo(sh, i + 1)}${x.lie ? ` · ${x.lie}${x.lieAlt?.length && !x.lieSet ? "?" : ""}` : ""}${x.out === "ob" ? " · OB +1" : x.out === "pa" ? " · +1" : ""}`, { permanent: true, direction: "right", className: "lbl" });
        if (last) mk.on("drag", e => pinLoupe.move(e.target.getLatLng())).on("dragend", e => { pinLoupe.end(); const ll = e.target.getLatLng();
          x.p = [ll.lat, ll.lng]; x.src = "drag"; if (rh.putts) rh.firstPuttFt = firstPuttFt(); persist(); drawAll(false); });
      });
    }
    if (A.gps && ctx.mode === "round") {
      L.circle(A.gps.p, { radius: A.gps.acc / YD, color: "#3E6E8E", weight: 1, fillOpacity: .12, interactive: false }).addTo(top);
      L.circleMarker(A.gps.p, { radius: 7, color: "#FFFDF7", weight: 3, fillColor: "#3E6E8E", fillOpacity: 1, interactive: false }).addTo(top);
    }
    if (trace?.length) L.polyline(trace.concat(trace.length > 2 ? [trace[0]] : []), { color: "#ff4fd8", weight: 3, dashArray: "4 4", pane: "lines" }).addTo(top);
    renderSheet();
  }

  // ---- bottom sheet
  // the compact yardage row: yards to the pin, F / M / B beside it, a small caption under them. On the green: feet.
  function yardRow(from, label, targets = [], extra = "") {
    const pin = pinOrCenter(h, getPin());
    if (ctx.mode === "round" && Geo.inRing(from, h.green)) {
      const ft = ftTo(from, pin);
      return `<div class="yrow"><div class="ybig"><b>${ft}</b><i>ft</i></div><div class="ycol"><div class="yttl">To the pin · on the green</div>
        <div class="ysub">${esc(label)}${pinMoved() ? "" : " · pin at center"}</div></div></div>`;
    }
    const line = playLine(h, from, getPin(), targets);
    const yd = Math.round(Geo.length(line) * YD);
    // front/middle/back are measured along the last leg into the green, from the last point well short of it
    let li = line.length - 2; while (li > 0 && Geo.yd(line[li], pin) < 30) li--;
    const last = line[li], before = Geo.length(line.slice(0, li + 1)) * YD;
    const fb = Geo.frontBack(h.green, last, pin);   // where my line to the pin enters (front) and leaves (back) the green; M = green center
    const c = Math.round(before + Geo.yd(last, h.greenCenter));
    const sub = [label + (line.length > 2 ? " · line of play" : ""), pinMoved() ? "" : "pin center", extra || `card ${card}`,
      playsLikeOn(ctx.slug) ? `plays ~${plays(ctx.slug, yd)} (${meta(ctx.slug).elevationFt.toLocaleString()} ft)` : ""].filter(Boolean).join(" · ");
    return `<div class="yrow"><div class="ybig"><b>${yd}</b><i>yd</i></div><div class="ycol">
      <div class="fmb">${fb ? `<span><i>F</i><b>${Math.round(before + fb.front)}</b></span>` : ""}<span class="m"><i>M</i><b>${c}</b></span>${fb ? `<span><i>B</i><b>${Math.round(before + fb.back)}</b></span>` : ""}</div>
      <div class="ysub">${esc(sub)}</div></div></div>`;
  }
  // Green view: just the pin, in feet on the green, in yards (and how far off the green) otherwise
  function greenRow(from, label) {
    const pin = pinOrCenter(h, getPin());
    if (Geo.inRing(from, h.green)) return yardRow(from, label);
    const fb = Geo.frontBack(h.green, from, pin), off = fb ? Math.round(fb.front) : null;
    return `<div class="yrow"><div class="ybig"><b>${Math.round(Geo.yd(from, pin))}</b><i>yd</i></div><div class="ycol"><div class="yttl">To the pin${off != null ? ` · ${off} off the green` : ""}</div>
      <div class="ysub">${esc(label)}${pinMoved() ? "" : " · pin at center"}</div></div></div>`;
  }
  // the line the hazard panel measures along: browse = from the tee; plan = from the start of the shot I'm setting,
  // else my last planned target; round = tee (GPS on the tee) / my GPS / my last ball. To the pin through targets ahead.
  function panelLine() {
    if (ctx.mode === "browse") return playLine(h, teeP, getPin());
    if (ctx.mode === "plan") {
      const tg = planKeys.map(k => ph[k]?.p), pinP = pinOrCenter(h, getPin());
      if (planKeys.includes(tapMode)) return playLine(h, planOrigin(tapMode), getPin(), tg);
      const set = planKeys.filter(k => ph[k]?.p && !Geo.inRing(ph[k].p, h.green) && Geo.yd(ph[k].p, pinP) > 30);
      return playLine(h, set.length ? ph[set.at(-1)].p : teeP, getPin(), tg);
    }
    const P = roundPlan?.holes[n];
    return playLine(h, measureFrom(), getPin(), P ? planKeys.map(k => P[k]?.p) : []);
  }
  // yardage-book labels on the map, each at the point it measures to with a tiny tick: "238" (reach) and "262 carry".
  // Carry numbers are placed first; a label that would overlap another (or the buttons) tries the other sides of its
  // tick, then is left out. Redrawn with GPS, target drags and zoom.
  let hzLast = [];
  function hzLabels(rows) {
    hzLayer.clearLayers(); hzLast = rows; if (!rows.length || !map._loaded) return;
    const sz = map.getSize(), placed = [{ x0: sz.x - 66, y0: 0, x1: sz.x, y1: 230 }, { x0: 0, y0: 0, x1: 230, y1: 44 },   // the button stack, the pin label
      { x0: 0, y0: sz.y - ($("#sheet", s)?.offsetHeight || sheetMin) - 24, x1: sz.x, y1: sz.y }];       // the panel and the map credit
    const at = p => map.latLngToContainerPoint(p), pn = at(pinOrCenter(h, getPin())), tp = at(teeP);
    placed.push({ x0: pn.x - 8, y0: pn.y - 40, x1: pn.x + 42, y1: pn.y + 6 }, { x0: tp.x - 12, y0: tp.y - 12, x1: tp.x + 12, y1: tp.y + 12 });   // the flag, the tee
    if (ctx.mode === "round") (rh.shots || []).slice(1).forEach(x => { const b = at(x.p); placed.push({ x0: b.x - 12, y0: b.y - 12, x1: b.x + 130, y1: b.y + 14 }); });   // balls and their labels
    const items = [...rows.filter(r => r.carry != null).map(r => ({ r, p: r.pB, txt: `${r.carry} carry` })),
      ...rows.filter(r => r.F > 0).map(r => ({ r, p: r.pF, txt: `${r.F}` }))];
    const pts = items.map(it => map.latLngToContainerPoint(it.p));
    pts.forEach(pt => placed.push({ x0: pt.x - 3, y0: pt.y - 3, x1: pt.x + 3, y1: pt.y + 3 }));       // every tick stays visible
    const hit = (a, b) => a.x0 < b.x1 + 2 && b.x0 < a.x1 + 2 && a.y0 < b.y1 + 2 && b.y0 < a.y1 + 2;
    items.forEach((it, k) => {
      const pt = pts[k], w = Math.round(it.txt.length * 6.2 + 6), hh = 14;
      if (pt.x < 0 || pt.y < 0 || pt.x > sz.x || pt.y > sz.y) return;
      // label right of the tick, left, above, below
      const opts = [[8, -hh / 2, "r"], [-8 - w, -hh / 2, "l"], [-w / 2, -8 - hh, "t"], [-w / 2, 8, "b"]];
      const own = placed.findIndex(b => b.x0 === pt.x - 3 && b.y0 === pt.y - 3);
      for (const [dx, dy, d] of opts) {
        const box = { x0: pt.x + dx, y0: pt.y + dy, x1: pt.x + dx + w, y1: pt.y + dy + hh };
        if (box.x0 < 2 || box.y0 < 2 || box.x1 > sz.x - 2 || box.y1 > sz.y - 2) continue;
        if (placed.some((b, bi) => bi !== own && hit(b, box))) continue;
        placed.push(box);
        L.marker(it.p, { interactive: false, keyboard: false, zIndexOffset: 300, icon: L.divIcon({ className: "", iconSize: [0, 0],   // marker pane: stays upright on the turned map
          html: `<i class="ydt ${d}"></i><span class="ydl${it.r.red ? " red" : ""}${base === "aerial" ? " ae" : ""}" style="left:${dx}px;top:${dy}px">${esc(it.txt)}</span>` }) }).addTo(hzLayer);
        break;
      }
    });
  }
  map.on("zoomend", () => hzLabels(hzLast));
  // the bottom sheet has three heights, dragged between by the handle: "min" (the default: one compact block, the map
  // gets most of the screen), "half" (adds hazards, the club strip, the plan) and "full" (everything). The last height
  // used is remembered; a tap on the map folds it back to min.
  let sheetState = ["min", "half", "full"].includes(prefs.sheet) ? prefs.sheet : "min";
  function sheetHeights() {
    const H = s.clientHeight || innerHeight;
    return { min: sheetMin, half: Math.max(sheetMin + 120, Math.round(H * 0.5)), full: Math.round(H * 0.88) };
  }
  function setSheet(state, px) {
    const sh = $("#sheet", s); if (!sh) return;
    if (state !== sheetState) { sheetState = state; prefs.sheet = state; Store.set("viewPrefs", prefs); }
    sh.classList.toggle("min", state === "min" && px == null); if (state === "min" && px == null) sh.scrollTop = 0;
    const hgt = px ?? sheetHeights()[state]; sh.style.height = hgt + "px"; placeFloats(hgt);
  }
  // drag handling lives on the sheet itself (bound once), so a re-render mid-drag (live GPS updates) doesn't cut it off.
  // Let go: snap to the nearest height. A tap on the handle steps up (min → half → full → min).
  function bindSheetDrag(sh) {
    if (sh.dataset.drag) return; sh.dataset.drag = "1";
    let y0 = null, h0 = 0, moved = false;
    sh.addEventListener("pointerdown", e => { if (!e.target.closest(".grab")) return; y0 = e.clientY; h0 = sh.offsetHeight; moved = false; sh.classList.add("dragging"); try { sh.setPointerCapture(e.pointerId); } catch {} });
    sh.addEventListener("pointermove", e => { if (y0 == null) return; const hs = sheetHeights(), dy = y0 - e.clientY; if (Math.abs(dy) > 4) moved = true;
      if (moved) setSheet(sheetState, Math.max(hs.min * 0.8, Math.min(hs.full, h0 + dy))); });
    const up = () => { if (y0 == null) return; sh.classList.remove("dragging"); y0 = null;
      if (!moved) return setSheet({ min: "half", half: "full", full: "min" }[sheetState]);
      const hs = sheetHeights(), cur = sh.offsetHeight;
      setSheet(Object.keys(hs).reduce((a, k) => Math.abs(hs[k] - cur) < Math.abs(hs[a] - cur) ? k : a)); };
    sh.addEventListener("pointerup", up); sh.addEventListener("pointercancel", up);
  }
  // pin presets and hints sit just above the sheet
  function placeFloats(hgt = $("#sheet", s)?.offsetHeight || 0) {        // pass the target height: offsetHeight lags during the slide
    s.style.setProperty("--sheet-h", hgt + "px");             // the map credit line sits just above the sheet
    $("#hint", s).style.bottom = (hgt + 12) + "px"; $("#undoBar", s).style.bottom = (hgt + 12) + "px";
  }
  // one short hazard line for the compact sheet: the first hazard in play, "+2" for the rest
  function hzLineHTML(rows) {
    if (!rows.length) return `<span class="hzline muted">No hazards</span>`;
    const r = rows[0], what = r.carry != null ? `${r.carry} carry` : `${r.F} reach`;
    return `<span class="hzline${r.red ? " red" : ""}">${esc(chipName(r.f))}${hzSide(r)} ${what}${rows.length > 1 ? ` · +${rows.length - 1}` : ""}</span>`;
  }
  // the lie of the ball I'm playing from: a guess near an edge ("Rough? Fairway · Fringe"), otherwise the lie, tappable
  function lieHTML() {
    const sh = rh?.shots || [], b = sh.length > 1 ? sh.at(-1) : null; if (!b) return "";
    const i = sh.length - 1, next = strokeNo(sh, i) + (b.out ? 1 : 0) + 1, pi = sh.findIndex(x => x.prov);
    const btn = (a, t, main) => `<button class="${main ? "liechip" : "liealt"}" data-pen="${a}">${t}</button>`;
    // a provisional: in play until I find the first ball (then it and its strokes come off)
    const prov = pi > 0 && pi >= i - 1 ? `<div class="penrow"><span><b>Provisional</b>${pi === i ? ` · +1, hit ${next} from ${pi === 1 ? "the tee" : "your last spot"}` : " in play"}</span>${btn("found", "Found the first ball")}</div>` : "";
    if (b.out === "ob") return prov || `<div class="penrow"><span><b>Out of bounds</b> · +1, hit ${next} from ${i === 1 ? "the tee" : "your last spot"}</span>${btn("clear", "Not OB")}</div>`;
    if (b.out === "pa") return `<div class="penrow"><span><b>Penalty area</b> · +1, ${b.drop ? `hit ${next} from the drop (${esc(b.dropLie || "")})` : "tap your drop spot"}</span>${btn("drop", b.drop ? "Move drop" : "Tap drop spot", !b.drop)}${btn("clear", "Not in it")}</div>`;
    if (b.lie === "Out of bounds" && !b.outNo) return prov + `<div class="penrow"><span><b>Out of bounds?</b></span>${btn("ob", "Stroke and distance +1", true)}${btn("prov", "Provisional ball")}${btn("clear", "In bounds")}</div>`;
    if (b.lie === "Penalty area" && !b.outNo) return prov + `<div class="penrow"><span><b>Penalty area?</b></span>${btn("pa", "+1 · drop", true)}${btn("clear", "Not in it")}</div>`;
    return prov + lieRow(b);
  }
  function lieRow(b) {
    if (b.lieAlt?.length && !b.lieSet) return `<div class="lierow"><button class="liechip guess" data-lieok="1" title="Tap to confirm">${esc(lieOfShot(b))}?</button>${b.lieAlt.map(l => `<button class="liealt" data-lie="${esc(l)}">${esc(l)}</button>`).join('<span class="muted">·</span>')}</div>`;
    return `<div class="lierow"><span class="seclbl">Lie</span><button class="liechip" data-liepick="1">${esc(lieOfShot(b))}</button></div>`;
  }
  const sec = (label, html) => html ? `<div class="sec"><div class="seclbl">${label}</div>${html}</div>` : "";
  function renderSheet() {
    const sh = $("#sheet", s); const pin = pinOrCenter(h, getPin());
    // ball on the green: putting in feet, so the yardage hazard panel and its labels step aside
    const greenMode = ctx.mode === "round" && rh.shots?.length && Geo.inRing(measureFrom(), h.green);
    const hzRows = greenMode ? [] : hazardPanel(course, n, panelLine()); hzLabels(view === "green" ? [] : hzRows);
    const hp = greenMode ? null : panelHTML(hzRows, ctx.slug);
    const hzLine = greenMode || view === "green" ? "" : hzLineHTML(hzRows);
    const hzHalf = hp ? hp.chips + hp.carry : "";
    const fullNotes = (view === "green" ? "" : slopeHTML()) + (greenMode ? "" : pinHazardsHTML(course, n, pin));
    $("#ydHead", s).textContent = onTeeGPS() ? `par ${h.par} · plays ${playsToday()} today (card ${card})` : `par ${h.par} · ${card} yd`;
    const navBtns = done => `<div class="row"><button class="btn alt" id="pv">‹ Hole ${n > 1 ? n - 1 : NH}</button>${n < NH ? `<button class="btn" id="nx">Hole ${n + 1} ›</button>` : `<button class="btn" id="sum">${done}</button>`}</div>`;
    let cmp = "", half = "", full = "";
    if (ctx.mode === "browse") {
      const pk = clubPick(plays(ctx.slug, card), h.par > 3 ? "total" : "carry", h.par > 3);
      if (view === "green") cmp += greenRow(teeP, `${tee} tee`);
      else {
        cmp += yardRow(teeP, `${tee} tee`);
        cmp += `<div class="cline" data-open="half">${pk ? `<b>${esc(clubAbbr(pk.name) || pk.name)}</b><span>· ${h.par > 3 ? "tee shot" : `${card} to the pin`}</span>` : ""}${hzLine}</div>`;
      }
      if (pk) half += sec("Club", `<div class="note it">${esc(pk.name)} · ${esc(clubLine(pk.club))}</div>`);
      half += hzHalf;
      full += fullNotes;
    } else if (ctx.mode === "plan") {
      const tg = planKeys.map(k => ph[k]?.p);
      cmp += view === "green" ? greenRow(planOrigin("approach"), "from your approach") : yardRow(teeP, `${tee} tee`, tg);
      if (view !== "green") {
        const set = planKeys.filter(k => ph[k]?.p);
        cmp += `<div class="cline" data-open="half">${set.length ? set.map(k => `<span>${KEYNAME[k].split(" (")[0]} <b>${esc(clubAbbr(ph[k].club) || "–")}</b> ${Math.round(Geo.yd(planOrigin(k), ph[k].p))}</span>`).join(" → ") : `<span class="muted">No targets yet · drag up to plan</span>`}${hzLine}</div>`;
      }
      let cards = "";
      planKeys.forEach(k => {
        const t = ph[k]; const from = planOrigin(k);
        const yd = t?.p ? Math.round(Geo.yd(from, t.p)) : null;
        const warns = t?.p ? [...spotWarnings(course, n, k, from, t.p), ...targetWarnings(course, n, from, t.p)].map(w => ({ ...w, msg: w.msg[0].toLowerCase() + w.msg.slice(1) })) : [];
        cards += `<div class="pcard"><div class="pch"><b>${KEYNAME[k]}</b>
          ${yd != null ? `<span class="num">${yd} yd${playsTxt(ctx.slug, yd)}</span>` : '<span class="muted">not set</span>'}
          <button class="btn small${tapMode === k ? "" : " alt"}" data-set="${k}">${t?.p ? "Move" : "Set"}</button></div>
          ${clubPickHTML(k, from, t || {})}
          ${warns.map(w => `<div class="warn${w.red ? " red" : ""}">Heads up: ${esc(w.msg)}. You can keep this target.</div>`).join("")}</div>`;
      });
      half += (ph.reason ? sec(ph.edited ? "Auto-plan's first idea · you've changed this hole" : `Why${ph.auto ? ` · Auto-plan, ${STRATEGIES[ph.auto]?.label || ""}` : ""}`, `<div class="it">${esc(ph.reason)}</div>`) : "") + sec("Your plan", cards) + hzHalf;
      full += fullNotes;
      full += sec(`Danger side${ph.dangerSet ? "" : " (suggested)"}`, `<div class="chips">${["short", "long", "left", "right"].map(d => `<button class="chip${ph.danger === d ? " on" : ""}" data-danger="${d}">${d}</button>`).join("")}</div>`);
      const sc = ph.score || h.par;   // shown as par until you change it or set a target
      full += sec("Planned score", `<div class="scorerow"><button class="btn small alt" id="sm">−</button><b class="num">${sc}</b><button class="btn small alt" id="sp">+</button></div>`)
        + sec("Hole note", `<input id="note" placeholder="Note for this hole" value="${esc(ph.note || "")}">`) + navBtns("Finish plan");
    } else {
      // on the tee (no shots yet): today's tee = your GPS spot when you're on the tee box, else the course marker
      const onTee = !rh.shots?.length, gpsTee = onTeeGPS();
      const fromGPS = !onTee && gpsNear() && !rh.shots.at(-1).onGreen; const from = onTee ? teeToday() : fromGPS ? A.gps.p : ballSpot();
      const label = onTee ? (gpsTee ? `${tee} tee · your spot (GPS ±${Math.round(A.gps.acc)} yd)` : `${tee} tee`)
        : fromGPS ? `You (GPS ±${Math.round(A.gps.acc)} yd)` : rh.shots?.length > 1 ? ({ ob: rh.shots.length === 2 ? "Replay from the tee" : "Replay from your last spot", pa: rh.shots.at(-1).drop ? "Your drop" : "Your ball" }[rh.shots.at(-1).out] || "Your ball") : `${tee} tee`;
      const P = roundPlan?.holes[n], tg = P ? planKeys.map(k => P[k]?.p) : [];
      // plan on the tee: targets stay where you planned them; distances come from today's tee, and the first club is
      // re-picked from your bag if the new distance calls for a different one
      let repick = null, planRows = "";
      if (P && onTee && planKeys.some(k => P[k]?.p)) {
        let prev = from;
        const rows = planKeys.filter(k => P[k]?.p).map((k, i) => {
          const prevPt = prev, d = Math.round(Geo.yd(prev, P[k].p)); prev = P[k].p;
          let club = P[k].club || pickFor(k, prevPt, P[k].p)?.name, note = "";
          if (i === 0 && gpsTee) {
            const was = pickFor(k, teeP, P[k].p)?.name, now = pickFor(k, from, P[k].p)?.name;
            if (now && was !== now && now !== club) { const ch = card - playsToday(); note = `Tees ${ch >= 0 ? "up" : "back"} ${Math.abs(ch)} yards: ${club} → ${now}`; repick = { from: club, to: now }; club = now; }
          }
          return `<div class="planrow"><span>${KEYNAME[k]}</span><b class="num">${d} yd</b><span class="club">${esc(club || "")}</span></div>${note ? `<div class="warn">${esc(note)}</div>` : ""}`;
        });
        planRows = `<div class="planrows">${rows.join("")}</div>`;
      } else if (P) planRows = `<div class="muted">${planKeys.filter(k => P[k]?.p).map(k => `${KEYNAME[k]} ${esc(P[k].club || "")}`).join(" → ") || "no targets"}${P.danger ? ` · danger ${P.danger}` : ""}${P.score ? ` · planned ${P.score}` : ""}</div>`;
      const nsh = Math.max(0, (rh.shots?.length || 0) - 1);
      // the club for this shot: the planned club (re-picked when the tee moved), else My Bag's pick for the distance
      // ahead; pre-selected once per shot, picked from the club strip (half height) to change it
      const planClub = repick && nsh === 0 ? repick.to : P && planKeys[nsh] ? P[planKeys[nsh]]?.club : null;
      const ahead = playLine(h, from, getPin(), tg)[1] || pin, teeShot = nsh === 0 && h.par > 3;
      const sug = greenMode ? "Putter" : clubPick(plays(ctx.slug, Geo.yd(from, ahead)), teeShot ? "total" : "carry", teeShot)?.name;
      if (rh.clubFor !== nsh && !rh.nextClub && (planClub || sug)) { rh.nextClub = planClub || sug; rh.clubFor = nsh; }
      const cur = A.bag.find(c => c.name === rh.nextClub);
      const tgtYd = Math.round(Geo.yd(from, ahead));
      const cnote = repick && nsh === 0 ? `Tees ${card - playsToday() >= 0 ? "up" : "back"}: ${repick.from} → ${repick.to} today` : planClub && planClub !== rh.nextClub ? `Planned ${planClub}` : planClub ? "As planned" : cur ? `From your bag · ${clubLine(cur).split(" · ")[1]}` : "";
      const putts = rh.shots?.at(-1)?.onGreen && rh.putts == null;
      const mainBtn = putts ? '<button class="btn slim" id="logPutts">Log putts</button>' : greenMode || view === "green" ? '<button class="btn slim" id="onGreen">On the green · putts</button>' : '<button class="btn slim" id="atBall">I\'m at my ball</button>';
      if (view === "green" || greenMode) cmp += greenRow(from, label) + mainBtn;
      else cmp += yardRow(from, label, tg, gpsTee ? `plays ${playsToday()} today / card ${card}` : "")
        + lieHTML()
        + `<div class="cline" data-open="half"><b>${rh.nextClub ? esc(clubAbbr(rh.nextClub) || rh.nextClub) : "No club"}</b><span>· ${tgtYd} to ${ahead === pin ? "the pin" : "target"}</span>${hzLine}</div>`
        + mainBtn;
      if (fromGPS && greenMode) half += '<div class="warn">GPS is only good to a few yards on the green. Tap "On green" to place your ball, then drag it into place.</div>';
      half += sec(`Club${rh.nextClub ? ` · ${esc(rh.nextClub)}` : ""}`, (cnote ? `<div class="note it claret">${esc(cnote)}</div>` : "") + `<div class="clubstrip" id="clubs">${A.settings.bag.map(([c]) => `<button class="chip${rh.nextClub === c ? " on" : ""}" data-club="${esc(c)}">${esc(clubAbbr(c) || c)}</button>`).join("")}<button class="chip${rh.nextClub === "Putter" ? " on" : ""}" data-club="Putter">Putter</button></div>`);
      half += hzHalf + sec(P && onTee && gpsTee ? "Your plan from today's tee" : "Your plan", planRows);
      full += fullNotes + (P?.note ? sec("Hole note", `<div class="it">“${esc(P.note)}”</div>`) : "");
      // every-hole controls live at half height: log a shot, putts, GPS and the score (never only at full height)
      const hole = `<div class="row">${putts ? '<button class="btn alt small" id="atBall">I\'m at my ball</button>' : ""}<button class="btn alt small" id="tapBall">Tap ball</button>${putts ? "" : '<button class="btn alt small" id="onGreen">On green</button>'}<button class="btn alt small${A.gpsWatch !== null ? " on" : ""}" id="live">${A.gpsWatch !== null ? "GPS on" : "Live GPS"}</button></div>
        <div class="scorerow"><span class="seclbl">Score</span><b class="num">${rh.score ?? "–"}</b><span class="muted" style="flex:1">${rh.putts != null ? `${rh.putts} putts${rh.firstPuttFt != null ? ` · first ${rh.firstPuttFt} ft` : ""} <button class="linkbtn" id="redoPutts">Redo</button>` : rh.puttLog?.length ? `${rh.puttLog.length} putt${rh.puttLog.length > 1 ? "s" : ""} so far` : ""}</span>
        <button class="btn small alt" id="sm">−</button><button class="btn small alt" id="sp">+</button></div>`;
      half = sec("This hole", hole) + half;
      const pn = penOf(rh);
      full += sec(`Penalties${penWords(pn) ? ` · ${penWords(pn)}` : ""}`, `<div class="row"><button class="btn alt small" data-pen="ob">Out of bounds</button><button class="btn alt small" data-pen="prov">Provisional ball</button><button class="btn alt small" data-pen="pa">Penalty area</button></div>
        <div class="row"><button class="btn alt small" id="pen">Other penalty +1${pn.other ? ` (${pn.other})` : ""}</button><button class="btn alt small" id="undo">Undo last shot</button></div>`) + navBtns("Finish round");
    }
    if (view === "green") { cmp = `<div class="gcmp"><div class="gl">${cmp}</div>${presetGridHTML()}</div>`; half = (slopeHTML() ? sec("Slopes", slopeHTML()) : "") + half; }
    sh.innerHTML = `<div class="grab" role="button" aria-label="Drag up for more, tap to step up"></div><div class="cmp">${cmp}</div><div class="more">${half}</div><div class="more">${full}</div>`;
    // the compact block sets the folded height: everything above the half-height extras, plus the bottom padding
    const c = $(".cmp", sh); sheetMin = Math.round(c.offsetTop + c.offsetHeight + parseFloat(getComputedStyle(sh).paddingBottom) + 2);
    bindSheetDrag(sh);
    if (!sh.classList.contains("dragging")) setSheet(sheetState);
    sh.querySelectorAll("[data-open]").forEach(x => x.onclick = () => setSheet(x.dataset.open));
    const setLie = l => { const b = rh.shots.at(-1); b.lie = l; b.lieSet = true; persist(); drawAll(false); };
    sh.querySelectorAll("[data-lie]").forEach(x => x.onclick = () => setLie(x.dataset.lie));
    sh.querySelectorAll("[data-lieok]").forEach(x => x.onclick = () => setLie(rh.shots.at(-1).lie));
    sh.querySelectorAll("[data-liepick]").forEach(x => x.onclick = () => {
      const md = modal(`<h3 style="margin:0">Lie for shot ${rh.shots.length}</h3><div class="chips">${LIES.map(l => `<button class="chip${l === rh.shots.at(-1).lie ? " on" : ""}" data-l="${esc(l)}">${esc(l)}</button>`).join("")}</div>`);
      md.querySelectorAll("[data-l]").forEach(c => c.onclick = () => { md.remove(); setLie(c.dataset.l); }); });
    const on = (id, f) => { const x = $("#" + id, sh); if (x) x.onclick = f; };
    const setHide = v => { const all = Store.get("slopeHide:" + ctx.slug, {}); all[n] = v; Store.set("slopeHide:" + ctx.slug, all); drawAll(false); };
    on("slopeHide", () => setHide(true)); on("slopeShow", () => setHide(false));
    on("slopeTog", () => { prefs.slopes = !slopesOn(); Store.set("viewPrefs", prefs); drawAll(false); });
    sh.querySelectorAll("[data-preset]").forEach(x => x.onclick = () => { const k = x.dataset.preset; setPin(k === "Middle Center" ? null : presetSpots()[k]); drawAll(false); });
    on("pv", () => holeView({ ...ctx, n: n > 1 ? n - 1 : NH }));
    on("nx", () => holeView({ ...ctx, n: n + 1 }));
    on("sum", () => ctx.mode === "plan" ? planSummary(plan.id) : roundSummary(round.id));
    if (ctx.mode === "plan") {
      sh.querySelectorAll("[data-set]").forEach(b => b.onclick = () => setTap(tapMode === b.dataset.set ? null : b.dataset.set));
      sh.querySelectorAll("[data-byclub]").forEach(x => x.onclick = () => { const [k, c] = x.dataset.byclub.split("|"); placeByClub(k, c); });
      sh.querySelectorAll("[data-unlock]").forEach(x => x.onclick = () => { const k = x.dataset.unlock; ph[k].byClub = false; ph[k].clubSet = false;
        ph[k].club = pickFor(k, planOrigin(k), ph[k].p)?.name || null; afterPlanChange(k); });
      sh.querySelectorAll("[data-danger]").forEach(x => x.onclick = () => { ph.danger = ph.danger === x.dataset.danger ? null : x.dataset.danger; ph.dangerSet = true; persist(); renderSheet(); });
      on("sm", () => { ph.score = Math.max(1, (ph.score || h.par) - 1); persist(); renderSheet(); });
      on("sp", () => { ph.score = (ph.score || h.par) + 1; persist(); renderSheet(); });
      $("#note", sh).onchange = e => { ph.note = e.target.value; persist(); };
      if (ph.danger === undefined) { ph.danger = suggestDanger(); persist(); }
    }
    if (ctx.mode === "round") {
      sh.querySelectorAll("[data-club]").forEach(x => x.onclick = () => { rh.nextClub = x.dataset.club; rh.clubFor = Math.max(0, (rh.shots?.length || 0) - 1); persist(); renderSheet(); });   // tapping a club always selects it
      on("atBall", () => bestFix((p, acc) => { addBall(p, "gps"); toast(`Ball marked (GPS ±${Math.round(acc)} yd). Drag-free: tap "Tap ball" to fix it.`); }));
      on("tapBall", () => setTap("ball"));
      on("onGreen", () => {
        // GPS on the green is a starting point only: drop the ball there, then drag it into place and log putts
        if (gpsNear() && Geo.inRing(A.gps.p, h.green)) { addBall(A.gps.p, "gps", true); setView("green"); toast("Ball placed at your GPS spot. Drag it into place, then log putts.", 3500); }
        else setTap("green");
      });
      on("logPutts", askPutts);
      on("redoPutts", () => { delete rh.puttLog; rh.putts = null; rh.firstPuttFt = null; rh.leaveFt = null; rh.score = scoreOf(); persist(); askPutts(); });
      on("pen", () => { const b0 = snap(); rh.penalties = (rh.penalties || 0) + 1; rh.score = scoreOf(); persist(); renderSheet(); undoBar(`Penalty added · score ${rh.score}`, b0); });
      // out of bounds (stroke and distance), a provisional, a penalty area (then tap the drop), or "it wasn't"
      sh.querySelectorAll("[data-pen]").forEach(x => x.onclick = () => {
        const a = x.dataset.pen, s2 = rh.shots || [], i = s2.length - 1, b = s2[i], b0 = snap();
        if (i < 1) return toast("Log the shot first: tap where it finished.");
        const clear = o => { delete o.out; delete o.prov; delete o.drop; delete o.dropLie; o.outNo = true;
          if (["Out of bounds", "Penalty area"].includes(o.lie)) { o.lie = "Rough"; o.lieAlt = []; o.lieSet = false; } };
        let msg;
        if (a === "found") { const pi = s2.findIndex(o => o.prov); s2.length = pi + 1; clear(s2[pi]); s2[pi].club = null; rh.nextClub = null; msg = "Provisional picked up · playing the first ball"; }
        else if (a === "clear") { clear(b); msg = `Shot ${strokeNo(s2, i)} · no penalty`; }
        else if (a === "drop") { setTap("drop"); setSheet("min"); return; }
        else if (b.out) return toast("This shot already has a penalty. Use Undo or Not OB / Not in it first.");
        else if (a === "ob" || a === "prov") { b.out = "ob"; delete b.outNo; if (a === "prov") b.prov = true;
          rh.nextClub = s2[i - 1].club || rh.nextClub; rh.clubFor = i;      // usually the same club again
          msg = `${a === "prov" ? "Provisional" : "Out of bounds"} · +1, hit ${strokeNo(s2, i) + 2} from ${i === 1 ? "the tee" : "your last spot"}`; }
        else if (a === "pa") { b.out = "pa"; delete b.outNo; msg = "Penalty area · +1, now tap your drop spot"; }
        if (rh.score != null || rh.putts != null) rh.score = scoreOf();
        persist(); drawAll(false); if (view === "hole") aim(); undoBar(msg, b0);
        if (a === "pa") { setTap("drop"); setSheet("min"); }
      });
      on("undo", () => { if (rh.shots?.length > 1) { rh.shots.pop(); if (rh.shots.length === 1) rh.shots = []; rh.score = scoreOf(); persist(); drawAll(false); } });
      on("live", () => { if (A.gpsWatch !== null) { navigator.geolocation.clearWatch(A.gpsWatch); A.gpsWatch = null; A.gps = null; drawAll(false); } else startGPS(); });
      on("sm", () => { const b0 = snap(); rh.score = Math.max(1, (rh.score || h.par) - 1); persist(); renderSheet(); undoBar(`Score ${rh.score}`, b0); });
      on("sp", () => { const b0 = snap(); rh.score = (rh.score || h.par) + 1; persist(); renderSheet(); undoBar(`Score ${rh.score}`, b0); });
    }
  }
  setBase(base); aim();
  setTimeout(() => {                                       // one-time tips on the first hole view and the first plan
    if (!document.body.contains(s)) return;
    if (ctx.mode === "plan") tipOnce("plan", [
      { sel: "#sheet .grab", text: "Drag the panel up to plan each shot: tap a club and the target goes where that club lands, or drag a target on the map and the club is picked for you." }], s);
    else tipOnce("hole", [
      { sel: "#sheet .grab", text: "The panel: yardages up front. Drag it up for hazards, your club and plan; tap the map to fold it back down." },
      { sel: "#atBall", text: "I'm at my ball: stand by your ball and tap. GPS marks the shot and the yardages start from there." },
      { sel: "#pinBtn", text: "The flag button opens Green view: slopes, the pin presets, and drag the flag (or tap the green) to move the pin. Tap it again to go back." }], s);
  }, 700);
}

// ---------------------------------------------------------------- plan summary, copy, switch tees
async function planSummary(id) {
  const p = Store.plans().find(x => x.id === id); if (!p) return home();
  const course = await loadCourse(p.course);
  const b = screen("Plan summary", () => coursePage(p.course), "");
  const keys = par => par === 3 ? ["approach"] : par === 5 ? ["teeTarget", "layup", "approach"] : ["teeTarget", "approach"];
  let rows = "";
  course.holes.forEach(h => {
    const ph = p.holes[h.n] || {}; const tee = teePoint(course, h.n, ph.tee || p.tees);
    const parts = keys(h.par).map(k => { const t = ph[k]; if (!t?.p) return "–"; let from = tee;
      const ks = keys(h.par); for (let j = ks.indexOf(k) - 1; j >= 0; j--) if (ph[ks[j]]?.p) { from = ph[ks[j]].p; break; }
      return `${esc(t.club || "?")} ${Math.round(Geo.yd(from, t.p))}`; }).filter((x, i, a) => x !== "–" || a.every(y => y === "–")).join(" → ");   // a skipped layup (in two) drops out
    rows += `<tr${(p.changed || []).includes(h.n) ? ' style="background:#fff3cd"' : ""} data-n="${h.n}" style="cursor:pointer"><td><b>${h.n}</b></td><td>${h.par}</td><td>${parts}${ph.reason ? `<div class="muted it" style="font-size:12px">${esc(ph.reason)}</div>` : ""}</td><td>${esc(ph.danger || "")}</td><td>${ph.pin ? "moved" : "center"}</td><td class="num"><b>${ph.score || "–"}</b></td></tr>`;
  });
  const card = el(`<div class="card"><label class="f">Plan name<input id="nm" value="${esc(p.name)}"></label>
    <div class="muted">${esc(meta(p.course).name)} · ${esc(p.tees)} tees · planned total <b>${planTotal(p) || "–"}</b> (par ${course.par.reduce((a, c) => a + c, 0)})</div>
    ${p.strategy ? `<div class="carry">Auto-plan, ${esc(STRATEGIES[p.strategy]?.label || p.strategy)}. Tap a hole to review it: drag any target or tap a club to change it. It's saved as you go.</div>` : ""}
    ${(p.changed || []).length ? `<div class="warn">Highlighted holes: the club probably changes from the ${esc(p.copiedFromTees)} plan.</div>` : ""}
    <div class="tablewrap"><table class="t"><tr><th>#</th><th>Par</th><th>Targets (club yd)</th><th>Danger</th><th>Pin</th><th>Score</th></tr>${rows}</table></div>
    <div class="row"><button class="btn" id="edit">Edit holes</button><button class="btn alt" id="play">Play this plan</button></div>
    <div class="row"><button class="btn alt" id="copy">Copy plan</button><button class="btn alt" id="sw">Copy for other tees</button><button class="btn alt red" id="del">Delete</button></div></div>`);
  b.appendChild(card);
  $("#nm", card).onchange = e => { p.name = e.target.value; Store.savePlan(p); };
  $("#edit", card).onclick = () => holeView({ mode: "plan", slug: p.course, tees: p.tees, n: 1, planId: p.id });
  card.querySelectorAll("tr[data-n]").forEach(tr => tr.onclick = () => holeView({ mode: "plan", slug: p.course, tees: p.tees, n: +tr.dataset.n, planId: p.id }));
  $("#play", card).onclick = () => { const r = { id: Store.id(), course: p.course, tees: p.tees, date: Date.now(), planId: p.id, holes: {} };
    Object.entries(p.holes).forEach(([n, ph]) => { r.holes[n] = {}; if (ph.pin) r.holes[n].pin = ph.pin; if (ph.tee) r.holes[n].tee = ph.tee; });
    Store.saveRound(r); holeView({ mode: "round", slug: p.course, tees: p.tees, n: 1, roundId: r.id }); };
  $("#copy", card).onclick = () => { const c = JSON.parse(JSON.stringify(p)); c.id = Store.id(); c.created = Date.now(); c.name = p.name + " (copy)"; delete c.changed; Store.savePlan(c); planSummary(c.id); };
  $("#sw", card).onclick = () => {
    const md = modal(`<h3 style="margin:0">Copy this plan for other tees</h3><p class="muted">Targets stay where they are; yardages are re-measured from the new tees, and holes where the club likely changes are highlighted.</p><div class="chips" id="tc"></div>`);
    course.teeOrder.filter(t => t !== p.tees).forEach(t => { const c = el(`<button class="chip">${esc(t)}</button>`); c.onclick = () => {
      const np = JSON.parse(JSON.stringify(p)); np.id = Store.id(); np.created = Date.now(); np.tees = t; np.copiedFromTees = p.tees; np.name = `${p.name} → ${t}`; np.changed = [];
      course.holes.forEach(h => { const ph = np.holes[h.n]; if (!ph) return; delete ph.tee; const ks = keys(h.par); const k0 = ks[0];
        if (ph[k0]?.p) { const yd = Geo.yd(teePoint(course, h.n, t), ph[k0].p); const nc = clubFor(plays(p.course, yd), h.par > 3 ? "total" : "carry", h.par > 3); if (nc !== ph[k0].club) { np.changed.push(h.n); ph[k0].club = nc; ph[k0].clubSet = false; } } });
      Store.savePlan(np); md.remove(); planSummary(np.id); }; $("#tc", md).appendChild(c); });
  };
  $("#del", card).onclick = () => { const md = modal(`<h3 style="margin:0">Delete this plan?</h3><div class="row"><button class="btn alt" id="n">Keep it</button><button class="btn red" id="y">Delete</button></div>`);
    $("#n", md).onclick = () => md.remove(); $("#y", md).onclick = () => { Store.deletePlan(p.id); md.remove(); coursePage(p.course); }; };
}

// ---------------------------------------------------------------- round summary: plan vs actual
async function roundSummary(id) {
  const r = Store.rounds().find(x => x.id === id); if (!r) return home();
  const course = await loadCourse(r.course); const plan = r.planId ? Store.plans().find(p => p.id === r.planId) : null;
  const b = screen("Round summary", home, "");
  const keys = par => par === 3 ? ["approach"] : par === 5 ? ["teeTarget", "layup", "approach"] : ["teeTarget", "approach"];
  const NAME = { teeTarget: "Tee shot", layup: "Layup", approach: "Approach" };
  const inHazard = (p, n) => hazards(course, n).filter(f => f.properties.kind !== "trees" && f.properties.kind !== "ob_line" && f.properties.kind !== "fence" && Geo.inside(p, f.geometry));
  const pens = { ob: 0, pa: 0, other: 0 };
  let tot = 0, ptot = 0, teeN = 0, teeIn = 0, apN = 0, apGood = 0, found = [], plannedHz = 0; const drift = []; let rows = "";
  const first = [], leave = [];                                  // putting, in feet
  course.holes.forEach(h => {
    const rh = r.holes[h.n] || {}, ph = plan?.holes[h.n] || {}; const sh = rh.shots || [];
    tot += rh.score || 0; if (rh.score) ptot += ph.score || h.par;
    const tee = rh.tee || r.tees;
    let detail = []; let miss = [];
    if (plan) {
      const ks = keys(h.par);
      ks.forEach((k, i) => {
        const tg = ph[k]; if (!tg?.p) return;
        const idx = k === "approach" ? (() => { const g = sh.findIndex(x => x.onGreen); return (g > 0 ? g : sh.length - 1) - 1; })() : i;
        const shot = sh[idx], fin = sh[idx + 1]; if (!shot || !fin) return;
        const o = playFrom(sh, idx), d = Geo.yd(fin.p, tg.p), m = Geo.miss(o, tg.p, fin.p);
        miss.push(d);
        detail.push(`${NAME[k]}: ${Math.round(d)} yd ${Geo.bearingWords(m)} of target · ${esc(tg.club || "?")} planned, ${shot.club ? esc(shot.club) + " used" : "club not logged"}`);
        if (k === "teeTarget") { teeN++; if (d <= 15) teeIn++; }
        if (k === "approach" && ph.danger && !(h.par === 3 && meta(r.course).teeShots === "shortgame")) {
          const pin = pinOrCenter(h, rh.pin), mm = Geo.miss(o, pin, fin.p);
          const bad = { short: mm.along < -3, long: mm.along > 3, left: mm.cross > 3, right: mm.cross < -3 }[ph.danger];
          apN++; if (!bad) apGood++; else detail.push(`<span class="pill red">missed toward danger (${ph.danger})</span>`);
        }
        plannedHz += targetWarnings(course, h.n, o, tg.p).length;
      });
    }
    sh.slice(1).filter(x => !x.out).forEach(x => inHazard(x.p, h.n).forEach(f => { found.push(`${h.n}: ${hazardName(f)}`); detail.push(`<span class="pill yellow">ended in ${esc(hazardName(f))}</span>`); }));
    if (sh.some(x => x.lie)) detail.push(`Lies: ${sh.slice(1).map(x => esc(lieOfShot(x)) + (x.lieAlt?.length && !x.lieSet ? "?" : "")).join(" → ")}`);
    const pn = penOf(rh); Object.keys(pens).forEach(k => pens[k] += pn[k]);
    if (penWords(pn)) detail.push(`<span class="pill red">${esc(penWords(pn))}</span>`);
    if (rh.putts != null) detail.push(rh.puttLog?.length ? `${rh.putts} putt${rh.putts === 1 ? "" : "s"}: ${rh.puttLog.map(p => `${p.ft} ft${p.up && p.up !== "level" ? ` ${p.up}` : ""} ${p.made ? "made" : `missed ${p.miss}`}`).join(" · ")}`
      : `${rh.putts} putt${rh.putts === 1 ? "" : "s"}${rh.firstPuttFt != null ? ` · first ${rh.firstPuttFt} ft` : ""}${rh.leaveFt ? ` · left ${rh.leaveFt} ft` : ""}`);
    if (rh.firstPuttFt != null) first.push(rh.firstPuttFt); if (rh.leaveFt != null && rh.putts >= 2) leave.push(rh.leaveFt);
    const pinMovedVsPlan = plan && ((ph.pin && !rh.pin) || (!ph.pin && rh.pin) || (ph.pin && rh.pin && Geo.yd(ph.pin, rh.pin) > 1));
    if (pinMovedVsPlan) detail.push(`<span class="pill blue">pin moved from plan</span>`);
    if (plan && rh.score) drift.push({ n: h.n, v: (miss.length ? miss.reduce((a, c) => a + c, 0) / miss.length : 0) + 10 * Math.abs((rh.score || 0) - (ph.score || h.par)) });
    rows += `<tr><td><b>${h.n}</b></td><td>${h.par}</td><td>${esc(tee)}</td>${plan ? `<td class="num">${ph.score || "–"}</td>` : ""}<td class="num"><b>${rh.score ?? "–"}</b></td><td>${detail.join("<br>") || ""}</td></tr>`;
  });
  const pct = (a, b2) => b2 ? `${Math.round(100 * a / b2)}%` : "–";
  const top3 = drift.sort((a, b2) => b2.v - a.v).slice(0, 3).map(x => x.n);
  const card = el(`<div class="card"><h3>${esc(meta(r.course).name)} · ${new Date(r.date).toLocaleDateString()}</h3>
    <div class="muted">${esc(r.tees)} tees${Object.values(r.holes).some(x => x.tee) ? " (some holes played from other tees)" : ""}${plan ? ` · plan: ${esc(plan.name)}` : ""}</div>
    <div class="stat"><div><b>${tot || "–"}</b><span>score${plan ? ` vs ${ptot} planned on the holes played` : ""}</span></div>
    <div><b>${pens.ob}</b><span>out-of-bounds strokes</span></div><div><b>${pens.pa}</b><span>penalty-area strokes</span></div>${pens.other ? `<div><b>${pens.other}</b><span>other penalty strokes</span></div>` : ""}
    ${first.length ? `<div><b>${Math.round(first.reduce((a, c) => a + c, 0) / first.length)} ft</b><span>average first putt (${first.length} hole${first.length === 1 ? "" : "s"})</span></div>` : ""}
    ${leave.length ? `<div><b>${Math.round(leave.reduce((a, c) => a + c, 0) / leave.length)} ft</b><span>average first-putt leave</span></div>` : ""}
    ${plan ? `<div><b>${pct(teeIn, teeN)}</b><span>tee shots within 15 yd of target (${teeIn}/${teeN})</span></div>
    <div><b>${pct(apGood, apN)}</b><span>approaches on the planned side (${apGood}/${apN})</span></div>
    <div><b>${found.length}</b><span>hazards found vs ${plannedHz} warned about in the plan</span></div>
    <div><b>${top3.length ? top3.join(", ") : "–"}</b><span>holes that drifted most from the plan</span></div>` : ""}</div>
    <div class="tablewrap"><table class="t"><tr><th>#</th><th>Par</th><th>Tees</th>${plan ? "<th>Plan</th>" : ""}<th>Score</th><th>${plan ? "Plan vs actual" : "Notes"}</th></tr>${rows}</table></div>
    ${plan ? '<p class="muted">“Drifted most” ranks holes by how far your shots finished from the planned targets (average yards), plus 10 for every stroke off your planned score.</p>' : ""}
    <div class="row"><button class="btn" id="resume">Back to the round</button><button class="btn alt red" id="del">Delete round</button></div></div>`);
  b.appendChild(card);
  $("#resume", card).onclick = () => holeView({ mode: "round", slug: r.course, tees: r.tees, n: 1, roundId: r.id });
  $("#del", card).onclick = () => { const md = modal(`<h3 style="margin:0">Delete this round?</h3><div class="row"><button class="btn alt" id="n">Keep it</button><button class="btn red" id="y">Delete</button></div>`);
    $("#n", md).onclick = () => md.remove(); $("#y", md).onclick = () => { Store.deleteRound(r.id); md.remove(); home(); }; };
}

// hidden data-check page (app/#teelog): the GPS tee-off spots saved on this phone, to copy to Claude
function teeLogPage() {
  const text = JSON.stringify(Store.teeLog(), null, 1);
  app.innerHTML = `<div class="body"><div class="card"><h3>Tee-off log (${Store.teeLog().length})</h3>
    <p class="muted">Where you teed off with GPS. Copy this and send it to Claude.</p><textarea readonly style="height:300px;font:12px ui-monospace,monospace"></textarea>
    <div class="row"><button class="btn" id="cp">Copy</button><a class="btn alt" href="./" style="text-align:center;text-decoration:none">Back to the app</a></div></div></div>`;
  $("textarea").value = text;
  $("#cp").onclick = async e => { try { await navigator.clipboard.writeText(text); } catch { $("textarea").select(); document.execCommand("copy"); } e.target.textContent = "Copied"; };
  return Promise.resolve();
}

// ---------------------------------------------------------------- start-up: safe data update, beta note, first-time setup
function betaNote() {
  return new Promise(res => {
    const md = modal(`<h3 style="margin:0">Koan Golf beta</h3><p>Distances are estimates from public maps. Your data stays on your phone. Please send feedback.</p>
      <p class="muted" style="margin:0">Version ${APP_VERSION} · the Feedback link is at the top of every screen.</p><button class="btn" id="ok">Got it</button>`);
    $("#ok", md).onclick = () => { Store.set("betaSeen", true); md.remove(); res(); };
  });
}
async function boot() {
  Store.migrate();
  A.profile = Store.profile(); A.bag = Store.bag(); A.settings = Store.settings();
  if (location.hash === "#teelog") return teeLogPage();
  if (!A.index.length) await loadIndex();
  hideSplash();                                            // before the beta note or welcome cards
  if (!Store.get("betaSeen", false)) await betaNote();
  if (!A.profile.name) { if (!Store.get("tourSeen", false)) await welcomeCards("Set up my bag"); return setupWizard(); }
  return home();
}

// the splash shows for at least ~0.8 s after the page starts, then fades out
function hideSplash() { const sp = document.getElementById("splash"); if (!sp || hideSplash.done) return; hideSplash.done = true;
  setTimeout(() => { sp.classList.add("out"); setTimeout(() => sp.remove(), 500); }, Math.max(0, 800 - performance.now())); }
boot().finally(hideSplash).catch(e => { app.innerHTML = `<div class="body"><div class="card"><h3>Couldn't load course data</h3><p>${esc(e.message)}</p></div></div>`; });
