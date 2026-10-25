import test from 'node:test';
import assert from 'node:assert/strict';
import { paintDrawing, drawingArtifact, resizeDrawingPreview, DRAWING_PREVIEW_MAX_PIXELS } from './drawing-paint.js';
const strokes = [{ color: '#111827', width: 4, points: [{ x: -10, y: -20 }, { x: 1600, y: 500 }] }];
function context() { const calls = []; const ctx = { calls }; for (const name of ['setTransform', 'clearRect', 'beginPath', 'arc', 'fill', 'moveTo', 'lineTo', 'stroke']) ctx[name] = (...args) => calls.push([name,...args]); return ctx; }

test('paths use rounded joins and a single dot is painted as a filled circle', () => {
  const ctx = context(); paintDrawing(ctx, [...strokes, { ...strokes[0], points: [{ x: 2, y: 3 }] }]);
  assert.equal(ctx.lineCap, 'round'); assert.equal(ctx.lineJoin, 'round');
  assert.ok(ctx.calls.some(call => call[0] === 'arc' && call[1] === 2 && call[3] === 2));
  assert.equal(ctx.calls.filter(call => call[0] === 'stroke').length, 1); assert.equal(ctx.calls.filter(call => call[0] === 'fill').length, 1);
});
test('PNG output is bounded, preserves canonical extent, and releases raster memory', async () => {
  const ctx = context(); let type; const canvas = { getContext: () => ctx, toBlob: (done, mime) => { type = mime; done(new Blob(['png'], { type: mime })); } };
  const artifact = await drawingArtifact(strokes, 2, { createElement: () => canvas });
  assert.equal(type, 'image/png'); assert.ok(artifact.natW <= 1200 && artifact.natH <= 1200);
  assert.deepEqual(artifact.bounds, { x: -13, y: -23, w: 1616, h: 526 });
  assert.equal(canvas.width, 0); assert.equal(canvas.height, 0);
});
test('missing context, null encoder and empty or invalid drawings stay uncommitted', async () => {
  const canvas = { getContext: () => null }; const document = { createElement: () => canvas };
  assert.equal(await drawingArtifact(strokes, 2, document), null); assert.equal(canvas.width, 0);
  canvas.getContext = () => context(); canvas.toBlob = done => done(null);
  assert.equal(await drawingArtifact(strokes, 2, document), null);
  assert.equal(await drawingArtifact([], 2, document), null); assert.equal(await drawingArtifact(strokes, NaN, document), null);
  resizeDrawingPreview(canvas, 10000, 10000, 3); assert.ok(canvas.width * canvas.height <= DRAWING_PREVIEW_MAX_PIXELS);
});

test('eraser uses transparent destination-out and restores normal composition before later colored strokes', () => {
  const modes=[],ctx=context();
  for (const method of ['stroke','fill']) ctx[method]=()=>modes.push(ctx.globalCompositeOperation);
  paintDrawing(ctx,[...strokes,{...strokes[0],tool:'eraser',width:24},...strokes]);
  assert.deepEqual(modes,['source-over','destination-out','source-over']); assert.equal(ctx.globalCompositeOperation,'source-over');
});
test('editing paints the original bitmap first, retains its world size and allows an entirely transparent replacement', async () => {
  const ctx=context(), bitmap={};let drawn;
  ctx.drawImage=(...args)=>{drawn=args;};
  const canvas={getContext:()=>ctx,toBlob:(done,mime)=>done(new Blob(['png'],{type:mime}))};
  const base={image:bitmap,bounds:{x:10.25,y:20.5,w:800,h:100}};
  const result=await drawingArtifact([{...strokes[0],tool:'eraser'}],2,{createElement:()=>canvas},base);
  assert.deepEqual(result.bounds,base.bounds); assert.deepEqual(drawn,[bitmap,10.25,20.5,800,100]);
  assert.ok(result.blob);
});
test('an entirely erased new draft produces no uploadable empty object', async () => {
  const ctx=context();ctx.getImageData=()=>({data:new Uint8ClampedArray(4)});
  const canvas={getContext:()=>ctx,toBlob:()=>assert.fail('empty draft must not encode')};
  const erased=await drawingArtifact([...strokes,{...strokes[0],tool:'eraser'}],2,{createElement:()=>canvas});
  assert.deepEqual(erased,{empty:true});
});

test('raster quality is retained when a saved image is reopened at a smaller fit zoom', async () => {
  const ctx=context();ctx.drawImage=()=>{};
  const canvas={getContext:()=>ctx,toBlob:(done,mime)=>done(new Blob(['png'],{type:mime}))};
  const base={image:{width:1000,height:600},bounds:{x:0,y:0,w:500,h:300}};
  const result=await drawingArtifact([],0.25,{createElement:()=>canvas},base);
  assert.equal(result.natW,1000);assert.equal(result.natH,600);
});
