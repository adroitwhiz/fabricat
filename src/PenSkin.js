const twgl = require('twgl.js');

const RenderConstants = require('./RenderConstants');
const Skin = require('./Skin');

const Rectangle = require('./Rectangle');
const ShaderManager = require('./ShaderManager');

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


/**
 * Reused memory location for projection matrices.
 * @type {FloatArray}
 */
const __projectionMatrix = twgl.m4.identity();

/**
 * Reused memory location for translation matrix for building a model matrix.
 * @type {FloatArray}
 */
const __modelTranslationMatrix = twgl.m4.identity();

/**
 * Reused memory location for rotation matrix for building a model matrix.
 * @type {FloatArray}
 */
const __modelRotationMatrix = twgl.m4.identity();

/**
 * Reused memory location for scaling matrix for building a model matrix.
 * @type {FloatArray}
 */
const __modelScalingMatrix = twgl.m4.identity();

/**
 * Reused memory location for a model matrix.
 * @type {FloatArray}
 */
const __modelMatrix = twgl.m4.identity();

/**
 * Reused memory location for a vector to create a translation matrix from.
 * @type {FloatArray}
 */
const __modelTranslationVector = twgl.v3.create();

/**
 * Reused memory location for a vector to create a scaling matrix from.
 * @type {FloatArray}
 */
const __modelScalingVector = twgl.v3.create();

class PenSkin extends Skin {
    /**
     * Create a Skin which implements a Scratch pen layer.
     * @param {int} id - The unique ID for this Skin.
     * @param {RenderWebGL} renderer - The renderer which will use this Skin.
     * @extends Skin
     * @listens RenderWebGL#event:NativeSizeChanged
     */
    constructor (id, renderer) {
        super(id);

        /**
         * @private
         * @type {RenderWebGL}
         */
        this._renderer = renderer;

        /** @type {HTMLCanvasElement} */
        this._canvas = document.createElement('canvas');

        /** @type {WebGLTexture} */
        this._texture = null;

        /** @type {WebGLTexture} */
        this._exportTexture = null;

        /** @type {WebGLFramebuffer} */
        this._framebuffer = null;

        /** @type {WebGLFramebuffer} */
        this._silhouetteBuffer = null;

        /** @type {boolean} */
        this._canvasDirty = false;

        /** @type {boolean} */
        this._silhouetteDirty = false;

        /** @type {object} */
        this._lineOnBufferDrawRegionId = {
            enter: () => this._enterDrawLineOnBuffer(),
            exit: () => this._exitDrawLineOnBuffer()
        };

        /** @type {object} */
        this._toBufferDrawRegionId = {
            enter: () => this._enterDrawToBuffer(),
            exit: () => this._exitDrawToBuffer()
        };

        /** @type {twgl.BufferInfo} */
        this._lineBufferInfo = null;

        const NO_EFFECTS = 0;
        /** @type {twgl.ProgramInfo} */
        this._stampShader = this._renderer._shaderManager.getShader(ShaderManager.DRAW_MODE.stamp, NO_EFFECTS);

        /** @type {twgl.ProgramInfo} */
        this._lineShader = this._renderer._shaderManager.getShader(ShaderManager.DRAW_MODE.lineSample, NO_EFFECTS);

        this._createLineGeometry();

        this.onNativeSizeChanged = this.onNativeSizeChanged.bind(this);
        this._renderer.on(RenderConstants.Events.NativeSizeChanged, this.onNativeSizeChanged);

        this._setCanvasSize(renderer.getNativeSize());
    }

    /**
     * Dispose of this object. Do not use it after calling this method.
     */
    dispose () {
        this._renderer.removeListener(RenderConstants.Events.NativeSizeChanged, this.onNativeSizeChanged);
        this._renderer.gl.deleteTexture(this._texture);
        this._renderer.gl.deleteTexture(this._exportTexture);
        this._texture = null;
        super.dispose();
    }

    /**
     * @returns {boolean} true for a raster-style skin (like a BitmapSkin), false for vector-style (like SVGSkin).
     */
    get isRaster () {
        return true;
    }

