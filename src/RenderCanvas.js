const EventEmitter = require('events');

const matrix = require('gl-matrix');

const BitmapSkin = require('./BitmapSkin');
const Drawable = require('./Drawable');
const Rectangle = require('./Rectangle');
const PenSkin = require('./PenSkin');
const RenderConstants = require('./RenderConstants');
const ShaderManager = require('./ShaderManager');
const SVGSkin = require('./SVGSkin');
const TextBubbleSkin = require('./TextBubbleSkin');
const log = require('./util/log');

const createDebugCanvas = false;

const __isTouchingDrawablesPoint = matrix.vec2.create();
const __candidatesBounds = new Rectangle();
const __touchingColor = new Uint8ClampedArray(4);
const __blendColor = new Uint8ClampedArray(4);

/**
 * @callback RenderCanvas#idFilterFunc
 * @param {int} drawableID The ID to filter.
 * @return {bool} True if the ID passes the filter, otherwise false.
 */

/**
 * Maximum touch size for a picking check.
 * @todo Figure out a reasonable max size. Maybe this should be configurable?
 * @type {Array<int>}
 * @memberof RenderCanvas
 */
const MAX_TOUCH_SIZE = [3, 3];

/**
 * Determines if the mask color is "close enough" (only test the 6 top bits for
 * each color).  These bit masks are what scratch 2 used to use, so we do the same.
 * @param {Uint8Array} a A color3b or color4b value.
 * @param {Uint8Array} b A color3b or color4b value.
 * @returns {boolean} If the colors match within the parameters.
 */
const maskMatches = (a, b) => (
    // has some non-alpha component to test against
    a[3] > 0 &&
    (a[0] & 0b11111100) === (b[0] & 0b11111100) &&
    (a[1] & 0b11111100) === (b[1] & 0b11111100) &&
    (a[2] & 0b11111100) === (b[2] & 0b11111100)
);

/**
 * Determines if the given color is "close enough" (only test the 5 top bits for
 * red and green, 4 bits for blue).  These bit masks are what scratch 2 used to use,
 * so we do the same.
 * @param {Uint8Array} a A color3b or color4b value.
 * @param {Uint8Array} b A color3b or color4b value / or a larger array when used with offsets
 * @param {number} offset An offset into the `b` array, which lets you use a larger array to test
 *                  multiple values at the same time.
 * @returns {boolean} If the colors match within the parameters.
 */
const colorMatches = (a, b, offset) => (
    (a[0] & 0b11111000) === (b[offset + 0] & 0b11111000) &&
    (a[1] & 0b11111000) === (b[offset + 1] & 0b11111000) &&
    (a[2] & 0b11110000) === (b[offset + 2] & 0b11110000)
);

/**
 * Sprite Fencing - The number of pixels a sprite is required to leave remaining
 * onscreen around the edge of the staging area.
 * @type {number}
 */
const FENCE_WIDTH = 15;


class RenderCanvas extends EventEmitter {
    /**
     * Check if this environment appears to support this renderer before attempting to create an instance.
     * Catching an exception from the constructor is also a valid way to test for (lack of) support.
     * @param {canvas} [optCanvas] - An optional canvas to use for the test. Otherwise a temporary canvas will be used.
     * @returns {boolean} - True if this environment appears to support this renderer, false otherwise.
     */
    static isSupported (optCanvas) {
        try {
            // Create the context the same way that the constructor will: attributes may make the difference.
            return !!RenderCanvas._getContext(optCanvas || document.createElement('canvas'));
        } catch (e) {
            return false;
        }
    }

    static _getContext (canvas) {
        return canvas.getContext('2d');
    }

    /**
     * Create a renderer for drawing Scratch sprites to a canvas using the 2d canvas API.
     * Coordinates will default to Scratch 2.0 values if unspecified.
     * The stage's "native" size will be calculated from the these coordinates.
     * For example, the defaults result in a native size of 480x360.
     * Queries such as "touching color?" will always execute at the native size.
     * @see RenderCanvas#setStageSize
     * @see RenderCanvas#resize
     * @param {canvas} canvas The canvas to draw onto.
     * @param {int} [xLeft=-240] The x-coordinate of the left edge.
     * @param {int} [xRight=240] The x-coordinate of the right edge.
     * @param {int} [yBottom=-180] The y-coordinate of the bottom edge.
     * @param {int} [yTop=180] The y-coordinate of the top edge.
     * @constructor
     * @listens RenderCanvas#event:NativeSizeChanged
     */
    constructor (canvas, xLeft, xRight, yBottom, yTop) {
        super();

        this.ctx = RenderCanvas._getContext(canvas);

        /** @type {Drawable[]} */
        this._allDrawables = [];

        /** @type {Skin[]} */
        this._allSkins = [];

        /** @type {Array<int>} */
        this._drawList = [];

        // A list of layer group names in the order they should appear
        // from furthest back to furthest in front.
        /** @type {Array<String>} */
        this._groupOrdering = [];

        /**
         * @typedef LayerGroup
         * @property {int} groupIndex The relative position of this layer group in the group ordering
         * @property {int} drawListOffset The absolute position of this layer group in the draw list
         * This number gets updated as drawables get added to or deleted from the draw list.
         */

        // Map of group name to layer group
        /** @type {Object.<string, LayerGroup>} */
        this._layerGroups = {};

        /** @type {int} */
        this._nextDrawableId = RenderConstants.ID_NONE + 1;

        /** @type {int} */
        this._nextSkinId = RenderConstants.ID_NONE + 1;

        /** @type {module:gl-matrix/mat2d.mat2d} */
        this._projection = matrix.mat2d.create();
        this._inverseProjection = matrix.mat2d.create();
        this._drawProjection = matrix.mat2d.create();
        this._scaleMatrix = matrix.mat2d.create();

        /** @type {HTMLCanvasElement} */
        this._tempCanvas = document.createElement('canvas');
        this._tempCanvasCtx = this._tempCanvas.getContext('2d');

        /** @type {any} */
        this._regionId = null;

        /** @type {function} */
        this._exitRegion = null;

        /** @type {Array.<snapshotCallback>} */
        this._snapshotCallbacks = [];

        this.on(RenderConstants.Events.NativeSizeChanged, this.onNativeSizeChanged);

        this.setBackgroundColor(1, 1, 1);
        this.setStageSize(xLeft || -240, xRight || 240, yBottom || -180, yTop || 180);
        this.resize(this._nativeSize[0], this._nativeSize[1]);

        if (createDebugCanvas) {
            this.setDebugCanvas(document.body.appendChild(document.createElement("canvas")));

            this._debugCanvas.style.position = 'absolute';
            this._debugCanvas.style.top = '0px';
            this._debugCanvas.style.left = '0px';
            this._debugCanvas.style.zIndex = '999';
        }
    }

    /**
     * @returns {WebGLRenderingContext} the WebGL rendering context associated with this renderer.
     */
    get gl () {
        return this._gl;
    }

    /**
     * @returns {HTMLCanvasElement} the canvas of the WebGL rendering context associated with this renderer.
     */
    get canvas () {
        return this.ctx.canvas;
    }

