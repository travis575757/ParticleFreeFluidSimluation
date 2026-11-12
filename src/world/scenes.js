// World scenes: ground, liquid, sources and drains in cells; x and z horizontal, y up.
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
};
