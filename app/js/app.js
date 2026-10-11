// Driven Golf: courses, tees, pins, hazards, round plans, rounds and plan-vs-actual. Saved on this phone.
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

const KIND_LABEL = { water: "Water", bunker: "Bunker", trees: "Trees", ob_area: "Out of bounds", fence: "Fence (OB)", ob_line: "Course boundary (OB)", avoid: "Avoid zone" };
const HAZARD_KINDS = ["water", "bunker", "trees", "ob_area", "fence", "ob_line", "avoid"];
function hazardName(f) {
  const p = f.properties;
  if (p.kind === "avoid") return p.name || "Avoid zone";
  if (p.kind === "water") return p.sub === "lateral" ? "Lateral water" : "Water";
  if (p.kind === "bunker") return p.sub === "greenside" ? "Greenside bunker" : "Fairway bunker";
  return KIND_LABEL[p.kind] || p.kind;
}
const isRed = f => ["water", "ob_area", "fence", "ob_line"].includes(f.properties.kind) || (f.properties.kind === "avoid" && f.properties.color === "red");
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
// the pin or my next planned target) and within reach (longest club + 20), nearest first. Front / middle / back are
// straight-line yards from me to the near edge, the center and the far edge of the part of the outline near my line.
const PANEL_SIDE_YD = 30, PANEL_KINDS = ["water", "bunker", "ob_area", "fence", "ob_line", "avoid"];
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
const panelName = f => { const p = f.properties;
  return p.kind === "avoid" ? (p.name || "Avoid zone") : p.kind === "water" ? (p.sub === "lateral" ? "Lateral water" : "Water")
    : p.kind === "bunker" ? (p.sub === "greenside" ? "Greenside bunker" : "Fairway bunker") : "OB"; };
function hazardPanel(course, n, line) {
  const from = line[0], reach = Math.max(...A.bag.map(c => c.total || c.carry)) + 20, rows = [];   // in plays-like yards (altitude)
  hazards(course, n).filter(f => PANEL_KINDS.includes(f.properties.kind)).forEach(f => {
    const g = f.geometry, poly = g.type.includes("Polygon");
    const near = Geo.linesOf(g).flatMap(r => densify(r)).map(p => ({ p, sd: lineSide(line, p), d: Geo.yd(from, p) }))
      .filter(x => x.sd.d * YD <= PANEL_SIDE_YD);
    if (!near.length) return;
    const F = poly && Geo.inside(from, g) ? 0 : Math.min(...near.map(x => x.d)), B = Math.max(...near.map(x => x.d));
    if (plays(course.slug, F) > reach || B < 5) return;
    const c = [near.reduce((a, x) => a + x.p[0], 0) / near.length, near.reduce((a, x) => a + x.p[1], 0) / near.length];
    const M = Math.min(B, Math.max(F, Geo.yd(from, c)));
    const crosses = Geo.crossings(line, g, 1).length > 0, nl = near.filter(x => x.sd.s > 0).length;
    const side = crosses ? "crossing" : nl >= near.length - nl ? "L" : "R";
    rows.push({ f, F: Math.round(F), M: Math.round(M), B: Math.round(B), side, c, red: isRed(f) });
  });
  return rows.sort((a, b) => a.F - b.F);
}
// the club that carries the back edge of the nearest hazard area my line crosses (shortest club in My Bag that gets
// there). Only areas you fly over: an OB line or fence is a boundary, not something to carry.
function carryClub(rows, slug) {
  const r = rows.find(x => x.side === "crossing" && x.B > 0 && x.f.geometry.type.includes("Polygon")); if (!r) return null;
  const need = plays(slug, r.B), bag = A.settings.bag.slice().sort((a, b) => a[1] - b[1]);
  const club = bag.find(([, d]) => d >= need);
  return { r, txt: club ? `Carry ${panelName(r.f).toLowerCase()} ${r.B} → ${club[0]} (${club[1]} carry)` : `Carry ${panelName(r.f).toLowerCase()} ${r.B} → beyond your longest club (${bag.at(-1)[0]} ${bag.at(-1)[1]})` };
}
function panelHTML(rows, slug, open) {
  const pl = playsLikeOn(slug), cc = carryClub(rows, slug);
  const body = rows.length ? rows.map(r => `<div class="hzr"><span class="sw" style="background:${swatch(r.f)}"></span><span class="nm">${esc(panelName(r.f))} ${r.side} — <b class="num">${r.F} / ${r.M} / ${r.B}</b></span>${pl ? `<span class="pl">plays ${plays(slug, r.F)} / ${plays(slug, r.M)} / ${plays(slug, r.B)}</span>` : ""}</div>`).join("")
    : '<div class="muted">Nothing in play from here.</div>';
  return `<div class="hzp"><div class="hzh"><b>Hazards in play</b><span class="muted">front / middle / back</span><button class="linkbtn" id="hzToggle">${open ? "Hide" : `Show (${rows.length})`}</button></div>
    ${open ? body + (cc ? `<div class="carry">${esc(cc.txt)}</div>` : "") : ""}</div>`;
}
function pinHazardsHTML(course, n, pin) {
  const near = hazards(course, n).filter(f => f.properties.kind !== "trees").map(f => ({ f, d: Geo.distToGeom(pin, f.geometry) * YD })).filter(x => x.d <= 15);
  if (!near.length) return "";
  return `<div class="muted">From the pin: ${near.sort((a, b) => a.d - b.d).map(x => `${esc(hazardName(x.f))} ${Math.round(x.d)} yd`).join(" · ")}</div>`;
}
function targetWarnings(course, n, from, target) {
  const out = [];
  hazards(course, n).forEach(f => {
    const red = isRed(f), yellow = f.properties.kind === "avoid" && f.properties.color === "yellow";
    if (!red && !yellow) return;
    const d = Geo.distToGeom(target, f.geometry) * YD;
    if (d <= 15) out.push({ red, msg: `${Math.round(d)} yd from ${hazardName(f)}` });
    else if (from && red) {
      const rc = Geo.reachCarry([from, target], f.geometry, 2);
      if (rc && rc.carry < Geo.yd(from, target) - 3) out.push({ red, msg: `line carries ${hazardName(f)} (${rc.reach} to reach, ${rc.carry} to carry)` });
    }
  });
  return out;
}

// ---------------------------------------------------------------- screens
function screen(title, back, body) {
  app.innerHTML = "";
  const s = el(`<div class="screen"><div class="bar">${back ? '<button class="back" aria-label="Back">‹</button>' : ""}<h1>${esc(title)}</h1></div><div class="body"></div></div>`);
  if (back) $(".back", s).onclick = back;
  app.appendChild(s); stopMap();
  const b = $(".body", s); if (typeof body === "string") b.innerHTML = body; return b;
}

