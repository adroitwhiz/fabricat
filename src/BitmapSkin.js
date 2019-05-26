const Skin = require('./Skin');

class BitmapSkin extends Skin {
    /**
     * Create a new Bitmap Skin.
     * @extends Skin
     * @param {!int} id - The ID for this Skin.
     * @param {!RenderCanvas} renderer - The renderer which will use this skin.
     */
    constructor (id, renderer) {
        super(id);

        /** @type {!int} */
        this._costumeResolution = 1;

        /** @type {!RenderCanvas} */
        this._renderer = renderer;

        /** @type {HTMLCanvasElement} */
        this._texture = document.createElement('canvas');
        this._ctx = this._texture.getContext('2d');

        /** @type {Array<int>} */
        this._textureSize = [0, 0];
    }

    /**
     * Dispose of this object. Do not use it after calling this method.
     */
    dispose () {
        if (this._texture) {
            this._texture = null;
        }
        super.dispose();
    }

    /**
     * @returns {boolean} true for a raster-style skin (like a BitmapSkin), false for vector-style (like SVGSkin).
     */
    get isRaster () {
        return true;
    }

    /**
     * @return {Array<number>} the "native" size, in texels, of this skin.
     */
    get size () {
        return [this._textureSize[0] / this._costumeResolution, this._textureSize[1] / this._costumeResolution];
    }

    /**
     * @return {Array<number>} the ratio of this skin's "native" size to its texture's size.
     */
    get sizeRatio () {
        return 0.5;
    }

    /**
     * @param {Array<number>} scale - The scaling factors to be used.
     * @return {WebGLTexture} The GL texture representation of this skin when drawing at the given scale.
     */
    // eslint-disable-next-line no-unused-vars
    getTexture (scale) {
        return this._texture;
    }

    /**
     * Get the bounds of the drawable for determining its fenced position.
     * @param {Array<number>} drawable - The Drawable instance this skin is using.
     * @return {!Rectangle} The drawable's bounds. For compatibility with Scratch 2, we always use getAABB for bitmaps.
     */
    getFenceBounds (drawable) {
        return drawable.getAABB();
    }

    /**
     * Set the contents of this skin to a snapshot of the provided bitmap data.
     * @param {ImageData|HTMLImageElement|HTMLCanvasElement|HTMLVideoElement} bitmapData - new contents for this skin.
     * @param {int} [costumeResolution=1] - The resolution to use for this bitmap.
     * @param {Array<number>} [rotationCenter] - Optional rotation center for the bitmap. If not supplied, it will be
     * calculated from the bounding box
     * @fires Skin.event:WasAltered
     */
    setBitmap (bitmapData, costumeResolution, rotationCenter) {
        // We can't just set our texture to bitmapData, because it may be changed/reused for loading other costumes.
        // Instead, we draw it to our own internal canvas.
        const texSize = BitmapSkin._getBitmapSize(bitmapData);
        this._texture.width = texSize[0];
        this._texture.height = texSize[1];

        this._ctx.clearRect(0, 0, texSize[0], texSize[1]);
        this._ctx.drawImage(bitmapData, 0, 0);

        this._silhouette.update(bitmapData);

        // Do these last in case any of the above throws an exception
        this._costumeResolution = costumeResolution || 2;
        this._textureSize = BitmapSkin._getBitmapSize(bitmapData);

        if (typeof rotationCenter === 'undefined') rotationCenter = this.calculateRotationCenter();
        this.setRotationCenter.apply(this, rotationCenter);

        this.emit(Skin.Events.WasAltered);
    }

    /**
     * @param {ImageData|HTMLImageElement|HTMLCanvasElement|HTMLVideoElement} bitmapData - bitmap data to inspect.
     * @returns {Array<int>} the width and height of the bitmap data, in pixels.
     * @private
     */
    static _getBitmapSize (bitmapData) {
        if (bitmapData instanceof HTMLImageElement) {
            return [bitmapData.naturalWidth || bitmapData.width, bitmapData.naturalHeight || bitmapData.height];
        }

        if (bitmapData instanceof HTMLVideoElement) {
            return [bitmapData.videoWidth || bitmapData.width, bitmapData.videoHeight || bitmapData.height];
        }

        // ImageData or HTMLCanvasElement
        return [bitmapData.width, bitmapData.height];
    }

}

module.exports = BitmapSkin;