    /**
     * @return {Array<number>} the "native" size, in texels, of this skin. [width, height]
     */
    get size () {
        return [this._canvas.width, this._canvas.height];
    }

    /**
     * @return {WebGLTexture} The GL texture representation of this skin when drawing at the given size.
     * @param {int} pixelsWide - The width that the skin will be rendered at, in GPU pixels.
     * @param {int} pixelsTall - The height that the skin will be rendered at, in GPU pixels.
     */
    // eslint-disable-next-line no-unused-vars
    getTexture (pixelsWide, pixelsTall) {
        if (this._canvasDirty) {
            this._drawToBuffer();
        }

        return this._exportTexture;
    }

    /**
     * Clear the pen layer.
     */
    clear () {
        const gl = this._renderer.gl;
        twgl.bindFramebufferInfo(gl, this._framebuffer);

        gl.clearColor(1, 1, 1, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        const ctx = this._canvas.getContext('2d');
        ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);

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
        this._drawLineOnBuffer(
            penAttributes,
            this._rotationCenter[0] + x0, this._rotationCenter[1] - y0,
            this._rotationCenter[0] + x1, this._rotationCenter[1] - y1
        );

        this._silhouetteDirty = true;
    }

    /**
     * Create 2D geometry for drawing lines to a framebuffer.
     */
    _createLineGeometry () {
        const quads = {
            a_position: {
                numComponents: 2,
                data: [
                    -1, -1,
                    1, -1,
                    -1, 1,
                    -1, 1,
                    1, -1,
                    1, 1
                ]
            },
            a_texCoord: {
                numComponents: 2,
                data: [
                    1, 0,
                    0, 0,
                    1, 1,
                    1, 1,
                    0, 0,
                    0, 1
                ]
            }
        };

        this._lineBufferInfo = twgl.createBufferInfoFromArrays(this._renderer.gl, quads);
    }

    /**
     * Prepare to draw lines in the _lineOnBufferDrawRegionId region.
     */
    _enterDrawLineOnBuffer () {
        const gl = this._renderer.gl;

        const bounds = this._bounds;
        const currentShader = this._lineShader;
        const projection = twgl.m4.ortho(0, bounds.width, 0, bounds.height, -1, 1, __projectionMatrix);

        twgl.bindFramebufferInfo(gl, this._framebuffer);

        // Needs a blend function that blends a destination that starts with
        // no alpha.
        gl.blendFuncSeparate(
            gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA,
            gl.ONE, gl.ONE_MINUS_SRC_ALPHA
        );

        gl.viewport(0, 0, bounds.width, bounds.height);

        gl.useProgram(currentShader.program);

        twgl.setBuffersAndAttributes(gl, currentShader, this._lineBufferInfo);

        const uniforms = {
            u_skin: this._texture,
            u_projectionMatrix: projection,
            u_fudge: 0
        };

        twgl.setUniforms(currentShader, uniforms);
    }

    /**
     * Return to a base state from _lineOnBufferDrawRegionId.
     */
    _exitDrawLineOnBuffer () {
        const gl = this._renderer.gl;

        gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);