async function home() {
  if (!A.index.length) await loadIndex();
  const b = screen("Driven Golf", null, "");
  // me: name and handicap index (typed in from GHIN), with a nudge to refresh it after about two weeks
  const pr = A.profile, age = daysSince(pr.hcpDate);
  const me = el(`<div class="card me"><div class="item" style="padding:0"><div class="grow"><b>${pr.name ? esc(pr.name) : "Set up your Player Profile"}</b>
    <small>${pr.hcp !== "" && pr.hcp != null ? `Handicap index ${esc(pr.hcp)}` : "Name, handicap index, home course and My Bag"}</small></div><span>›</span></div>
    ${age != null && age >= 14 ? `<div class="warn">Your index was last updated ${age} days ago. <a href="https://www.ghin.com/" target="_blank" rel="noopener">Look up on GHIN</a>, then update it in your profile.</div>` : ""}</div>`);
  $(".item", me).onclick = profilePage; b.appendChild(me);
  const pl = el(`<button class="btn">Plan a round</button>`); pl.onclick = planWizard; b.appendChild(pl);
  // courses grouped by club: club -> its courses -> (course page) tees. Search matches either name.
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
  const groups = ["All", ...new Set(A.index.map(c => c.group))];
  let gsel = Store.get("roundFilter", "All"); if (!groups.includes(gsel)) gsel = "All";
  const rounds = Store.rounds().sort((a, b) => b.date - a.date).filter(r => gsel === "All" || meta(r.course).group === gsel);
  b.appendChild(el(`<h2>Rounds</h2>`));
  const fl = el(`<div class="chips">${groups.map(g => `<button class="chip${g === gsel ? " on" : ""}" data-g="${esc(g)}">${g === "18" ? "Full courses" : esc(g)}</button>`).join("")}</div>`);
  fl.querySelectorAll("[data-g]").forEach(x => x.onclick = () => { Store.set("roundFilter", x.dataset.g); home(); });
  b.appendChild(fl);
  const rl = el(`<div class="card list"></div>`);
  if (!rounds.length) rl.appendChild(el(`<p>No rounds here yet. Pick a course, then Start a round.</p>`));
  rounds.slice(0, 30).forEach(r => {
    const tot = Object.values(r.holes).reduce((s, h) => s + (h.score || 0), 0);
    const it = el(`<div class="item"><div class="grow"><b>${esc(meta(r.course).name || r.course)}</b><small>${esc(meta(r.course).course || "")} · ${new Date(r.date).toLocaleDateString()} · ${esc(r.tees)} tees${r.planId ? " · with plan" : ""}</small></div><b class="num">${tot || "–"}</b></div>`);
    it.onclick = () => roundSummary(r.id); rl.appendChild(it);
  });
  b.appendChild(rl);
  const st = el(`<button class="btn alt">Player Profile and My Bag</button>`); st.onclick = profilePage; b.appendChild(st);
}

async function coursePage(slug) {
  const course = await loadCourse(slug); const m = meta(slug);
  const b = screen(m.name, home, "");
  const prefTee = A.settings.prefTees?.[slug];
  let tee = [prefTee, Store.get("lastTee:" + slug, null), course.teeOrder[0]].find(t => t && course.teeOrder.includes(t));
  const card = el(`<div class="card"><h3>${esc(m.course)}</h3><p>${esc(m.city)} · par ${course.par.reduce((a, c) => a + c, 0)}${m.elevationFt != null ? ` · ${m.elevationFt.toLocaleString()} ft elevation` : ""}</p>
    <div class="muted">Tees</div><div class="chips" id="tees"></div><div class="muted" id="teeYd"></div>
    ${m.unconfirmedTees ? '<div class="warn">These yardages are measured from the map, not the scorecard. Check them against the card at the course.</div>' : ""}
    ${m.teeShots === "shortgame" ? '<div class="muted">Tee shots here count as short-game shots in your stats.</div>' : m.teeShots === "approach" ? '<div class="muted">Par-3 tee shots here count as approach shots in your stats.</div>' : ""}
    <div class="row"><button class="btn" id="startRound">Start a round</button><button class="btn alt" id="plan">Plan a round</button></div>
    <div class="row"><button class="btn alt" id="browse">Browse holes</button>${m.practice ? `<a class="btn alt" style="text-align:center;text-decoration:none" href="${esc(m.practice)}">Practice area</a>` : ""}</div></div>`);
  b.appendChild(card);
  const drawTees = () => {
    const box = $("#tees", card); box.innerHTML = "";
    course.teeOrder.forEach(t => { const c = el(`<button class="chip${t === tee ? " on" : ""}">${esc(t)}</button>`);
      c.onclick = () => { tee = t; Store.set("lastTee:" + slug, t); drawTees(); }; box.appendChild(c); });
    $("#teeYd", card).textContent = `${course.tees[tee].reduce((a, c) => a + c, 0).toLocaleString()} yards from the ${tee} tees`;
  };
  drawTees();
  $("#startRound", card).onclick = () => startRound(slug, tee);
  $("#plan", card).onclick = () => newPlan(slug, tee);
  $("#browse", card).onclick = () => holeView({ mode: "browse", slug, tees: tee, n: 1, pins: {} });
  const plans = Store.plans().filter(p => p.course === slug).sort((a, b) => b.created - a.created);
  b.appendChild(el(`<h2>Plans</h2>`));
  const pl = el(`<div class="card list"></div>`);
  if (!plans.length) pl.appendChild(el(`<p>No plans yet for this course.</p>`));
  plans.forEach(p => { const it = el(`<div class="item"><div class="grow"><b>${esc(p.name)}</b><small>${esc(p.tees)} tees · planned ${planTotal(p) || "–"}</small></div><span>›</span></div>`);
    it.onclick = () => planSummary(p.id); pl.appendChild(it); });
  b.appendChild(pl);
}

