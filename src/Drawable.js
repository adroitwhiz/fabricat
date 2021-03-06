const matrix = require('gl-matrix');

const EffectTransform = require('./EffectTransform');
const Rectangle = require('./Rectangle');
const RenderConstants = require('./RenderConstants');
const EffectManager = require('./EffectManager');
const log = require('./util/log');

/**
 * An internal workspace for calculating texture locations from world vectors
 * this is REUSED for memory conservation reasons
 * @type {matrix.vec2}
 */
const __isTouchingPosition = matrix.vec2.create();
const __isTouchingVec = matrix.vec2.create();

/**
 * Convert a scratch space location into a texture space float.  Uses the
 * internal __isTouchingPosition as a return value, so this should be copied
 * if you ever need to get two local positions and store both.  Requires that
 * the drawable inverseMatrix is up to date.
 *
 * @param {Drawable} drawable The drawable to get the inverse matrix from
 * @param {matrix.vec2} vec [x,y] scratch space vector
 * @return {matrix.vec2} [x,y] texture space float vector - transformed by effects and matrix
 */
const getLocalPosition = (drawable, vec) => {
    // Transform from world coordinates to Drawable coordinates.
    const localPosition = __isTouchingPosition;
    const inverse = drawable._inverseMatrix;

    __isTouchingVec[0] = vec[0] + 0.5;
    __isTouchingVec[1] = vec[1] - 0.5;

    matrix.vec2.transformMat2d(localPosition, __isTouchingVec, inverse);

    const skinSize = drawable.skin.size;
    const skinRatio = drawable.skin.sizeRatio;
    localPosition[0] /= (skinSize[0] * skinRatio);
    localPosition[1] /= (skinSize[1] * skinRatio);

    // Apply texture effect transform if the localPosition is within the drawable's space.
    // Disable this for now because distortion effects are not implemented
    /* if (drawable.enabledEffects !== 0 &&
        (localPosition[0] >= 0 && localPosition[0] < 1) &&
        (localPosition[1] >= 0 && localPosition[1] < 1)
    ) {
        EffectTransform.transformPoint(drawable, localPosition, localPosition);
    }*/
    return localPosition;
};

class Drawable {
    /**
     * An object which can be drawn by the renderer.
     * @param {!int} id - This Drawable's unique ID.
     * @param {!RenderCanvas} renderer - The renderer which will use this skin.
     * @constructor
     */
    constructor (id, renderer) {
        /** @type {!int} */
        this._id = id;

        this._renderer = renderer;

        this.transformMatrix = matrix.mat2d.create();

        this._effects = {};

        const numEffects = EffectManager.EFFECTS.length;
        for (let index = 0; index < numEffects; ++index) {
            const effectName = EffectManager.EFFECTS[index];
            const effectInfo = EffectManager.EFFECT_INFO[effectName];
            const converter = effectInfo.converter;
            this._effects[effectInfo.effectName] = converter(0);
        }

        this._position = matrix.vec2.create();
        this._scale = matrix.vec2.fromValues(100, 100);
        this._direction = 90;
        this._transformDirty = true;
        this._rotationMatrix = matrix.mat2d.create();
        this._rotationTransformDirty = true;
        this._rotationCenter = matrix.vec2.create();
        this._rotationCenterDirty = true;
        this._skinScale = matrix.vec2.create();
        this._skinScaleDirty = true;
        this._inverseMatrix = matrix.mat2d.create();
        this._inverseTransformDirty = true;
        this._visible = true;

        /** A bitmask identifying which effects are currently in use.
         * @readonly
         * @type {int} */
        this.enabledEffects = 0;

        this._aabbPoints = [
            matrix.vec2.create(),
            matrix.vec2.create(),
            matrix.vec2.create(),
            matrix.vec2.create()
        ];
        this._transformedAABBPoints = [
            matrix.vec2.create(),
            matrix.vec2.create(),
            matrix.vec2.create(),
            matrix.vec2.create()
        ];
        this._aabbDirty = true;
        this._aabb = new Rectangle();

        /** @todo move convex hull functionality, maybe bounds functionality overall, to Skin classes */
        this._convexHullPoints = null;
        this._transformedHullPoints = null;
        this._convexHullDirty = true;
        this._convexHullMatrix = matrix.mat2d.create();

        // The precise bounding box will be from the transformed convex hull points,
        // so initialize the array of transformed hull points in setConvexHullPoints.
        // Initializing it once per convex hull recalculation avoids unnecessary creation of objects.
        this._transformedHullPoints = null;
        this._transformedHullDirty = true;

        this._skinWasAltered = this._skinWasAltered.bind(this);

        this.isTouching = this._isTouchingNever;
    }

