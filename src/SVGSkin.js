const Skin = require('./Skin');
const SvgRenderer = require('scratch-svg-renderer').SVGRenderer;

class SVGSkin extends Skin {
    /**
     * Create a new SVG skin.
     * @param {!int} id - The ID for this Skin.
     * @param {!RenderCanvas} renderer - The renderer which will use this skin.
     * @constructor
     * @extends Skin
     */
    constructor (id, renderer) {
        super(id);

        /** @type {RenderCanvas} */
        this._renderer = renderer;

        /** @type {SvgRenderer} */
        this._svgRenderer = new SvgRenderer();

        /** @type {HTMLImageElement} */
        this._texture = document.createElement('img');

        /**
         * The natural size, in Scratch units, of this skin.
         * @type {Array<number>}
         */
        this.size = [0, 0];

        /**
         * The viewbox offset of the svg.
         * @type {Array<number>}
         */
        this._viewOffset = [0, 0];

        /**
         * The rotation center before offset by _viewOffset.
         * @type {Array<number>}
         */
        this._rawRotationCenter = [NaN, NaN];
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
     * Set the origin, in object space, about which this Skin should rotate.
     * @param {number} x - The x coordinate of the new rotation center.
     * @param {number} y - The y coordinate of the new rotation center.
     */
    setRotationCenter (x, y) {
        if (x !== this._rawRotationCenter[0] || y !== this._rawRotationCenter[1]) {
            this._rawRotationCenter[0] = x;
            this._rawRotationCenter[1] = y;
            super.setRotationCenter(x - this._viewOffset[0], y - this._viewOffset[1]);
        }
    }

    /**
     * @param {Array<number>} scale - The scaling factors to be used, each in the [0,100] range.
     * @return {HTMLImageElement} The texture representation of this skin when drawing at the given scale.
     */
    // eslint-disable-next-line no-unused-vars
    getTexture (scale) {
        return this._texture;
    }

    /**
     * Set the contents of this skin to a snapshot of the provided SVG data.
     * @param {string} svgData - new SVG to use.
     * @param {Array<number>} [rotationCenter] - Optional rotation center for the SVG. If not supplied, it will be
     * calculated from the bounding box
     * @fires Skin.event:WasAltered
     */
    setSVG (svgData, rotationCenter) {
        this._svgRenderer.fromString(svgData, 1, () => {
            this._texture.src = `data:image/svg+xml;utf8,${encodeURIComponent(this._svgRenderer.toString(true))}`;

            this._texture.onload = () => {
                this._silhouette.update(this._texture);

                if (typeof rotationCenter === 'undefined') rotationCenter = this.calculateRotationCenter();
                this.size = this._svgRenderer.size;
                this._viewOffset = this._svgRenderer.viewOffset;
                // Reset rawRotationCenter when we update viewOffset.
                this._rawRotationCenter = [NaN, NaN];
                this.setRotationCenter(rotationCenter[0], rotationCenter[1]);
                this.emit(Skin.Events.WasAltered);
            };
            
        });
    }

}

module.exports = SVGSkin;