// Plan a round: club -> course (when the club has more than one) -> tees (my preferred tees first) -> hole-by-hole plan
function planWizard() {
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
      t => newPlan(slug, t));
  };
  step("Plan a round · club", clubs.map(n => [n, A.index.find(c => c.name === n).city, n]), name => {
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
// learning: where my logged shots finished vs my bag numbers. A logged shot ends where the ball stopped, so it's
// compared with total (carry if no total yet). Full swings only (at least 75% of the bag number), 5+ shots.
function bagLearning() {
  const by = {};
  Store.rounds().forEach(r => Object.values(r.holes).forEach(hh => {
    const sh = hh.shots || [];
    for (let i = 0; i < sh.length - 1; i++) { const c = sh[i].club; if (!c || c === "Putter") continue; (by[c] = by[c] || []).push(Geo.yd(sh[i].p, sh[i + 1].p)); }
  }));
  const dismissed = Store.get("bagDismiss", {});
  return A.bag.map(c => {
    const now = c.total || c.carry, ds = (by[c.name] || []).filter(d => d >= 0.75 * now).sort((a, b) => a - b);
    if (ds.length < 5) return null;
    const med = Math.round(ds[Math.floor(ds.length / 2)]);
    if (Math.abs(med - now) < 5 || dismissed[c.name] === med) return null;
    return { c, med, n: ds.length };
  }).filter(Boolean);
}
function profilePage() {
  const p = Store.profile(); let bag = JSON.parse(JSON.stringify(Store.bag()));
  const b = screen("Player Profile", home, "");
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
      const it = el(`<div class="learn">Your ${esc(sg.c.name)} finishes about <b>${sg.med}</b> yards over ${sg.n} logged shots (where the ball stopped, so that's total).
        Update its total from ${sg.c.total ?? "—"} to ${sg.med}? <div class="row"><button class="btn small">Update</button><button class="btn small alt">Not now</button></div></div>`);
      const [yes, no] = it.querySelectorAll("button");
      yes.onclick = () => { const c = bag.find(x => x.name === sg.c.name); if (c) c.total = sg.med; drawBag(); it.remove(); toast("Updated. Save your profile to keep it."); };
      no.onclick = () => { const d = Store.get("bagDismiss", {}); d[sg.c.name] = sg.med; Store.set("bagDismiss", d); it.remove(); };
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
    toast("Profile saved"); home();
  };
  b.append(prof, bagCard, pt, save);
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
  [["aerial", 250], ["fills", 350], ["hz", 420], ["lines", 460]].forEach(([nm, z]) => { map.createPane(nm, parent); map.getPane(nm).style.zIndex = z; });
  map.getPane("aerial").style.pointerEvents = "none"; map.getPane("fills").style.pointerEvents = "none";
  return map;
}
const FILL = { rough: "#b9d99a", fairway: "#7ccf5e", green: "#3fbf4f", tee_box: "#5fbf6a", bunker: "#f1e1a6", water: "#5aa9e6", trees: "#2f6b34" };
function drawFeatures(map, feats, base, opts = {}) {
  const g = L.layerGroup();
  const order = ["rough", "trees", "fairway", "tee_box", "water", "bunker", "green"];
  if (base === "map") {
    feats.filter(f => FILL[f.properties.kind]).sort((a, b) => order.indexOf(a.properties.kind) - order.indexOf(b.properties.kind))
      .forEach(f => L.geoJSON(f, { pane: "fills", interactive: false, style: { stroke: true, color: "#00000025", weight: .6, fillColor: FILL[f.properties.kind], fillOpacity: 1 } }).addTo(g));
  } else {
    feats.filter(f => ["green", "fairway"].includes(f.properties.kind)).forEach(f =>
      L.geoJSON(f, { pane: "hz", interactive: false, style: { color: "#ffffff", weight: 1, opacity: .55, fill: false } }).addTo(g));
  }
  // hazard outlines on top in both views (on the photo they mark what to avoid)
  feats.forEach(f => {
    const k = f.properties.kind, sel = opts.selected === f.properties.id;
    let st = null;
    if (k === "water") st = { color: f.properties.sub === "lateral" ? "#c62828" : "#1f6fd1", weight: 2.2, fillColor: "#5aa9e6", fillOpacity: base === "map" ? 0 : .25 };
    else if (k === "bunker" && base !== "map") st = { color: "#f6e3a1", weight: 1.6, fill: false };
    else if (k === "ob_area") st = { color: "#ffffff", weight: 2, dashArray: "6 5", fillColor: "#ffffff", fillOpacity: .18 };
    else if (k === "fence" || k === "ob_line") st = { color: "#ffffff", weight: 3, dashArray: "8 6", fill: false };
    else if (k === "avoid") st = { color: f.properties.color === "red" ? "#c62828" : "#e0a800", weight: 2.5, fillColor: f.properties.color === "red" ? "#c62828" : "#e0a800", fillOpacity: .22 };
    else if (k === "trees" && base !== "map") st = null;
    if (sel) st = { ...(st || {}), color: "#ff4fd8", weight: 4, fill: true, fillColor: "#ff4fd8", fillOpacity: .2 };
    if (st) L.geoJSON(f, { pane: "hz", interactive: !!opts.onSelect, style: st }).on("click", () => opts.onSelect && opts.onSelect(f)).addTo(g);
  });
  return g;
}
const pinIcon = (moved) => L.divIcon({ className: "", iconSize: [30, 30], iconAnchor: [4, 28],
  html: `<div class="pinm"><svg width="26" height="30" viewBox="0 0 26 30"><line x1="4" y1="2" x2="4" y2="29" stroke="#fff" stroke-width="2.5"/><path d="M5 3 L23 8 L5 13 Z" fill="${moved ? "#d6452f" : "#ffd27a"}" stroke="#16231a" stroke-width="1"/><circle cx="4" cy="28" r="2.5" fill="#16231a"/></svg></div>` });
const ballIcon = L.divIcon({ className: "", iconSize: [16, 16], html: '<div class="ballm"></div>' });
const tgtIcon = (t, plan) => L.divIcon({ className: "", iconSize: [26, 26], html: `<div class="tgt${plan ? " plan" : ""}">${esc(t)}</div>` });
const teeIcon = L.divIcon({ className: "", iconSize: [14, 14], html: '<div style="width:14px;height:14px;border-radius:3px;background:#fff;border:2px solid #16231a"></div>' });

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
  const setPin = p => { if (rh) rh.pin = p; else if (ph) ph.pin = p; else (ctx.pins = ctx.pins || {})[n] = p; persist(); };
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

  const s = el(`<div class="hole">
    <div class="bar"><button class="back" aria-label="Back">‹</button>
      <div style="flex:1;min-width:0"><div class="holenav"><button id="prev" aria-label="Previous hole">‹</button><span class="hn">Hole ${n}</span><button id="next" aria-label="Next hole">›</button>
      <span class="sub" id="ydHead">par ${h.par} · ${cardYards(course, tee, n)} yd</span></div>
      <div class="sub">${esc(modeTitle)} · ${esc(m.name)} · <button id="teeBtn" style="all:unset;cursor:pointer;text-decoration:underline">${esc(tee)} tees${tee !== ctx.tees ? " (this hole)" : ""}</button></div></div>
      <button class="btn small alt" id="menu">⋯</button></div>
    <div class="mapwrap"><div id="map"></div>
      <div class="fl seg" style="top:10px;left:10px"><button data-v="hole" class="on">Hole</button><button data-v="green">Green</button></div>
      <div class="fl seg" style="top:10px;right:10px"><button data-b="map">Map</button><button data-b="aerial">Aerial</button></div>
      <button class="fl floatbtn" id="reset" style="top:50px;left:10px">Reset</button>
      <button class="fl floatbtn" id="slopesBtn" style="top:90px;left:10px" hidden>Slopes</button>
      <div class="fl pinlabel" id="pinLabel" style="top:50px;right:10px"></div>
      <div class="fl presets" id="presets" hidden></div>
      <div class="fl hint" id="hint" hidden><span id="hintText"></span><button id="hintDone">Done</button></div>
    </div>
    <div class="sheet" id="sheet"></div></div>`);
  app.appendChild(s);
  $(".back", s).onclick = () => ctx.mode === "plan" ? planSummary(plan.id) : ctx.mode === "round" ? roundSummary(round.id) : coursePage(ctx.slug);
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
  let hzOpen = prefs.hzOpen !== false;
  const holeBounds = () => L.latLngBounds([teeP, h.greenCenter, ...h.path.slice(1, -1)]).pad(0.12);
  const greenBounds = () => L.latLngBounds(h.green).pad(0.35);
  const frame = () => {
    map.invalidateSize({ animate: false });                 // the sheet below changes height: re-measure the map first
    if (view === "green") map.fitBounds(greenBounds(), { paddingTopLeft: [10, 90], paddingBottomRight: [10, tapMode === "pin" ? 200 : 60] });   // room for the presets
    else map.fitBounds(holeBounds(), { paddingTopLeft: [10, 90], paddingBottomRight: [10, 40] });
  };
  const setBase = b => { base = b; prefs.base = b; Store.set("viewPrefs", prefs);
    s.querySelectorAll("[data-b]").forEach(x => x.classList.toggle("on", x.dataset.b === b));
    if (b === "aerial") aerial.addTo(map); else aerial.remove(); drawAll(); };
  const setView = v => { view = v; s.querySelectorAll("[data-v]").forEach(x => x.classList.toggle("on", x.dataset.v === v)); drawAll(); frame(); };   // draw (sheet height) first, then frame
  s.querySelectorAll("[data-b]").forEach(x => x.onclick = () => setBase(x.dataset.b));
  s.querySelectorAll("[data-v]").forEach(x => x.onclick = () => setView(x.dataset.v));
  $("#reset", s).onclick = frame;
  $("#slopesBtn", s).onclick = () => { prefs.slopes = !prefs.slopes; Store.set("viewPrefs", prefs); drawAll(false); };
  const loupeBase = () => L.imageOverlay(h.aerial.img, h.aerial.bounds);
  const wasHold = attachHold(map, loupeBase, ll => onTap(ll), () => !!tapMode);
  const pinLoupe = dragLoupe(map, loupeBase);
  map.on("click", e => { if (wasHold()) return; onTap([e.latlng.lat, e.latlng.lng]); });

  // ---- what a tap does
  const HINTS = { pin: "Drag the flag, tap the green, or pick a preset. Press and hold to magnify.",
    teeTarget: "Tap where you want your tee shot to finish.", layup: "Tap your layup target.", approach: "Tap your approach target.",
    ball: "Tap where your ball is. Press and hold to magnify.", green: "Tap where your ball finished on the green.",
    trace: "Tap around the area to outline it, then press Done." };
  function setTap(mode) {
    tapMode = mode;
    $("#hint", s).hidden = !mode; $("#hintText", s).textContent = mode ? HINTS[mode] : "";
    $("#presets", s).hidden = mode !== "pin";
    if (mode === "pin" || mode === "green") setView("green");
    else drawAll();
    if (mode === "pin") drawPresets();
  }
  $("#hintDone", s).onclick = () => { if (tapMode === "trace") finishTrace(); else { setTap(null); if (view === "green") setView("hole"); } };
  function onTap(p) {
    if (!tapMode) return;
    if (tapMode === "pin") { setPin(onGreen(p)); drawAll(); return; }
    if (["teeTarget", "layup", "approach"].includes(tapMode)) {
      const k = tapMode; const from = planOrigin(k); const yd = Geo.yd(from, p);
      ph[k] = { p, club: ph[k]?.clubSet ? ph[k].club : pickFor(k, from, p)?.name || null, clubSet: ph[k]?.clubSet };
      if (!ph.score) ph.score = h.par;
      if (k === "approach" && !ph.dangerSet) ph.danger = suggestDanger();
      persist(); setTap(null); drawAll(); return;
    }
    if (tapMode === "ball") { addBall(p, "tap"); setTap(null); return; }
    if (tapMode === "green") { addBall(p, "tap", true); setTap(null); askPutts(); return; }
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
    const line = playLine(h, measureFrom(), null, P ? planKeys.map(k => P[k]?.p) : []);
    let i = line.length - 2; while (i > 0 && Geo.yd(line[i], h.greenCenter) < 30) i--;
    return line[i];
  }
  function drawPresets() {
    const box = $("#presets", s); box.innerHTML = "";
    const pre = Geo.pinPresets(h.green, approachFrom(), h.greenCenter);   // laid out along my line into the green
    ["Back Left", "Back Center", "Back Right", "Middle Left", "Middle Center", "Middle Right", "Front Left", "Front Center", "Front Right"].forEach(k => {
      const b = el(`<button>${k.replace("Middle Center", "Center").replace("Middle ", "Mid ")}</button>`);
      b.onclick = () => { setPin(k === "Middle Center" ? null : pre[k]); drawAll(); }; box.appendChild(b);
    });
  }

  // ---- plan helpers
  const planKeys = h.par === 3 ? ["approach"] : h.par === 5 ? ["teeTarget", "layup", "approach"] : ["teeTarget", "approach"];
  const KEYNAME = { teeTarget: "Tee shot", layup: "Layup", approach: h.par === 3 ? (m.teeShots === "shortgame" ? "Tee shot (short game)" : "Tee shot (approach)") : "Approach" };
  // club for a planned shot: total yards for the tee shot (tee clubs on par 4/5) and layups; carry for approaches and
  // whenever the line has to carry a red hazard or avoid zone. Plays-like yards on altitude courses.
  function pickFor(k, from, p) {
    const yd = plays(ctx.slug, Geo.yd(from, p));
    const overHz = targetWarnings(course, n, from, p).some(w => w.msg.startsWith("line carries"));
    return clubPick(yd, k === "approach" || overHz ? "carry" : "total", k === "teeTarget" && h.par > 3);
  }
  function clubPickHTML(k, from, t) {
    const pk = pickFor(k, from, t.p), cur = A.bag.find(c => c.name === t.club) || pk?.club;
    if (!cur) return "";
    const order = A.bag.slice().sort((a, b) => b.carry - a.carry), i = order.findIndex(c => c.name === cur.name);
    const up = order[i - 1], dn = order[i + 1], note = pickNote(pk);
    return `<div class="clubpick"><button class="btn small alt" ${up ? `data-pickclub="${k}|${esc(up.name)}"` : "disabled"}>▲ ${up ? esc(up.name) : ""}</button>
      <b>${esc(clubLine(cur))}</b><button class="btn small alt" ${dn ? `data-pickclub="${k}|${esc(dn.name)}"` : "disabled"}>▼ ${dn ? esc(dn.name) : ""}</button></div>
      <div class="muted" style="font-size:12px">Picked by ${pk?.use === "total" ? "total" : "carry"} yards${t.clubSet ? ` · you chose ${esc(t.club)} <button class="linkbtn" data-autoclub="${k}">use the suggestion (${esc(pk?.name || "")})</button>` : ""}</div>
      ${note ? `<div class="warn">${esc(note)}</div>` : ""}`;
  }
  function planOrigin(k) {
    const i = planKeys.indexOf(k);
    for (let j = i - 1; j >= 0; j--) if (ph?.[planKeys[j]]?.p) return ph[planKeys[j]].p;
    return teeP;
  }
  function suggestDanger() {
    const pin = pinOrCenter(h, getPin()), from = planOrigin("approach");
    const tally = { short: 0, long: 0, left: 0, right: 0 };
    hazards(course, n).forEach(f => {
      if (!["water", "bunker", "ob_area", "fence", "ob_line", "avoid"].includes(f.properties.kind)) return;
      const d = Geo.distToGeom(pin, f.geometry) * YD; if (d > 20) return;
      // nearest point direction: sample the hazard's outline
      let best = null; Geo.linesOf(f.geometry).forEach(l => l.forEach(q => { const dd = Geo.yd(pin, q); if (!best || dd < best.d) best = { d: dd, q }; }));
      if (!best) return;
      const mm = Geo.miss(from, pin, best.q), w = isRed(f) ? 3 : 1;
      if (Math.abs(mm.along) > Math.abs(mm.cross)) tally[mm.along > 0 ? "long" : "short"] += w; else tally[mm.cross > 0 ? "left" : "right"] += w;
    });
    const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
    return top[1] > 0 ? top[0] : null;
  }

  // ---- round helpers
  const shots = () => (rh.shots = rh.shots || []);
  function ballSpot() { const sh = rh?.shots || []; return sh.length ? sh.at(-1).p : teeToday(); }
  function addBall(p, src, onGreen = false) {
    const sh = shots();
    if (!sh.length) {                                        // where you really teed off
      const gpsTee = onTeeGPS();
      sh.push({ p: teeToday(), club: rh.nextClub || null, src: gpsTee ? "gps tee" : "tee" });
      if (gpsTee) Store.logTee({ course: ctx.slug, hole: n, tee, p: A.gps.p, acc: Math.round(A.gps.acc), marker: teeP, t: Date.now() });
    }
    else if (rh.nextClub) sh.at(-1).club = rh.nextClub;
    sh.push({ p, club: null, src, onGreen });
    rh.nextClub = null; persist(); drawAll();
  }
  // putting is in feet: first putt = my ball on the green to the pin; leave = where the first putt finished
  const firstPuttFt = () => { const b = rh.shots?.at(-1); return b?.onGreen ? ftTo(b.p, pinOrCenter(h, getPin())) : null; };
  function askPutts() {
    const fp = firstPuttFt();
    const md = modal(`<h3 style="margin:0">Putts on hole ${n}</h3>${fp != null ? `<p class="muted">First putt: <b>${fp} ft</b></p>` : ""}<div class="chips" id="pc"></div>`);
    [0, 1, 2, 3, 4].forEach(k => { const c = el(`<button class="chip">${k}</button>`); c.onclick = () => {
      rh.putts = k; rh.firstPuttFt = k ? fp : null; rh.leaveFt = k === 1 ? 0 : null; rh.score = scoreOf(); persist(); md.remove(); drawAll();
      if (k >= 2) askLeave(); }; $("#pc", md).appendChild(c); });
  }
  function askLeave() {
    const md = modal(`<h3 style="margin:0">Where did your first putt finish?</h3><p class="muted">Feet from the hole</p><div class="chips" id="lc"></div><button class="btn alt" id="sk">Skip</button>`);
    [1, 2, 3, 4, 5, 6, 8, 10, 15, 20].forEach(ft => { const c = el(`<button class="chip">${ft}${ft === 20 ? "+" : ""} ft</button>`);
      c.onclick = () => { rh.leaveFt = ft; persist(); md.remove(); drawAll(false); }; $("#lc", md).appendChild(c); });
    $("#sk", md).onclick = () => md.remove();
  }
  const scoreOf = () => { const sh = rh.shots || []; const strokes = Math.max(0, sh.length - 1) || (sh.length ? 1 : 0); return strokes + (rh.putts || 0) + (rh.penalties || 0); };

  // ---- GPS (round): live position for yardages
  function startGPS() {
    if (!("geolocation" in navigator) || !window.isSecureContext) { toast("Location needs the https:// address on your phone."); return; }
    if (A.gpsWatch !== null) return;
    A.gpsWatch = navigator.geolocation.watchPosition(pos => {
      A.gps = { p: [pos.coords.latitude, pos.coords.longitude], acc: pos.coords.accuracy * YD, t: Date.now() }; drawAll(false);
    }, err => { toast(err.code === 1 ? "Location is blocked for this site. Allow it in your browser settings." : "No GPS fix yet."); }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
  }
  function bestFix(cb) {
    if (!("geolocation" in navigator) || !window.isSecureContext) return toast("Location needs the https:// address on your phone.");
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
        <div class="row"><button class="btn red" id="r">Red · penalty or lost ball</button><button class="btn" style="background:#e0a800;color:#16231a" id="y">Yellow · costly but playable</button></div>`);
      const save = color => { const all = Store.avoid(ctx.slug); (all[n] = all[n] || []).push({ id: "a" + Store.id(), name: $("#nm", md).value.trim() || "Avoid zone", color, ring: pts }); Store.saveAvoid(ctx.slug, all); md.remove(); drawAll(); toast("Avoid zone saved"); };
      $("#r", md).onclick = () => save("red"); $("#y", md).onclick = () => save("yellow");
    } else {
      typePicker(t => { const ed = Store.hazardEdits(ctx.slug); const e = (ed[n] = ed[n] || {}); (e.added = e.added || []).push({ type: "Feature",
        properties: { id: "u" + Store.id(), ...t }, geometry: { type: "Polygon", coordinates: [pts.concat([pts[0]]).map(([a, b]) => [b, a])] } });
        Store.saveHazardEdits(ctx.slug, ed); drawAll(); toast("Hazard added"); });
    }
  }
  let ctxTrace = {};
  function typePicker(cb) {
    const md = modal(`<h3 style="margin:0">What is it?</h3><div class="list" id="tp"></div>`);
    [["Water", { kind: "water", sub: "water" }], ["Lateral water (red)", { kind: "water", sub: "lateral" }], ["Greenside bunker", { kind: "bunker", sub: "greenside" }],
     ["Fairway bunker", { kind: "bunker", sub: "fairway" }], ["Trees / woods", { kind: "trees" }], ["Out of bounds", { kind: "ob_area" }]].forEach(([lab, t]) => {
      const it = el(`<div class="item"><div class="grow">${lab}</div><span>›</span></div>`); it.onclick = () => { md.remove(); cb(t); }; $("#tp", md).appendChild(it); });
  }
  function hazardMenu() {
    const md = modal(`<h3 style="margin:0">Hazards on hole ${n}</h3><p class="muted">Tap one to select it on the map, then retype or delete it. Your edits are saved on this phone.</p>
      <div class="row"><button class="btn small" id="tr">Trace a new hazard</button><button class="btn small red" id="az">Draw an avoid zone</button></div><div class="list" id="hl"></div>
      <button class="btn small alt" id="undoAll">Undo all hazard edits on this hole</button>`);
    hazards(course, n).forEach(f => {
      const it = el(`<div class="item"><span class="sw" style="background:${swatch(f)}"></span><div class="grow">${esc(hazardName(f))}${f.properties.id.startsWith("u") || f.properties.id.startsWith("a") ? ' <span class="pill blue">yours</span>' : ""}</div>
        <button class="btn small alt" data-a="re">Retype</button><button class="btn small alt" data-a="del">Delete</button></div>`);
      it.onclick = e => {
        const a = e.target.dataset.a; selectedHz = f.properties.id; drawAll();
        if (a === "del") {
          if (f.properties.kind === "avoid") { const all = Store.avoid(ctx.slug); all[n] = (all[n] || []).filter(z => z.id !== f.properties.id); Store.saveAvoid(ctx.slug, all); }
          else { const ed = Store.hazardEdits(ctx.slug); const e2 = (ed[n] = ed[n] || {});
            if (f.properties.id.startsWith("u")) e2.added = (e2.added || []).filter(x => x.properties.id !== f.properties.id); else (e2.deleted = e2.deleted || []).push(f.properties.id);
            Store.saveHazardEdits(ctx.slug, ed); }
          md.remove(); selectedHz = null; drawAll(); hazardMenu(); toast("Deleted");
        } else if (a === "re") {
          md.remove(); typePicker(t => { const ed = Store.hazardEdits(ctx.slug); const e2 = (ed[n] = ed[n] || {});
            if (f.properties.id.startsWith("u")) { const x = (e2.added || []).find(x => x.properties.id === f.properties.id); Object.assign(x.properties, t, t.sub ? {} : { sub: undefined }); }
            else (e2.retyped = e2.retyped || {})[f.properties.id] = { sub: null, ...t };
            Store.saveHazardEdits(ctx.slug, ed); drawAll(); hazardMenu(); });
        }
      };
      $("#hl", md).appendChild(it);
    });
    $("#tr", md).onclick = () => { md.remove(); ctxTrace = { kind: "hazard" }; trace = []; setTap("trace"); };
    $("#az", md).onclick = () => { md.remove(); ctxTrace = { kind: "avoid" }; trace = []; setTap("trace"); };
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
  function drawSlopes() {
    slopeLayer.clearLayers();
    const btn = $("#slopesBtn", s); btn.hidden = view !== "green" || !slopes?.holes?.[n]; btn.classList.toggle("on", !!prefs.slopes);
    const sh = slopeHole(); if (!sh || view !== "green" || !prefs.slopes) return;
    L.imageOverlay("data/" + sh.img, sh.bounds, { pane: "fills", interactive: false }).addTo(slopeLayer);
    sh.contours.forEach(c => L.polyline(c, { pane: "hz", color: "#ffffff", weight: 0.6, opacity: 0.25, interactive: false }).addTo(slopeLayer));
    const R = Math.PI / 180, at = (o, b2, m) => Geo.ll([Math.sin(b2 * R) * m, Math.cos(b2 * R) * m], o);
    sh.arrows.filter(a => a[3] >= 0.75).forEach(([la, lo, down]) => {      // small arrows pointing downhill
      const o = [la, lo], tip = at(o, down, 0.8), tail = at(o, down + 180, 0.8);
      L.polyline([tail, tip], { pane: "hz", color: "#16231a", weight: 1.2, opacity: 0.4, interactive: false }).addTo(slopeLayer);
      L.polyline([at(tip, down + 150, 0.45), tip, at(tip, down - 150, 0.45)], { pane: "hz", color: "#16231a", weight: 1.2, opacity: 0.4, interactive: false }).addTo(slopeLayer);
    });
    sh.steep.forEach(z => {
      L.polygon(z.ring, { pane: "hz", color: "#8e1c14", weight: 1.2, opacity: 0.7, dashArray: "3 4", fill: false, interactive: false }).addTo(slopeLayer);
      const c = [z.ring.reduce((a, q) => a + q[0], 0) / z.ring.length, z.ring.reduce((a, q) => a + q[1], 0) / z.ring.length];
      L.marker(c, { interactive: false, keyboard: false, icon: L.divIcon({ className: "", iconSize: [0, 0], html: `<div class="slopelbl">${esc(z.label)}</div>` }) }).addTo(slopeLayer);
    });
  }
  function slopeHTML() {
    if (!slopes?.holes?.[n]) return "";
    if (slopeHidden()) return `<div class="muted">${slopes.holes[n].suspect && Store.get("slopeHide:" + ctx.slug, {})[n] === undefined ? `Slopes hidden: ${esc(slopes.holes[n].suspect)}` : "Slopes hidden for this green."}
      <button class="linkbtn" id="slopeShow">Show anyway</button></div>`;
    const read = pinSlope();
    const note = view === "green" && prefs.slopes ? `<div class="muted" style="font-size:12px">Estimated from public lidar (${esc(slopes.year)}). Greens can change; trust what you see. ${esc(slopes.credit)}.
      <button class="linkbtn" id="slopeHide">Hide slopes for this green</button></div>` : "";
    return `<div class="slope">${read ? `<b>${esc(read)}</b>` : ""}${note}</div>`;
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
    const pm = L.marker(pin, { icon: pinIcon(pinMoved()), draggable: tapMode === "pin", zIndexOffset: 800 }).addTo(top);
    pm.on("drag", e => pinLoupe.move(e.target.getLatLng()));
    pm.on("dragend", e => { pinLoupe.end(); const ll = e.target.getLatLng(); setPin(onGreen([ll.lat, ll.lng])); drawAll(false); });
    pm.on("click", () => { if (ctx.mode !== "round" || true) setTap(tapMode === "pin" ? null : "pin"); });
    if (view === "green") [3, 6, 10].forEach(ft => L.circle(pin, { radius: ft / 3.28084, color: "#fff", weight: 1, opacity: .6, fill: false, interactive: false, pane: "lines" }).addTo(top));
    // planned targets + planned line
    const P = ph || (roundPlan ? roundPlan.holes[n] : null);
    const planned = P ? planKeys.map(k => P[k]?.p).filter(Boolean) : [];
    if (planned.length) {
      L.polyline([teeToday(), ...planned, pin], { pane: "lines", color: "#ffd27a", weight: 2, dashArray: "6 7", interactive: false }).addTo(top);
      planKeys.forEach(k => { if (!P[k]?.p) return; L.marker(P[k].p, { icon: tgtIcon(k === "teeTarget" ? "T" : k === "layup" ? "L" : "A", true), draggable: ctx.mode === "plan", zIndexOffset: 600 }).addTo(top)
        .on("dragend", e => { if (ctx.mode !== "plan") return; const ll = e.target.getLatLng(); ph[k].p = [ll.lat, ll.lng]; if (!ph[k].clubSet) ph[k].club = pickFor(k, planOrigin(k), ph[k].p)?.name || null; persist(); drawAll(false); }); });
    } else if (ctx.mode !== "round") {
      L.polyline(playLine(h, teeP, getPin()), { pane: "lines", color: "#fff", weight: 1.6, dashArray: "5 7", opacity: .85, interactive: false }).addTo(top);
    }
    // round: actual shots + GPS
    if (rh?.shots?.length) {
      L.polyline(rh.shots.map(x => x.p), { pane: "lines", color: "#fff", weight: 2.5, interactive: false }).addTo(top);
      rh.shots.slice(1).forEach((x, i) => {
        const last = i === rh.shots.length - 2 && x.onGreen;      // my ball on the green: drag it into place (GPS is only good to a few yards)
        const mk = L.marker(x.p, { icon: ballIcon, interactive: last, draggable: last, zIndexOffset: last ? 850 : 0 }).addTo(top)
          .bindTooltip(`${i + 1}`, { permanent: true, direction: "right", className: "lbl" });
        if (last) mk.on("drag", e => pinLoupe.move(e.target.getLatLng())).on("dragend", e => { pinLoupe.end(); const ll = e.target.getLatLng();
          x.p = [ll.lat, ll.lng]; x.src = "drag"; if (rh.putts) rh.firstPuttFt = firstPuttFt(); persist(); drawAll(false); });
      });
    }
    if (A.gps && ctx.mode === "round") {
      L.circle(A.gps.p, { radius: A.gps.acc / YD, color: "#2a7de1", weight: 1, fillOpacity: .12, interactive: false }).addTo(top);
      L.circleMarker(A.gps.p, { radius: 7, color: "#fff", weight: 3, fillColor: "#2a7de1", fillOpacity: 1, interactive: false }).addTo(top);
    }
    if (trace?.length) L.polyline(trace.concat(trace.length > 2 ? [trace[0]] : []), { color: "#ff4fd8", weight: 3, dashArray: "4 4", pane: "lines" }).addTo(top);
    renderSheet();
  }

  // ---- bottom sheet
  function yardBlock(from, label, targets = [], fromGPS = false) {
    const pin = pinOrCenter(h, getPin());
    // my ball is on the green (inside the outline, not the fringe): everything in feet
    if (ctx.mode === "round" && Geo.inRing(from, h.green)) {
      const ft = ftTo(from, pin);
      return `<div class="yards"><b>${ft}<span class="unit"> ft</span></b><div><div class="muted">Pin: ${ft} ft · ${esc(label)}${pinMoved() ? "" : " (pin at center)"}</div>
        ${fromGPS ? '<div class="warn">GPS is only good to a few yards on the green. Tap "On green" to place your ball, then drag it into place.</div>' : ""}</div></div>`;
    }
    const line = playLine(h, from, getPin(), targets);
    const total = Geo.length(line) * YD;
    // front/center/back are measured along the last leg into the green, from the last point well short of it
    let li = line.length - 2; while (li > 0 && Geo.yd(line[li], pin) < 30) li--;
    const last = line[li], before = Geo.length(line.slice(0, li + 1)) * YD;
    const yd = Math.round(total);
    const fb = Geo.frontBack(h.green, last, pin);   // where my line to the pin enters (front) and leaves (back) the green; C = green center
    const c = Math.round(before + Geo.yd(last, h.greenCenter));
    const bent = line.length > 2;
    return `<div class="yards"><b>${yd}</b><div><div class="muted">${esc(label)} to the pin${pinMoved() ? "" : " (center)"}${bent ? " · along the line of play" : ""}</div>
      <div class="fcb">${fb ? `<span>F <b>${Math.round(before + fb.front)}</b></span>` : ""}<span>M <b>${c}</b></span>${fb ? `<span>B <b>${Math.round(before + fb.back)}</b></span>` : ""}</div>
      ${playsLikeOn(ctx.slug) ? `<div class="pl">Plays like ~${plays(ctx.slug, yd)} (estimate, ${meta(ctx.slug).elevationFt.toLocaleString()} ft)</div>` : ""}</div></div>`;
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
  function hzLabels(rows) {
    hzLayer.clearLayers();
    rows.forEach(r => L.marker(r.c, { interactive: false, keyboard: false, zIndexOffset: 300, icon: L.divIcon({ className: "", iconSize: [0, 0],   // marker pane: stays upright on the turned map
      html: `<div class="hzlbl${r.red ? " red" : ""}">${r.F}/${r.M}/${r.B}</div>` }) }).addTo(hzLayer));
  }
  function renderSheet() {
    const sh = $("#sheet", s); const pin = pinOrCenter(h, getPin()); let html = "";
    // ball on the green: putting in feet, so the yardage hazard panel and its labels step aside
    const greenMode = ctx.mode === "round" && rh.shots?.length && Geo.inRing(measureFrom(), h.green);
    const hzRows = greenMode ? [] : hazardPanel(course, n, panelLine()); hzLabels(hzRows);
    const hzHTML = slopeHTML() + (greenMode ? "" : panelHTML(hzRows, ctx.slug, hzOpen) + pinHazardsHTML(course, n, pin));
    $("#ydHead", s).textContent = onTeeGPS() ? `par ${h.par} · plays ${playsToday()} today (card ${card})` : `par ${h.par} · ${card} yd`;
    if (ctx.mode === "browse") {
      html += yardBlock(teeP, `${tee} tee`);
      html += hzHTML;
      html += `<div class="row"><button class="btn alt" id="movePin">${tapMode === "pin" ? "Done moving pin" : "Move pin"}</button></div>`;
    } else if (ctx.mode === "plan") {
      html += yardBlock(teeP, `${tee} tee`, planKeys.map(k => ph[k]?.p));
      html += `<div class="row"><button class="btn small alt" id="movePin">${tapMode === "pin" ? "Done moving pin" : pinMoved() ? "Move pin" : "Set pin (center now)"}</button></div>`;
      planKeys.forEach(k => {
        const t = ph[k]; const from = planOrigin(k);
        const yd = t?.p ? Math.round(Geo.yd(from, t.p)) : null;
        const warns = t?.p ? targetWarnings(course, n, from, t.p) : [];
        html += `<div class="card" style="padding:10px;gap:6px"><div style="display:flex;gap:8px;align-items:center"><b style="flex:1">${KEYNAME[k]}</b>
          ${yd != null ? `<span class="num">${yd} yd${playsTxt(ctx.slug, yd)}</span>` : '<span class="muted">not set</span>'}
          <button class="btn small${tapMode === k ? "" : " alt"}" data-set="${k}">${t?.p ? "Move" : "Set"}</button></div>
          ${t?.p ? clubPickHTML(k, from, t) : ""}
          ${warns.map(w => `<div class="warn${w.red ? " red" : ""}">Heads up: ${esc(w.msg)}. You can keep this target.</div>`).join("")}</div>`;
      });
      html += hzHTML;
      html += `<div class="muted">Danger side${ph.dangerSet ? "" : " (suggested from nearby hazards)"}</div><div class="chips">${["short", "long", "left", "right"].map(d => `<button class="chip${ph.danger === d ? " on" : ""}" data-danger="${d}">${d}</button>`).join("")}</div>`;
      const sc = ph.score || h.par;   // shown as par until you change it or set a target
      html += `<div style="display:flex;gap:10px;align-items:center"><span class="muted">Planned score</span><button class="btn small alt" id="sm">−</button><b class="num" style="font-size:20px">${sc}</b><button class="btn small alt" id="sp">+</button></div>
        <input id="note" placeholder="Note for this hole" value="${esc(ph.note || "")}">
        <div class="row"><button class="btn alt" id="pv">‹ Hole ${n > 1 ? n - 1 : NH}</button>${n < NH ? `<button class="btn" id="nx">Hole ${n + 1} ›</button>` : `<button class="btn" id="sum">Finish plan</button>`}</div>`;
    } else {
      // on the tee (no shots yet): today's tee = your GPS spot when you're on the tee box, else the course marker
      const onTee = !rh.shots?.length, gpsTee = onTeeGPS();
      const fromGPS = !onTee && gpsNear() && !rh.shots.at(-1).onGreen; const from = onTee ? teeToday() : fromGPS ? A.gps.p : ballSpot();
      const label = onTee ? (gpsTee ? `${tee} tee · your spot (GPS ±${Math.round(A.gps.acc)} yd)` : `${tee} tee`)
        : fromGPS ? `You (GPS ±${Math.round(A.gps.acc)} yd)` : rh.shots?.length > 1 ? "Your ball" : `${tee} tee`;
      const P = roundPlan?.holes[n];
      html += yardBlock(from, label, P ? planKeys.map(k => P[k]?.p) : [], fromGPS);
      if (gpsTee) html += `<div class="today">Plays <b>${playsToday()}</b> today (card ${card})</div>`;
      html += hzHTML;
      // plan on the tee: targets stay where you planned them; distances come from today's tee, and the first club is
      // re-picked from your bag if the new distance calls for a different one
      let repick = null;
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
        html += `<div class="planrows"><div class="muted">Your plan${gpsTee ? " from today's tee" : ""}</div>${rows.join("")}</div>`;
      } else if (P) html += `<div class="muted">Plan: ${planKeys.filter(k => P[k]?.p).map(k => `${KEYNAME[k]} ${esc(P[k].club || "")}`).join(" → ") || "no targets"}${P.danger ? ` · danger ${P.danger}` : ""}${P.score ? ` · planned ${P.score}` : ""}${P.note ? ` · “${esc(P.note)}”` : ""}</div>`;
      const nsh = Math.max(0, (rh.shots?.length || 0) - 1);
      const nextNo = nsh + 1;
      // the planned club for this shot (re-picked when the tee moved) is pre-selected once; tap another chip to change it
      const planClub = repick && nsh === 0 ? repick.to : P && planKeys[nsh] ? P[planKeys[nsh]]?.club : null;
      if (planClub && rh.clubFor !== nsh && !rh.nextClub) { rh.nextClub = planClub; rh.clubFor = nsh; }
      html += `<div class="muted">Shot ${nextNo} club${repick && nsh === 0 ? ` (plan: ${esc(repick.from)} → ${esc(repick.to)} today)` : P && planKeys[nsh] && P[planKeys[nsh]]?.club ? ` (plan: ${esc(P[planKeys[nsh]].club)})` : ""}</div><div class="chips" id="clubs">${A.settings.bag.map(([c]) => `<button class="chip${rh.nextClub === c ? " on" : ""}" data-club="${esc(c)}">${esc(c)}</button>`).join("")}<button class="chip${rh.nextClub === "Putter" ? " on" : ""}" data-club="Putter">Putter</button></div>
        <div class="row"><button class="btn" id="atBall">I'm at my ball</button><button class="btn alt" id="tapBall">Tap ball</button></div>
        ${rh.shots?.at(-1)?.onGreen && rh.putts == null ? '<div class="row"><button class="btn" id="logPutts">Log putts</button></div>' : ""}
        <div class="row"><button class="btn alt" id="onGreen">On green</button><button class="btn alt" id="pen">Penalty +1${rh.penalties ? ` (${rh.penalties})` : ""}</button><button class="btn alt" id="undo">Undo</button></div>
        <div class="row"><button class="btn alt small" id="live">${A.gpsWatch !== null ? "Live GPS on" : "Turn on live GPS"}</button><button class="btn alt small" id="movePin">${tapMode === "pin" ? "Done moving pin" : "Move pin"}</button></div>
        <div style="display:flex;gap:10px;align-items:center"><span class="muted">Score</span><b class="num" style="font-size:22px">${rh.score ?? "–"}</b><span class="muted">${rh.putts != null ? `${rh.putts} putts${rh.firstPuttFt != null ? ` · first ${rh.firstPuttFt} ft${rh.leaveFt ? `, left ${rh.leaveFt} ft` : ""}` : ""}` : ""}</span>
        <button class="btn small alt" id="sm">−</button><button class="btn small alt" id="sp">+</button></div>
        <div class="row"><button class="btn alt" id="pv">‹ Hole ${n > 1 ? n - 1 : NH}</button>${n < NH ? `<button class="btn" id="nx">Hole ${n + 1} ›</button>` : `<button class="btn" id="sum">Finish round</button>`}</div>`;
    }
    sh.innerHTML = html;
    const on = (id, f) => { const x = $("#" + id, sh); if (x) x.onclick = f; };
    on("movePin", () => setTap(tapMode === "pin" ? null : "pin"));
    on("hzToggle", () => { hzOpen = !hzOpen; prefs.hzOpen = hzOpen; Store.set("viewPrefs", prefs); renderSheet(); });
    const setHide = v => { const all = Store.get("slopeHide:" + ctx.slug, {}); all[n] = v; Store.set("slopeHide:" + ctx.slug, all); drawAll(false); };
    on("slopeHide", () => setHide(true)); on("slopeShow", () => setHide(false));
    on("pv", () => holeView({ ...ctx, n: n > 1 ? n - 1 : NH }));
    on("nx", () => holeView({ ...ctx, n: n + 1 }));
    on("sum", () => ctx.mode === "plan" ? planSummary(plan.id) : roundSummary(round.id));
    if (ctx.mode === "plan") {
      sh.querySelectorAll("[data-set]").forEach(b => b.onclick = () => setTap(tapMode === b.dataset.set ? null : b.dataset.set));
      sh.querySelectorAll("[data-pickclub]").forEach(x => x.onclick = () => { const [k, c] = x.dataset.pickclub.split("|"); ph[k].club = c; ph[k].clubSet = true; persist(); renderSheet(); });
      sh.querySelectorAll("[data-autoclub]").forEach(x => x.onclick = () => { const k = x.dataset.autoclub; ph[k].clubSet = false; ph[k].club = pickFor(k, planOrigin(k), ph[k].p)?.name || null; persist(); renderSheet(); });
      sh.querySelectorAll("[data-danger]").forEach(x => x.onclick = () => { ph.danger = ph.danger === x.dataset.danger ? null : x.dataset.danger; ph.dangerSet = true; persist(); renderSheet(); });
      on("sm", () => { ph.score = Math.max(1, (ph.score || h.par) - 1); persist(); renderSheet(); });
      on("sp", () => { ph.score = (ph.score || h.par) + 1; persist(); renderSheet(); });
      $("#note", sh).onchange = e => { ph.note = e.target.value; persist(); };
      if (ph.danger === undefined) { ph.danger = suggestDanger(); persist(); }
    }
    if (ctx.mode === "round") {
      sh.querySelectorAll("[data-club]").forEach(x => x.onclick = () => { rh.nextClub = rh.nextClub === x.dataset.club ? null : x.dataset.club; persist(); renderSheet(); });
      on("atBall", () => bestFix((p, acc) => { addBall(p, "gps"); toast(`Ball marked (GPS ±${Math.round(acc)} yd). Drag-free: tap "Tap ball" to fix it.`); }));
      on("tapBall", () => setTap("ball"));
      on("onGreen", () => {
        // GPS on the green is a starting point only: drop the ball there, then drag it into place and log putts
        if (gpsNear() && Geo.inRing(A.gps.p, h.green)) { addBall(A.gps.p, "gps", true); setView("green"); toast("Ball placed at your GPS spot. Drag it into place, then log putts.", 3500); }
        else setTap("green");
      });
      on("logPutts", askPutts);
      on("pen", () => { rh.penalties = (rh.penalties || 0) + 1; rh.score = scoreOf(); persist(); renderSheet(); });
      on("undo", () => { if (rh.shots?.length > 1) { rh.shots.pop(); if (rh.shots.length === 1) rh.shots = []; rh.score = scoreOf(); persist(); drawAll(false); } });
      on("live", () => { if (A.gpsWatch !== null) { navigator.geolocation.clearWatch(A.gpsWatch); A.gpsWatch = null; A.gps = null; drawAll(false); } else startGPS(); });
      on("sm", () => { rh.score = Math.max(1, (rh.score || h.par) - 1); persist(); renderSheet(); });
      on("sp", () => { rh.score = (rh.score || h.par) + 1; persist(); renderSheet(); });
    }
  }
  // turn the map so the hole plays up the screen (tee at the bottom, green at the top)
  const az = (a, b2) => { const d = Geo.xy(b2, a); return (Math.atan2(d[0], d[1]) * 180 / Math.PI + 360) % 360; };
  A.holeBearing = az(teeP, h.greenCenter);
  setBase(base); frame();
  if (map.setBearing) { map.setBearing(-A.holeBearing * (A.bearingSign || 1)); frame(); }
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
      return `${esc(t.club || "?")} ${Math.round(Geo.yd(from, t.p))}`; }).join(" → ");
    rows += `<tr${(p.changed || []).includes(h.n) ? ' style="background:#fff3cd"' : ""}><td><b>${h.n}</b></td><td>${h.par}</td><td>${parts}</td><td>${esc(ph.danger || "")}</td><td>${ph.pin ? "moved" : "center"}</td><td class="num"><b>${ph.score || "–"}</b></td></tr>`;
  });
  const card = el(`<div class="card"><label class="f">Plan name<input id="nm" value="${esc(p.name)}"></label>
    <div class="muted">${esc(meta(p.course).name)} · ${esc(p.tees)} tees · planned total <b>${planTotal(p) || "–"}</b> (par ${course.par.reduce((a, c) => a + c, 0)})</div>
    ${(p.changed || []).length ? `<div class="warn">Highlighted holes: the club probably changes from the ${esc(p.copiedFromTees)} plan.</div>` : ""}
    <div class="tablewrap"><table class="t"><tr><th>#</th><th>Par</th><th>Targets (club yd)</th><th>Danger</th><th>Pin</th><th>Score</th></tr>${rows}</table></div>
    <div class="row"><button class="btn" id="edit">Edit holes</button><button class="btn alt" id="play">Play this plan</button></div>
    <div class="row"><button class="btn alt" id="copy">Copy plan</button><button class="btn alt" id="sw">Copy for other tees</button><button class="btn alt red" id="del">Delete</button></div></div>`);
  b.appendChild(card);
  $("#nm", card).onchange = e => { p.name = e.target.value; Store.savePlan(p); };
  $("#edit", card).onclick = () => holeView({ mode: "plan", slug: p.course, tees: p.tees, n: 1, planId: p.id });
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
        const d = Geo.yd(fin.p, tg.p), m = Geo.miss(shot.p, tg.p, fin.p);
        miss.push(d);
        detail.push(`${NAME[k]}: ${Math.round(d)} yd ${Geo.bearingWords(m)} of target · ${esc(tg.club || "?")} planned, ${shot.club ? esc(shot.club) + " used" : "club not logged"}`);
        if (k === "teeTarget") { teeN++; if (d <= 15) teeIn++; }
        if (k === "approach" && ph.danger && !(h.par === 3 && meta(r.course).teeShots === "shortgame")) {
          const pin = pinOrCenter(h, rh.pin), mm = Geo.miss(shot.p, pin, fin.p);
          const bad = { short: mm.along < -3, long: mm.along > 3, left: mm.cross > 3, right: mm.cross < -3 }[ph.danger];
          apN++; if (!bad) apGood++; else detail.push(`<span class="pill red">missed toward danger (${ph.danger})</span>`);
        }
        plannedHz += targetWarnings(course, h.n, shot.p, tg.p).length;
      });
    }
    sh.slice(1).forEach(x => inHazard(x.p, h.n).forEach(f => { found.push(`${h.n}: ${hazardName(f)}`); detail.push(`<span class="pill yellow">ended in ${esc(hazardName(f))}</span>`); }));
    if (rh.penalties) detail.push(`<span class="pill red">${rh.penalties} penalty</span>`);
    if (rh.putts != null) detail.push(`${rh.putts} putt${rh.putts === 1 ? "" : "s"}${rh.firstPuttFt != null ? ` · first ${rh.firstPuttFt} ft` : ""}${rh.leaveFt ? ` · left ${rh.leaveFt} ft` : ""}`);
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

(location.hash === "#teelog" ? teeLogPage() : home()).catch(e => { app.innerHTML = `<div class="body"><div class="card"><h3>Couldn't load course data</h3><p>${esc(e.message)}</p></div></div>`; });
