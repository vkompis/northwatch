import assert from 'node:assert/strict';
import { pickListedImo } from './sanctionListings';

const entry = (listedName: string | null, listedImo: string | null) => ({ listedName, listedImo });

// Bonifacy has not sent its IMO; the list under its MMSI has the same name
assert.equal(pickListedImo([entry('BONIFACY', '9284726')], 'BONIFACY'), '9284726');
assert.equal(pickListedImo([entry('Bonifacy', '9284726'), entry('BONIFACY', '9284726')], 'BONIFACY '), '9284726');

// A reused MMSI: the list names another ship (SC 609 on HOMA's old MMSI)
assert.equal(pickListedImo([entry('HOMA', '9357389')], 'SC 609'), null);
// Any entry under another name makes the MMSI doubtful, as do two different numbers
assert.equal(pickListedImo([entry('BONIFACY', '9284726'), entry('HOMA', '9357389')], 'BONIFACY'), null);
assert.equal(pickListedImo([entry('BONIFACY', '9284726'), entry('BONIFACY', '9357389')], 'BONIFACY'), null);
// No ship name to compare, or nothing on the list
assert.equal(pickListedImo([entry('BONIFACY', '9284726')], ''), null);
assert.equal(pickListedImo([entry('BONIFACY', null)], 'BONIFACY'), null);
assert.equal(pickListedImo([], 'BONIFACY'), null);

console.log('sanctionListings tests passed');
