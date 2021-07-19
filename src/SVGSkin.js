const Skin = require('./Skin');
const {loadSvgString, serializeSvgToString} = require('scratch-svg-renderer');
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

        /** @type {HTMLImageElement} */
        this._svgImage = document.createElement('img');

        /** @type {boolean} */
        this._svgImageLoaded = false;

        /** @type {Array<number>} */
        this._size = [0, 0];

        /** @type {HTMLCanvasElement} */
        this._canvas = document.createElement('canvas');

        /** @type {CanvasRenderingContext2D} */
        this._context = this._canvas.getContext('2d');

        /**
         * The natural size, in Scratch units, of this skin.
         * @type {Array<number>}
         */
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
        return this._svgImage;
    }

    /**
     * Set the contents of this skin to a snapshot of the provided SVG data.
     * @param {string} svgData - new SVG to use.
     * @param {Array<number>} [rotationCenter] - Optional rotation center for the SVG.
     * @fires Skin.event:WasAltered
     */
    setSVG (svgData, rotationCenter) {
        const svgTag = loadSvgString(svgData);
        const svgText = serializeSvgToString(svgTag, true /* shouldInjectFonts */);
        this._svgImageLoaded = false;


        const {x, y, width, height} = svgTag.viewBox.baseVal;
        this.size[0] = width;
        this.size[1] = height;

        this._svgImage.onload = () => {

            if (width === 0 || height === 0) {
                super.setEmptyImageData();
                return;
            }

            if (typeof rotationCenter === 'undefined') rotationCenter = this.calculateRotationCenter();
            // Compensate for viewbox offset.
            // See https://github.com/LLK/scratch-render/pull/90.
            this._rotationCenter[0] = rotationCenter[0] - x;
            this._rotationCenter[1] = rotationCenter[1] - y;

            this._svgImageLoaded = true;

            this.emit(Skin.Events.WasAltered);
        };

        this._svgImage.src = `data:image/svg+xml;utf8,${encodeURIComponent(svgText)}`;
    }

}

module.exports = SVGSkin;