    /**
     * Set the physical size of the stage in device-independent pixels.
     * This will be multiplied by the device's pixel ratio on high-DPI displays.
     * @param {int} pixelsWide The desired width in device-independent pixels.
     * @param {int} pixelsTall The desired height in device-independent pixels.
     */
    resize (pixelsWide, pixelsTall) {
        const canvas = this.ctx.canvas;
        const pixelRatio = window.devicePixelRatio || 1;

        const newWidth = pixelsWide * pixelRatio;
        const newHeight = pixelsTall * pixelRatio;

        // The color picker triggers "componentDidUpdate" on the stage, which resizes the canvas.
        // Resizing will erase the canvas' contents, causing flickering, so check if we *really* need to resize.
        if (canvas.width !== newWidth || canvas.height !== newHeight) {
            canvas.width = newWidth;
            canvas.height = newHeight;
        }

        this._scaleMatrix[0] = (pixelsWide * pixelRatio) / this._nativeSize[0];
        this._scaleMatrix[3] = (pixelsTall * pixelRatio) / this._nativeSize[1];
    }

    /**
     * Set the background color for the stage. The stage will be cleared with this
     * color each frame.
     * @param {number} red The red component for the background.
     * @param {number} green The green component for the background.
     * @param {number} blue The blue component for the background.
     */
    setBackgroundColor (red, green, blue) {
        this._backgroundColor = [red, green, blue, 1];
    }

    /**
     * Tell the renderer to draw various debug information to the provided canvas
     * during certain operations.
     * @param {canvas} canvas The canvas to use for debug output.
     */
    setDebugCanvas (canvas) {
        this._debugCanvas = canvas;
    }

    /**
     * Set logical size of the stage in Scratch units.
     * @param {int} xLeft The left edge's x-coordinate. Scratch 2 uses -240.
     * @param {int} xRight The right edge's x-coordinate. Scratch 2 uses 240.
     * @param {int} yBottom The bottom edge's y-coordinate. Scratch 2 uses -180.
     * @param {int} yTop The top edge's y-coordinate. Scratch 2 uses 180.
     */
    setStageSize (xLeft, xRight, yBottom, yTop) {
        this._xLeft = xLeft;
        this._xRight = xRight;
        this._yBottom = yBottom;
        this._yTop = yTop;

        // swap yBottom & yTop to fit Scratch convention of +y=up
        matrix.mat2d.set(this._projection, 1, 0, 0, -1, Math.abs(xRight - xLeft) / 2, Math.abs(yBottom - yTop) / 2);
        matrix.mat2d.invert(this._inverseProjection, this._projection);

        this._setNativeSize(Math.abs(xRight - xLeft), Math.abs(yBottom - yTop));
    }

    /**
     * @return {Array<int>} the "native" size of the stage, which is used for pen, query renders, etc.
     */
    getNativeSize () {
        return [this._nativeSize[0], this._nativeSize[1]];
    }

    /**
     * Set the "native" size of the stage, which is used for pen, query renders, etc.
     * @param {int} width - the new width to set.
     * @param {int} height - the new height to set.
     * @private
     * @fires RenderCanvas#event:NativeSizeChanged
     */
    _setNativeSize (width, height) {
        this._nativeSize = [width, height];
        this.emit(RenderConstants.Events.NativeSizeChanged, {newSize: this._nativeSize});
    }

    /**
     * Create a new bitmap skin from a snapshot of the provided bitmap data.
     * @param {ImageData|HTMLImageElement|HTMLCanvasElement|HTMLVideoElement} bitmapData - new contents for this skin.
     * @param {!int} [costumeResolution=1] - The resolution to use for this bitmap.
     * @param {?Array<number>} [rotationCenter] Optional: rotation center of the skin. If not supplied, the center of
     * the skin will be used.
     * @returns {!int} the ID for the new skin.
     */
    createBitmapSkin (bitmapData, costumeResolution, rotationCenter) {
        const skinId = this._nextSkinId++;
        const newSkin = new BitmapSkin(skinId, this);
        newSkin.setBitmap(bitmapData, costumeResolution, rotationCenter);
        this._allSkins[skinId] = newSkin;
        return skinId;
    }

    /**
     * Create a new SVG skin.
     * @param {!string} svgData - new SVG to use.
     * @param {?Array<number>} rotationCenter Optional: rotation center of the skin. If not supplied, the center of the
     * skin will be used
     * @returns {!int} the ID for the new skin.
     */
    createSVGSkin (svgData, rotationCenter) {
        const skinId = this._nextSkinId++;
        const newSkin = new SVGSkin(skinId, this);
        newSkin.setSVG(svgData, rotationCenter);
        this._allSkins[skinId] = newSkin;
        return skinId;
    }

    /**
     * Create a new PenSkin - a skin which implements a Scratch pen layer.
     * @returns {!int} the ID for the new skin.
     */
    createPenSkin () {
        const skinId = this._nextSkinId++;
        const newSkin = new PenSkin(skinId, this);
        this._allSkins[skinId] = newSkin;
        return skinId;
    }

    /**
     * Create a new SVG skin using the text bubble svg creator. The rotation center
     * is always placed at the top left.
     * @param {!string} type - either "say" or "think".
     * @param {!string} text - the text for the bubble.
     * @param {!boolean} pointsLeft - which side the bubble is pointing.
     * @returns {!int} the ID for the new skin.
     */
    createTextSkin (type, text, pointsLeft) {
        const skinId = this._nextSkinId++;
        const newSkin = new TextBubbleSkin(skinId, this);
        newSkin.setTextBubble(type, text, pointsLeft);
        this._allSkins[skinId] = newSkin;
        return skinId;
    }

    /**
     * Update an existing SVG skin, or create an SVG skin if the previous skin was not SVG.
     * @param {!int} skinId the ID for the skin to change.
     * @param {!string} svgData - new SVG to use.
     * @param {?Array<number>} rotationCenter Optional: rotation center of the skin. If not supplied, the center of the
     * skin will be used
     */
    updateSVGSkin (skinId, svgData, rotationCenter) {
        if (this._allSkins[skinId] instanceof SVGSkin) {
            this._allSkins[skinId].setSVG(svgData, rotationCenter);
            return;
        }

        const newSkin = new SVGSkin(skinId, this);
        newSkin.setSVG(svgData, rotationCenter);
        this._reskin(skinId, newSkin);
    }

    /**
     * Update an existing bitmap skin, or create a bitmap skin if the previous skin was not bitmap.
     * @param {!int} skinId the ID for the skin to change.
     * @param {!ImageData|HTMLImageElement|HTMLCanvasElement|HTMLVideoElement} imgData - new contents for this skin.
     * @param {!number} bitmapResolution - the resolution scale for a bitmap costume.
     * @param {?Array<number>} rotationCenter Optional: rotation center of the skin. If not supplied, the center of the
     * skin will be used
     */
    updateBitmapSkin (skinId, imgData, bitmapResolution, rotationCenter) {
        if (this._allSkins[skinId] instanceof BitmapSkin) {
            this._allSkins[skinId].setBitmap(imgData, bitmapResolution, rotationCenter);
            return;
        }

        const newSkin = new BitmapSkin(skinId, this);
        newSkin.setBitmap(imgData, bitmapResolution, rotationCenter);
        this._reskin(skinId, newSkin);
    }

