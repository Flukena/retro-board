import { useEffect, useRef, useState } from 'react';
import { SnapshotImageCapture } from './public-wall-snapshot-image.js';

export function usePublicWallSnapshotImage(sceneRef, revision, captureTrigger = revision) {
  const captureRef = useRef(null);
  const [state, setState] = useState({ imageUrl: null, status: 'loading' });
  useEffect(() => {
    const capture = new SnapshotImageCapture();
    captureRef.current = capture;
    const update = () => setState(capture.state);
    capture.addEventListener('change', update);
    return () => {
      capture.removeEventListener('change', update);
      capture.dispose();
      captureRef.current = null;
    };
  }, []);

  useEffect(() => {
    const capture = captureRef.current;
    let stopped = false;
    let frame;
    void document.fonts.ready.then(() => {
      if (stopped) return;
      frame = requestAnimationFrame(() => {
        if (!stopped) void capture.capture(sceneRef.current, revision);
      });
    });
    return () => { stopped = true; cancelAnimationFrame(frame); };
  }, [captureTrigger, revision, sceneRef]);
  return state;
}
