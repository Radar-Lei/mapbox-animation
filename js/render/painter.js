'use strict';

var browser = require('../util/browser');
var mat4 = require('gl-matrix').mat4;
var FrameHistory = require('./frame_history');
var TilePyramid = require('../source/tile_pyramid');
var EXTENT = require('../data/bucket').EXTENT;
var pixelsToTileUnits = require('../source/pixels_to_tile_units');
var util = require('../util/util');

module.exports = Painter;

var glPolyfill = {
    vertexAttrib2fv: function(attribute, values) {
        this.vertexAttrib2f(attribute, values[0], values[1]);
    },

    vertexAttrib3fv: function(attribute, values) {
        this.vertexAttrib3f(attribute, values[0], values[1], values[2]);
    },

    vertexAttrib4fv: function(attribute, values) {
        this.vertexAttrib4f(attribute, values[0], values[1], values[2], values[3]);
    }
};

/**
 * Initialize a new painter object.
 *
 * @param {Canvas} gl an experimental-webgl drawing context
 */
function Painter(gl, transform) {
    this.gl = util.extend(gl, glPolyfill);
    this.transform = transform;

    this.reusableTextures = {};
    this.preFbos = {};

    this.frameHistory = new FrameHistory();

    this.setup();

    // Within each layer there are multiple distinct z-planes that can be drawn to.
    // This is implemented using the WebGL depth buffer.
    this.numSublayers = TilePyramid.maxUnderzooming + TilePyramid.maxOverzooming + 1;
    this.depthEpsilon = 1 / Math.pow(2, 16);

    this.lineWidthRange = gl.getParameter(gl.ALIASED_LINE_WIDTH_RANGE);
}

util.extend(Painter.prototype, require('./painter/use_program'));

/*
 * Update the GL viewport, projection matrix, and transforms to compensate
 * for a new width and height value.
 */
Painter.prototype.resize = function(width, height) {
    var gl = this.gl;

    this.width = width * browser.devicePixelRatio;
    this.height = height * browser.devicePixelRatio;
    gl.viewport(0, 0, this.width, this.height);

};


Painter.prototype.setup = function() {
    var gl = this.gl;

    gl.verbose = true;

    // We are blending the new pixels *behind* the existing pixels. That way we can
    // draw front-to-back and use then stencil buffer to cull opaque pixels early.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    gl.enable(gl.STENCIL_TEST);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);

    this._depthMask = false;
    gl.depthMask(false);

    this.identityMatrix = mat4.create();

    // The backgroundBuffer is used when drawing to the full *canvas*
    this.backgroundBuffer = gl.createBuffer();
    this.backgroundBuffer.itemSize = 2;
    this.backgroundBuffer.itemCount = 4;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.backgroundBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Int16Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    // The tileExtentBuffer is used when drawing to a full *tile*
    this.tileExtentBuffer = gl.createBuffer();
    this.tileExtentBuffer.itemSize = 4;
    this.tileExtentBuffer.itemCount = 4;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.tileExtentBuffer);
    gl.bufferData(
        gl.ARRAY_BUFFER,
        new Int16Array([
            // tile coord x, tile coord y, texture coord x, texture coord y
            0, 0, 0, 0,
            EXTENT, 0, 32767, 0,
            0, EXTENT, 0, 32767,
            EXTENT, EXTENT,  32767, 32767
        ]),
        gl.STATIC_DRAW);

    // The debugBuffer is used to draw tile outlines for debugging
    this.debugBuffer = gl.createBuffer();
    this.debugBuffer.itemSize = 2;
    this.debugBuffer.itemCount = 5;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.debugBuffer);
    gl.bufferData(
        gl.ARRAY_BUFFER,
        new Int16Array([
            0, 0, EXTENT, 0, EXTENT, EXTENT, 0, EXTENT, 0, 0]),
        gl.STATIC_DRAW);

    // The debugTextBuffer is used to draw tile IDs for debugging
    this.debugTextBuffer = gl.createBuffer();
    this.debugTextBuffer.itemSize = 2;
};

/*
 * Reset the color buffers of the drawing canvas.
 */
