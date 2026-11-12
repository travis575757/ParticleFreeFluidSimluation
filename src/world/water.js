// Water at rest: what a body of water looks like to the solver where it is not being solved.
//
// A water body has a level (cells, y up) and an extent in x and z. Its state of rest is the one
// the solver itself settles into for a pool filled to that level:
//   rho' = clamp(level - y, 0, 1) in the row of cells [y, y + 1)
//   p    = G * (theta + rows below the top liquid cell)       G = g dt / h, the pressure step per row
// where the top liquid cell is the highest one with rho' >= 0.5 and theta is where the
// ghost-fluid discretisation of the pressure solve puts the surface above its centre
// (phi / (phi - phi_above), phi = 0.5 - rho'; clamped at thetaMin as in the solver). That is not
// the hydrostatic pressure of the level itself: the two differ by up to 0.086 cells of head, and
// a held cell with the analytic value next to a solved one would drive a steady flow.

/** The rest state of water filled to `level`: { top: row of the top liquid cell, pTop: its pressure }. */
export function farLevel(level, G, thetaMin) {
  const top = Math.floor(level - 0.5);
  const a = Math.min(level - top, 1);                 // rho' of the top liquid cell, 0.5 .. 1
  const b = Math.max(level - top - 1, 0);             // rho' of the cell above it, 0 .. 0.5
  const theta = (a - 0.5) / (a - b);
  return { top, pTop: G * Math.max(theta, thetaMin), theta };
}
