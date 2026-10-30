import assert from 'node:assert/strict';
import { RELIEF_COLOURS, RELIEF_COLOURS_LIGHT, reliefColours, reliefGain, tileBbox3857, tintKartverketRelief } from './kartverketRelief.ts';

// Pixels: level seabed, slope in shadow, slope in light, land (transparent)
const px = new Uint8ClampedArray([
  180, 180, 180, 255,
  105, 105, 105, 255,
  255, 255, 255, 255,
  255, 255, 255, 0,
]);
tintKartverketRelief(px, RELIEF_COLOURS, 1);
assert.deepEqual([...px.slice(0, 4)], [...RELIEF_COLOURS.water, 255]); // level → plain water
// Full shadow at 90 % of the shadow colour, full light at 35 % of the highlight colour
assert.deepEqual([...px.slice(4, 8)], [1, 6, 15, 255]);
assert.deepEqual([...px.slice(8, 12)], [46, 70, 97, 255]);
assert.deepEqual([...px.slice(12, 16)], [255, 255, 255, 0]); // no data stays transparent

// Gain lifts subtle shading but never past full shade
const faint = new Uint8ClampedArray([170, 170, 170, 255, 0, 0, 0, 255]);
tintKartverketRelief(faint, RELIEF_COLOURS, 3);
assert.ok(faint[2] < RELIEF_COLOURS.water[2] && faint[2] > RELIEF_COLOURS.shadow[2]);
assert.deepEqual([...faint.slice(4, 7)], [1, 6, 15]);
assert.equal(reliefGain(4), 3);
assert.equal(reliefGain(14), 1.6);
assert.ok(reliefGain(9) < 3 && reliefGain(9) > 1.6);

// Light map: level seabed is the light style's water (#F5F7F8)
assert.equal(reliefColours('light'), RELIEF_COLOURS_LIGHT);
const level = new Uint8ClampedArray([180, 180, 180, 255]);
tintKartverketRelief(level, RELIEF_COLOURS_LIGHT, 2);
assert.deepEqual([...level.slice(0, 3)], [0xf5, 0xf7, 0xf8]);

// z1 tile (1,0) is the north-east quarter of the Mercator square
const [minx, miny, maxx, maxy] = tileBbox3857(1, 1, 0);
assert.equal(minx, 0);
assert.equal(miny, 0);
assert.ok(Math.abs(maxx - 20037508.34) < 0.01 && Math.abs(maxy - 20037508.34) < 0.01);

console.log('kartverketRelief.test.ts: ok');
