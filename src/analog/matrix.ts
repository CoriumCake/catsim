/* Dense LU solve with partial pivoting, in place on typed arrays.
 * Our circuits have tens of unknowns, where a dense solver is simpler and as fast as a sparse one.
 * (Sparse LU with Markowitz ordering is the upgrade path if large circuits ever need it.) */

export class DenseSolver {
  readonly n: number;
  readonly A: Float64Array; // row-major n×n
  readonly b: Float64Array;
  private readonly perm: Int32Array;

  constructor(n: number) {
    this.n = n;
    this.A = new Float64Array(n * n);
    this.b = new Float64Array(n);
    this.perm = new Int32Array(n);
  }

  clear(): void { this.A.fill(0); this.b.fill(0); }

  add(r: number, c: number, v: number): void { if (r >= 0 && c >= 0) this.A[r * this.n + c] += v; }
  addRhs(r: number, v: number): void { if (r >= 0) this.b[r] += v; }

  /** Solves A·x = b into `x`. Returns false if the matrix is singular. A and b are destroyed. */
  solve(x: Float64Array): boolean {
    const { n, A, b, perm } = this;
    for (let i = 0; i < n; i++) perm[i] = i;
    for (let k = 0; k < n; k++) {
      // partial pivoting
      let p = k, max = Math.abs(A[k * n + k]);
      for (let i = k + 1; i < n; i++) { const v = Math.abs(A[i * n + k]); if (v > max) { max = v; p = i; } }
      if (max < 1e-300 || !Number.isFinite(max)) return false;
      if (p !== k) {
        for (let j = 0; j < n; j++) { const t = A[k * n + j]; A[k * n + j] = A[p * n + j]; A[p * n + j] = t; }
        const t = b[k]; b[k] = b[p]; b[p] = t;
      }
      const piv = A[k * n + k];
      for (let i = k + 1; i < n; i++) {
        const f = A[i * n + k] / piv;
        if (f === 0) continue;
        A[i * n + k] = 0;
        for (let j = k + 1; j < n; j++) A[i * n + j] -= f * A[k * n + j];
        b[i] -= f * b[k];
      }
    }
    for (let i = n - 1; i >= 0; i--) {
      let s = b[i];
      for (let j = i + 1; j < n; j++) s -= A[i * n + j] * x[j];
      x[i] = s / A[i * n + i];
      if (!Number.isFinite(x[i])) return false;
    }
    return true;
  }
}
