import assert from 'node:assert/strict';
import { flattenLand, terrariumElevation } from './terrarium.ts';

// Pixels: 2469 m mountain, 0 m shore, −1 m shallows, −3000 m deep sea
const px = new Uint8ClampedArray([
  137, 165, 0, 255,
  128, 0, 0, 255,
  127, 255, 0, 255,
  116, 72, 0, 255,
]);
const elev = (d: Uint8ClampedArray, i: number) => terrariumElevation(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
assert.equal(elev(px, 0), 2469);
assert.equal(elev(px, 2), -1);
assert.equal(elev(px, 3), -3000);

flattenLand(px);
assert.equal(elev(px, 0), 0); // land flattened
assert.equal(elev(px, 1), 0);
assert.equal(elev(px, 2), -1); // sea untouched
assert.equal(elev(px, 3), -3000);
assert.equal(px[3], 255); // alpha kept

console.log('terrarium.test.ts: ok');