    _reskin (skinId, newSkin) {
        const oldSkin = this._allSkins[skinId];
        this._allSkins[skinId] = newSkin;

        // Tell drawables to update
        for (const drawable of this._allDrawables) {
            if (drawable && drawable.skin === oldSkin) {
                drawable.skin = newSkin;
                drawable.setConvexHullDirty();
                drawable.setTransformDirty();
            }
        }
        oldSkin.dispose();
    }

    /**
     * Update a skin using the text bubble svg creator.
     * @param {!int} skinId the ID for the skin to change.
     * @param {!string} type - either "say" or "think".
     * @param {!string} text - the text for the bubble.
     * @param {!boolean} pointsLeft - which side the bubble is pointing.
     */
    updateTextSkin (skinId, type, text, pointsLeft) {
        if (this._allSkins[skinId] instanceof TextBubbleSkin) {
            this._allSkins[skinId].setTextBubble(type, text, pointsLeft);
            return;
        }

        const newSkin = new TextBubbleSkin(skinId, this);
        newSkin.setTextBubble(type, text, pointsLeft);
        this._reskin(skinId, newSkin);
    }


    /**
     * Destroy an existing skin. Do not use the skin or its ID after calling this.
     * @param {!int} skinId - The ID of the skin to destroy.
     */
    destroySkin (skinId) {
        const oldSkin = this._allSkins[skinId];
        oldSkin.dispose();
        delete this._allSkins[skinId];
    }

    /**
     * Create a new Drawable and add it to the scene.
     * @param {string} group Layer group to add the drawable to
     * @returns {int} The ID of the new Drawable.
     */
    createDrawable (group) {
        if (!group || !this._layerGroups.hasOwnProperty(group)) {
            log.warn('Cannot create a drawable without a known layer group');
            return;
        }
        const drawableID = this._nextDrawableId++;
        const drawable = new Drawable(drawableID, this);
        this._allDrawables[drawableID] = drawable;
        this._addToDrawList(drawableID, group);

        drawable.skin = null;

        return drawableID;
    }

    /**
     * Set the layer group ordering for the renderer.
     * @param {Array<string>} groupOrdering The ordered array of layer group
     * names
     */
    setLayerGroupOrdering (groupOrdering) {
        this._groupOrdering = groupOrdering;
        for (let i = 0; i < this._groupOrdering.length; i++) {
            this._layerGroups[this._groupOrdering[i]] = {
                groupIndex: i,
                drawListOffset: 0
            };
        }
    }

    _addToDrawList (drawableID, group) {
        const currentLayerGroup = this._layerGroups[group];
        const currentGroupOrderingIndex = currentLayerGroup.groupIndex;

        const drawListOffset = this._endIndexForKnownLayerGroup(currentLayerGroup);
        this._drawList.splice(drawListOffset, 0, drawableID);

        this._updateOffsets('add', currentGroupOrderingIndex);
    }

    _updateOffsets (updateType, currentGroupOrderingIndex) {
        for (let i = currentGroupOrderingIndex + 1; i < this._groupOrdering.length; i++) {
            const laterGroupName = this._groupOrdering[i];
            if (updateType === 'add') {
                this._layerGroups[laterGroupName].drawListOffset++;
            } else if (updateType === 'delete'){
                this._layerGroups[laterGroupName].drawListOffset--;
            }
        }
    }

    get _visibleDrawList () {
        return this._drawList.filter(id => this._allDrawables[id]._visible);
    }

    // Given a layer group, return the index where it ends (non-inclusive),
    // e.g. the returned index does not have a drawable from this layer group in it)
    _endIndexForKnownLayerGroup (layerGroup) {
        const groupIndex = layerGroup.groupIndex;
        if (groupIndex === this._groupOrdering.length - 1) {
            return this._drawList.length;
        }
        return this._layerGroups[this._groupOrdering[groupIndex + 1]].drawListOffset;
    }

    /**
     * Destroy a Drawable, removing it from the scene.
     * @param {int} drawableID The ID of the Drawable to remove.
     * @param {string} group Group name that the drawable belongs to
     */
    destroyDrawable (drawableID, group) {
        if (!group || !this._layerGroups.hasOwnProperty(group)) {
            log.warn('Cannot destroy drawable without known layer group.');
            return;
        }
        const drawable = this._allDrawables[drawableID];
        drawable.dispose();
        delete this._allDrawables[drawableID];

        const currentLayerGroup = this._layerGroups[group];
        const endIndex = this._endIndexForKnownLayerGroup(currentLayerGroup);

        let index = currentLayerGroup.drawListOffset;
        while (index < endIndex) {
            if (this._drawList[index] === drawableID) {
                break;
            }
            index++;
        }
        if (index < endIndex) {
            this._drawList.splice(index, 1);
            this._updateOffsets('delete', currentLayerGroup.groupIndex);
        } else {
            log.warn('Could not destroy drawable that could not be found in layer group.');
            return;
        }
    }

    /**
     * Returns the position of the given drawableID in the draw list. This is
     * the absolute position irrespective of layer group.
     * @param {number} drawableID The drawable ID to find.
     * @return {number} The postion of the given drawable ID.
     */
    getDrawableOrder (drawableID) {
        return this._drawList.indexOf(drawableID);
    }

    /**
     * Set a drawable's order in the drawable list (effectively, z/layer).
     * Can be used to move drawables to absolute positions in the list,
     * or relative to their current positions.
     * "go back N layers": setDrawableOrder(id, -N, true, 1); (assuming stage at 0).
     * "go to back": setDrawableOrder(id, 1); (assuming stage at 0).
     * "go to front": setDrawableOrder(id, Infinity);
     * @param {int} drawableID ID of Drawable to reorder.
     * @param {number} order New absolute order or relative order adjusment.
     * @param {string=} group Name of layer group drawable belongs to.
     * Reordering will not take place if drawable cannot be found within the bounds
     * of the layer group.
     * @param {boolean=} optIsRelative If set, `order` refers to a relative change.
     * @param {number=} optMin If set, order constrained to be at least `optMin`.
     * @return {?number} New order if changed, or null.
     */
    setDrawableOrder (drawableID, order, group, optIsRelative, optMin) {
        if (!group || !this._layerGroups.hasOwnProperty(group)) {
            log.warn('Cannot set the order of a drawable without a known layer group.');
            return;
        }

        const currentLayerGroup = this._layerGroups[group];
        const startIndex = currentLayerGroup.drawListOffset;
        const endIndex = this._endIndexForKnownLayerGroup(currentLayerGroup);

        let oldIndex = startIndex;
        while (oldIndex < endIndex) {
            if (this._drawList[oldIndex] === drawableID) {
                break;
            }
            oldIndex++;
        }

        if (oldIndex < endIndex) {
            // Remove drawable from the list.
            if (order === 0) {
                return oldIndex;
            }

            const _ = this._drawList.splice(oldIndex, 1)[0];
            // Determine new index.
            let newIndex = order;
            if (optIsRelative) {
                newIndex += oldIndex;
            }

            const possibleMin = (optMin || 0) + startIndex;
            const min = (possibleMin >= startIndex && possibleMin < endIndex) ? possibleMin : startIndex;
            newIndex = Math.max(newIndex, min);

            newIndex = Math.min(newIndex, endIndex);

            // Insert at new index.
            this._drawList.splice(newIndex, 0, drawableID);
            return newIndex;
        }

        return null;
    }

