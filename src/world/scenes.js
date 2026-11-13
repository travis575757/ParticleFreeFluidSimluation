// World scenes: ground, liquid, sources and drains in cells; x and z horizontal, y up.
import { sdBox, sdCut, sdIntersect, sdPlane, integrateShape, floatDraught } from './hull.js';

const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
const ss = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const box = (lo, hi, vel = [0, 0, 0]) => ({ type: 'box', center: lo.map((v, d) => (v + hi[d]) / 2), half: lo.map((v, d) => (hi[d] - v) / 2), vel });
// a turn of `yaw` about y after a tilt about `tilt` (its length is the angle)
function quatY(yaw, tilt = [0, 0, 0]) {
  const a = Math.hypot(...tilt);
  const qt = a > 0 ? [...tilt.map((v) => (v / a) * Math.sin(a / 2)), Math.cos(a / 2)] : [0, 0, 0, 1];
  const qy = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
  const [ax, ay, az, aw] = qy, [bx, by, bz, bw] = qt;
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}

export const WORLD_SCENES = {
  // 1. A river on a plateau runs over a cliff into a plunge pool, which empties through a
  //    channel. The river is deep and fast for its fall (16 m at 10 cm cells): a sheet of
  //    water thins as it accelerates, and one that falls much further than this ends up
  //    thinner than a cell.
  waterfall: {
    title: 'High waterfall',
    blurb: 'A river falls 16 m from a plateau into a plunge pool and leaves through a channel. Cells are stored along the river, down the fall and around the pool only.',
    build() {
      const top = 196, bed = top - 16, low = 30, level = 20;
      const height = (x, z) => {
        const az = Math.abs(z);
        // plateau with the river bed cut into it
        const plateau = top - (top - bed) * (1 - ss(14, 20, az)) * ss(4, 8, x);
        // low ground: the plunge pool, and the wide channel that leaves it
        const bowl = (low + 4) * (1 - ss(34, 66, Math.hypot(x - 170, z)));
        const channel = (16 + 8 * ss(230, 350, x)) * (1 - ss(26, 32, az)) * ss(180, 190, x) * (1 - ss(358, 364, x));
        const ground = low - Math.max(bowl, channel);
        return plateau + (ground - plateau) * ss(100, 106, x);
      };
      return {
        h: 0.1,
        terrain: { origin: [-40, -110], spacing: 2, n: [221, 111], height },
        liquid: [box([100, -4, -66], [236, level, 66])],
        emitters: [{ prim: box([8, bed, -13], [20, bed + 12, 13], [30, 0, 0]) }],
        drains: [{ prim: box([340, 0, -34], [356, 40, 34]) }],
        camera: { target: [165, 84, 0], dist: 470, yaw: 0.62, pitch: 0.16 },
      };
    },
  },

  // 2. Six basins step down a hillside; each fills and spills over its rim into the next.
  cascade: {
    title: 'Terraced cascade',
    blurb: 'Water poured into the top basin fills it, spills over the rim into the next, and so on down six terraces to a drain. Bricks appear as the water arrives.',
    build() {
      const N = 6, P = 64, drop = 22, y0 = 12 + (N - 1) * drop, half = 36, end = N * P;
      const floor = (k) => y0 - drop * clamp(k, 0, N - 1);
      const height = (x, z) => {
        const az = Math.abs(z);
        const k = clamp(Math.floor(x / P), 0, N - 1);
        const u = x - k * P;
        // the basins: floor, rim at the downstream end, the drop behind it; a wall at either end
        let y = floor(k);
        y += 5 * ss(50, 53, u) * (1 - ss(57, 59, u));
        if (k < N - 1) y += (floor(k + 1) - floor(k)) * ss(59, 63, u);
        y += 16 * (1 - ss(0, 4, x)) + 16 * ss(end - 6, end - 2, x);
        // side walls, and the hillside the whole thing stands on
        y += (floor(k) + 16 - y) * ss(half, half + 4, az);
        const hill = y0 - 8 - drop * (clamp(x, -60, end + 60) / P - 0.5);
        const built = (1 - ss(half + 12, half + 28, az)) * ss(-26, -10, x) * (1 - ss(end + 10, end + 26, x));
        return hill + (y - hill) * built;
      };
      return {
        h: 0.05,
        terrain: { origin: [-70, -90], spacing: 1, n: [end + 141, 181], height },
        liquid: [],
        emitters: [{ prim: box([5, floor(0), -22], [15, floor(0) + 10, 22], [30, 0, 0]) }],
        drains: [{ prim: box([end - 22, floor(N - 1) - 2, -half], [end - 8, floor(N - 1) + 12, half]) }],
        camera: { target: [end / 2 - 24, y0 / 2 - 14, 0], dist: 470, yaw: 0.9, pitch: 0.38 },
      };
    },
  },

  // 3. A sea without shores or a bed. Nothing of it is stored until the crate arrives.
  sea: {
    title: 'Crate into open sea',
    blurb: 'A crate falls into a sea that is not stored anywhere. The water is solved where the crate lands and where its waves go; behind them it comes to rest and the bricks are given back.',
    build({ drop = 24, size = 5, density = 0.45 } = {}) {
      const level = 24.25;
      return {
        h: 0.05,
        water: [{ box: [-1e6, -1e6, 1e6, 1e6], level }],
        liquid: [],
        bodies: [{ shape: 'box', pos: [0, level + drop, 0], half: [size, size * 0.8, size], round: 1, density, color: 0,
          quat: quatY(0.5, [0.35, 0, 0.2]), omega: [0.4, 0, 0.3] }],
        camera: { target: [0, level + 2, 0], dist: 250, yaw: 0.7, pitch: 0.36 },
      };
    },
  },

  // 4. Five buoys far apart on the same sea, each in its own island of solved water. Every five
  //    seconds a lump of water drops next to one of them, the first after 15 s: by then the
  //    buoys have settled and gone to sleep, and nothing of the sea is stored any more.
  buoys: {
    title: 'Scattered buoys',
    blurb: 'Five buoys far apart on one sea. Each settles and goes to sleep with the water around it; a lump of water dropped next to one wakes that buoy and its surroundings only.',
    build() {
      const level = 24.25, r = 5;
      const at = [[-230, -70], [-95, 85], [35, -95], [150, 70], [265, -40]];
      return {
        h: 0.1,
        water: [{ box: [-1e6, -1e6, 1e6, 1e6], level }],
        liquid: [],
        // (a ball of 0.35 times the liquid's density floats with its centre a fifth of its radius above the surface)
        bodies: at.map(([x, z], i) => ({ shape: 'ball', pos: [x, level + 0.2 * r + 2, z], radius: r, density: 0.35, color: i })),
        emitters: at.map(([x, z], i) => ({
          prim: { type: 'ball', center: [x + 16, level + 26, z + 6], radius: 4.5, vel: [0, -20, 0] },
          from: 15 + ((i * 2) % 5) * 5, every: 25, for: 0.017,
        })),
        camera: { target: [20, level, 0], dist: 640, yaw: 0.35, pitch: 0.42 },
      };
    },
  },

  // 5. A harbour basin behind breakwaters, open to the sea through a gap. A launch goes round
  //    it; two buoys and a crate ride its wake.
  harbour: {
    title: 'Boat across a harbour',
    blurb: 'A launch goes round a harbour basin. The water is solved around the boat and in its wake and comes to rest behind it; the buoys and the crate wake up when the wake reaches them.',
    build() {
      const level = 24.25, bed = 8, deep = -24, quay = 31;
      const height = (x, z) => {
        const ax = Math.abs(x);
        // the bed: level in the basin, dropping away outside; the shore behind the quay
        let y = bed + (deep - bed) * ss(-78, -150, z);
        y += (quay - y) * ss(60, 72, z);
        // two breakwaters out from the shore and one across, with the entrance in its middle
        const side = (1 - ss(4, 9, Math.abs(ax - 150))) * ss(-74, -66, z);
        const outer = (1 - ss(4, 9, Math.abs(z + 66))) * ss(24, 32, ax) * (1 - ss(150, 156, ax));
        return y + (level + 5 - y) * Math.max(side, outer);
      };
      // the launch: once round the basin in 28 s (1.6 m/s)
      const T = 28, a = 96, b = 36, z0 = 0;
      const boat = (t) => {
        const w = 2 * Math.PI / T, c = Math.cos(w * t), sn = Math.sin(w * t);
        return { shape: 'box', pos: [a * c, level - 0.6, z0 + b * sn], half: [13, 3.6, 4.6], round: 1.6, yaw: Math.atan2(-b * c, -a * sn) };
      };
      return {
        h: 0.1,
        terrain: { origin: [-280, -230], spacing: 2, n: [281, 161], height },
        water: [{ box: [-1e6, -1e6, 1e6, 76], level }],
        // (the waves of the map run on water as deep as the basin)
        swell: { params: { depth: level - bed } },
        liquid: [],
        kinematic: (t) => [boat(t)],
        bodies: [
          // (the buoys a boat's width inside its course, the crate outside it by the quay)
          { shape: 'ball', pos: [-40, level + 2.5, 20], radius: 4.5, density: 0.35, color: 0 },
          { shape: 'ball', pos: [55, level + 2.5, -17], radius: 4.5, density: 0.35, color: 2 },
          { shape: 'box', pos: [8, level + 3, 50], half: [5, 4, 5], round: 1, density: 0.5, color: 3 },
        ],
        camera: { target: [0, level - 4, -6], dist: 430, yaw: 0.5, pitch: 0.5 },
      };
    },
  },

  // 6. A river comes down a valley in pools and steps, over three falls, and into the sea.
  //    The water is a height field (two numbers per 2 x 2 cells of ground) except where that
  //    will not do: at the falls, and around what the camera looks at.
  river: {
    title: 'Mountain river to the sea',
    blurb: 'Most of a kilometre of river in pools, chutes and three falls, down to the sea. All of it moves as shallow water on a map, two numbers per 20 cm of ground; the falls and the water around the view target are solved in 3D, and handed back when the view moves on.',
    build({ pools = 16 } = {}) {
      const sea = 24, half = 256;
      // the pools from the head down: each ends in a sill, then a chute or (every fifth) a fall
      const P = [];
      for (let i = 0, x = 96; i < pools; i++) {
        const len = Math.round(400 + 110 * Math.sin(1.7 * i + 0.4));
        const fall = i % 5 === 3 ? 30 + 4 * Math.sin(i) : 6 + 2.5 * Math.sin(2.3 * i + 1);
        P.push({ x0: x, x1: x + len, xc: x + len - 16, fall, steep: i % 5 === 3 });
        x += len;
      }
      let y = sea - 2;
      for (let i = pools - 1; i >= 0; i--) { y += P[i].fall; P[i].crest = y; }
      const end = P[pools - 1].x1;
      const length = Math.ceil((end + 620) / 64) * 64;
      const poolAt = (x) => { let i = 0; while (i < pools - 1 && x >= P[i].x1) i++; return i; };
      // height of the river bed along its middle
      const thal = (x) => {
        if (x >= end) return sea - 2 - 60 * ss(0, 560, x - end);
        const i = poolAt(x), p = P[i];
        const u = clamp((x - p.x0) / (p.xc - p.x0), 0, 1);
        // the pool: deepest below the step it comes from, shallow towards its sill
        const deep = (3 + (i > 0 && P[i - 1].steep ? 12 : 7) * Math.sin(Math.PI * Math.sqrt(u)) ** 0.8) * ss(-2, 26, x - p.x0) * (1 - ss(p.xc - 44, p.xc - 6, x));
        const down = p.steep ? ss(p.xc + 3, p.xc + 6, x) : clamp((x - p.xc - 2) / (1.8 * p.fall), 0, 1);
        return p.crest - deep - p.fall * down;
      };
      const mid = (x) => 84 * Math.sin(x / 520) + 36 * Math.sin(x / 190 + 1.3);
      const wide = (x) => 46 + 9 * Math.sin(x / 140) + 190 * ss(end - 60, end + 420, x);
      const height = (x, z) => {
        const d = Math.abs(z - mid(x) * (1 - ss(end - 200, end + 300, x))), w = wide(x);
        const t = thal(clamp(x, 0, length));
        const rough = 3 * Math.sin(x * 0.043 + 1.7 * Math.sin(z * 0.031)) + 2 * Math.sin(z * 0.057 + x * 0.011);
        let h = t + 14 * Math.min(d / w, 1) ** 2.5 + (70 + 2 * rough) * ss(0.9 * w, w + 90, d) + rough * ss(0.6 * w, w, d);
        // the head of the valley
        h += 60 * (1 - ss(30, 96, x));
        return h;
      };
      // the water it starts with: every pool up to a little over its sill, a sheet on the steps, the sea
      const level = (i) => P[i].crest + 2.6;
      const depth = (x, z, bed) => {
        if (x >= end) return Math.max(sea - bed, 0);
        const i = poolAt(x), p = P[i];
        if (x < p.x0) return 0;
        const below = i + 1 < pools ? level(i + 1) : sea;
        // (on the step: a sheet in the middle of the channel)
        if (x > p.xc) return Math.max(below - bed, Math.min(Math.max(level(i) - bed, 0), Math.max(thal(x) + 2.4 - bed, 0)), 0);
        return Math.max(level(i) - bed, 0);
      };
      const head = P[0].x0 + 24, flow = 3600;
      const falls = P.filter((p) => p.steep);
      const look = falls[falls.length - 1];
      return {
        h: 0.1,
        terrain: { origin: [0, -half], spacing: 2, n: [length / 2 + 1, half + 1], height },
        liquid: [],
        heightfield: {
          origin: [0, -half], n: [length / 2, half], cell: 2, depth,
          sources: [
            { box: [head - 16, mid(head) - 20, head + 16, mid(head) + 20], rate: flow / (32 * 40) },
            { box: [length - 32, -half, length, half], level: sea, pull: 0.2 },
          ],
        },
        // (falls and jumps are solved within 60 m of what the camera looks at)
        params: { hfPromoteRadius: 600 },
        world: { focusRadius: 56 },
        camera: { target: [look.xc + 30, look.crest - 22, mid(look.xc + 30)], dist: 560, yaw: 0.9, pitch: 0.42 },
        marks: { pools: P, end, length, sea, mid },
      };
    },
  },

  // 7. Swell runs up a beach of 1 in 20 between two headlands. The sea is a height field; the
  //    swell comes in through a strip along its seaward edge that is held at the level of a
  //    long wave, and beyond that edge the same wave is drawn and nothing else. On the way in
  //    the waves steepen until the height field cannot hold them.
  surf: {
    title: 'Surf on a beach',
    blurb: 'Swell of 0.7 m runs in over a beach of 1 in 20. Out at sea it is shallow water on a map; where a wave has steepened into a front, around the view target, it is handed to the 3D solver, breaks there, and the water behind it goes back to the map.',
    build({ amp = 3.5, period = 7 } = {}) {
      const sea = 40, deep = 30, half = 384, length = 1024, shore = 120 + 20 * deep;
      const height = (x, z) => {
        // level offshore, then the beach with a bar on it, the dunes behind
        const bar = 2.2 * Math.exp(-(((x - 470 - 30 * Math.sin(z / 110)) / 34) ** 2));
        let y = sea - deep + Math.max(x - 120, 0) / 20 + bar + 1.2 * Math.sin(z / 60) * ss(560, 700, x);
        y += 10 * ss(shore + 80, shore + 180, x) + 3 * Math.sin(z / 37 + x / 90) * ss(shore + 60, shore + 140, x);
        // a headland at either end of the beach
        const hd = ss(296, 332, Math.abs(z) + 14 * Math.sin(x / 45)) * ss(250, 340, x);
        return y + Math.max(sea + 22 + 6 * Math.sin(x / 31 + z / 53) - y, 0) * hd;
      };
      const strip = (x0, x1, pull) => ({ box: [x0, -half, x1, half], swell: true, pull });
      return {
        h: 0.1,
        terrain: { origin: [-512, -640], spacing: 4, n: [417, 321], height },
        liquid: [],
        heightfield: {
          origin: [0, -half], n: [length / 2, half], cell: 2,
          depth: (x, z, bed) => (x < shore + 40 ? Math.max(sea - bed, 0) : 0),
          // (the first strip is the swell; the others take out what the beach sends back)
          sources: [strip(0, 16, 1), strip(16, 48, 0.04), strip(48, 80, 0.04)],
          sea: { level: sea, wave: { amp, period, depth: deep, dir: [1, 0], origin: [8, 0] } },
        },
        // (the surf is solved within 10 m of what the camera looks at: about what the budget of bricks covers)
        params: { hfPromoteRadius: 64 },
        world: { focusRadius: 48 },
        camera: { target: [600, sea + 2, 0], dist: 330, yaw: 1.0, pitch: 0.26 },
        marks: { sea, shore, half },
      };
    },
  },

  // 8. A reservoir behind a dam, a river valley below it. After three seconds the gate in the
  //    dam is pulled up. Reservoir and valley are a height field; the water around the gate is
  //    solved while the gate moves, and so is the front of the flood wherever it is.
  dam: {
    title: 'Dam failure',
    blurb: 'Three seconds in, the gate of a dam is pulled out of the way and 3.6 m of water goes down a valley with 40 cm in it. Reservoir and valley are shallow water on a map; the water around the gate and the flood near the view target are solved in 3D, and the flood runs on down the valley as a wave on the map.',
    build({ at = 3 } = {}) {
      const base = 40, full = 76, low = 44, crest = 86, xd = 640, thick = 24, gate = 24, end = 2048, half = 192;
      const xg = xd + thick / 2;
      // the valley winds below the dam
      const zc = (x) => 70 * Math.sin((x - xd) / 240) * ss(xd + 40, xd + 360, x);
      const wide = (x) => 150 - 70 * ss(xd - 260, xd - 20, x) - 16 * ss(xd, xd + 200, x);
      const height = (x, z) => {
        const d = Math.abs(z - zc(x));
        const floor = base + 30 * (1 - ss(40, 420, x));
        const rough = 2.5 * Math.sin(x * 0.037 + 1.3 * Math.sin(z * 0.029)) + 1.5 * Math.sin(z * 0.061 + x * 0.013);
        // (the sides no steeper than 1 in 1: water that runs back down them stays on the ground)
        let y = floor + (64 + 2 * rough) * ss(wide(x), wide(x) + 110, d) + rough * ss(0.7 * wide(x), wide(x) + 20, d);
        // the dam, with the opening the gate stands in
        const ridge = ss(xd - 3, xd, x) * (1 - ss(xd + thick, xd + thick + 3, x));
        y += Math.max(crest - y, 0) * ridge * ss(gate, gate + 2, Math.abs(z));
        return y;
      };
      const lift = (t) => 54 * ss(at, at + 1.2, t);
      const house = (x, side) => box([x - 10, base - 2, zc(x) + side * 30 - 9], [x + 10, base + 20, zc(x) + side * 30 + 9]);
      return {
        h: 0.1,
        terrain: { origin: [0, -half], spacing: 2, n: [end / 2 + 1, half + 1], height },
        solids: [house(1010, 1), house(1230, -1), house(1500, 1)],
        liquid: [],
        kinematic: (t) => [{ shape: 'box', pos: [xg, base + 23 + lift(t), 0], half: [7, 24, gate + 3], round: 0.5 }],
        heightfield: {
          origin: [0, -half], n: [end / 2, half], cell: 2,
          depth: (x, z, bed) => Math.max((x < xg ? full : low) - bed, 0),
          // (the gate is a wall to the height field until it goes)
          blocked: (x, z, world) => !(world.time >= at) && Math.abs(z) < gate + 3 && Math.abs(x - xg) < 7,
          sources: [{ box: [end - 48, -half, end, half], level: low, pull: 0.2 }],
        },
        events: [{ at, run: (world) => world.setBed() }],
        // (the flood is solved within 8 m of what the camera looks at, which is what the budget
        // of bricks covers of water this deep, and is the map's beyond)
        params: { hfPromoteRadius: 48 },
        world: { focusRadius: 32 },
        camera: { target: [xd + 150, base + 12, 10], dist: 520, yaw: -0.9, pitch: 0.4 },
        marks: { xd, xg, base, full, low, at, zc },
      };
    },
  },

  // 9. A cliff with a slot cut into it that narrows to nothing under a slab of rock, and a
  //    hole in the slab over its end. The swell that runs into the slot has nowhere to go but
  //    up. The sea is a height field; the slot is solved always: water under a roof is
  //    nothing a height field could hold.
  cave: {
    title: 'Sea cave and blowhole',
    blurb: 'Swell of 1.2 m runs into a slot in a shelf of rock that narrows under a roof, and comes out of a hole in the roof. The sea is shallow water on a map; the slot and the water in front of it are always solved in 3D. (The air is not simulated: what spouts is the water itself.)',
    build({ amp = 6, period = 8 } = {}) {
      // (the roof is low: the swell fills the slot up to it, and what comes in after that has one way out)
      const sea = 40, deep = 30, half = 320, length = 832, xc = 600, top = 56, roof = sea + 4, lid = roof + 8, xe = 764;
      const slotHalf = (x) => 30 - 22 * ss(xc + 20, xe - 4, x);
      const height = (x, z) => {
        const az = Math.abs(z);
        const bed = sea - deep + 8 * ss(200, 560, x);
        // the cliff, straight where the slot is and ragged elsewhere
        const edge = xc + (18 * Math.sin(z / 70) + 8 * Math.sin(z / 23)) * ss(44, 110, az);
        const land = ss(edge - 5, edge, x);
        // (a shelf of rock where the slot is, above what the swell reaches and falling 1 in 50 to
        // the sea: what the hole throws out runs back, most of it along the roof, which lies in
        // a trench half a metre below the shelf; higher ground to either side and behind)
        const high = top + 0.02 * (x - xc) + 18 * ss(56, 150, az) + 14 * ss(xe + 30, xe + 120, x) + 2 * Math.sin(x / 41 + z / 67) * ss(70, 120, az);
        let y = bed + (high - bed) * land;
        // the slot: its floor rises towards its end
        const floor = sea - 22 + 14 * ss(xc, xe - 4, x);
        const cut = (1 - ss(slotHalf(x), slotHalf(x) + 3, az)) * (1 - ss(xe, xe + 4, x));
        return y + Math.min(floor - y, 0) * cut;
      };
      const strip = (x0, x1, pull) => ({ box: [x0, -half, x1, half], swell: true, pull });
      return {
        h: 0.1,
        terrain: { origin: [-448, -576], spacing: 4, n: [353, 289], height },
        // the roof, in four slabs around the hole (a metre square: a fifth of what the slot is wide at its mouth)
        solids: [
          box([xc + 36, roof, -36], [xe - 16, lid, 36]),
          box([xe - 16, roof, -36], [xe - 6, lid, -5]),
          box([xe - 16, roof, 5], [xe - 6, lid, 36]),
          box([xe - 6, roof, -36], [xe + 12, lid, 36]),
        ].map((s) => ({ ...s, rock: true })),
        liquid: [],
        heightfield: {
          origin: [0, -half], n: [length / 2, half], cell: 2,
          depth: (x, z, bed) => (x < xe + 8 ? Math.max(sea - bed, 0) : 0),
          sources: [strip(0, 16, 1), strip(16, 48, 0.04), strip(48, 80, 0.04), strip(80, 112, 0.04)],
          sea: { level: sea, wave: { amp, period, depth: deep, dir: [1, 0], origin: [8, 0] } },
        },
        solve: [{ lo: [xc - 24, 0, -48], hi: [xe + 16, 112, 48] }],
        // (the cliff to either side is left to the map: the swell that slams into it would use up the bricks)
        params: { hfPromoteRadius: 56 },
        world: { focusRadius: 0 },
        // (seen from the sea: the mouth of the slot, the roof, the hole at its far end)
        camera: { target: [xc + 90, sea + 8, 0], dist: 320, yaw: -1.15, pitch: 0.38 },
        marks: { sea, xc, xe, roof },
      };
    },
  },

  // 10. A lake on high ground loses its water through a hole in its floor; the water comes out
  //     again at the foot of the slope, 6 m lower, and runs down a channel and over a ledge
  //     into a pond. The way under the ground is not simulated: it is a link that takes water
  //     out at one end and puts the same water in at the other, as much as the difference in
  //     level drives through it.
  spring: {
    title: 'Sinkhole and spring',
    blurb: 'A lake drains through a hole in its floor and comes out again as a spring 6 m lower, which runs over a ledge into a pond. The way under the ground is a link between two patches of the map: what goes in at one end comes out at the other, driven by the difference in level. The fall and the water around the view target are solved in 3D.',
    build({ flow = 3000, area = 45 } = {}) {
      const lake = 120, pond = 32, half = 256, length = 1024, xs = 584, xl = 780;
      const zs = (x) => 30 * Math.sin((x - xs) / 90);
      const height = (x, z) => {
        // the high ground with the lake in it, and the hole in the lake's floor
        const rl = Math.hypot((x - 280) / 1.5, z);
        let up = 128 - 22 * (1 - ss(60, 130, rl)) + 4 * Math.sin(x / 57) * Math.sin(z / 43) * ss(130, 180, rl);
        up -= 10 * (1 - ss(4, 22, Math.hypot(x - 380, z)));
        // the low ground: the spring's hollow, the channel, the ledge, the pond
        let low = 70 - 26 * ss(520, 1000, x) + 3 * Math.sin(x / 47 + z / 61) * ss(24, 70, Math.abs(z - zs(x)));
        low -= 8 * (1 - ss(8, 16, Math.abs(z - zs(x)))) * ss(xs - 30, xs - 10, x);
        low -= 10 * (1 - ss(8, 24, Math.hypot(x - xs, z)));
        // (the ledge is sharp where the channel crosses it and a slope further off)
        const run = 2 + 70 * ss(30, 130, Math.abs(z - zs(x)));
        low -= 14 * ss(xl - run, xl + run, x);
        // (the pond lies in a hollow of its own: at its level it stays where it is)
        low = Math.max(low, 37 * ss(860, 900, x));
        const rp = Math.hypot(x - 900, z);
        low -= Math.max(low - 22, 0) * (1 - ss(50, 95, rp));
        const scarp = 508 + 26 * Math.sin(z / 130);
        return up + (low - up) * ss(scarp - 16, scarp + 16, x);
      };
      return {
        h: 0.1,
        terrain: { origin: [0, -half], spacing: 2, n: [length / 2 + 1, half + 1], height },
        liquid: [],
        heightfield: {
          origin: [0, -half], n: [length / 2, half], cell: 2,
          // (the lake in its basin and the pond in its own: nothing on the slope between them)
          depth: (x, z, bed) => (Math.hypot((x - 280) / 1.5, z) < 140 ? Math.max(lake - bed, 0) : Math.hypot(x - 900, z) < 100 ? Math.max(pond - bed, 0) : 0),
          sources: [
            { box: [150, -20, 182, 20], rate: flow / (32 * 40) },
            { box: [930, -30, 960, 30], level: pond, pull: 0.2 },
          ],
          links: [{ a: [372, -8, 388, 8], b: [xs - 8, -8, xs + 8, 8], area }],
        },
        params: { hfPromoteRadius: 400 },
        world: { focusRadius: 48 },
        camera: { target: [xl - 40, 50, zs(xl - 40)], dist: 520, yaw: 0.5, pitch: 0.5 },
        marks: { lake, pond, xs, xl, zs },
      };
    },
  },
  // 12. A ship off an island, three compartments open at the top. A hole below the waterline
  //     of the foremost one floods it and the ship goes down by the bow; a second hole
  //     amidships is more than she can carry, and she ends on the sea bed.
  ship: {
    title: 'Holed ship off an island',
    blurb: 'A ship with three compartments lies off an island. After five seconds a hole opens under her bow and she settles by the head; a second one amidships sinks her. The Hole tool makes more (or sooner). Her hull is a distance field in a texture; she and the water in her are solved together.',
    build({ first = 5, second = 30 } = {}) {
      const level = 40.25, bed = 6;
      const height = (x, z) => {
        const r = Math.hypot(x - 110, z + 120);
        // the sea bed, rising to an island with a hill on it
        const island = (level + 3 - bed) * (1 - ss(70, 190, r)) + 26 * (1 - ss(0, 80, r));
        return bed + island + 1.5 * Math.sin(x / 23 + 1) * Math.sin(z / 31) * ss(60, 200, r);
      };
      const ship = shipShape(3);
      const body = shipBody(3, ship, { draught: 10 });
      const at = [-60, 60];
      // a hole through the side at the drawing's (x, y), on the side z > 0
      const side = (x, y) => {
        let z = 0;
        while (z < ship.c && ship.shell(x, y, z) < -ship.wall / 2) z += 0.05;
        return [x, y, z];
      };
      const hole = (at, where, radius) => ({ at, run: (world) => { const b = world.hulls[0]; if (b) world.breachAt(b.fromDrawing(where), radius, 2); } });
      return {
        h: 0.1,
        terrain: { origin: [-260, -300], spacing: 2, n: [261, 261], height },
        water: [{ box: [-1e6, -1e6, 1e6, 1e6], level }],
        swell: { params: { depth: level - bed } },
        liquid: [],
        // (off the foot of the island's slope: over it her bow takes the ground as she trims)
        bodies: [{ ...body, pos: [at[0], level - body.draught + ship.b, at[1]], quat: quatY(0.5) }],
        events: [hole(first, side(22, -ship.b + ship.wall + 1.5), 2.5), hole(second, side(0, -ship.b + ship.wall + 1.5), 3)],
        camera: { target: [at[0], level - 4, at[1]], dist: 165, yaw: 0.2, pitch: 0.55 },
        marks: { level, bed, ship },
      };
    },
  },
};

