// WebKit sizes a composited layer's backing store from the element's own CSS
// size, not from the zoom applied by its ancestors. Inside the zoomed-out
// board world one such layer (or anything promoted to sit above it) can need
// gigabytes, which iOS answers by killing the tab. `GestureEvent` exists only
// in WebKit, so it marks the browsers that need composited layers kept out of
// the world.
export const webkitCompositing = view => typeof view?.GestureEvent === 'function';
