/** Terrarium DEM encoding: elevation = R·256 + G + B/256 − 32768 (metres). */
export function terrariumElevation(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

/** Set every land pixel (elevation ≥ 0 ⇔ R ≥ 128) to exactly 0 m, in place. */
export function flattenLand(rgba: Uint8ClampedArray): void {
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i] >= 128) {
      rgba[i] = 128;
      rgba[i + 1] = 0;
      rgba[i + 2] = 0;
    }
  }
}