    /**
     * Dispose of this Drawable. Do not use it after calling this method.
     */
    dispose () {
        // Use the setter: disconnect events
        this.skin = null;
    }

    /**
     * Mark this Drawable's transform as dirty.
     * It will be recalculated next time it's needed.
     */
    setTransformDirty () {
        this._transformDirty = true;
        this._inverseTransformDirty = true;
        this._transformedHullDirty = true;
    }

    /**
     * @returns {number} The ID for this Drawable.
     */
    get id () {
        return this._id;
    }

    /**
     * @returns {Skin} the current skin for this Drawable.
     */
    get skin () {
        return this._skin;
    }

    /**
     * @param {Skin} newSkin - A new Skin for this Drawable.
     */
    set skin (newSkin) {
        if (this._skin !== newSkin) {
            this._skin = newSkin;
            this._skinWasAltered();
        }
    }

    /**
     * @returns {Array<number>} the current scaling percentages applied to this Drawable. [100,100] is normal size.
     */
    get scale () {
        return [this._scale[0], this._scale[1]];
    }

    getTransform () {
        if (this._transformDirty) {
            this._calculateTransform();
        }
        return this.transformMatrix;
    }

    /**
     * @returns {boolean} whether this Drawable is visible.
     */
    getVisible () {
        return this._visible;
    }

    /**
     * Update the position if it is different. Marks the transform as dirty.
     * @param {Array.<number>} position A new position.
     */
    updatePosition (position) {
        if (this._position[0] !== position[0] ||
            this._position[1] !== position[1]) {
            this._position[0] = Math.round(position[0]);
            this._position[1] = Math.round(position[1]);
            this.setTransformDirty();
        }
    }

    /**
     * Update the direction if it is different. Marks the transform as dirty.
     * @param {number} direction A new direction.
     */
    updateDirection (direction) {
        if (this._direction !== direction) {
            this._direction = direction;
            this._rotationTransformDirty = true;
            this.setTransformDirty();
        }
    }

    /**
     * Update the scale if it is different. Marks the transform as dirty.
     * @param {Array.<number>} scale A new scale.
     */
    updateScale (scale) {
        if (this._scale[0] !== scale[0] ||
            this._scale[1] !== scale[1]) {
            this._scale[0] = scale[0];
            this._scale[1] = scale[1];
            this._rotationCenterDirty = true;
            this._skinScaleDirty = true;
            this.setTransformDirty();
        }
    }

    /**
     * Update visibility if it is different. Marks the convex hull as dirty.
     * @param {boolean} visible A new visibility state.
     */
    updateVisible (visible) {
        if (this._visible !== visible) {
            this._visible = visible;
            this.setConvexHullDirty();
        }
    }

    /**
     * Update an effect. Marks the convex hull as dirty if the effect changes shape.
     * @param {string} effectName The name of the effect.
     * @param {number} rawValue A new effect value.
     */
    updateEffect (effectName, rawValue) {
        const effectInfo = EffectManager.EFFECT_INFO[effectName];
        if (rawValue) {
            this.enabledEffects |= effectInfo.mask;
        } else {
            this.enabledEffects &= ~effectInfo.mask;
        }
        const converter = effectInfo.converter;
        this._effects[effectInfo.effectName] = converter(rawValue);
        if (effectInfo.shapeChanges) {
            this.setConvexHullDirty();
        }
    }

