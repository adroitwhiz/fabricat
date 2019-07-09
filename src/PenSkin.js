const matrix = require('gl-matrix');

const RenderConstants = require('./RenderConstants');
const Skin = require('./Skin');

/**
 * Attributes to use when drawing with the pen
 * @typedef {object} PenSkin#PenAttributes
 * @property {number} [diameter] - The size (diameter) of the pen.
 * @property {Array<number>} [color4f] - The pen color as an array of [r,g,b,a], each component in the range [0,1].
 */

/**
 * The pen attributes to use when unspecified.
 * @type {PenSkin#PenAttributes}
 * @memberof PenSkin
 * @private
 * @const
 */
const DefaultPenAttributes = {
    color4f: [0, 0, 1, 1],
    diameter: 1
};

class PenSkin extends Skin {
    /**
     * Create a Skin which implements a Scratch pen layer.
     * @param {int} id - The unique ID for this Skin.
     * @param {RenderCanvas} renderer - The renderer which will use this Skin.
     * @extends Skin
     * @listens RenderCanvas#event:NativeSizeChanged
     */
    constructor (id, renderer) {
        super(id);

        /**
         * @private
         * @type {RenderCanvas}
         */
        this._renderer = renderer;

        /** @type {HTMLCanvasElement} */
        this._canvas = document.createElement('canvas');

        /** @type {CanvasRenderingContext2D} */
        this._ctx = this._canvas.getContext('2d');

        /** @type {Array<number>} */
        this.size = matrix.vec2.create();

        /** @type {boolean} */
        this._silhouetteDirty = false;
        
        this.onNativeSizeChanged = this.onNativeSizeChanged.bind(this);
        this._renderer.on(RenderConstants.Events.NativeSizeChanged, this.onNativeSizeChanged);

        this._setCanvasSize(renderer.getNativeSize());
    }

    /**
     * Dispose of this object. Do not use it after calling this method.
     */
    dispose () {
        this._renderer.removeListener(RenderConstants.Events.NativeSizeChanged, this.onNativeSizeChanged);
        super.dispose();
    }

    /**
     * @returns {boolean} true for a raster-style skin (like a BitmapSkin), false for vector-style (like SVGSkin).
     */
    get isRaster () {
        return true;
    }

    /**
     * @return {HTMLCanvasElement} a draw-able canvas of this pen skin
     */
    getTexture () {
        return this._canvas;
    }

    /**
     * Clear the pen layer.
     */
    clear () {
        this._ctx.clearRect(0, 0, this.size[0], this.size[1]);
        this._silhouetteDirty = true;
    }

    /**
     * Draw a point on the pen layer.
     * @param {PenAttributes} penAttributes - how the point should be drawn.
     * @param {number} x - the X coordinate of the point to draw.
     * @param {number} y - the Y coordinate of the point to draw.
     */
    drawPoint (penAttributes, x, y) {
        // Canvas renders a zero-length line as two end-caps back-to-back, which is what we want.
        this.drawLine(penAttributes, x, y, x, y);
    }

    /**
     * Draw a line on the pen layer.
     * @param {PenAttributes} penAttributes - how the line should be drawn.
     * @param {number} x0 - the X coordinate of the beginning of the line.
     * @param {number} y0 - the Y coordinate of the beginning of the line.
     * @param {number} x1 - the X coordinate of the end of the line.
     * @param {number} y1 - the Y coordinate of the end of the line.
     */
    drawLine (penAttributes, x0, y0, x1, y1) {
        const ctx = this._ctx;
        this._setAttributes(ctx, penAttributes);

        // Width 1 and 3 lines need to be offset by 0.5.
        const diameter = penAttributes.diameter || DefaultPenAttributes.diameter;
        const offset = (Math.max(4 - diameter, 0) % 2) / 2;
        ctx.beginPath();
        ctx.moveTo(this._rotationCenter[0] + x0 + offset, this._rotationCenter[1] - y0 + offset);
        ctx.lineTo(this._rotationCenter[0] + x1 + offset, this._rotationCenter[1] - y1 + offset);
        ctx.stroke();
        this._silhouetteDirty = true;
    }

    /**
     * React to a change in the renderer's native size.
     * @param {object} event - The change event.
     */
    onNativeSizeChanged (event) {
        this._setCanvasSize(event.newSize);
    }

    /**
     * Set the size of the pen canvas.
     * @param {Array<int>} canvasSize - the new width and height for the canvas.
     * @private
     */
    _setCanvasSize (canvasSize) {
        const [width, height] = canvasSize;

        this._canvas.width = this.size[0] = width;
        this._canvas.height = this.size[1] = height;
        this._rotationCenter[0] = width / 2;
        this._rotationCenter[1] = height / 2;
        this._silhouetteDirty = true;
    }

    /**
     * Set context state to match provided pen attributes.
     * @param {CanvasRenderingContext2D} context - the canvas rendering context to be modified.
     * @param {PenAttributes} penAttributes - the pen attributes to be used.
     * @private
     */
    _setAttributes (context, penAttributes) {
        penAttributes = penAttributes || DefaultPenAttributes;
        const color4f = penAttributes.color4f || DefaultPenAttributes.color4f;
        const diameter = penAttributes.diameter || DefaultPenAttributes.diameter;

        const r = Math.round(color4f[0] * 255);
        const g = Math.round(color4f[1] * 255);
        const b = Math.round(color4f[2] * 255);
        const a = color4f[3]; // Alpha is 0 to 1 (not 0 to 255 like r,g,b)

        context.strokeStyle = `rgba(${r},${g},${b},${a})`;
        context.lineCap = 'round';
        context.lineWidth = diameter;
    }

    /**
     * If there have been pen operations that have dirtied the canvas, update
     * now before someone wants to use our silhouette.
     */
    updateSilhouette () {
        if (this._silhouetteDirty) {
            this._silhouette.update(this._ctx.getImageData(0, 0, this.size[0], this.size[1]));
        }
    }
}

module.exports = PenSkin;
