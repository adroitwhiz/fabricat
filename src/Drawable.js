const twgl = require('twgl.js');
const matrix = require('gl-matrix');

const Rectangle = require('./Rectangle');
const RenderConstants = require('./RenderConstants');
const ShaderManager = require('./ShaderManager');
const Skin = require('./Skin');

/**
 * An internal workspace for calculating texture locations from world vectors
 * this is REUSED for memory conservation reasons
 * @type {twgl.v3}
 */
const __isTouchingPosition = matrix.vec2.create();

/**
 * Convert a scratch space location into a texture space float.  Uses the
 * internal __isTouchingPosition as a return value, so this should be copied
 * if you ever need to get two local positions and store both.  Requires that
 * the drawable inverseMatrix is up to date.
 *
 * @param {Drawable} drawable The drawable to get the inverse matrix and uniforms from
 * @param {twgl.v3} vec [x,y] scratch space vector
 * @return {twgl.v3} [x,y] texture space float vector - transformed by effects and matrix
 */
const getLocalPosition = (drawable, vec) => {
    // Transfrom from world coordinates to Drawable coordinates.
    const localPosition = __isTouchingPosition;
    const v0 = vec[0];
    const v1 = vec[1];
    const m = drawable._inverseMatrix;
    // var v2 = v[2];
    const d = (v0 * m[3]) + (v1 * m[7]) + m[15];
    // The RenderCanvas quad flips the texture's X axis. So rendered bottom
    // left is 1, 0 and the top right is 0, 1. Flip the X axis so
    // localPosition matches that transformation.
    localPosition[0] = 0.5 - (((v0 * m[0]) + (v1 * m[4]) + m[12]) / d);
    localPosition[1] = (((v0 * m[1]) + (v1 * m[5]) + m[13]) / d) + 0.5;

    matrix.vec2.transformMat2d(localPosition, vec, m);

    const skinSize = drawable.skin.size;
    const skinRatio = drawable.skin.sizeRatio;
    localPosition[0] /= (skinSize[0] / skinRatio[0]);
    localPosition[1] /= (skinSize[1] / skinRatio[1]);

    // Apply texture effect transform if the localPosition is within the drawable's space.
    // Disabled for now because effects aren't implemented.
    /* if ((localPosition[0] >= 0 && localPosition[0] < 1) && (localPosition[1] >= 0 && localPosition[1] < 1)) {
        EffectTransform.transformPoint(drawable, localPosition, localPosition);
    } */
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

        /**
         * The uniforms to be used by the vertex and pixel shaders.
         * Some of these are used by other parts of the renderer as well.
         * @type {Object.<string,*>}
         * @private
         */
        this._uniforms = {
            /**
             * The model matrix, to concat with projection at draw time.
             * @type {module:twgl/m4.Mat4}
             */
            u_modelMatrix: twgl.m4.identity(),

            /**
             * The color to use in the silhouette draw mode.
             * @type {Array<number>}
             */
            u_silhouetteColor: Drawable.color4fFromID(this._id)
        };

        // Effect values are uniforms too
        const numEffects = ShaderManager.EFFECTS.length;
        for (let index = 0; index < numEffects; ++index) {
            const effectName = ShaderManager.EFFECTS[index];
            const effectInfo = ShaderManager.EFFECT_INFO[effectName];
            const converter = effectInfo.converter;
            this._uniforms[effectInfo.uniformName] = converter(0);
        }

        this._position = matrix.vec2.create();
        this._scale = matrix.vec2.fromValues(100, 100);
        this._direction = 90;
        this._transformDirty = true;
        this._translationMatrix = matrix.mat2d.create();
        this._scaleMatrix = matrix.mat2d.create();
        this._rotationMatrix = matrix.mat2d.create();
        this._rotationTransformDirty = true;
        this._rotationCenter = matrix.vec2.create();
        this._rotationCenterDirty = true;
        this._skinScale = matrix.vec2.create();
        this._skinScaleDirty = true;
        this._inverseMatrix = matrix.mat2d.create();
        this._inverseTransformDirty = true;
        this._visible = true;
        this._effectBits = 0;

        this._boundsMatrix = matrix.mat2d.create();

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
        this._preciseBounds = new Rectangle();

        this._skinWasAltered = this._skinWasAltered.bind(this);
    }

    /**
     * Draw this drawable to the renderer's canvas.
     */
    draw () {

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
            if (this._skin) {
                this._skin.removeListener(Skin.Events.WasAltered, this._skinWasAltered);
            }
            this._skin = newSkin;
            if (this._skin) {
                this._skin.addListener(Skin.Events.WasAltered, this._skinWasAltered);
            }
            this._skinWasAltered();
        }
    }

    /**
     * @returns {Array<number>} the current scaling percentages applied to this Drawable. [100,100] is normal size.
     */
    get scale () {
        return [this._scale[0], this._scale[1]];
    }

    /**
     * @returns {int} A bitmask identifying which effects are currently in use.
     */
    getEnabledEffects () {
        return this._effectBits;
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
     * Update the position, direction, scale, or effect properties of this Drawable.
     * @param {object.<string,*>} properties The new property values to set.
     */
    updateProperties (properties) {
        let dirty = false;
        if ('position' in properties && (
            this._position[0] !== properties.position[0] ||
            this._position[1] !== properties.position[1])) {
            this._position[0] = Math.round(properties.position[0]);
            this._position[1] = Math.round(properties.position[1]);
            dirty = true;
        }
        if ('direction' in properties && this._direction !== properties.direction) {
            this._direction = properties.direction;
            this._rotationTransformDirty = true;
            dirty = true;
        }
        if ('scale' in properties && (
            this._scale[0] !== properties.scale[0] ||
            this._scale[1] !== properties.scale[1])) {
            this._scale[0] = properties.scale[0];
            this._scale[1] = properties.scale[1];
            this._rotationCenterDirty = true;
            this._skinScaleDirty = true;
            dirty = true;
        }
        if ('visible' in properties) {
            this._visible = properties.visible;
            this.setConvexHullDirty();
        }
        if (dirty) {
            this.setTransformDirty();
        }
        const numEffects = ShaderManager.EFFECTS.length;
        for (let index = 0; index < numEffects; ++index) {
            const effectName = ShaderManager.EFFECTS[index];
            if (effectName in properties) {
                const rawValue = properties[effectName];
                const effectInfo = ShaderManager.EFFECT_INFO[effectName];
                if (rawValue) {
                    this._effectBits |= effectInfo.mask;
                } else {
                    this._effectBits &= ~effectInfo.mask;
                }
                const converter = effectInfo.converter;
                this._uniforms[effectInfo.uniformName] = converter(rawValue);
                if (effectInfo.shapeChanges) {
                    this.setConvexHullDirty();
                }
            }
        }
    }

    /**
     * Calculate the transform to use when rendering this Drawable.
     * @private
     */
    _calculateTransform () {
        if (this._rotationTransformDirty) {
            const rotation = (90 - this._direction) * Math.PI / 180;

            // Calling rotationZ sets the destination matrix to a rotation
            // around the Z axis setting matrix components 0, 1, 4 and 5 with
            // cosine and sine values of the rotation.
            // twgl.m4.rotationZ(rotation, this._rotationMatrix);

            // twgl assumes the last value set to the matrix was anything.
            // Drawable knows, it was another rotationZ matrix, so we can skip
            // assigning the values that will never change.
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
            const sizeRatio0 = sizeRatio[0];
            const sizeRatio1 = sizeRatio[1];

            const skinCenter = this.skin.rotationCenter;
            const center0 = skinCenter[0];
            const center1 = skinCenter[1];
            const rotationCenter = this._rotationCenter;
            rotationCenter[0] = Math.round(center0) / sizeRatio0;
            rotationCenter[1] = Math.round(center1) / sizeRatio1;

            this._rotationCenterDirty = false;
        }

        if (this._skinScaleDirty && this.skin !== null) {
            const sizeRatio = this.skin.sizeRatio;

            this._scaleMatrix[0] = sizeRatio[0] * this._scale[0] * 0.01;
            this._scaleMatrix[3] = sizeRatio[1] * this._scale[1] * -0.01;

            this._skinScaleDirty = false;
        }

        const position0 = this._position[0];
        const position1 = this._position[1];
        const rotationCenter = this._rotationCenter;
        const center0 = rotationCenter[0];
        const center1 = rotationCenter[1];

        this._translationMatrix = matrix.mat2d.fromValues(1, 0, 0, 1, position0, position1);

        const transformMatrix = this.transformMatrix;

        matrix.mat2d.identity(transformMatrix);

        matrix.mat2d.set(transformMatrix, 1, 0, 0, 1, Math.round(-center0), Math.round(-center1));

        matrix.mat2d.multiply(transformMatrix, this._scaleMatrix, transformMatrix);
        matrix.mat2d.multiply(transformMatrix, this._rotationMatrix, transformMatrix);
        matrix.mat2d.multiply(transformMatrix, this._translationMatrix, transformMatrix);
        

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
        this._transformedHullPoints = [];
        for (let i = 0; i < points.length; i++) {
            this._transformedHullPoints.push(matrix.vec2.create());
        }
        this._convexHullDirty = false;
    }

    /**
     * Check if the world position touches the skin.
     * @param {twgl.v3} vec World coordinate vector.
     * @return {boolean} True if the world position touches the skin.
     */
    isTouching (vec) {
        if (!this.skin) {
            return false;
        }

        const localPosition = getLocalPosition(this, vec);

        if (this.useNearest) {
            return this.skin.isTouchingNearest(localPosition);
        }
        return this.skin.isTouchingLinear(localPosition);
    }

    /**
     * Should the drawable use NEAREST NEIGHBOR or LINEAR INTERPOLATION mode
     */
    get useNearest () {
        // Raster skins (bitmaps) should always prefer nearest neighbor
        if (this.skin.isRaster) {
            return true;
        }

        // We can't use nearest neighbor unless we are a multiple of 90 rotation
        if (this._direction % 90 !== 0) {
            return false;
        }

        // If the scale of the skin is very close to 100 (0.99999 variance is okay I guess)
        if (Math.abs(this.scale[0]) > 99 && Math.abs(this.scale[0]) < 101 &&
            Math.abs(this.scale[1]) > 99 && Math.abs(this.scale[1]) < 101) {
            return true;
        }
        return false;
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
            const size0 = skin.size[0] / skin.sizeRatio[0];
            const size1 = skin.size[1] / skin.sizeRatio[1];
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
        this.updateMatrix();
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
        matrix.mat2d.scale(this._convexHullMatrix, this.transformMatrix, this.skin.sizeRatio);
        for (let i = 0; i < this._convexHullPoints.length; i++) {
            matrix.vec2.transformMat2d(
                this._transformedHullPoints[i],
                this._convexHullPoints[i],
                this._convexHullMatrix
            );
        }
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
     * @param {twgl.v3} vec The scratch space [x,y] vector
     * @param {Drawable} drawable The drawable to sample the texture from
     * @param {Uint8ClampedArray} dst The "color4b" representation of the texture at point.
     * @returns {Uint8ClampedArray} The dst object filled with the color4b
     */
    static sampleColor4b (vec, drawable, dst) {
        const localPosition = getLocalPosition(drawable, vec);

        return drawable.skin._silhouette.colorAtNearest(localPosition, dst);

        // TODO: reimplement for certain effects
        /* if (localPosition[0] < 0 || localPosition[1] < 0 ||
            localPosition[0] > 1 || localPosition[1] > 1) {
            dst[3] = 0;
            return dst;
        }
        const textColor =
        // commenting out to only use nearest for now
        // drawable.useNearest ?
             drawable.skin._silhouette.colorAtNearest(localPosition, dst);
        // : drawable.skin._silhouette.colorAtLinear(localPosition, dst);
        return EffectTransform.transformColor(drawable, textColor, textColor); */
    }
}

module.exports = Drawable;
