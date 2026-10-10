// Everything is saved on this phone (localStorage). Shapes are plain JSON so they can move to a server later.
const Store = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem("dg:" + k)); return v ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("dg:" + k, JSON.stringify(v)); return true; } catch { return false; } },
  id() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); },

  settings() {
    return Object.assign({
      homeElevationFt: 900,           // Twin Cities
      bag: [["Driver", 230], ["3 wood", 210], ["5 wood", 195], ["4 hybrid", 185], ["5 iron", 172], ["6 iron", 162],
            ["7 iron", 151], ["8 iron", 140], ["9 iron", 129], ["PW", 117], ["GW", 104], ["SW", 90], ["LW", 72]],
    }, Store.get("settings", {}));
  },
  saveSettings(s) { Store.set("settings", s); },

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
};