    /**
     * Calculate the transform to use when rendering this Drawable.
     * @private
     */
    _calculateTransform () {
        if (this._rotationTransformDirty) {
            const rotation = (90 - this._direction) * Math.PI / 180;

            const c = Math.cos(rotation);
            const s = Math.sin(rotation);
            this._rotationMatrix[0] = c;
            this._rotationMatrix[1] = s;
            this._rotationMatrix[2] = -s;
            this._rotationMatrix[3] = c;

            this._rotationTransformDirty = false;
        }

        // Adjust rotation center relative to the skin.
        if (this._rotationCenterDirty && this.skin !== null) {
            const sizeRatio = this.skin.sizeRatio;

            const skinCenter = this.skin.rotationCenter;
            const center0 = skinCenter[0];
            const center1 = skinCenter[1];
            const rotationCenter = this._rotationCenter;
            rotationCenter[0] = center0 * sizeRatio;
            rotationCenter[1] = center1 * sizeRatio;

            this._rotationCenterDirty = false;
        }

        if (this._skinScaleDirty && this.skin !== null) {
            const sizeRatio = this.skin.sizeRatio;

            this._skinScale[0] = (this._scale[0] * 0.01) / sizeRatio;
            this._skinScale[1] = (this._scale[1] * -0.01) / sizeRatio;

            this._skinScaleDirty = false;
        }

        const position = this._position;
        const rotationCenter = this._rotationCenter;
        const center0 = rotationCenter[0];
        const center1 = rotationCenter[1];
        const scale = this._skinScale;
        const scale0 = scale[0];
        const scale1 = scale[1];

        const transformMatrix = this.transformMatrix;

        transformMatrix[0] = this._rotationMatrix[0] * scale0;
        transformMatrix[1] = this._rotationMatrix[1] * scale0;
        transformMatrix[2] = this._rotationMatrix[2] * scale1;
        transformMatrix[3] = this._rotationMatrix[3] * scale1;
        transformMatrix[4] = (transformMatrix[0] * -center0) + (transformMatrix[2] * -center1) + position[0];
        transformMatrix[5] = (transformMatrix[1] * -center0) + (transformMatrix[3] * -center1) + position[1];

        this._transformDirty = false;
    }

    /**
     * Whether the Drawable needs convex hull points provided by the renderer.
     * @return {boolean} True when no convex hull known, or it's dirty.
     */
    needsConvexHullPoints () {
        return !this._convexHullPoints || this._convexHullDirty || this._convexHullPoints.length === 0;
    }

    /**
     * Set the convex hull to be dirty.
     * Do this whenever the Drawable's shape has possibly changed.
     */
    setConvexHullDirty () {
        this._convexHullDirty = true;
    }

    /**
     * Set the AABB to be dirty.
     * Do this whenever the Drawable's shape has possibly changed.
     */
    setAABBDirty () {
        this._AABBDirty = true;
    }

    /**
     * Set the convex hull points for the Drawable.
     * @param {Array<Array<number>>} points Convex hull points, as [[x, y], ...]
     */
    setConvexHullPoints (points) {
        this._convexHullPoints = points;
        this._convexHullDirty = false;

        // Re-create the "transformed hull points" array.
        // We only do this when the hull points change to avoid unnecessary allocations and GC.
        this._transformedHullPoints = [];
        for (let i = 0; i < points.length; i++) {
            this._transformedHullPoints.push(matrix.vec2.create());
        }
        this._transformedHullDirty = true;
    }

    /**
     * @function
     * @name isTouching
     * Check if the world position touches the skin.
     * The caller is responsible for ensuring this drawable's inverse matrix & its skin's silhouette are up-to-date.
     * @see updateCPURenderAttributes
     * @param {matrix.vec2} vec World coordinate vector.
     * @return {boolean} True if the world position touches the skin.
     */

    // `updateCPURenderAttributes` sets this Drawable instance's `isTouching` method
    // to one of the following three functions:
    // If this drawable has no skin, set it to `_isTouchingNever`.
    // Otherwise, if this drawable uses nearest-neighbor scaling at its current scale, set it to `_isTouchingNearest`.
    // Otherwise, set it to `_isTouchingLinear`.
    // This allows several checks to be moved from the `isTouching` function to `updateCPURenderAttributes`.

    // eslint-disable-next-line no-unused-vars
    _isTouchingNever (vec) {
        return false;
    }

    _isTouchingNearest (vec) {
        return this.skin.isTouchingNearest(getLocalPosition(this, vec));
    }

    _isTouchingLinear (vec) {
        return this.skin.isTouchingLinear(getLocalPosition(this, vec));
    }

