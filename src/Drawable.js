const twgl = require('twgl.js');

const Rectangle = require('./Rectangle');
const RenderConstants = require('./RenderConstants');
const ShaderManager = require('./ShaderManager');
const Skin = require('./Skin');
const EffectTransform = require('./EffectTransform');

/**
 * An internal workspace for calculating texture locations from world vectors
 * this is REUSED for memory conservation reasons
 * @type {twgl.v3}
 */
const __isTouchingPosition = twgl.v3.create();

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
    // The RenderWebGL quad flips the texture's X axis. So rendered bottom
    // left is 1, 0 and the top right is 0, 1. Flip the X axis so
    // localPosition matches that transformation.
    localPosition[0] = 0.5 - (((v0 * m[0]) + (v1 * m[4]) + m[12]) / d);
    localPosition[1] = (((v0 * m[1]) + (v1 * m[5]) + m[13]) / d) + 0.5;
    // Apply texture effect transform if the localPosition is within the drawable's space.
    if ((localPosition[0] >= 0 && localPosition[0] < 1) && (localPosition[1] >= 0 && localPosition[1] < 1)) {
        EffectTransform.transformPoint(drawable, localPosition, localPosition);
    }
    return localPosition;
};

class Drawable {
    /**
     * An object which can be drawn by the renderer.
     * @todo double-buffer all rendering state (position, skin, effects, etc.)
     * @param {!int} id - This Drawable's unique ID.
     * @constructor
     */
    constructor (id) {
        /** @type {!int} */
        this._id = id;

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

        this._position = twgl.v3.create(0, 0);
        this._scale = twgl.v3.create(100, 100);
        this._direction = 90;
        this._transformDirty = true;
        this._rotationMatrix = twgl.m4.identity();
        this._rotationTransformDirty = true;
        this._rotationAdjusted = twgl.v3.create();
        this._rotationCenterDirty = true;
        this._skinScale = twgl.v3.create(0, 0, 0);
        this._skinScaleDirty = true;
        this._inverseMatrix = twgl.m4.identity();
        this._inverseTransformDirty = true;
        this._visible = true;
        this._effectBits = 0;

        /** @todo move convex hull functionality, maybe bounds functionality overall, to Skin classes */
        this._convexHullPoints = null;
        this._convexHullDirty = true;

        this._skinWasAltered = this._skinWasAltered.bind(this);
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

    /**
     * @returns {object.<string, *>} the shader uniforms to be used when rendering this Drawable.
     */
    getUniforms () {
        if (this._transformDirty) {
            this._calculateTransform();
        }
        return this._uniforms;
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
            const rotation = (270 - this._direction) * Math.PI / 180;

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
            // this._rotationMatrix[2] = 0;
            // this._rotationMatrix[3] = 0;
            this._rotationMatrix[4] = -s;
            this._rotationMatrix[5] = c;
            // this._rotationMatrix[6] = 0;
            // this._rotationMatrix[7] = 0;
            // this._rotationMatrix[8] = 0;
            // this._rotationMatrix[9] = 0;
            // this._rotationMatrix[10] = 1;
            // this._rotationMatrix[11] = 0;
            // this._rotationMatrix[12] = 0;
            // this._rotationMatrix[13] = 0;
            // this._rotationMatrix[14] = 0;
            // this._rotationMatrix[15] = 1;

            this._rotationTransformDirty = false;
        }

        // Adjust rotation center relative to the skin.
        if (this._rotationCenterDirty && this.skin !== null) {
            // twgl version of the following in function work.
            // let rotationAdjusted = twgl.v3.subtract(
            //     this.skin.rotationCenter,
            //     twgl.v3.divScalar(this.skin.size, 2, this._rotationAdjusted),
            //     this._rotationAdjusted
            // );
            // rotationAdjusted = twgl.v3.multiply(
            //     rotationAdjusted, this._scale, rotationAdjusted
            // );
            // rotationAdjusted = twgl.v3.divScalar(
            //     rotationAdjusted, 100, rotationAdjusted
            // );
            // rotationAdjusted[1] *= -1; // Y flipped to Scratch coordinate.
            // rotationAdjusted[2] = 0; // Z coordinate is 0.

            // Locally assign rotationCenter and skinSize to keep from having
            // the Skin getter properties called twice while locally assigning
            // their components for readability.
            const rotationCenter = this.skin.rotationCenter;
            const skinSize = this.skin.size;
            const center0 = rotationCenter[0];
            const center1 = rotationCenter[1];
            const skinSize0 = skinSize[0];
            const skinSize1 = skinSize[1];
            const scale0 = this._scale[0];
            const scale1 = this._scale[1];

            const rotationAdjusted = this._rotationAdjusted;
            rotationAdjusted[0] = (center0 - (skinSize0 / 2)) * scale0 / 100;
            rotationAdjusted[1] = ((center1 - (skinSize1 / 2)) * scale1 / 100) * -1;
            // rotationAdjusted[2] = 0;

            this._rotationCenterDirty = false;
        }

        if (this._skinScaleDirty && this.skin !== null) {
            // twgl version of the following in function work.
            // const scaledSize = twgl.v3.divScalar(
            //     twgl.v3.multiply(this.skin.size, this._scale),
            //     100
            // );
            // // was NaN because the vectors have only 2 components.
            // scaledSize[2] = 0;

            // Locally assign skinSize to keep from having the Skin getter
            // properties called twice.
            const skinSize = this.skin.size;
            const scaledSize = this._skinScale;
            scaledSize[0] = skinSize[0] * this._scale[0] / 100;
            scaledSize[1] = skinSize[1] * this._scale[1] / 100;
            // scaledSize[2] = 0;

            this._skinScaleDirty = false;
        }

        const modelMatrix = this._uniforms.u_modelMatrix;

        // twgl version of the following in function work.
        // twgl.m4.identity(modelMatrix);
        // twgl.m4.translate(modelMatrix, this._position, modelMatrix);
        // twgl.m4.multiply(modelMatrix, this._rotationMatrix, modelMatrix);
        // twgl.m4.translate(modelMatrix, this._rotationAdjusted, modelMatrix);
        // twgl.m4.scale(modelMatrix, scaledSize, modelMatrix);

        // Drawable configures a 3D matrix for drawing in WebGL, but most values
        // will never be set because the inputs are on the X and Y position axis
        // and the Z rotation axis. Drawable can bring the work inside
        // _calculateTransform and greatly reduce the ammount of math and array
        // assignments needed.

        const scale0 = this._skinScale[0];
        const scale1 = this._skinScale[1];
        const rotation00 = this._rotationMatrix[0];
        const rotation01 = this._rotationMatrix[1];
        const rotation10 = this._rotationMatrix[4];
        const rotation11 = this._rotationMatrix[5];
        const adjusted0 = this._rotationAdjusted[0];
        const adjusted1 = this._rotationAdjusted[1];
        const position0 = this._position[0];
        const position1 = this._position[1];

        // Commented assignments show what the values are when the matrix was
        // instantiated. Those values will never change so they do not need to
        // be reassigned.
        modelMatrix[0] = scale0 * rotation00;
        modelMatrix[1] = scale0 * rotation01;
        // modelMatrix[2] = 0;
        // modelMatrix[3] = 0;
        modelMatrix[4] = scale1 * rotation10;
        modelMatrix[5] = scale1 * rotation11;
        // modelMatrix[6] = 0;
        // modelMatrix[7] = 0;
        // modelMatrix[8] = 0;
        // modelMatrix[9] = 0;
        // modelMatrix[10] = 1;
        // modelMatrix[11] = 0;
        modelMatrix[12] = (rotation00 * adjusted0) + (rotation10 * adjusted1) + position0;
        modelMatrix[13] = (rotation01 * adjusted0) + (rotation11 * adjusted1) + position1;
        // modelMatrix[14] = 0;
        // modelMatrix[15] = 1;

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
     * Set the convex hull points for the Drawable.
     * @param {Array<Array<number>>} points Convex hull points, as [[x, y], ...]
     */
    setConvexHullPoints (points) {
        this._convexHullPoints = points;
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
        const tm = this._uniforms.u_modelMatrix;
        const bounds = new Rectangle();
        bounds.initFromPointsAABB([
            twgl.m4.transformPoint(tm, [-0.5, -0.5, 0]),
            twgl.m4.transformPoint(tm, [0.5, -0.5, 0]),
            twgl.m4.transformPoint(tm, [-0.5, 0.5, 0]),
            twgl.m4.transformPoint(tm, [0.5, 0.5, 0])
        ]);
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
        const projection = twgl.m4.ortho(-1, 1, -1, 1, -1, 1);
        const skinSize = this.skin.size;
        const halfXPixel = 1 / skinSize[0] / 2;
        const halfYPixel = 1 / skinSize[1] / 2;
        const tm = twgl.m4.multiply(this._uniforms.u_modelMatrix, projection);
        const transformedHullPoints = [];
        for (let i = 0; i < this._convexHullPoints.length; i++) {
            const point = this._convexHullPoints[i];
            const glPoint = twgl.v3.create(
                0.5 + (-point[0] / skinSize[0]) - halfXPixel,
                (point[1] / skinSize[1]) - 0.5 + halfYPixel,
                0
            );
            twgl.m4.transformPoint(tm, glPoint, glPoint);
            transformedHullPoints.push(glPoint);
        }
        return transformedHullPoints;
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
            twgl.m4.copy(this._uniforms.u_modelMatrix, inverse);
            // The normal matrix uses a z scaling of 0 causing model[10] to be
            // 0. Getting a 4x4 inverse is impossible without a scaling in x, y,
            // and z.
            inverse[10] = 1;
            twgl.m4.inverse(inverse, inverse);
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
        if (localPosition[0] < 0 || localPosition[1] < 0 ||
            localPosition[0] > 1 || localPosition[1] > 1) {
            dst[3] = 0;
            return dst;
        }
        const textColor =
        // commenting out to only use nearest for now
        // drawable.useNearest ?
             drawable.skin._silhouette.colorAtNearest(localPosition, dst);
        // : drawable.skin._silhouette.colorAtLinear(localPosition, dst);
        return EffectTransform.transformColor(drawable, textColor, textColor);
    }
}

module.exports = Drawable;