Painter.prototype.clearColor = function() {
    var gl = this.gl;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
};

/*
 * Reset the drawing canvas by clearing the stencil buffer so that we can draw
 * new tiles at the same location, while retaining previously drawn pixels.
 */
Painter.prototype.clearStencil = function() {
    var gl = this.gl;
    gl.clearStencil(0x0);
    gl.stencilMask(0xFF);
    gl.clear(gl.STENCIL_BUFFER_BIT);
};

Painter.prototype.clearDepth = function() {
    var gl = this.gl;
    gl.clearDepth(1);
    this.depthMask(true);
    gl.clear(gl.DEPTH_BUFFER_BIT);
};

Painter.prototype._renderTileClippingMasks = function(coords) {
    var gl = this.gl;
    gl.colorMask(false, false, false, false);
    this.depthMask(false);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.STENCIL_TEST);

    // Only write clipping IDs to the last 5 bits. The first three are used for drawing fills.
    gl.stencilMask(0xF8);
    // Tests will always pass, and ref value will be written to stencil buffer.
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);

    var idNext = 1;
    this._tileClippingMaskIDs = {};
    for (var i = 0; i < coords.length; i++) {
        var coord = coords[i];
        var id = this._tileClippingMaskIDs[coord.id] = (idNext++) << 3;

        gl.stencilFunc(gl.ALWAYS, id, 0xF8);

        var program = this.useProgram('fill', coord.posMatrix);

        // Draw the clipping mask
        gl.bindBuffer(gl.ARRAY_BUFFER, this.tileExtentBuffer);
        gl.vertexAttribPointer(program.a_pos, this.tileExtentBuffer.itemSize, gl.SHORT, false, 8, 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, this.tileExtentBuffer.itemCount);
    }

    gl.stencilMask(0x00);
    gl.colorMask(true, true, true, true);
    this.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
};

Painter.prototype.enableTileClippingMask = function(coord) {
    var gl = this.gl;
    gl.stencilFunc(gl.EQUAL, this._tileClippingMaskIDs[coord.id], 0xF8);
};

// Overridden by headless tests.
Painter.prototype.prepareBuffers = function() {};
Painter.prototype.bindDefaultFramebuffer = function() {
    var gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
};

var draw = {
    symbol: require('./draw_symbol'),
    circle: require('./draw_circle'),
    line: require('./draw_line'),
    fill: require('./draw_fill'),
    raster: require('./draw_raster'),
    background: require('./draw_background'),
    debug: require('./draw_debug')
};

Painter.prototype.render = function(style, options) {
    this.style = style;
    this.options = options;

    this.lineAtlas = style.lineAtlas;

    this.spriteAtlas = style.spriteAtlas;
    this.spriteAtlas.setSprite(style.sprite);

    this.glyphSource = style.glyphSource;

    this.frameHistory.record(this.transform.zoom);

    this.prepareBuffers();
    this.clearColor();
    this.clearDepth();

    this.depthRange = (style._order.length + 2) * this.numSublayers * this.depthEpsilon;

    this.renderPass({isOpaquePass: true});
    this.renderPass({isOpaquePass: false});
};

Painter.prototype.renderPass = function(options) {
    var groups = this.style._groups;
    var isOpaquePass = options.isOpaquePass;
    this.currentLayer = isOpaquePass ? this.style._order.length : -1;

    for (var i = 0; i < groups.length; i++) {
        var group = groups[isOpaquePass ? groups.length - 1 - i : i];
        var source = this.style.sources[group.source];

        var j;
        var coords = [];
        if (source) {
            coords = source.getVisibleCoordinates();
            for (j = 0; j < coords.length; j++) {
                coords[j].posMatrix = this.transform.calculatePosMatrix(coords[j], source.maxzoom);
            }
            this.clearStencil();
            if (source.prepare) source.prepare();
            if (source.isTileClipped) {
                this._renderTileClippingMasks(coords);
            }
        }

        if (isOpaquePass) {
            this.gl.disable(this.gl.BLEND);
            this.isOpaquePass = true;
        } else {
            this.gl.enable(this.gl.BLEND);
            this.isOpaquePass = false;
            coords.reverse();
        }

        for (j = 0; j < group.length; j++) {
            var layer = group[isOpaquePass ? group.length - 1 - j : j];
            this.currentLayer += isOpaquePass ? -1 : 1;
            this.renderLayer(this, source, layer, coords);
        }

        if (source) {
            draw.debug(this, source, coords);
        }
    }
};