    /**
     * Get the precise bounds for a Drawable.
     * This function applies the transform matrix to the known convex hull,
     * and then finds the minimum box along the axes.
     * Before calling this, ensure the renderer has updated convex hull points.
     * @return {!Rectangle} Bounds for a tight box around the Drawable.
     */
    getBounds () {
        if (this.needsConvexHullPoints()) {
            throw new Error('Needs updated convex hull points before bounds calculation.');
        }
        if (this._transformDirty) {
            this._calculateTransform();
        }
        const transformedHullPoints = this._getTransformedHullPoints();
        // Search through transformed points to generate box on axes.
        const bounds = new Rectangle();
        bounds.initFromPointsAABB(transformedHullPoints);
        return bounds;
    }

    /**
     * Get the precise bounds for the upper 8px slice of the Drawable.
     * Used for calculating where to position a text bubble.
     * Before calling this, ensure the renderer has updated convex hull points.
     * @return {!Rectangle} Bounds for a tight box around a slice of the Drawable.
     */
    getBoundsForBubble () {
        if (this.needsConvexHullPoints()) {
            throw new Error('Needs updated convex hull points before bubble bounds calculation.');
        }
        if (this._transformDirty) {
            this._calculateTransform();
        }
        const slice = 8; // px, how tall the top slice to measure should be.
        const transformedHullPoints = this._getTransformedHullPoints();
        const maxY = Math.max.apply(null, transformedHullPoints.map(p => p[1]));
        const filteredHullPoints = transformedHullPoints.filter(p => p[1] > maxY - slice);
        // Search through filtered points to generate box on axes.
        const bounds = new Rectangle();
        bounds.initFromPointsAABB(filteredHullPoints);
        return bounds;
    }

    /**
     * Get the rough axis-aligned bounding box for the Drawable.
     * Calculated by transforming the skin's bounds.
     * Note that this is less precise than the box returned by `getBounds`,
     * which is tightly snapped to account for a Drawable's transparent regions.
     * `getAABB` returns a much less accurate bounding box, but will be much
     * faster to calculate so may be desired for quick checks/optimizations.
     * @return {!Rectangle} Rough axis-aligned bounding box for Drawable.
     */
    getAABB () {
        if (this._transformDirty) {
            this._calculateTransform();
        }
        if (this._AABBDirty) {
            const skin = this.skin;
            const size0 = skin.size[0] * skin.sizeRatio;
            const size1 = skin.size[1] * skin.sizeRatio;
            matrix.vec2.set(this._aabbPoints[1], size0, 0);
            matrix.vec2.set(this._aabbPoints[2], size0, size1);
            matrix.vec2.set(this._aabbPoints[3], 0, size1);
        }

        const tm = this.transformMatrix;
        const bounds = this._aabb;
        const aabbPoints = this._aabbPoints;
        const transformedPoints = this._transformedAABBPoints;

        matrix.vec2.transformMat2d(transformedPoints[0], aabbPoints[0], tm);
        matrix.vec2.transformMat2d(transformedPoints[1], aabbPoints[1], tm);
        matrix.vec2.transformMat2d(transformedPoints[2], aabbPoints[2], tm);
        matrix.vec2.transformMat2d(transformedPoints[3], aabbPoints[3], tm);

        bounds.initFromPointsAABB(transformedPoints);
        return bounds;
    }

    /**
     * Return the best Drawable bounds possible without performing graphics queries.
     * I.e., returns the tight bounding box when the convex hull points are already
     * known, but otherwise return the rough AABB of the Drawable.
     * @return {!Rectangle} Bounds for the Drawable.
     */
    getFastBounds () {
        if (!this.needsConvexHullPoints()) {
            return this.getBounds();
        }
        return this.getAABB();
    }

    /**
     * Transform all the convex hull points by the current Drawable's
     * transform. This allows us to skip recalculating the convex hull
     * for many Drawable updates, including translation, rotation, scaling.
     * @return {!Array.<!Array.number>} Array of glPoints which are Array<x, y>
     * @private
     */
    _getTransformedHullPoints () {
        if (!this._transformedHullDirty) {
            return this._transformedHullPoints;
        }

        matrix.mat2d.scale(
            this._convexHullMatrix,
            this.transformMatrix,
            [this.skin.sizeRatio, this.skin.sizeRatio]
        );

        for (let i = 0; i < this._convexHullPoints.length; i++) {
            matrix.vec2.transformMat2d(
                this._transformedHullPoints[i],
                this._convexHullPoints[i],
                this._convexHullMatrix
            );
        }

        this._transformedHullDirty = false;

        return this._transformedHullPoints;
    }