    /**
     * Draw all current drawables and present the frame on the canvas.
     */
    draw () {
        const ctx = this.ctx;

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

        matrix.mat2d.multiply(this._drawProjection, this._scaleMatrix, this._projection);

        this._drawThese(this._drawList, this._drawProjection, {dstCanvas: this.canvas});

        if (this._snapshotCallbacks.length > 0) {
            const snapshot = this.canvas.toDataURL();
            this._snapshotCallbacks.forEach(cb => cb(snapshot));
            this._snapshotCallbacks = [];
        }
    }

    /**
     * Get the precise bounds for a Drawable.
     * @param {int} drawableID ID of Drawable to get bounds for.
     * @return {object} Bounds for a tight box around the Drawable.
     */
    getBounds (drawableID) {
        const drawable = this._allDrawables[drawableID];
        // Tell the Drawable about its updated convex hull, if necessary.
        if (drawable.needsConvexHullPoints()) {
            const points = this._getConvexHullPointsForDrawable(drawableID);
            drawable.setConvexHullPoints(points);
        }
        const bounds = drawable.getFastBounds();
        // In debug mode, draw the bounds.
        if (this._debugCanvas) {
            this._debugCanvas.width = this.ctx.canvas.width;
            this._debugCanvas.height = this.ctx.canvas.height;
            const context = this._debugCanvas.getContext('2d');
            context.drawImage(this.ctx.canvas, 0, 0);
            context.strokeStyle = '#FF00FF';
            const pr = window.devicePixelRatio;
            context.strokeRect(
                pr * (bounds.left + (this._nativeSize[0] / 2)),
                pr * (-bounds.top + (this._nativeSize[1] / 2)),
                pr * (bounds.right - bounds.left),
                pr * (-bounds.bottom + bounds.top)
            );
        }
        return bounds;
    }

    /**
     * Get the precise bounds for a Drawable around the top slice.
     * Used for positioning speech bubbles more closely to the sprite.
     * @param {int} drawableID ID of Drawable to get bubble bounds for.
     * @return {object} Bounds for a tight box around the Drawable top slice.
     */
    getBoundsForBubble (drawableID) {
        const drawable = this._allDrawables[drawableID];
        // Tell the Drawable about its updated convex hull, if necessary.
        if (drawable.needsConvexHullPoints()) {
            const points = this._getConvexHullPointsForDrawable(drawableID);
            drawable.setConvexHullPoints(points);
        }
        const bounds = drawable.getBoundsForBubble();
        // In debug mode, draw the bounds.
        if (this._debugCanvas) {
            this._debugCanvas.width = this.ctx.canvas.width;
            this._debugCanvas.height = this.ctx.canvas.height;
            const context = this._debugCanvas.getContext('2d');
            context.drawImage(this.ctx.canvas, 0, 0);
            context.strokeStyle = '#FF0000';
            const pr = window.devicePixelRatio;
            context.strokeRect(
                pr * (bounds.left + (this._nativeSize[0] / 2)),
                pr * (-bounds.top + (this._nativeSize[1] / 2)),
                pr * (bounds.right - bounds.left),
                pr * (-bounds.bottom + bounds.top)
            );
        }
        return bounds;
    }

    /**
     * Get the current skin (costume) size of a Drawable.
     * @param {int} drawableID The ID of the Drawable to measure.
     * @return {Array<number>} Skin size, width and height.
     */
    getCurrentSkinSize (drawableID) {
        const drawable = this._allDrawables[drawableID];
        return this.getSkinSize(drawable.skin.id);
    }

    /**
     * Get the size of a skin by ID.
     * @param {int} skinID The ID of the Skin to measure.
     * @return {Array<number>} Skin size, width and height.
     */
    getSkinSize (skinID) {
        const skin = this._allSkins[skinID];
        return skin.size;
    }

    /**
     * Get the rotation center of a skin by ID.
     * @param {int} skinID The ID of the Skin
     * @return {Array<number>} The rotationCenterX and rotationCenterY
     */
    getSkinRotationCenter (skinID) {
        const skin = this._allSkins[skinID];
        return skin.calculateRotationCenter();
    }

    /**
     * Check if a particular Drawable is touching a particular color.
     * Unlike touching drawable, if the "tester" is invisble, we will still test.
     * @param {int} drawableID The ID of the Drawable to check.
     * @param {Array<int>} color3b Test if the Drawable is touching this color.
     * @param {Array<int>} [mask3b] Optionally mask the check to this part of Drawable.
     * @returns {boolean} True iff the Drawable is touching the color.
     */
    isTouchingColor (drawableID, color3b, mask3b) {
        const candidates = this._candidatesTouching(drawableID, this._visibleDrawList);
        if (candidates.length === 0) {
            return false;
        }

        const bounds = this._candidatesBounds(candidates);

        const debugCanvasContext = this._debugCanvas && this._debugCanvas.getContext('2d');
        if (debugCanvasContext) {
            this._debugCanvas.width = bounds.width;
            this._debugCanvas.height = bounds.height;
        }

        const drawable = this._allDrawables[drawableID];
        const point = __isTouchingDrawablesPoint;
        const color = __touchingColor;
        const hasMask = Boolean(mask3b);

        // Scratch Space - +y is top
        for (let y = bounds.bottom; y <= bounds.top; y++) {
            for (let x = bounds.left; x <= bounds.right; x++) {
                point[1] = y;
                point[0] = x;
                // if we use a mask, check our sample color...
                if (hasMask ?
                    maskMatches(Drawable.sampleColor4b(point, drawable, color), mask3b) :
                    drawable.isTouching(point)) {
                    RenderCanvas.sampleColor3b(point, candidates, color);
                    if (debugCanvasContext) {
                        debugCanvasContext.fillStyle = `rgb(${color[0]},${color[1]},${color[2]})`;
                        debugCanvasContext.fillRect(x - bounds.left, bounds.bottom - y, 1, 1);
                    }
                    // ...and the target color is drawn at this pixel
                    if (colorMatches(color, color3b, 0)) {
                        return true;
                    }
                }
            }
        }
        return false;
    }


    /**
     * Check if a particular Drawable is touching any in a set of Drawables.
     * @param {int} drawableID The ID of the Drawable to check.
     * @param {?Array<int>} candidateIDs The Drawable IDs to check, otherwise all visible drawables in the renderer
     * @returns {boolean} True if the Drawable is touching one of candidateIDs.
     */
    isTouchingDrawables (drawableID, candidateIDs = this._drawList) {
        const candidates = this._candidatesTouching(drawableID,
            // even if passed an invisible drawable, we will NEVER touch it!
            candidateIDs.filter(id => this._allDrawables[id]._visible));
        // if we are invisble we don't touch anything.
        if (candidates.length === 0 || !this._allDrawables[drawableID]._visible) {
            return false;
        }

        // Get the union of all the candidates intersections.
        const bounds = this._candidatesBounds(candidates);

        const drawable = this._allDrawables[drawableID];
        const point = __isTouchingDrawablesPoint;

        for (let x = bounds.left; x <= bounds.right; x++) {
            // Scratch Space - +y is top
            point[0] = x;
            for (let y = bounds.bottom; y <= bounds.top; y++) {
                point[1] = y;
                if (drawable.isTouching(point)) {
                    for (let index = 0; index < candidates.length; index++) {
                        if (candidates[index].drawable.isTouching(point)) {
                            return true;
                        }
                    }
                }
            }
        }

        return false;
    }

