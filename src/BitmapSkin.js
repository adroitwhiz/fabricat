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

        /** @type {Array<int>} */
        this.size = [0, 0];
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
     * @return {Array<number>} the ratio of this skin's texture size to its native size.
     */
    get sizeRatio () {
        return 2;
    }

    /**
     * @param {Array<number>} scale - The scaling factors to be used.
     * @return {HTMLCanvasElement} The texture of this skin when drawing at the given scale.
     */
    // eslint-disable-next-line no-unused-vars
    getTexture (scale) {
        return this._texture || super.getTexture();
    }

    /**
     * Set the contents of this skin to a snapshot of the provided bitmap data.
     * @param {ImageData|HTMLImageElement|HTMLCanvasElement|HTMLVideoElement} bitmapData - new contents for this skin.
     * @param {int} [costumeResolution=2] - The resolution to use for this bitmap.
     * @param {Array<number>} [rotationCenter] - Optional rotation center for the bitmap. If not supplied, it will be
     * calculated from the bounding box
     * @fires Skin.event:WasAltered
     */
    setBitmap (bitmapData, costumeResolution = 2, rotationCenter) {
        if (!bitmapData.width || !bitmapData.height) {
            super.setEmptyImageData();
            return;
        }

        // We can't just set our texture to bitmapData, because it may be changed/reused for loading other costumes.
        // Instead, we draw it to our own internal canvas.
        const texSize = BitmapSkin._getBitmapSize(bitmapData);
        this._texture.width = texSize[0];
        this._texture.height = texSize[1];

        this._ctx.clearRect(0, 0, texSize[0], texSize[1]);
        this._ctx.drawImage(bitmapData, 0, 0);

        this._silhouette.update(this._texture);

        // Do these last in case any of the above throws an exception
        this._textureSize = texSize;

        this.size[0] = this._textureSize[0] / costumeResolution;
        this.size[1] = this._textureSize[1] / costumeResolution;

        if (typeof rotationCenter === 'undefined') rotationCenter = this.calculateRotationCenter();
        this._rotationCenter[0] = rotationCenter[0];
        this._rotationCenter[1] = rotationCenter[1];

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