    /**
     * Update the transform matrix and calculate it's inverse for collision
     * and local texture position purposes.
     */
    updateMatrix () {
        if (this._transformDirty) {
            this._calculateTransform();
        }
        // Get the inverse of the model matrix or update it.
        if (this._inverseTransformDirty) {
            const inverse = this._inverseMatrix;
            matrix.mat2d.invert(inverse, this.transformMatrix);
            this._inverseTransformDirty = false;
        }
    }

    /**
     * Update everything necessary to render this drawable on the CPU.
     */
    updateCPURenderAttributes () {
        this.updateMatrix();
        // CPU rendering always occurs at the "native" size, so no need to scale up this._scale
        if (this.skin) {
            this.skin.updateSilhouette(this._scale);

            if (this.skin.useNearest(this._scale, this)) {
                this.isTouching = this._isTouchingNearest;
            } else {
                this.isTouching = this._isTouchingLinear;
            }
        } else {
            log.warn(`Could not find skin for drawable with id: ${this._id}`);

            this.isTouching = this._isTouchingNever;
        }
    }

    /**
     * Respond to an internal change in the current Skin.
     * @private
     */
    _skinWasAltered () {
        this._rotationCenterDirty = true;
        this._skinScaleDirty = true;
        this.setConvexHullDirty();
        this.setAABBDirty();
        this.setTransformDirty();
    }

    /**
     * Calculate a color to represent the given ID number. At least one component of
     * the resulting color will be non-zero if the ID is not RenderConstants.ID_NONE.
     * @param {int} id The ID to convert.
     * @returns {Array<number>} An array of [r,g,b,a], each component in the range [0,1].
     */
    static color4fFromID (id) {
        id -= RenderConstants.ID_NONE;
        const r = ((id >> 0) & 255) / 255.0;
        const g = ((id >> 8) & 255) / 255.0;
        const b = ((id >> 16) & 255) / 255.0;
        return [r, g, b, 1.0];
    }

    /**
     * Calculate the ID number represented by the given color. If all components of
     * the color are zero, the result will be RenderConstants.ID_NONE; otherwise the result
     * will be a valid ID.
     * @param {int} r The red value of the color, in the range [0,255].
     * @param {int} g The green value of the color, in the range [0,255].
     * @param {int} b The blue value of the color, in the range [0,255].
     * @returns {int} The ID represented by that color.
     */
    static color3bToID (r, g, b) {
        let id;
        id = (r & 255) << 0;
        id |= (g & 255) << 8;
        id |= (b & 255) << 16;
        return id + RenderConstants.ID_NONE;
    }

    /**
     * Sample a color from a drawable's texture.
     * The caller is responsible for ensuring this drawable's inverse matrix & its skin's silhouette are up-to-date.
     * @see updateCPURenderAttributes
     * @param {matrix.vec2} vec The scratch space [x,y] vector
     * @param {Drawable} drawable The drawable to sample the texture from
     * @param {Uint8ClampedArray} dst The "color4b" representation of the texture at point.
     * @param {number} [effectMask] A bitmask for which effects to use. Optional.
     * @returns {Uint8ClampedArray} The dst object filled with the color4b
     */
    static sampleColor4b (vec, drawable, dst, effectMask) {
        const localPosition = getLocalPosition(drawable, vec);

        if (localPosition[0] < 0 || localPosition[1] < 0 ||
            localPosition[0] > 1 || localPosition[1] > 1) {
            dst[0] = 0;
            dst[1] = 0;
            dst[2] = 0;
            dst[3] = 0;
            return dst;
        }

        const textColor =
        // commenting out to only use nearest for now
        // drawable.skin.useNearest(drawable._scale, drawable) ?
             drawable.skin._silhouette.colorAtNearest(localPosition, dst);
        // : drawable.skin._silhouette.colorAtLinear(localPosition, dst);

        if (drawable.enabledEffects === 0) return textColor;
        return EffectTransform.transformColor(drawable, textColor, effectMask);
    }
}

module.exports = Drawable;