    /**
     * Convert a client based x/y position on the canvas to a Scratch 3 world space
     * Rectangle.  This creates recangles with a radius to cover selecting multiple
     * scratch pixels with touch / small render areas.
     *
     * @param {int} centerX The client x coordinate of the picking location.
     * @param {int} centerY The client y coordinate of the picking location.
     * @param {int} [width] The client width of the touch event (optional).
     * @param {int} [height] The client width of the touch event (optional).
     * @returns {Rectangle} Scratch world space rectangle, iterate bottom <= top,
     *                      left <= right.
     */
    clientSpaceToScratchBounds (centerX, centerY, width = 1, height = 1) {
        const ctx = this.ctx;

        const clientToScratchX = this._nativeSize[0] / ctx.canvas.clientWidth;
        const clientToScratchY = this._nativeSize[1] / ctx.canvas.clientHeight;

        width *= clientToScratchX;
        height *= clientToScratchY;

        width = Math.max(1, Math.min(Math.round(width), MAX_TOUCH_SIZE[0]));
        height = Math.max(1, Math.min(Math.round(height), MAX_TOUCH_SIZE[1]));
        const x = (centerX * clientToScratchX) - ((width - 1) / 2);
        // + because scratch y is inverted
        const y = (centerY * clientToScratchY) + ((height - 1) / 2);

        const xOfs = (width % 2) ? 0 : -0.5;
        // y is offset +0.5
        const yOfs = (height % 2) ? 0 : -0.5;

        const bounds = new Rectangle();
        bounds.initFromBounds(Math.floor(this._xLeft + x + xOfs), Math.floor(this._xLeft + x + xOfs + width - 1),
            Math.ceil(this._yTop - y + yOfs), Math.ceil(this._yTop - y + yOfs + height - 1));
        return bounds;
    }