// ---- hulls --------------------------------------------------------------------------------
// The drawing of a ship: bow towards +x, y up, the origin in the middle of the box around her.
// 3D: a flat-bottomed hull with round bilges and a pointed bow, open at the top, divided by
// two bulkheads. 2D: her section along the keel, with three bulkheads.
export function shipShape(dim, o = {}) {
  const wall = o.wall ?? 3;
  if (dim === 2) {
    const a = o.a ?? 60, b = o.b ?? 12, n = o.compartments ?? 4;
    const top = b + 20, floor = -b + wall, wide = (2 * (a - wall) - (n - 1) * wall) / n;
    const comps = Array.from({ length: n }, (_, k) => [-a + wall + k * (wide + wall), -a + wall + k * (wide + wall) + wide]);
    const outer = sdBox(2, [0, 0, 0], [a, b, 1]);
    const cavity = ([x0, x1]) => sdBox(2, [(x0 + x1) / 2, (floor + top) / 2, 0], [(x1 - x0) / 2, (top - floor) / 2, 1]);
    return { sd: sdCut(outer, ...comps.map(cavity)), shell: outer, box: [[-a, -b, -1], [a, b, 1]], a, b, c: 1, wall, comps, floor };
  }
  const a = o.a ?? 36, b = o.b ?? 8, c = o.c ?? 12, bow = o.bow ?? 20, n = o.compartments ?? 3;
  const l = Math.hypot(c, bow);
  const taper = [sdPlane([a, 0, 0], [c / l, 0, bow / l]), sdPlane([a, 0, 0], [c / l, 0, -bow / l])];
  const outer = sdIntersect(sdBox(3, [0, 0, 0], [a, b, c], 2), ...taper);
  // (the same with the top far above: what is cut out of the hull stays open upwards)
  const tall = sdIntersect(sdBox(3, [0, 20, 0], [a, b + 20, c], 2), ...taper);
  const inner = (x, y, z) => tall(x, y, z) + wall;
  const long = (2 * (a - wall) - (n - 1) * wall) / n;
  const comps = Array.from({ length: n }, (_, k) => [-a + wall + k * (long + wall), -a + wall + k * (long + wall) + long]);
  const cavity = ([x0, x1]) => sdIntersect(inner, sdBox(3, [(x0 + x1) / 2, 20, 0], [(x1 - x0) / 2, 60, c + 8]));
  return { sd: sdCut(outer, ...comps.map(cavity)), shell: outer, box: [[-a, -b, -c], [a, b, c]], a, b, c, wall, comps, floor: -b + wall };
}

