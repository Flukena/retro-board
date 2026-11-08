import test from 'node:test';
import assert from 'node:assert/strict';
import { createMaintainerRoomLinks } from './maintainer-room-access.js';
import { canonicalDocName } from './relay-room-registry.js';

const handle='A'.repeat(32);
const docName=canonicalDocName('Board123','secret-token_with-dashes');
const registry={registeredRoomsByHandle:new Map([[handle,docName]]),isLocked:()=>false};

test('explicit owner room access yields a normal collaborator link without loading the document', () => {
  const link=createMaintainerRoomLinks({registry,boardOrigin:'https://board.example'})(handle);
  const url=new URL(link);
  assert.equal(url.origin,'https://board.example');
  assert.equal(canonicalDocName(url.pathname.slice('/b/'.length),url.hash.slice(1)),docName);
  assert.equal(url.search,'');
  assert.equal(createMaintainerRoomLinks({registry,boardOrigin:'https://board.example'})('B'.repeat(32)),null);
  assert.equal(createMaintainerRoomLinks({registry,boardOrigin:'https://board.example'})('../bad'),null);
  assert.equal(createMaintainerRoomLinks()(handle),null);
});

test('public room access never exports its internal capability', () => {
  const access=createMaintainerRoomLinks({registry,boardOrigin:'http://localhost:5173',publicWall:true});
  assert.equal(access(handle),'http://localhost:5173/public');
});

test('an encrypted room never yields an access link, even though its capability is registered', () => {
  const locked={...registry,isLocked:name=>name===docName};
  assert.equal(createMaintainerRoomLinks({registry:locked,boardOrigin:'https://board.example'})(handle),null);
  assert.equal(createMaintainerRoomLinks({registry:locked,boardOrigin:'http://localhost:5173',publicWall:true})(handle),null);
});