    /**
     * Determine if the drawable is touching a client based x/y.  Helper method for sensing
     * touching mouse-pointer.  Ignores visibility.
     *
     * @param {int} drawableID The ID of the drawable to check.
     * @param {int} centerX The client x coordinate of the picking location.
     * @param {int} centerY The client y coordinate of the picking location.
     * @param {int} [touchWidth] The client width of the touch event (optional).
     * @param {int} [touchHeight] The client height of the touch event (optional).
     * @returns {boolean} If the drawable has any pixels that would draw in the touch area
     */
    drawableTouching (drawableID, centerX, centerY, touchWidth, touchHeight) {
        const drawable = this._allDrawables[drawableID];
        if (!drawable) {
            return false;
        }
        const bounds = this.clientSpaceToScratchBounds(centerX, centerY, touchWidth, touchHeight);
        const worldPos = matrix.vec2.create();

        drawable.updateMatrix();
        if (drawable.skin) {
            drawable.skin.updateSilhouette();
        } else {
            log.warn(`Could not find skin for drawable with id: ${drawableID}`);
        }

        for (worldPos[1] = bounds.bottom; worldPos[1] <= bounds.top; worldPos[1]++) {
            for (worldPos[0] = bounds.left; worldPos[0] <= bounds.right; worldPos[0]++) {
                if (drawable.isTouching(worldPos)) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * Detect which sprite, if any, is at the given location.
     * This function will pick all drawables that are visible, unless specific
     * candidate drawable IDs are provided.  Used for determining what is clicked
     * or dragged.  Will not select hidden / ghosted sprites.
     *
     * @param {int} centerX The client x coordinate of the picking location.
     * @param {int} centerY The client y coordinate of the picking location.
     * @param {int} [touchWidth] The client width of the touch event (optional).
     * @param {int} [touchHeight] The client height of the touch event (optional).
     * @param {Array<int>} [candidateIDs] The Drawable IDs to pick from, otherwise all visible drawables.
     * @returns {int} The ID of the topmost Drawable under the picking location, or
     * RenderConstants.ID_NONE if there is no Drawable at that location.
     */
    pick (centerX, centerY, touchWidth, touchHeight, candidateIDs) {
        candidateIDs = (candidateIDs || this._drawList).filter(id => {
            const drawable = this._allDrawables[id];
            // default pick list ignores visible and ghosted sprites.
            if (drawable.getVisible()) {
                drawable.updateMatrix();
                if (drawable.skin) {
                    drawable.skin.updateSilhouette();
                } else {
                    log.warn(`Could not find skin for drawable with id: ${id}`);
                }
                return true;
            }
            return false;
        });

        if (candidateIDs.length === 0) {
            return false;
        }

        const bounds = this.clientSpaceToScratchBounds(centerX, centerY, touchWidth, touchHeight);
        if (bounds.left === -Infinity || bounds.bottom === -Infinity) {
            return false;
        }

        const hits = [];
        const worldPos = matrix.vec2.fromValues(0, 0);
        // Iterate over the scratch pixels and check if any candidate can be
        // touched at that point.
        for (worldPos[1] = bounds.bottom; worldPos[1] <= bounds.top; worldPos[1]++) {
            for (worldPos[0] = bounds.left; worldPos[0] <= bounds.right; worldPos[0]++) {

                // Check candidates in the reverse order they would have been
                // drawn. This will determine what candiate's silhouette pixel
                // would have been drawn at the point.
                for (let d = candidateIDs.length - 1; d >= 0; d--) {
                    const id = candidateIDs[d];
                    const drawable = this._allDrawables[id];
                    if (drawable.isTouching(worldPos)) {
                        hits[id] = (hits[id] || 0) + 1;
                        break;
                    }
                }
            }
        }

        // Bias toward selecting anything over nothing
        hits[RenderConstants.ID_NONE] = 0;

        let hit = RenderConstants.ID_NONE;
        for (const hitID in hits) {
            if (hits.hasOwnProperty(hitID) && (hits[hitID] > hits[hit])) {
                hit = hitID;
            }
        }

        return Number(hit);
    }

    /**
     * @typedef DrawableExtraction
     * @property {Uint8Array} data Raw pixel data for the drawable
     * @property {int} width Drawable bounding box width
     * @property {int} height Drawable bounding box height
     * @property {Array<number>} scratchOffset [x, y] offset in Scratch coordinates
     * from the drawable position to the client x, y coordinate
     * @property {int} x The x coordinate relative to drawable bounding box
     * @property {int} y The y coordinate relative to drawable bounding box
     */

    /**
     * Return drawable pixel data and picking coordinates relative to the drawable bounds
     * @param {int} drawableID The ID of the drawable to get pixel data for
     * @param {int} x The client x coordinate of the picking location.
     * @param {int} y The client y coordinate of the picking location.
     * @return {?DrawableExtraction} Data about the picked drawable
     */
    extractDrawable (drawableID, x, y) {
        const drawable = this._allDrawables[drawableID];
        if (!drawable) return null;

        // Convert client coordinates into absolute scratch units
        const scratchX = this._nativeSize[0] * ((x / this.ctx.canvas.clientWidth) - 0.5);
        const scratchY = this._nativeSize[1] * ((y / this.ctx.canvas.clientHeight) - 0.5);

        const bounds = drawable.getFastBounds();
        bounds.snapToInt();

        // Translate to scratch units relative to the drawable
        const pickX = scratchX - bounds.left;
        const pickY = scratchY + bounds.top;

        const dstCanvas = this._tempCanvas;
        const dstCtx = this._tempCanvasCtx;

        dstCanvas.width = bounds.width;
        dstCanvas.height = bounds.height;

        const corner = matrix.vec2.fromValues(-bounds.left, bounds.top);
        matrix.vec2.transformMat2d(corner, corner, this._inverseProjection);
        
        const translated = matrix.mat2d.create();
        matrix.mat2d.translate(translated, this._projection, corner);

        this._drawThese([drawableID], translated, {dstCanvas: dstCanvas});

        const data = dstCtx.getImageData(0, 0, dstCanvas.width, dstCanvas.height).data;

        if (this._debugCanvas) {
            this._debugCanvas.width = dstCanvas.width;
            this._debugCanvas.height = dstCanvas.height;
            const ctx = this._debugCanvas.getContext('2d');
            const imageData = ctx.createImageData(dstCanvas.width, dstCanvas.height);
            imageData.data.set(data);
            ctx.putImageData(imageData, 0, 0);
            ctx.beginPath();
            ctx.arc(pickX, pickY, 3, 0, 2 * Math.PI, false);
            ctx.fillStyle = 'white';
            ctx.fill();
            ctx.lineWidth = 1;
            ctx.strokeStyle = 'black';
            ctx.stroke();
        }

        return {
            data: data,
            width: bounds.width,
            height: bounds.height,
            scratchOffset: [
                -scratchX + drawable._position[0],
                -scratchY - drawable._position[1]
            ],
            x: pickX,
            y: pickY
        };
    }

    /**
     * @typedef ColorExtraction
     * @property {Uint8Array} data Raw pixel data for the drawable
     * @property {int} width Drawable bounding box width
     * @property {int} height Drawable bounding box height
     * @property {object} color Color object with RGBA properties at picked location
     */

    /**
     * Return drawable pixel data and color at a given position
     * @param {int} x The client x coordinate of the picking location.
     * @param {int} y The client y coordinate of the picking location.
     * @param {int} radius The client radius to extract pixels with.
     * @return {?ColorExtraction} Data about the picked color
     */
    extractColor (x, y, radius) {
        const scratchX = Math.round(this._nativeSize[0] * ((x / this.ctx.canvas.clientWidth) - 0.5));
        const scratchY = Math.round(-this._nativeSize[1] * ((y / this.ctx.canvas.clientHeight) - 0.5));

        const readX = Math.round(x - radius);
        const readY = Math.round(y - radius);

        const bounds = new Rectangle();
        bounds.initFromBounds(scratchX - radius, scratchX + radius, scratchY - radius, scratchY + radius);

        const pickX = scratchX - bounds.left;
        const pickY = bounds.top - scratchY;

        // double the radius, and also square it (radius * 2) * (radius * 2) * (4 bytes/pixel)
        const data = this.ctx.getImageData(readX, readY, radius * 2, radius * 2).data;

        const pixelBase = Math.floor(4 * ((pickY * bounds.width) + pickX));
        const color = {
            r: data[pixelBase],
            g: data[pixelBase + 1],
            b: data[pixelBase + 2],
            a: data[pixelBase + 3]
        };

        if (this._debugCanvas) {
            this._debugCanvas.width = bounds.width;
            this._debugCanvas.height = bounds.height;
            const ctx = this._debugCanvas.getContext('2d');
            const imageData = ctx.createImageData(bounds.width, bounds.height);
            imageData.data.set(data);
            ctx.putImageData(imageData, 0, 0);
            ctx.strokeStyle = 'black';
            ctx.fillStyle = `rgba(${color.r}, ${color.g}, ${color.b}, ${color.a})`;
            ctx.rect(pickX - 4, pickY - 4, 8, 8);
            ctx.fill();
            ctx.stroke();
        }

        return {
            data: data,
            width: bounds.width,
            height: bounds.height,
            color: color
        };
    }

    /**
     * Get the candidate bounding box for a touching query.
     * @param {int} drawableID ID for drawable of query.
     * @return {?Rectangle} Rectangle bounds for touching query, or null.
     */
    _touchingBounds (drawableID) {
        const drawable = this._allDrawables[drawableID];

        /** @todo remove this once URL-based skin setting is removed. */
        if (!drawable.skin || !drawable.skin.getTexture([100, 100])) return null;

        drawable.updateMatrix();
        drawable.skin.updateSilhouette();
        const bounds = drawable.getFastBounds();

        // Limit queries to the stage size.
        bounds.clamp(this._xLeft, this._xRight, this._yBottom, this._yTop);

        // Use integer coordinates for queries
        bounds.snapToInt();

        if (bounds.width === 0 || bounds.height === 0) {
            // No space to query.
            return null;
        }
        return bounds;
    }

    /**
     * Filter a list of candidates for a touching query into only those that
     * could possibly intersect the given bounds.
     * @param {int} drawableID - ID for drawable of query.
     * @param {Array<int>} candidateIDs - Candidates for touching query.
     * @return {?Array< {id, drawable, intersection} >} Filtered candidates with useful data.
     */
    _candidatesTouching (drawableID, candidateIDs) {
        const bounds = this._touchingBounds(drawableID);
        const result = [];
        if (bounds === null) {
            return result;
        }
        // iterate through the drawables list BACKWARDS - we want the top most item to be the first we check
        for (let index = candidateIDs.length - 1; index >= 0; index--) {
            const id = candidateIDs[index];
            if (id !== drawableID) {
                const drawable = this._allDrawables[id];
                if (drawable.skin && drawable._visible) {
                    // Update the CPU position data
                    drawable.updateMatrix();
                    drawable.skin.updateSilhouette();
                    const candidateBounds = drawable.getFastBounds();
                    if (bounds.intersects(candidateBounds)) {
                        result.push({
                            id,
                            drawable,
                            intersection: Rectangle.intersect(bounds, candidateBounds)
                        });
                    }
                }
            }
        }
        return result;
    }

    /**
     * Helper to get the union bounds from a set of candidates returned from the above method
     * @private
     * @param {Array<object>} candidates info from _candidatesTouching
     * @return {Rectangle} the outer bounding box union
     */
    _candidatesBounds (candidates) {
        return candidates.reduce((memo, {intersection}) => {
            if (!memo) {
                return intersection;
            }
            // store the union of the two rectangles in our static rectangle instance
            return Rectangle.union(memo, intersection, __candidatesBounds);
        }, null);
    }


    /**
     * Update the position, direction, scale, or effect properties of this Drawable.
     * @param {int} drawableID The ID of the Drawable to update.
     * @param {object.<string,*>} properties The new property values to set.
     */
    updateDrawableProperties (drawableID, properties) {
        const drawable = this._allDrawables[drawableID];
        if (!drawable) {
            /**
             * @todo fix whatever's wrong in the VM which causes this, then add a warning or throw here.
             * Right now this happens so much on some projects that a warning or exception here can hang the browser.
             */
            return;
        }
        if ('skinId' in properties) {
            drawable.skin = this._allSkins[properties.skinId];
        }
        if ('rotationCenter' in properties) {
            const newRotationCenter = properties.rotationCenter;
            drawable.skin.setRotationCenter(newRotationCenter[0], newRotationCenter[1]);
        }
        drawable.updateProperties(properties);
    }

    /**
     * Update the position object's x & y members to keep the drawable fenced in view.
     * @param {int} drawableID - The ID of the Drawable to update.
     * @param {Array.<number, number>} position to be fenced - An array of type [x, y]
     * @return {Array.<number, number>} The fenced position as an array [x, y]
     */
    getFencedPositionOfDrawable (drawableID, position) {
        let x = position[0];
        let y = position[1];

        const drawable = this._allDrawables[drawableID];
        if (!drawable) {
            // TODO: fix whatever's wrong in the VM which causes this, then add a warning or throw here.
            // Right now this happens so much on some projects that a warning or exception here can hang the browser.
            return [x, y];
        }

        const dx = x - drawable._position[0];
        const dy = y - drawable._position[1];
        const aabb = drawable._skin.getFenceBounds(drawable);
        const inset = Math.floor(Math.min(aabb.width, aabb.height) / 2);

        const sx = this._xRight - Math.min(FENCE_WIDTH, inset);
        if (aabb.right + dx < -sx) {
            x = Math.ceil(drawable._position[0] - (sx + aabb.right));
        } else if (aabb.left + dx > sx) {
            x = Math.floor(drawable._position[0] + (sx - aabb.left));
        }
        const sy = this._yTop - Math.min(FENCE_WIDTH, inset);
        if (aabb.top + dy < -sy) {
            y = Math.ceil(drawable._position[1] - (sy + aabb.top));
        } else if (aabb.bottom + dy > sy) {
            y = Math.floor(drawable._position[1] + (sy - aabb.bottom));
        }
        return [x, y];
    }

    /**
     * Clear a pen layer.
     * @param {int} penSkinID - the unique ID of a Pen Skin.
     */
    penClear (penSkinID) {
        const skin = /** @type {PenSkin} */ this._allSkins[penSkinID];
        skin.clear();
    }

    /**
     * Draw a point on a pen layer.
     * @param {int} penSkinID - the unique ID of a Pen Skin.
     * @param {PenAttributes} penAttributes - how the point should be drawn.
     * @param {number} x - the X coordinate of the point to draw.
     * @param {number} y - the Y coordinate of the point to draw.
     */
    penPoint (penSkinID, penAttributes, x, y) {
        const skin = /** @type {PenSkin} */ this._allSkins[penSkinID];
        skin.drawPoint(penAttributes, x, y);
    }

    /**
     * Draw a line on a pen layer.
     * @param {int} penSkinID - the unique ID of a Pen Skin.
     * @param {PenAttributes} penAttributes - how the line should be drawn.
     * @param {number} x0 - the X coordinate of the beginning of the line.
     * @param {number} y0 - the Y coordinate of the beginning of the line.
     * @param {number} x1 - the X coordinate of the end of the line.
     * @param {number} y1 - the Y coordinate of the end of the line.
     */
    penLine (penSkinID, penAttributes, x0, y0, x1, y1) {
        const skin = /** @type {PenSkin} */ this._allSkins[penSkinID];
        skin.drawLine(penAttributes, x0, y0, x1, y1);
    }

    /**
     * Stamp a Drawable onto a pen layer.
     * @param {int} penSkinID - the unique ID of a Pen Skin.
     * @param {int} stampID - the unique ID of the Drawable to use as the stamp.
     */
    penStamp (penSkinID, stampID) {
        const stampDrawable = this._allDrawables[stampID];
        if (!stampDrawable) {
            return;
        }

        const bounds = this._touchingBounds(stampID);
        if (!bounds) {
            return;
        }

        const skin = /** @type {PenSkin} */ this._allSkins[penSkinID];

        this._drawThese([stampID], this._projection, {ignoreVisibility: true, dstCanvas: skin._canvas});
    }

    /* ******
     * Truly internal functions: these support the functions above.
     ********/

    /**
     * Respond to a change in the "native" rendering size. The native size is used by buffers which are fixed in size
     * regardless of the size of the main render target. This includes the buffers used for queries such as picking and
     * color-touching. The fixed size allows (more) consistent behavior across devices and presentation modes.
     * @param {object} event - The change event.
     * @private
     */
    onNativeSizeChanged () {
        
    }

    /**
     * Draw a set of Drawables, by drawable ID
     * @param {Array<int>} drawables The Drawable IDs to draw, possibly this._drawList.
     * @param {module:matrix.mat2d} projection The projection matrix to use.
     * @param {object} [opts] Options for drawing
     * @param {idFilterFunc} opts.filter An optional filter function.
     * @param {int} opts.effectMask Bitmask for effects to allow
     * @param {boolean} opts.ignoreVisibility Draw all, despite visibility (e.g. stamping, touching color) TODO
     * @param {HTMLCanvasElement} opts.dstCanvas The destination canvas to draw to
     * @private
     */
    _drawThese (drawables, projection, opts = {}) {
        let ctx;
        if (opts.dstCanvas) {
            ctx = opts.dstCanvas.getContext('2d');
        } else {
            //ctx = this.ctx;
            console.warn('No canvas specified');
        }

        ctx.save();
        ctx.imageSmoothingEnabled = false;

        const mat = matrix.mat2d.create();
        
        for (let drawableIndex = 0; drawableIndex < drawables.length; ++drawableIndex) {
            const drawableID = drawables[drawableIndex];

            // If we have a filter, check whether the ID fails
            if (opts.filter && !opts.filter(drawableID)) continue;

            const drawable = this._allDrawables[drawableID];
            /** @todo check if drawable is inside the viewport before anything else */

            // Hidden drawables (e.g., by a "hide" block) are not drawn unless
            // the ignoreVisibility flag is used (e.g. for stamping or touchingColor).
            if (!drawable.getVisible() && !opts.ignoreVisibility) continue;

            // Combine drawable scale with the native vs. backing pixel ratio
            const drawableScale = [
                drawable.scale[0] * ctx.canvas.width / this._nativeSize[0],
                drawable.scale[1] * ctx.canvas.height / this._nativeSize[1]
            ];

            // If the skin or texture isn't ready yet, skip it.
            if (!drawable.skin || !drawable.skin.getTexture(drawableScale)) continue;

            let effectBits = drawable.getEnabledEffects();
            effectBits &= opts.hasOwnProperty('effectMask') ? opts.effectMask : effectBits;

            let tex = drawable.skin.getTexture(drawableScale);

            ctx.save();

            // Ghost effect
            if ((effectBits & ShaderManager.EFFECT_INFO.ghost.mask) !== 0) {
                ctx.globalAlpha = drawable._effects[ShaderManager.EFFECT_INFO.ghost.uniformName];
            }

            // Color effect
            if ((effectBits & ShaderManager.EFFECT_INFO.color.mask) !== 0) {
                const tmpCtx = this._tempCanvasCtx;
                tmpCtx.width = drawableScale[0];
                tmpCtx.height = drawableScale[1];
                tmpCtx.filter = drawable._effects[ShaderManager.EFFECT_INFO.color.uniformName];
                tmpCtx.clearRect(0, 0, drawableScale[0], drawableScale[1]);
                tmpCtx.drawImage(tex, 0, 0);
                tex = this._tempCanvas;

                if (drawable.skin instanceof SVGSkin) {
                    ctx.imageSmoothingEnabled = true;
                }
            }

            matrix.mat2d.multiply(mat, projection, drawable.getTransform());
            ctx.setTransform(mat[0], mat[1], mat[2], mat[3], mat[4], mat[5]);

            if (tex) {
                ctx.drawImage(tex, 0, 0);
            }

            ctx.restore();
        }

        ctx.restore();
    }

    /**
     * Get the convex hull points for a particular Drawable.
     * To do this, calculate it based on the drawable's Silhouette.
     * @param {int} drawableID The Drawable IDs calculate convex hull for.
     * @return {Array<Array<number>>} points Convex hull points, as [[x, y], ...]
     */
    _getConvexHullPointsForDrawable (drawableID) {
        const drawable = this._allDrawables[drawableID];
        const [width, height] = drawable.skin.size;
        // No points in the hull if invisible or size is 0.
        if (!drawable.getVisible() || width === 0 || height === 0) {
            return [];
        }

        /**
         * Return the determinant of two vectors, the vector from A to B and the vector from A to C.
         *
         * The determinant is useful in this case to know if AC is counter-clockwise from AB.
         * A positive value means that AC is counter-clockwise from AB. A negative value means AC is clockwise from AB.
         *
         * @param {Float32Array} A A 2d vector in space.
         * @param {Float32Array} B A 2d vector in space.
         * @param {Float32Array} C A 2d vector in space.
         * @return {number} Greater than 0 if counter clockwise, less than if clockwise, 0 if all points are on a line.
         */
        const determinant = function (A, B, C) {
            // AB = B - A
            // AC = C - A
            // det (AB BC) = AB0 * AC1 - AB1 * AC0
            return (((B[0] - A[0]) * (C[1] - A[1])) - ((B[1] - A[1]) * (C[0] - A[0])));
        };

        // This algorithm for calculating the convex hull somewhat resembles the monotone chain algorithm.
        // The main difference is that instead of sorting the points by x-coordinate, and y-coordinate in case of ties,
        // it goes through them by y-coordinate in the outer loop and x-coordinate in the inner loop.
        // This gives us "left" and "right" hulls, whereas the monotone chain algorithm gives "top" and "bottom" hulls.

        const leftHull = [];
        const rightHull = [];

        // While convex hull algorithms usually push and pop values from the list of hull points,
        // here, we keep indices for the "last" point in each array. Any points past these indices are ignored.
        // This is functionally equivalent to pushing and popping from a "stack" of hull points.
        let leftEndPointIndex = -1;
        let rightEndPointIndex = -1;

        const _pixelPos = matrix.vec2.create();

        let currentPoint;

        // *Not* Scratch Space-- +y is bottom
        // Loop over all rows of pixels, starting at the top
        for (let y = 0; y < height; y++) {
            _pixelPos[1] = y / height;

            // We start at the leftmost point, then go rightwards until we hit a point
            let x = 0;
            for (; x < width; x++) {
                _pixelPos[0] = x / width;
                if (drawable.skin.isTouchingLinear(_pixelPos)) {
                    currentPoint = [x, y];
                    break;
                }
            }

            // If we managed to loop all the way through, there are no touchable points on this row. Go to the next one
            if (x >= width) {
                continue;
            }

            // Because leftEndPointIndex is initialized to -1, this is skipped for the bottom two rows.
            // It runs only when there are enough points in the left hull to make at least one line.
            // If appending the current point to the left hull makes a counter-clockwise turn,
            // we want to append the current point. Otherwise, we decrement the index of the "last" hull point until the
            // current point makes a counter-clockwise turn.
            // This decrementing has the same effect as popping from the point list, but is hopefully faster.
            while (leftEndPointIndex > 0) {
                if (determinant(leftHull[leftEndPointIndex], leftHull[leftEndPointIndex - 1], currentPoint) > 0) {
                    break;
                } else {
                    // leftHull.pop();
                    --leftEndPointIndex;
                    
                }
            }

            // This has the same effect as pushing to the point list.
            // This "list head pointer" coding style leaves excess points dangling at the end of the list,
            // but that doesn't matter; we simply won't copy them over to the final hull.

            // leftHull.push(currentPoint);
            leftHull[++leftEndPointIndex] = currentPoint;

            // Now we repeat the process for the right side, looking leftwards for a pixel.
            for (x = width - 1; x >= 0; x--) {
                _pixelPos[0] = x / width;
                if (drawable.skin.isTouchingLinear(_pixelPos)) {
                    currentPoint = [x, y];
                    break;
                }
            }

            // Because we're coming at this from the right, it goes clockwise this time.
            while (rightEndPointIndex > 0) {
                if (determinant(rightHull[rightEndPointIndex], rightHull[rightEndPointIndex - 1], currentPoint) < 0) {
                    break;
                } else {
                    --rightEndPointIndex;
                }
            }

            rightHull[++rightEndPointIndex] = currentPoint;
        }

        // Start off "hullPoints" with the left hull points. This is where we get rid of those dangling extra points.
        const hullPoints = leftHull.slice(0, leftEndPointIndex + 1);
        // Add points from the right side in reverse order so all points are ordered clockwise.
        for (let j = rightEndPointIndex; j >= 0; --j) {
            hullPoints.push(rightHull[j]);
        }

        return hullPoints;
    }

    /**
     * Sample a "final" color from an array of drawables at a given scratch space.
     * Will blend any alpha values with the drawables "below" it.
     * @param {matrix.vec2} vec Scratch Vector Space to sample
     * @param {Array<Drawables>} drawables A list of drawables with the "top most"
     *              drawable at index 0
     * @param {Uint8ClampedArray} dst The color3b space to store the answer in.
     * @return {Uint8ClampedArray} The dst vector with everything blended down.
     */
    static sampleColor3b (vec, drawables, dst) {
        dst = dst || new Uint8ClampedArray(3);
        dst.fill(0);
        let blendAlpha = 1;
        for (let index = 0; blendAlpha !== 0 && index < drawables.length; index++) {
            /*
            if (left > vec[0] || right < vec[0] ||
                bottom > vec[1] || top < vec[0]) {
                continue;
            }
            */
            Drawable.sampleColor4b(vec, drawables[index].drawable, __blendColor);
            // if we are fully transparent, go to the next one "down"
            const sampleAlpha = __blendColor[3] / 255;
            // premultiply alpha
            dst[0] += __blendColor[0] * blendAlpha * sampleAlpha;
            dst[1] += __blendColor[1] * blendAlpha * sampleAlpha;
            dst[2] += __blendColor[2] * blendAlpha * sampleAlpha;
            blendAlpha *= (1 - sampleAlpha);
        }
        // Backdrop could be transparent, so we need to go to the "clear color" of the
        // draw scene (white) as a fallback if everything was alpha
        dst[0] += blendAlpha * 255;
        dst[1] += blendAlpha * 255;
        dst[2] += blendAlpha * 255;
        return dst;
    }

    /**
     * @callback RenderCanvas#snapshotCallback
     * @param {string} dataURI Data URI of the snapshot of the renderer
     */

    /**
     * @param {snapshotCallback} callback Function called in the next frame with the snapshot data
     */
    requestSnapshot (callback) {
        this._snapshotCallbacks.push(callback);
    }
}

// :3
RenderCanvas.prototype.canHazPixels = RenderCanvas.prototype.extractDrawable;

module.exports = RenderCanvas;
