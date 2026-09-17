// Sparse linear algebra for the nodal and thermal solves.
//
// Rows are Maps from column index to value, so a network of N nodes with a handful of
// branches each costs O(N) storage instead of O(N^2). Elimination is Gaussian with partial
// pivoting, which is LU with the factors applied immediately; the systems here are solved
// once per Newton iteration, so there is nothing to gain from keeping the factors.

export class SingularMatrixError extends Error {
  constructor(column) {
    super(`Singular matrix: no usable pivot in column ${column}`);
    this.name = "SingularMatrixError";
    this.column = column;
  }
}

export class SparseSystem {
  constructor(size) {
    this.size = size;
    this.rows = Array.from({ length: size }, () => new Map());
    this.rhs = new Float64Array(size);
  }

  /** A[row][column] += value. Indices below zero are ignored (reference nodes). */
  add(row, column, value) {
    if (row < 0 || column < 0 || value === 0) return;
    const target = this.rows[row];
    const existing = target.get(column);
    target.set(column, existing === undefined ? value : existing + value);
  }

  /** b[row] += value. */
  addRhs(row, value) {
    if (row < 0 || value === 0) return;
    this.rhs[row] += value;
  }

  get(row, column) {
    return this.rows[row].get(column) ?? 0;
  }

  clear() {
    for (const row of this.rows) row.clear();
    this.rhs.fill(0);
  }

  /** Solves A x = b, destroying A and b. Returns a Float64Array of length `size`. */
  solve() {
    const { size, rows, rhs } = this;
    const solution = new Float64Array(size);
    if (size === 0) return solution;

    for (let column = 0; column < size; column += 1) {
      let pivotRow = -1;
      let pivotMagnitude = 0;
      for (let row = column; row < size; row += 1) {
        const magnitude = Math.abs(rows[row].get(column) ?? 0);
        if (magnitude > pivotMagnitude) {
          pivotMagnitude = magnitude;
          pivotRow = row;
        }
      }
      if (pivotRow < 0 || pivotMagnitude === 0) throw new SingularMatrixError(column);

      if (pivotRow !== column) {
        [rows[column], rows[pivotRow]] = [rows[pivotRow], rows[column]];
        const swap = rhs[column];
        rhs[column] = rhs[pivotRow];
        rhs[pivotRow] = swap;
      }

      const pivot = rows[column];
      const pivotValue = pivot.get(column);
      for (let row = column + 1; row < size; row += 1) {
        const target = rows[row];
        const leading = target.get(column);
        if (leading === undefined || leading === 0) continue;
        const factor = leading / pivotValue;
        target.delete(column);
        for (const [pivotColumn, pivotEntry] of pivot) {
          if (pivotColumn <= column) continue;
          const updated = (target.get(pivotColumn) ?? 0) - factor * pivotEntry;
          if (updated === 0) target.delete(pivotColumn);
          else target.set(pivotColumn, updated);
        }
        rhs[row] -= factor * rhs[column];
      }
    }

    for (let row = size - 1; row >= 0; row -= 1) {
      let accumulated = rhs[row];
      let diagonal = 0;
      for (const [column, value] of rows[row]) {
        if (column === row) diagonal = value;
        else accumulated -= value * solution[column];
      }
      if (diagonal === 0) throw new SingularMatrixError(row);
      solution[row] = accumulated / diagonal;
    }
    return solution;
  }
}

export const infinityNorm = (values) => {
  let largest = 0;
  for (const value of values) {
    const magnitude = Math.abs(value);
    if (magnitude > largest) largest = magnitude;
  }
  return largest;
};
