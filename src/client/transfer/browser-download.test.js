import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadArtifact } from './browser-download.js';

const DOWNLOAD_RELEASE_TICK_MS = 1;
const CSV_CONTENTS = 'หัวข้อ,ข้อความ\nIdeas,Hello\n';
const ARCHIVE_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
const CASES = [
  { name: 'CSV text', artifact: { contents: CSV_CONTENTS, mimeType: 'text/csv', fileName: 'board.csv' },
    expected: new TextEncoder().encode(CSV_CONTENTS), mimeType: 'text/csv' },
  { name: 'existing archive Blob', artifact: { blob: new Blob([ARCHIVE_BYTES], { type: 'application/zip' }), fileName: 'board.zip' },
    expected: ARCHIVE_BYTES, mimeType: 'application/zip' },
];

for (const fixture of CASES) {
  test(`download preserves ${fixture.name} bytes and releases its temporary URL after activation`, async context => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    let response;
    const anchor = { click() { response = fetch(this.href); } };
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { createElement(tag) { assert.equal(tag, 'a'); return anchor; } },
    });
    context.after(() => {
      if (anchor.href) URL.revokeObjectURL(anchor.href);
      if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
      else delete globalThis.document;
    });

    downloadArtifact(fixture.artifact);
    assert.equal(anchor.download, fixture.artifact.fileName);
    const downloaded = await response;
    assert.equal(downloaded.headers.get('content-type'), fixture.mimeType);
    assert.deepEqual(new Uint8Array(await downloaded.arrayBuffer()), fixture.expected);
    assert.equal((await fetch(anchor.href)).status, 200);

    context.mock.timers.tick(DOWNLOAD_RELEASE_TICK_MS);
    await assert.rejects(fetch(anchor.href), TypeError);
  });
}
