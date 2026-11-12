// World scenes: ground, liquid, sources and drains in cells; x and z horizontal, y up.
const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
const ss = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const box = (lo, hi, vel = [0, 0, 0]) => ({ type: 'box', center: lo.map((v, d) => (v + hi[d]) / 2), half: lo.map((v, d) => (hi[d] - v) / 2), vel });

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
};
