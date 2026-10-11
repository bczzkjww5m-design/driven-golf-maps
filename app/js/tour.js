// ---------------------------------------------------------------- first-time tour, location card, one-time tips
// Welcome cards after the beta note (before setup); "How Driven Golf works" in Member Profile shows them again.
// Existing members get a one-time "New: take the tour" note on the Clubhouse instead. Tips show once each (Reset tips
// in Member Profile brings them back). Uses app.js helpers (el, $, esc, Store, modal, toast) at run time.
const TOUR_ART = {
  welcome: '<path d="M14 66h92M24 66V40l36-18 36 18v26" /><path d="M48 66V48h24v18" /><path d="M60 22V6l14 5-14 5" class="b"/><path d="M34 52h6M80 52h6" />',
  bag: '<path d="M48 30h24l4 40H44z" /><path d="M48 30l-6-20M56 30l-2-24M64 30l3-22M72 30l8-18" /><path d="M40 8h6M52 4h5M66 6h5M78 10h6" class="b"/><path d="M76 40c8 0 10 6 10 12" />',
  plan: '<path d="M30 72c6-20 0-34 10-48s26-14 30-8" /><path d="M86 74c-4-18 8-30 2-44s-24-16-24-16" /><circle cx="68" cy="14" r="6" class="b"/><path d="M50 66l6-22 10-26" stroke-dasharray="3 4"/><circle cx="56" cy="44" r="5" /><circle cx="56" cy="44" r="1.5" class="b"/>',
  course: '<rect x="40" y="6" width="40" height="68" rx="6" /><path d="M54 12h12" /><path d="M60 26c-6 0-10 4-10 10 0 8 10 18 10 18s10-10 10-18c0-6-4-10-10-10z" class="b"/><circle cx="60" cy="36" r="3" /><path d="M48 64h24" stroke-dasharray="2 3"/>',
  practice: '<circle cx="60" cy="40" r="28" /><circle cx="60" cy="40" r="17" /><circle cx="60" cy="40" r="6" class="b"/><path d="M18 74l34-28" /><path d="M48 44l4 2-2 4" />',
};
const TOUR_CARDS = [
  { art: "welcome", title: "Welcome to The Clubhouse", text: "Your yardage book, caddie and practice coach in one place. Course maps come from public aerial photos and OpenStreetMap, and everything you log stays on this phone." },
  { art: "bag", title: "Your bag, your numbers", text: "Enter how far each club carries (where it lands) and goes in total (where it stops). Every club pick, plan and warning uses your numbers, and your logged shots suggest updates." },
  { art: "plan", title: "Plan before you play", text: "Pick a club for each shot and the target goes where that club lands, or drag the target and the club is picked for you. Auto-plan builds a whole round: Safe, Balanced or Aggressive." },
  { art: "course", title: "On the course", text: "Yardages to the green and to each hazard's reach and carry, from your GPS. Tap I'm at my ball to log a shot, and the flag button opens Green view to read slopes and move the pin." },
  { art: "practice", title: "Practice what matters", text: "Your rounds show where you lose shots. Each weakness comes with a drill: how to set it up, how to score it, and a course check to see if it worked." },
];
const tourArt = k => `<svg class="tart" viewBox="0 0 120 80" aria-hidden="true">${TOUR_ART[k]}</svg>`;
// the swipeable cards; resolves when finished or skipped
function welcomeCards(finalLabel = "Set up my bag") {
  return new Promise(res => {
    const ov = el(`<div class="tour" role="dialog" aria-label="Welcome to Driven Golf"><div class="ttop"><span class="caps brass">Driven Golf</span><button class="linkbtn" id="tskip">Skip</button></div>
      <div class="ttrack" id="ttrack">${TOUR_CARDS.map((c, i) => `<section class="tcard" aria-label="${i + 1} of ${TOUR_CARDS.length}">${tourArt(c.art)}<h2 class="ttl">${esc(c.title)}</h2><p>${esc(c.text)}</p></section>`).join("")}</div>
      <div class="tdots">${TOUR_CARDS.map((_, i) => `<i data-i="${i}"></i>`).join("")}</div><button class="btn" id="tnext">Next</button></div>`);
    document.body.appendChild(ov);
    const tr = $("#ttrack", ov), btn = $("#tnext", ov), at = () => Math.round(tr.scrollLeft / Math.max(1, tr.clientWidth));
    const sync = () => { const i = at(); ov.querySelectorAll(".tdots i").forEach((d, j) => d.classList.toggle("on", j === i)); btn.textContent = i === TOUR_CARDS.length - 1 ? finalLabel : "Next"; };
    const done = () => { Store.set("tourSeen", true); ov.remove(); res(); };
    tr.addEventListener("scroll", () => requestAnimationFrame(sync)); sync();
    btn.onclick = () => { const i = at(); if (i >= TOUR_CARDS.length - 1) return done(); tr.scrollTo({ left: (i + 1) * tr.clientWidth, behavior: "smooth" }); };
    ov.querySelectorAll(".tdots i").forEach(d => d.onclick = () => tr.scrollTo({ left: +d.dataset.i * tr.clientWidth, behavior: "smooth" }));
    $("#tskip", ov).onclick = done;
  });
}
// before the phone's location prompt (once): what location is for. Resolves true to go ahead.
function locationCard() {
  if (Store.get("locOk", false)) return Promise.resolve(true);
  return new Promise(res => {
    const md = modal(`${tourArt("course")}<h3 style="margin:0">Location is only for yardages</h3>
      <p>Driven Golf uses your phone's location to measure yardages to the green and hazards, and to mark where your ball is. It stays on this phone: nothing is sent anywhere or shared.</p>
      <p class="muted">Your phone asks next. You can change it any time in your browser's settings, and you can always tap the map instead.</p>
      <div class="row"><button class="btn alt" id="ln">Not now</button><button class="btn" id="ly">Continue</button></div>`);
    $("#ly", md).onclick = () => { Store.set("locOk", true); md.remove(); res(true); };
    $("#ln", md).onclick = () => { md.remove(); res(false); };
  });
}
// one-time tips: a small card pointing at a button, one step at a time ("1 of 3 · Next", last "Got it")
function tipOnce(key, steps, root = document) {
  const seen = Store.get("tipsSeen", {}); if (seen[key]) return;
  steps = steps.filter(t => !t.sel || root.querySelector(t.sel)); if (!steps.length) return;
  let i = 0, box = null;
  const show = () => {
    box?.remove(); const t = steps[i], target = t.sel ? root.querySelector(t.sel) : null;
    box = el(`<div class="tip" role="note"><div>${esc(t.text)}</div><div class="tiprow"><small>${steps.length > 1 ? `${i + 1} of ${steps.length}` : "Tip"}</small><button class="linkbtn" id="tipx">${i < steps.length - 1 ? "Next" : "Got it"}</button></div></div>`);
    document.body.appendChild(box);
    const r = target?.getBoundingClientRect(), W = innerWidth, H = innerHeight, bw = Math.min(300, W - 32);
    box.style.width = bw + "px";
    if (!r) { box.style.left = (W - bw) / 2 + "px"; box.style.top = "30%"; }
    else {
      const below = r.top < H / 2, left = Math.max(16, Math.min(W - bw - 16, r.left + r.width / 2 - bw / 2));
      box.style.left = left + "px"; box.classList.add(below ? "dn" : "up");
      box.style.setProperty("--ax", Math.max(14, Math.min(bw - 14, r.left + r.width / 2 - left)) + "px");
      if (below) box.style.top = (r.bottom + 10) + "px"; else box.style.bottom = (H - r.top + 10) + "px";
      target.classList.add("tiphi"); box._t = target;
    }
    $("#tipx", box).onclick = () => { box._t?.classList.remove("tiphi"); i++; if (i < steps.length) show(); else { box.remove(); const s = Store.get("tipsSeen", {}); s[key] = true; Store.set("tipsSeen", s); } };
  };
  show();
}
function resetTips() { Store.set("tipsSeen", {}); toast("Tips will show again as you go."); }
// existing members: one note on the Clubhouse instead of the cards
function tourNote(container) {
  if (Store.get("tourSeen", false)) return;
  const n = el(`<div class="card tournote"><span class="caps brass">New</span><b>Take the tour</b><small>A quick look at the bag, planning, the course view and practice.</small>
    <div class="row"><button class="btn small alt" id="tn0">Not now</button><button class="btn small" id="tn1">Take the tour</button></div></div>`);
  $("#tn0", n).onclick = () => { Store.set("tourSeen", true); n.remove(); };
  $("#tn1", n).onclick = async () => { n.remove(); await welcomeCards("Back to the Clubhouse"); home(); };
  container.prepend(n);
}
