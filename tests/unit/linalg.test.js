import test from "node:test";
import assert from "node:assert/strict";
import { SparseSystem, SingularMatrixError, infinityNorm } from "../../engine/core/linalg.js";

test("solves a 3x3 system", () => {
  // [ 2 1 -1 ] [x]   [  8 ]
  // [-3 -1 2 ] [y] = [-11 ]
  // [-2 1  2 ] [z]   [ -3 ]   ->  (2, 3, -1)
  const system = new SparseSystem(3);
  const rows = [
    [2, 1, -1],
    [-3, -1, 2],
    [-2, 1, 2]
  ];
  const rhs = [8, -11, -3];
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) system.add(i, j, rows[i][j]);
    system.addRhs(i, rhs[i]);
  }
  const solution = system.solve();
  assert.ok(Math.abs(solution[0] - 2) < 1e-12);
  assert.ok(Math.abs(solution[1] - 3) < 1e-12);
  assert.ok(Math.abs(solution[2] + 1) < 1e-12);
});

test("pivots rather than dividing by a zero diagonal", () => {
  const system = new SparseSystem(2);
  system.add(0, 1, 1);
  system.add(1, 0, 1);
  system.addRhs(0, 5);
  system.addRhs(1, 7);
  const solution = system.solve();
  assert.ok(Math.abs(solution[0] - 7) < 1e-12);
  assert.ok(Math.abs(solution[1] - 5) < 1e-12);
});

test("rejects a singular matrix", () => {
  const system = new SparseSystem(2);
  system.add(0, 0, 1);
  system.add(0, 1, 1);
  system.add(1, 0, 2);
  system.add(1, 1, 2);
  system.addRhs(0, 1);
  system.addRhs(1, 3);
  assert.throws(() => system.solve(), SingularMatrixError);
});

test("negative row and column indices are dropped as the reference node", () => {
  const system = new SparseSystem(1);
  system.add(-1, 0, 1e9);
  system.add(0, -1, 1e9);
  system.add(0, 0, 2);
  system.addRhs(0, 4);
  system.addRhs(-1, 1e9);
  const solution = system.solve();
  assert.ok(Math.abs(solution[0] - 2) < 1e-12);
});

test("infinity norm", () => {
  assert.equal(infinityNorm(new Float64Array([1, -7, 3])), 7);
  assert.equal(infinityNorm(new Float64Array(0)), 0);
});

test("a 200-node ladder solves quickly and accurately", () => {
  // A resistive ladder: node i connected to i+1 by 1 S, node 0 driven to 1 V by a stiff source.
  // The exact solution is a linear voltage ramp.
  const n = 200;
  const system = new SparseSystem(n);
  const stiff = 1e6;
  system.add(0, 0, stiff);
  system.addRhs(0, stiff * 1);
  for (let i = 0; i < n - 1; i += 1) {
    system.add(i, i, 1);
    system.add(i, i + 1, -1);
    system.add(i + 1, i + 1, 1);
    system.add(i + 1, i, -1);
  }
  // Terminate the far end to the reference through 1 S.
  system.add(n - 1, n - 1, 1);
  const solution = system.solve();
  for (let i = 0; i < n; i += 1) {
    const expected = 1 - i / n;
    assert.ok(Math.abs(solution[i] - expected) < 1e-6, `node ${i}: ${solution[i]} vs ${expected}`);
  }
});
