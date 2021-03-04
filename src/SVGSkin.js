const Skin = require('./Skin');
const SvgRenderer = require('scratch-svg-renderer').SVGRenderer;
const EffectManager = require('./EffectManager');

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
        this._texture = null;

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
        this._rawRotationCenter = [0, 0];
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

    useNearest (scale, drawable) {
        // If the effect bits for mosaic, pixelate, whirl, or fisheye are set, use linear
        if ((drawable.enabledEffects & (
            EffectManager.EFFECT_INFO.fisheye.mask |
            EffectManager.EFFECT_INFO.whirl.mask |
            EffectManager.EFFECT_INFO.pixelate.mask |
            EffectManager.EFFECT_INFO.mosaic.mask
        )) !== 0) {
            return false;
        }

        // We can't use nearest neighbor unless we are a multiple of 90 rotation
        if (drawable._direction % 90 !== 0) {
            return false;
        }

        // Because SVG skins' bounding boxes are currently not pixel-aligned, the idea here is to hide blurriness
        // by using nearest-neighbor scaling if one screen-space pixel is "close enough" to one texture pixel.
        // If the scale of the skin is very close to 100 (0.99999 variance is okay I guess)
        // TODO: Make this check more precise. We should use nearest if there's less than one pixel's difference
        // between the screen-space and texture-space sizes of the skin. Mipmaps make this harder because there are
        // multiple textures (and hence multiple texture spaces) and we need to know which one to choose.
        if (Math.abs(scale[0]) > 99 && Math.abs(scale[0]) < 101 &&
            Math.abs(scale[1]) > 99 && Math.abs(scale[1]) < 101) {
            return true;
        }
        return false;
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
     * @param {Array<number>} [rotationCenter] - Optional rotation center for the SVG.
     * @fires Skin.event:WasAltered
     */
    setSVG (svgData, rotationCenter) {
        this._svgRenderer.loadSVG(svgData, false, () => {
            this._texture = this._svgRenderer._cachedImage;

            this._silhouette.update(this._texture);

            if (typeof rotationCenter === 'undefined') rotationCenter = this.calculateRotationCenter();
            this._rotationCenter[0] = rotationCenter[0] - this._viewOffset[0];
            this._rotationCenter[1] = rotationCenter[1] - this._viewOffset[1];

            this.emit(Skin.Events.WasAltered);
        });

        // Size must be updated synchronously because the VM sets the costume's
        // `size` immediately after calling this.
        this.size = this._svgRenderer.size;
        this._viewOffset = this._svgRenderer.viewOffset;
        // Reset rawRotationCenter when we update viewOffset. The rotation
        // center used to render will be updated later.
        this._rawRotationCenter = [0, 0];
    }

}

module.exports = SVGSkin;
