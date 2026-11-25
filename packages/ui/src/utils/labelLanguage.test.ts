import assert from 'node:assert/strict';
import { browserLabelLanguage, localiseStyleLabels } from './labelLanguage.ts';

// Norwegian when any listed language is Norwegian (bokmål, nynorsk or plain "no")
assert.equal(browserLabelLanguage(['nb-NO', 'en-US']), 'no');
assert.equal(browserLabelLanguage(['en-GB', 'nn']), 'no');
assert.equal(browserLabelLanguage(['no']), 'no');
assert.equal(browserLabelLanguage(['en-GB']), 'en');
assert.equal(browserLabelLanguage(['de-DE', 'fr']), 'en');
assert.equal(browserLabelLanguage([]), 'en');
assert.equal(browserLabelLanguage(['nl-NL']), 'en'); // Dutch, not Norwegian

const style = {
  version: 8,
  layers: [
    { id: 'capitals', layout: { 'text-field': ['coalesce', ['get', 'name_no'], ['get', 'name:no'], ['get', 'name_en'], ['get', 'name']] } },
    {
      id: 'seas',
      layout: {
        'text-field': ['match', ['get', 'name_int'], 'Mediterranean Sea', 'Middelhavet', ['coalesce', ['get', 'name:no'], ['get', 'name']]],
      },
    },
    { id: 'rivers', layout: { 'text-field': ['coalesce', ['get', 'name_en'], ['get', 'name']] } },
    { id: 'roads', layout: { 'text-field': ['get', 'ref'] } },
    { id: 'water', type: 'fill' },
  ],
};

// Norwegian keeps the style as it is
assert.equal(localiseStyleLabels(style, 'no'), style);

// English swaps only the labels that asked for a Norwegian name
{
  const en = localiseStyleLabels(style, 'en');
  const field = (id: string) => (en.layers.find((l: any) => l.id === id) as any).layout?.['text-field'];
  const english = ['coalesce', ['get', 'name_en'], ['get', 'name:en'], ['get', 'name_int'], ['get', 'name']];
  assert.deepEqual(field('capitals'), english);
  assert.deepEqual(field('seas'), english);
  assert.deepEqual(field('rivers'), style.layers[2].layout!['text-field']);
  assert.deepEqual(field('roads'), ['get', 'ref']);
  assert.equal(field('water'), undefined);
  // The original style is not changed
  assert.equal((style.layers[0].layout as any)['text-field'][1][1], 'name_no');
}

console.log('labelLanguage.test.ts: ok');
