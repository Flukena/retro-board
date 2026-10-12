import { useEffect, useLayoutEffect } from 'react';

export const useBrowserLayoutEffect = (
  typeof document !== 'undefined' && typeof document.createElement === 'function'
    ? useLayoutEffect
    : useEffect
);

