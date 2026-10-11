// Everything is saved on this phone (localStorage). Shapes are plain JSON so they can move to a server later.
const Store = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem("dg:" + k)); return v ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("dg:" + k, JSON.stringify(v)); return true; } catch { return false; } },
  id() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); },

  // Player Profile (replaces the old Settings). Older phones: values move over from "settings" the first time.
  profile() {
    const old = Store.get("settings", {});
    return Object.assign({ name: "", homeCourse: "", homeElevationFt: old.homeElevationFt ?? 900, prefTees: old.prefTees || {},
      hand: "R", ghin: "", hcp: "", hcpDate: null }, Store.get("profile", {}));
  },
  saveProfile(p) { Store.set("profile", p); },
  // My Bag: up to 14 clubs, longest first. carry / total in yards (total null = not entered yet -> carry is used);
  // tee = a club I'd hit off the tee; swings = optional wedge partials {half:{carry,total}, threeq:{carry,total}}
  bag() {
    const b = Store.get("bag", null); if (b) return b;
    const old = Store.get("settings", {}).bag;               // distances saved by an older version: keep them
    if (old) return old.map(([name, d], i) => ({ id: "c" + i, name, carry: d, total: null, tee: /driver|wood|hybrid/i.test(name), swings: {} }));
    return [];                                               // new player: no numbers until they enter their own
  },
  // a starting list for first-time setup: common clubs with empty yardages
  starterBag() {
    return ["Driver", "3 wood", "5 wood", "4 hybrid", "5 iron", "6 iron", "7 iron", "8 iron", "9 iron", "PW", "GW", "SW", "LW"]
      .map((name, i) => ({ id: "s" + i, name, carry: null, total: null, tee: /driver|wood|hybrid/i.test(name), swings: {} }));
  },
  saveBag(b) { Store.set("bag", b); },
  // what the rest of the app reads: home elevation, preferred tees, and [club, carry] pairs
  settings() {
    const p = Store.profile();
    return { homeElevationFt: p.homeElevationFt, prefTees: p.prefTees, bag: Store.bag().map(c => [c.name, c.carry]) };
  },

  // rounds: {id, course, tees, date, planId, holes: {n: {tee, pin, shots:[{p,club,src,penalty}], putts, score}}}
  rounds() { return Store.get("rounds", []); },
  saveRound(r) { const all = Store.rounds().filter(x => x.id !== r.id); all.push(r); Store.set("rounds", all); },
  deleteRound(id) { Store.set("rounds", Store.rounds().filter(x => x.id !== id)); },

  // plans: {id, course, tees, name, created, holes: {n: {pin, teeTarget:{p,club}, layup:{p,club}, approach:{p,club}, danger, score, note}}}
  plans() { return Store.get("plans", []); },
  savePlan(p) { const all = Store.plans().filter(x => x.id !== p.id); all.push(p); Store.set("plans", all); },
  deletePlan(id) { Store.set("plans", Store.plans().filter(x => x.id !== id)); },

  // hazard edits per course: {n: {added:[Feature], deleted:[id], retyped:{id:{kind,sub}}}}
  hazardEdits(course) { return Store.get("hazards:" + course, {}); },
  saveHazardEdits(course, v) { Store.set("hazards:" + course, v); },
  // avoid zones per course: {n: [{id, name, color:'red'|'yellow', ring}]}
  avoid(course) { return Store.get("avoid:" + course, {}); },
  saveAvoid(course, v) { Store.set("avoid:" + course, v); },
  // hidden data check: where the golfer really teed off with GPS, per course/hole/tee set (shows where tee boxes are)
  // [{course, hole, tee, p:[lat,lng], acc (yd), marker:[lat,lng], t}] · read via app/#teelog, merged by scripts/26
  teeLog() { return Store.get("teeLog", []); },
  logTee(e) { const all = Store.teeLog(); all.push(e); Store.set("teeLog", all.slice(-2000)); },
};

// Tee markers are set by the course, not the golfer: remove tee moves saved by an earlier version (teeFix:<course>).
// Only those keys; rounds, plans, pins and the bag are untouched.
try { Object.keys(localStorage).filter(k => k.startsWith("dg:teeFix:")).forEach(k => localStorage.removeItem(k)); } catch {}

// ---------------------------------------------------------------- versions, safe updates, backups
// APP_VERSION: shown in the profile, the export file and feedback emails. DATA_VERSION: the saved-data format.
// Updates never delete saved data: migrate() only adds/converts, and keeps the old keys.
const APP_VERSION = "0.9.2-beta";
const DATA_VERSION = 2;
Store.migrate = function () {
  try {
    const v = Store.get("dataVersion", 1);
    if (v < 2) {
      // 1 -> 2: Settings became Player Profile + My Bag. Write the converted copies; "settings" itself is kept.
      if (localStorage.getItem("dg:profile") === null && localStorage.getItem("dg:settings") !== null) Store.saveProfile(Store.profile());
      if (localStorage.getItem("dg:bag") === null && Store.get("settings", {}).bag) Store.saveBag(Store.bag());
    }
    if (v !== DATA_VERSION) Store.set("dataVersion", DATA_VERSION);
  } catch (e) { /* never block the app over a migration */ }
};
// everything the app saved on this phone (every "dg:" key), as one file
Store.exportAll = function () {
  const data = {};
  Object.keys(localStorage).filter(k => k.startsWith("dg:") && k !== "dg:_beforeImport").forEach(k => {
    const raw = localStorage.getItem(k);
    try { data[k.slice(3)] = JSON.parse(raw); } catch { data[k.slice(3)] = { $raw: raw }; }   // readable JSON in the file
  });
  // practice shots are saved by the practice pages under their own names: include them too
  const practice = {};
  Object.keys(localStorage).filter(k => k.startsWith("driven-practice:")).forEach(k => {
    const raw = localStorage.getItem(k); try { practice[k] = JSON.parse(raw); } catch { practice[k] = { $raw: raw }; } });
  return { app: "Driven Golf", appVersion: APP_VERSION, dataVersion: Store.get("dataVersion", DATA_VERSION), exportedAt: new Date().toISOString(), data, practice };
};
Store.importAll = function (file) {
  if (!file || file.app !== "Driven Golf" || typeof file.data !== "object") throw new Error("That isn't a Driven Golf backup file.");
  const before = Store.exportAll();                         // one safety copy of what was here, in case of a mistake
  Object.keys(localStorage).filter(k => (k.startsWith("dg:") && k !== "dg:_beforeImport") || (file.practice && k.startsWith("driven-practice:"))).forEach(k => localStorage.removeItem(k));
  Object.entries(file.practice || {}).forEach(([k, v]) => { if (k.startsWith("driven-practice:")) localStorage.setItem(k, v && typeof v === "object" && "$raw" in v ? v.$raw : JSON.stringify(v)); });
  Object.entries(file.data).forEach(([k, v]) => {
    if (k === "_beforeImport") return;
    localStorage.setItem("dg:" + k, v && typeof v === "object" && "$raw" in v ? v.$raw : JSON.stringify(v));
  });
  localStorage.setItem("dg:_beforeImport", JSON.stringify(before));
  Store.migrate();                                          // a backup from an older version gets converted too
};