/**
 * The body of a ship that floats `draught` cells deep on an even keel: material of `density`
 * and ballast low in her, under the middle of what she displaces.
 */
export function shipBody(dim, ship, { draught, density = 0.5 }) {
  const [lo, hi] = ship.box;
  const under = integrateShape(dim, (x, y, z) => Math.max(ship.shell(x, y, z), y - lo[1] - draught), lo, hi, 1);
  const material = integrateShape(dim, ship.sd, lo, hi, 1);
  const ballast = Math.max(under.volume - density * material.volume, 0);
  // (ballast and material together have their centre over that of the water displaced)
  const x = ballast > 0 ? (under.volume * under.center[0] - density * material.volume * material.center[0]) / ballast : 0;
  const mass = density * material.volume + ballast;
  return { shape: 'hull', sd: ship.sd, shell: ship.shell, box: ship.box, density, ballast: [{ pos: [x, lo[1] + 2, 0], mass: ballast }],
    draught: floatDraught(dim, ship.shell, ship.box, mass) };
}

// ---- 2D scenes (world2d.html) ---------------------------------------------------------------
export const WORLD_SCENES_2D = {
  // 11. The same ship in section, afloat on a sea over a bed.
  flood: {
    title: 'Flooding compartments',
    blurb: 'A ship in section, four compartments in a row. After three seconds a hole opens in the floor of the foremost one: it fills to the level of the sea and the ship trims by the bow. Click on her hull to make more holes: with two compartments open she goes down and comes to rest on the bed.',
    build({ first = 3, second = Infinity } = {}) {
      const level = 72, bed = 16;
      const ship = shipShape(2);
      const body = shipBody(2, ship, { draught: 10.3 });
      const mid = (k) => [(ship.comps[k][0] + ship.comps[k][1]) / 2, -ship.b + ship.wall / 2, 0];
      return {
        h: 0.05,
        solids: [{ type: 'box', center: [0, bed - 500, 0], half: [4000, 500, 1] }],
        water: [{ box: [-1e6, -1e6, 1e6, 1e6], level }],
        liquid: [],
        bodies: [{ ...body, pos: [0.37, level - body.draught + ship.b, 0] }],
        events: [3, 2].map((k, i) => ({ at: i ? second : first, run: (world) => { const b = world.hulls[0]; if (b) world.breachAt(b.fromDrawing(mid(k)), 2.5, 2); } })),
        view: { center: [0, level - 22], width: 260 },
        marks: { level, bed, ship },
      };
    },
  },
};
