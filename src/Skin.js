const EventEmitter = require('events');

const matrix = require('gl-matrix');

const RenderConstants = require('./RenderConstants');
const Silhouette = require('./Silhouette');

/**
 * Truncate a number into what could be stored in a 32 bit floating point value.
 * @param {number} num Number to truncate.
 * @return {number} Truncated value.
 */
const toFloat32 = (function () {
    const memory = new Float32Array(1);
    return function (num) {
        memory[0] = num;
        return memory[0];
    };
}());

class Skin extends EventEmitter {
    /**
     * Create a Skin, which stores and/or generates textures for use in rendering.
     * @param {int} id - The unique ID for this Skin.
     * @constructor
     */
    constructor (id) {
        super();

        /** @type {int} */
        this._id = id;

        /** @type {Vec2} */
        this._rotationCenter = matrix.vec2.create();

        /**
         * A silhouette to store touching data, skins are responsible for keeping it up to date.
         * @private
         */
        this._silhouette = new Silhouette();

        this.setMaxListeners(RenderConstants.SKIN_SHARE_SOFT_LIMIT);
    }

    /**
     * Dispose of this object. Do not use it after calling this method.
     */
    dispose () {
        this._id = RenderConstants.ID_NONE;
    }

    /**
     * @returns {boolean} true for a raster-style skin (like a BitmapSkin), false for vector-style (like SVGSkin).
     */
    get isRaster () {
        return false;
    }

    /**
     * @returns {boolean} true if alpha is premultiplied, false otherwise
     */
    get hasPremultipliedAlpha () {
        return false;
    }

    /**
     * @return {int} the unique ID for this Skin.
     */
    get id () {
        return this._id;
    }

    /**
     * @returns {Vec3} the origin, in object space, about which this Skin should rotate.
     */
    get rotationCenter () {
        return this._rotationCenter;
    }

    /**
     * @abstract
     * @return {Array<number>} the "native" size, in texels, of this skin.
     */
    get size () {
        return [0, 0];
    }

    /**
     * @return {Array<number>} the ratio of this skin's "native" size to its texture's size.
     */
    get sizeRatio () {
        return 1;
    }

    /**
     * Set the origin, in object space, about which this Skin should rotate.
     * @param {number} x - The x coordinate of the new rotation center.
     * @param {number} y - The y coordinate of the new rotation center.
     * @fires Skin.event:WasAltered
     */
    setRotationCenter (x, y) {
        const emptySkin = this.size[0] === 0 && this.size[1] === 0;
        // Compare a 32 bit x and y value against the stored 32 bit center
        // values.
        const changed = (
            toFloat32(x) !== this._rotationCenter[0] ||
            toFloat32(y) !== this._rotationCenter[1]);
        if (!emptySkin && changed) {
            this._rotationCenter[0] = x;
            this._rotationCenter[1] = y;
            this.emit(Skin.Events.WasAltered);
        }
    }

    /**
     * Get the center of the current bounding box
     * @return {Array<number>} the center of the current bounding box
     */
    calculateRotationCenter () {
        return [this.size[0] / 2, this.size[1] / 2];
    }

    /**
     * @abstract
     * @param {Array<number>} scale - The scaling factors to be used.
     * @return {HTMLCanvasElement} The texture of this skin when drawing at the given size.
     */
    // eslint-disable-next-line no-unused-vars
    getTexture (scale) {
        return null;
    }

    /**
     * Get the bounds of the drawable for determining its fenced position.
     * @param {Array<number>} drawable - The Drawable instance this skin is using.
     * @return {!Rectangle} The drawable's bounds.
     */
    getFenceBounds (drawable) {
        return drawable.getFastBounds();
    }

    /**
     * If the skin defers silhouette operations until the last possible minute,
     * this will be called before isTouching uses the silhouette.
     * @abstract
     */
    updateSilhouette () {}

    /**
     * Does this point touch an opaque or translucent point on this skin?
     * Nearest Neighbor version
     * @param {matrix.vec2} vec A texture coordinate.
     * @return {boolean} Did it touch?
     */
    isTouchingNearest (vec) {
        return this._silhouette.isTouchingNearest(vec);
    }

    /**
     * Does this point touch an opaque or translucent point on this skin?
     * Linear Interpolation version
     * @param {matrix.vec2} vec A texture coordinate.
     * @return {boolean} Did it touch?
     */
    isTouchingLinear (vec) {
        return this._silhouette.isTouchingLinear(vec);
    }

}

/**
 * These are the events which can be emitted by instances of this class.
 * @enum {string}
 */
Skin.Events = {
    /**
     * Emitted when anything about the Skin has been altered, such as the appearance or rotation center.
     * @event Skin.event:WasAltered
     */
    WasAltered: 'WasAltered'
};

module.exports = Skin;