        twgl.bindFramebufferInfo(gl, null);
    }

    /**
     * Draw a line on the framebuffer.
     * @param {PenAttributes} penAttributes - how the line should be drawn.
     * @param {number} x0 - the X coordinate of the beginning of the line.
     * @param {number} y0 - the Y coordinate of the beginning of the line.
     * @param {number} x1 - the X coordinate of the end of the line.
     * @param {number} y1 - the Y coordinate of the end of the line.
     */
    _drawLineOnBuffer (penAttributes, x0, y0, x1, y1) {
        const gl = this._renderer.gl;

        const currentShader = this._lineShader;

        this._renderer.enterDrawRegion(this._lineOnBufferDrawRegionId);

        const radius = penAttributes.diameter / 2;

        // Clip drawn polygon to line's AABB.
        // Possible TODO: Make this tighter by calculating *actual* bounding box (not axis-aligned)?
        const transformMatrix = twgl.m4.identity();

        const left = Math.floor(Math.min(x0, x1) - radius) - 1;
        const right = Math.ceil(Math.max(x0, x1) + radius) + 1;
        const top = Math.floor(Math.min(y0, y1) - radius) - 1;
        const bottom = Math.floor(Math.max(y0, y1) + radius) + 1;

        twgl.m4.translate(transformMatrix, [(left / 240) - 1, (top / 180) - 1, 0], transformMatrix);
        twgl.m4.scale(transformMatrix, [(right - left) / 480, (bottom - top) / 360, 1], transformMatrix);
        twgl.m4.translate(transformMatrix, [1, 1, 0], transformMatrix);

        // All line-drawing work is done via shader--pass these parameters into it.
        const uniforms = {
            u_modelMatrix: transformMatrix,
            u_lineColor: penAttributes.color4f || DefaultPenAttributes.color4f,
            u_lineThickness: penAttributes.diameter,
            u_p1: [x0, y0],
            u_p2: [x1, y1],
            u_stageSize: this.size
        };

        twgl.setUniforms(currentShader, uniforms);

        twgl.drawBufferInfo(gl, this._lineBufferInfo, gl.TRIANGLES);

        this._silhouetteDirty = true;
    }

    /**
     * Stamp an image onto the pen layer.
     * @param {HTMLCanvasElement|HTMLImageElement|HTMLVideoElement} stampElement - the element to use as the stamp.
     * @param {number} x - the X coordinate of the stamp to draw.
     * @param {number} y - the Y coordinate of the stamp to draw.
     */
    drawStamp (stampElement, x, y) {
        const ctx = this._canvas.getContext('2d');

        ctx.drawImage(stampElement, this._rotationCenter[0] + x, this._rotationCenter[1] - y);

        this._canvasDirty = true;
        this._silhouetteDirty = true;
    }

    /**
     * Enter a draw region to draw a rectangle.
     *
     * Multiple calls with the same regionId skip the callback reducing the
     * amount of GL state changes.
     * @param {twgl.ProgramInfo} currentShader - program info to draw rectangle
     *   with
     * @param {Rectangle} bounds - viewport bounds to draw in
     *   region
     */
    _drawRectangleRegionEnter (currentShader, bounds) {
        const gl = this._renderer.gl;

        gl.viewport(0, 0, bounds.width, bounds.height);

        gl.useProgram(currentShader.program);
        twgl.setBuffersAndAttributes(gl, currentShader, this._renderer._bufferInfo);
    }

    /**
     * Draw a rectangle.
     * @param {twgl.ProgramInfo} currentShader - program info to draw rectangle
     *   with
     * @param {WebGLTexture} texture - texture to draw
     * @param {Rectangle} bounds - bounded area to draw in
     * @param {number} x - centered at x
     * @param {number} y - centered at y
     */
    _drawRectangle (currentShader, texture, bounds, x = -this._canvas.width / 2, y = this._canvas.height / 2) {
        const gl = this._renderer.gl;

        const projection = twgl.m4.ortho(
            bounds.left, bounds.right, bounds.top, bounds.bottom, -1, 1,
            __projectionMatrix
        );

        const uniforms = {
            u_skin: texture,
            u_projectionMatrix: projection,
            u_modelMatrix: twgl.m4.multiply(
                twgl.m4.translation(twgl.v3.create(
                    -x - (bounds.width / 2),
                    -y + (bounds.height / 2),
                    0
                ), __modelTranslationMatrix),
                twgl.m4.scaling(twgl.v3.create(
                    bounds.width,
                    bounds.height,
                    0
                ), __modelScalingMatrix),
                __modelMatrix
            ),
            u_fudge: 0
        };

        twgl.setTextureParameters(gl, texture, {minMag: gl.NEAREST});
        twgl.setUniforms(currentShader, uniforms);

        twgl.drawBufferInfo(gl, this._renderer._bufferInfo, gl.TRIANGLES);
    }

    /**
     * Prepare to draw a rectangle in the _toBufferDrawRegionId region.
     */
    _enterDrawToBuffer () {
        const gl = this._renderer.gl;

        twgl.bindFramebufferInfo(gl, this._framebuffer);

        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

        this._drawRectangleRegionEnter(this._stampShader, this._bounds);
    }

    /**
     * Return to a base state from _toBufferDrawRegionId.
     */
    _exitDrawToBuffer () {
        const gl = this._renderer.gl;

        gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);

        twgl.bindFramebufferInfo(gl, null);
    }

    /**
     * Draw the input texture to the framebuffer.
     * @param {WebGLTexture} texture - input texture to draw
     * @param {number} x - texture centered at x
     * @param {number} y - texture centered at y
     */
    _drawToBuffer (texture = this._texture, x = -this._canvas.width / 2, y = this._canvas.height / 2) {
        if (texture !== this._texture && this._canvasDirty) {
            this._drawToBuffer();
        }

        const gl = this._renderer.gl;

        // If the input texture is the one that represents the pen's canvas
        // layer, update the texture with the canvas data.
        if (texture === this._texture) {
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this._canvas);

            const ctx = this._canvas.getContext('2d');
            ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);

            this._canvasDirty = false;
        }

        const currentShader = this._stampShader;
        const bounds = this._bounds;

        this._renderer.enterDrawRegion(this._toBufferDrawRegionId);

        this._drawRectangle(currentShader, texture, bounds, x, y);

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

        const gl = this._renderer.gl;

        this._bounds = new Rectangle();
        this._bounds.initFromBounds(width / 2, width / -2, height / 2, height / -2);

        this._canvas.width = width;
        this._canvas.height = height;
        this._rotationCenter[0] = width / 2;
        this._rotationCenter[1] = height / 2;

        this._texture = twgl.createTexture(
            gl,
            {
                auto: true,
                mag: gl.NEAREST,
                min: gl.NEAREST,
                wrap: gl.CLAMP_TO_EDGE,
                src: this._canvas
            }
        );

        this._exportTexture = twgl.createTexture(
            gl,
            {
                auto: true,
                mag: gl.NEAREST,
                min: gl.NEAREST,
                wrap: gl.CLAMP_TO_EDGE,
                width,
                height
            }
        );

        const attachments = [
            {
                format: gl.RGBA,
                attachment: this._exportTexture
            }
        ];
        if (this._framebuffer) {
            twgl.resizeFramebufferInfo(gl, this._framebuffer, attachments, width, height);
            twgl.resizeFramebufferInfo(gl, this._silhouetteBuffer, [{format: gl.RGBA}], width, height);
        } else {
            this._framebuffer = twgl.createFramebufferInfo(gl, attachments, width, height);
            this._silhouetteBuffer = twgl.createFramebufferInfo(gl, [{format: gl.RGBA}], width, height);
        }

        gl.clearColor(1, 1, 1, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        this._silhouetteDirty = true;
    }

    /**
     * If there have been pen operations that have dirtied the canvas, update
     * now before someone wants to use our silhouette.
     */
    updateSilhouette () {
        if (this._silhouetteDirty) {
            if (this._canvasDirty) {
                this._drawToBuffer();
            }

            // Render export texture to another framebuffer
            const gl = this._renderer.gl;

            const bounds = this._bounds;

            this._renderer.enterDrawRegion(this._toBufferDrawRegionId);

            // Sample the framebuffer's pixels into the silhouette instance
            const skinPixels = new Uint8Array(Math.floor(this._canvas.width * this._canvas.height * 4));
            gl.readPixels(0, 0, this._canvas.width, this._canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, skinPixels);

            const skinCanvas = this._canvas;
            skinCanvas.width = bounds.width;
            skinCanvas.height = bounds.height;

            const skinContext = skinCanvas.getContext('2d');
            const skinImageData = skinContext.createImageData(bounds.width, bounds.height);
            skinImageData.data.set(skinPixels);
            skinContext.putImageData(skinImageData, 0, 0);

            this._silhouette.update(this._canvas);

            this._silhouetteDirty = false;
        }
    }
}

module.exports = PenSkin;
