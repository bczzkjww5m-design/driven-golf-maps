// Geometry helpers. Points are [lat, lng]. Distances in yards unless noted.
const YD = 1.09361;
const Geo = {
  // local flat metres around an origin (accurate at golf-hole scale)
  xy(p, o) { const k = Math.cos(o[0] * Math.PI / 180); return [(p[1] - o[1]) * 111320 * k, (p[0] - o[0]) * 110540]; },
  ll(xy, o) { const k = Math.cos(o[0] * Math.PI / 180); return [o[0] + xy[1] / 110540, o[1] + xy[0] / (111320 * k)]; },
  m(a, b) { const d = Geo.xy(b, a); return Math.hypot(d[0], d[1]); },
  yd(a, b) { return Geo.m(a, b) * YD; },

  // distance along a polyline (first point = 0) to the projection of p; also the lateral offset in metres
  along(line, p) {
    const o = line[0]; const P = Geo.xy(p, o); let acc = 0, best = null;
    for (let i = 0; i < line.length - 1; i++) {
      const A = Geo.xy(line[i], o), B = Geo.xy(line[i + 1], o);
      const dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy || 1e-9, L = Math.sqrt(L2);
      let t = ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / L2; t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(A[0] + t * dx - P[0], A[1] + t * dy - P[1]);
      if (!best || d < best.d) best = { d, s: acc + t * L };
      acc += L;
    }
    return { m: best.s, yd: best.s * YD, lateralM: best.d };
  },
  length(line) { let s = 0; for (let i = 0; i < line.length - 1; i++) s += Geo.m(line[i], line[i + 1]); return s; },
  pointAt(line, dM) {   // point at distance dM (metres) along the polyline
    for (let i = 0; i < line.length - 1; i++) {
      const L = Geo.m(line[i], line[i + 1]);
      if (dM <= L || i === line.length - 2) {
        const t = L ? Math.min(1, dM / L) : 0;
        return [line[i][0] + (line[i + 1][0] - line[i][0]) * t, line[i][1] + (line[i + 1][1] - line[i][1]) * t];
      }
      dM -= L;
    }
    return line.at(-1);
  },

  // polygon helpers; rings are [[lat,lng],...]
  inRing(p, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [yi, xi] = ring[i], [yj, xj] = ring[j];
      if ((yi > p[0]) !== (yj > p[0]) && p[1] < (xj - xi) * (p[0] - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  },
  ringsOf(geom) {   // GeoJSON geometry -> list of outer rings as [lat,lng]
    const flip = r => r.map(([x, y]) => [y, x]);
    if (!geom) return [];
    if (geom.type === "Polygon") return [flip(geom.coordinates[0])];
    if (geom.type === "MultiPolygon") return geom.coordinates.map(p => flip(p[0]));
    return [];
  },
  linesOf(geom) {
    const flip = r => r.map(([x, y]) => [y, x]);
    if (!geom) return [];
    if (geom.type === "LineString") return [flip(geom.coordinates)];
    if (geom.type === "MultiLineString") return geom.coordinates.map(flip);
    if (geom.type === "Polygon") return geom.coordinates.map(flip);
    if (geom.type === "MultiPolygon") return geom.coordinates.flatMap(p => p.map(flip));
    return [];
  },
  inside(p, geom) { return Geo.ringsOf(geom).some(r => Geo.inRing(p, r)); },
  // shortest distance (metres) from a point to a polygon's edge (0 if inside) or to a line
  distToGeom(p, geom) {
    if (Geo.inside(p, geom)) return 0;
    let best = Infinity;
    Geo.linesOf(geom).forEach(line => {
      const o = p;
      for (let i = 0; i < line.length - 1; i++) {
        const A = Geo.xy(line[i], o), B = Geo.xy(line[i + 1], o);
        const dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy || 1e-9;
        let t = (-A[0] * dx - A[1] * dy) / L2; t = Math.max(0, Math.min(1, t));
        best = Math.min(best, Math.hypot(A[0] + t * dx, A[1] + t * dy));
      }
    });
    return best;
  },

  // walk a line of play and report, for one hazard, yards to reach it and yards to carry it.
  // A hazard counts as "on the line" when the line passes within `widthM` of it.
  reachCarry(line, geom, widthM = 4) {     // first crossing only (kept for warnings)
    const all = Geo.crossings(line, geom, widthM); return all.length ? all[0] : null;
  },
  // every separate stretch where the line of play runs over/through a hazard: [{reach, carry}]
  crossings(line, geom, widthM = 4) {
    const total = Geo.length(line); const out = []; let cur = null;
    const isLine = geom.type === "LineString" || geom.type === "MultiLineString";
    for (let d = 0; d <= total; d += 1) {
      const p = Geo.pointAt(line, d);
      const hit = isLine ? Geo.distToGeom(p, geom) <= widthM : (Geo.inside(p, geom) || Geo.distToGeom(p, geom) <= widthM);
      if (hit) { if (!cur) cur = { first: d, last: d }; else cur.last = d; }
      else if (cur && d - cur.last > 3) { out.push(cur); cur = null; }
    }
    if (cur) out.push(cur);
    return out.map(c => ({ reach: Math.round(c.first * YD), carry: Math.round(c.last * YD) }));
  },
  // green front / center / back along the line of play arriving at the green, and the 9 pin presets
  greenDepth(green, from, center) {
    // direction of play: from -> center
    const o = center, F = Geo.xy(from, o); const L = Math.hypot(F[0], F[1]) || 1;
    const u = [-F[0] / L, -F[1] / L], v = [-u[1], u[0]];       // u = toward the back, v = to the left
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    green.forEach(p => { const q = Geo.xy(p, o); const a = q[0] * u[0] + q[1] * u[1], b = q[0] * v[0] + q[1] * v[1];
      minU = Math.min(minU, a); maxU = Math.max(maxU, a); minV = Math.min(minV, b); maxV = Math.max(maxV, b); });
    return { u, v, minU, maxU, minV, maxV };
  },
  // edge of the green along a ray from the center (for front/back/left/right snapping)
  edgeAlong(green, center, dir) {
    const o = center; let best = 0;
    for (let i = 0; i < green.length - 1; i++) {
      const A = Geo.xy(green[i], o), B = Geo.xy(green[i + 1], o);
      // intersect ray t*dir with segment A-B
      const ex = B[0] - A[0], ey = B[1] - A[1];
      const den = dir[0] * ey - dir[1] * ex; if (Math.abs(den) < 1e-9) continue;
      const t = (A[0] * ey - A[1] * ex) / den, s = (A[0] * dir[1] - A[1] * dir[0]) / den;
      if (t > 0 && s >= 0 && s <= 1) best = Math.max(best, t);
    }
    return best;   // metres from center to the edge in that direction
  },
  pinPresets(green, from, center) {
    const g = Geo.greenDepth(green, from, center), o = center;
    const presets = {};
    const rows = { Front: -1, Middle: 0, Back: 1 }, cols = { Left: 1, Center: 0, Right: -1 };
    for (const [rn, rv] of Object.entries(rows)) for (const [cn, cv] of Object.entries(cols)) {
      let dir = [g.u[0] * rv + g.v[0] * cv, g.u[1] * rv + g.v[1] * cv];
      const L = Math.hypot(dir[0], dir[1]);
      if (!L) { presets[`${rn} ${cn}`] = center; continue; }
      dir = [dir[0] / L, dir[1] / L];
      const edge = Geo.edgeAlong(green, center, dir);
      const k = Math.max(0.4 * edge, edge - 3.7);   // about 4 yards in from the edge, like a real hole location
      presets[`${rn} ${cn}`] = Geo.ll([dir[0] * k, dir[1] * k], o);
    }
    return presets;
  },
  // front / back of the green measured from a point, along the line through the pin
  frontBack(green, from, pin) {
    const o = from, P = Geo.xy(pin, o), L = Math.hypot(P[0], P[1]) || 1, u = [P[0] / L, P[1] / L];
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < green.length - 1; i++) {
      const A = Geo.xy(green[i], o), B = Geo.xy(green[i + 1], o);
      const ex = B[0] - A[0], ey = B[1] - A[1], den = u[0] * ey - u[1] * ex;
      if (Math.abs(den) < 1e-9) continue;
      const t = (A[0] * ey - A[1] * ex) / den, s = (A[0] * u[1] - A[1] * u[0]) / den;
      if (s >= 0 && s <= 1 && t > 0) { lo = Math.min(lo, t); hi = Math.max(hi, t); }
    }
    if (!isFinite(lo)) return null;
    return { front: Math.round(lo * YD), back: Math.round(hi * YD) };
  },
  // signed miss of `p` relative to the line from `from` to `target`: along (+long/-short) and cross (+left/-right), yards
  miss(from, target, p) {
    const o = target, F = Geo.xy(from, o), Q = Geo.xy(p, o), L = Math.hypot(F[0], F[1]) || 1;
    const u = [-F[0] / L, -F[1] / L];         // direction of travel
    return { along: (Q[0] * u[0] + Q[1] * u[1]) * YD, cross: (u[0] * Q[1] - u[1] * Q[0]) * YD };
  },
  bearingWords(m, tol = 3) {
    const w = [];
    if (m.along > tol) w.push("long"); else if (m.along < -tol) w.push("short");
    if (m.cross > tol) w.push("left"); else if (m.cross < -tol) w.push("right");
    return w.length ? w.join(" ") : "on target";
  },
  // plays-like: ~2% more carry per 1,000 ft above the golfer's home course
  playsLike(yards, courseFt, homeFt) {
    const f = 1 + 0.02 * ((courseFt || 0) - (homeFt || 0)) / 1000;
    return Math.round(yards / f);
  },
};
