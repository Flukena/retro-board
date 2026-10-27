import test from 'node:test';
import assert from 'node:assert/strict';
import { appendHistory, chartSegments, HISTORY_LIMIT_SAMPLES, resourceAlerts, selectRooms } from './monitoring-model.js';

const rooms = [
  {handle:'cold',connections:0, resident:false, blockedUntil:null,uploadBytes:20,documentBytesUpperBound:null},
  {handle:'busy',connections:4,resident:true,blockedUntil:null,uploadBytes:10,documentBytesUpperBound:50},
  {handle:'blocked',connections:1,resident:true,blockedUntil:123,uploadBytes:30,documentBytesUpperBound:10},
];
const status = at => ({at,rooms,memory:{rss:100,heapUsed:40,heapLimit:100},databaseBytes:79,uploadBytes:95,activeDocumentBytes:80,pendingStoreBytes:0,pendingStoreOps:9,limits:{databaseBytes:100,uploadBytes:100,activeDocumentBytes:100,pendingStoreBytes:10,pendingStoreOps:10}});

test('room filters and sorting use live clients, blocked status and known document size', () => {
  assert.deepEqual(selectRooms(rooms,'','active','connections').map(room=>room.handle),['busy','blocked']);
  assert.deepEqual(selectRooms(rooms,' BLOCK ','blocked','handle').map(room=>room.handle),['blocked']);
  assert.deepEqual(selectRooms(rooms,'','all','document').map(room=>room.handle),['busy','blocked','cold']);
  assert.deepEqual(selectRooms(rooms,'','cold','uploads').map(room=>room.handle),['cold']);
  assert.equal(rooms[0].handle,'cold','does not mutate source state');
});

test('resource alerts distinguish warning, critical, below threshold and missing limits', () => {
  assert.deepEqual(resourceAlerts(status('2026-10-27T00:00:00Z')), [
    {resource:'uploads',severity:'critical',percent:95},
    {resource:'activeDocuments',severity:'warning',percent:80},
    {resource:'backlog',severity:'warning',percent:90},
  ]);
  const data = status('2026-10-27T00:00:00Z');
  data.pendingStoreBytes=10;
  assert.deepEqual(resourceAlerts(data).at(-1),{resource:'backlog',severity:'critical',percent:100});
  delete data.memory.heapLimit;
  data.memory.heapUsed=1000;
  assert.ok(!resourceAlerts(data).some(alert=>alert.resource==='heap'));
});

test('history keeps bounded distinct samples and restarts after server time moves backward', () => {
  let history=[];
  for (let index=0; index<=HISTORY_LIMIT_SAMPLES; index+=1) history=appendHistory(history,status(new Date(index*5000).toISOString()));
  assert.equal(history.length,HISTORY_LIMIT_SAMPLES);
  assert.equal(history[0].at,5000);
  assert.equal(history.at(-1).clients,5);
  assert.equal(appendHistory(history,status(new Date(HISTORY_LIMIT_SAMPLES*5000).toISOString())),history);
  assert.equal(appendHistory(history,status('invalid')),history);
  assert.equal(appendHistory(history,status(new Date(0).toISOString())).length,1);
});

test('charts use real elapsed time, break across missing samples and handle zero usage', () => {
  const history=[{at:0,clients:0},{at:5000,clients:5},{at:30000,clients:0}];
  const chart=chartSegments(history,'clients',300,100);
  assert.equal(chart.maximum,5);
  assert.deepEqual(chart.segments,['0,100 50,0','300,100']);
  assert.deepEqual(chartSegments([], 'clients', 300,100),{maximum:1,segments:[]});
});
