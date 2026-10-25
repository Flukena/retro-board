import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDrawingImage } from './drawing-image.js';
const png = new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==','base64')],{type:'image/png'});
const target = { type:'image',src:'drawing.png',x:10.5,y:20.25,w:100,h:50 };
test('validated PNG opens at existing world bounds with abort propagation and caller-owned decoded resource', async () => {
  const abort=new AbortController(); let signal, closed=0;
  const bitmap={close(){closed++;}};
  const asset=await loadDrawingImage(target,{signal:abort.signal,readImage:async(_src,options)=>{signal=options.signal;return png;},decode:async()=>bitmap});
  assert.equal(signal,abort.signal); assert.deepEqual(asset.bounds,{x:10.5,y:20.25,w:100,h:50});
  assert.equal(closed,0); asset.image.close(); assert.equal(closed,1);
});
test('cancel during decode releases bitmap, bad raster never decodes and rejected reads propagate to retry UI', async () => {
  const abort=new AbortController(); let closed=0;
  assert.equal(await loadDrawingImage(target,{signal:abort.signal,readImage:async()=>png,decode:async()=>{abort.abort();return{close(){closed++;}};}}),null);
  assert.equal(closed,1);
  const malformed=await loadDrawingImage(target,{readImage:async()=>new Blob(['invalid']),decode:async()=>assert.fail('must validate before decode')}); assert.equal(malformed,null);
  await assert.rejects(loadDrawingImage(target,{readImage:async()=>{throw new Error('unavailable');},decode:async()=>null}),/unavailable/);
});