Painter.prototype.depthMask = function(mask) {
    if (mask !== this._depthMask) {
        this._depthMask = mask;
        this.gl.depthMask(mask);
    }
};

Painter.prototype.renderLayer = function(painter, source, layer, coords) {
    if (layer.isHidden(this.transform.zoom)) return;
    if (layer.type !== 'background' && !coords.length) return;
    draw[layer.type](painter, source, layer, coords);
};

// Draws non-opaque areas. This is for debugging purposes.
Painter.prototype.drawStencilBuffer = function() {
    var gl = this.gl;
    var program = this.useProgram('fill', this.identityMatrix);

    gl.stencilMask(0x00);
    gl.stencilFunc(gl.EQUAL, 0x80, 0x80);

    // Drw the filling quad where the stencil buffer isn't set.
    gl.bindBuffer(gl.ARRAY_BUFFER, this.backgroundBuffer);
    gl.vertexAttribPointer(program.a_pos, this.backgroundBuffer.itemSize, gl.SHORT, false, 0, 0);

    gl.uniform4fv(program.u_color, [0, 0, 0, 0.5]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, this.tileExtentBuffer.itemCount);
};

Painter.prototype.setDepthSublayer = function(n) {
    var farDepth = 1 - ((1 + this.currentLayer) * this.numSublayers + n) * this.depthEpsilon;
    var nearDepth = farDepth - 1 + this.depthRange;
    this.gl.depthRange(nearDepth, farDepth);
};

Painter.prototype.translatePosMatrix = function(matrix, tile, translate, anchor) {
    if (!translate[0] && !translate[1]) return matrix;

    if (anchor === 'viewport') {
        var sinA = Math.sin(-this.transform.angle);
        var cosA = Math.cos(-this.transform.angle);
        translate = [
            translate[0] * cosA - translate[1] * sinA,
            translate[0] * sinA + translate[1] * cosA
        ];
    }

    var translation = [
        pixelsToTileUnits(tile, translate[0], this.transform.zoom),
        pixelsToTileUnits(tile, translate[1], this.transform.zoom),
        0
    ];

    var translatedMatrix = new Float32Array(16);
    mat4.translate(translatedMatrix, matrix, translation);
    return translatedMatrix;
};

Painter.prototype.saveTexture = function(texture) {
    var textures = this.reusableTextures[texture.size];
    if (!textures) {
        this.reusableTextures[texture.size] = [texture];
    } else {
        textures.push(texture);
    }
};


Painter.prototype.getTexture = function(size) {
    var textures = this.reusableTextures[size];
    return textures && textures.length > 0 ? textures.pop() : null;
};

// Update the matrices if necessary. Note: This relies on object identity!
// This means changing the matrix values without the actual matrix object
// will FAIL to update the matrix properly.
Painter.prototype.setPosMatrix = function(posMatrix) {
    var program = this.currentProgram;
    if (program.posMatrix !== posMatrix) {
        this.gl.uniformMatrix4fv(program.u_matrix, false, posMatrix);
        program.posMatrix = posMatrix;
    }
};

// Update the matrices if necessary. Note: This relies on object identity!
// This means changing the matrix values without the actual matrix object
// will FAIL to update the matrix properly.
Painter.prototype.setExMatrix = function(exMatrix) {
    var program = this.currentProgram;
    if (exMatrix && program.exMatrix !== exMatrix && program.u_exmatrix) {
        this.gl.uniformMatrix4fv(program.u_exmatrix, false, exMatrix);
        program.exMatrix = exMatrix;
    }
};

Painter.prototype.lineWidth = function(width) {
    this.gl.lineWidth(util.clamp(width, this.lineWidthRange[0], this.lineWidthRange[1]));
};
