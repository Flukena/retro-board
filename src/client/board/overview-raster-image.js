const PNG_TYPE = 'image/png';

/**
 * Shows an offscreen raster canvas through an image URL. An `<img>` is painted
 * with the page instead of getting its own WebKit layer (see
 * `webkit-compositing.js`). Only the newest export is shown, and a URL is
 * revoked once a newer one has loaded or the image is disposed.
 */
export class OverviewRasterImage {
  #canvas; #urls; #onChange;
  #generation = 0; #latest = null; #shown = null; #disposed = false;

  constructor(canvas, { onChange, urlApi = URL }) {
    this.#canvas = canvas; this.#onChange = onChange; this.#urls = urlApi;
  }

  /** Export the canvas as it is now; earlier exports still encoding are dropped. */
  publish() {
    const generation = ++this.#generation;
    this.#canvas.toBlob(blob => {
      if (this.#disposed || generation !== this.#generation || !blob) return;
      if (this.#latest && this.#latest !== this.#shown) this.#urls.revokeObjectURL(this.#latest);
      this.#latest = this.#urls.createObjectURL(blob);
      this.#onChange(this.#latest);
    }, PNG_TYPE);
  }

  /** Call when the `<img>` finished loading `url`. Returns true when it is the newest export. */
  loaded(url) {
    if (this.#disposed || url !== this.#latest) return false;
    if (this.#shown && this.#shown !== url) this.#urls.revokeObjectURL(this.#shown);
    this.#shown = url;
    return true;
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const url of new Set([this.#latest, this.#shown])) if (url) this.#urls.revokeObjectURL(url);
    this.#latest = null; this.#shown = null;
    this.#canvas.width = 0; this.#canvas.height = 0;
  }
}
