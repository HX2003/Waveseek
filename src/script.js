// --------------------- Shaders ------------------------ //
// Below is the waveform shader, optimized to render many lines
const waveformShader = `
    struct DisplayUniform {
        width_pixels: u32,
        height_pixels: u32,
        aspect_ratio: f32
    };
    @group(0) @binding(0) var<uniform> display: DisplayUniform;

    struct ParamUniform {
        lower_bound: vec2f,
        length_bound: vec2f, // length_bound is basically upper_bound - lower_bound
        color: vec3f,
        thickness: f32
    };
    @group(0) @binding(1) var<uniform> param: ParamUniform;

    struct VertexShaderInput {
        @location(0) condition: vec2i,
        @location(1) p0: vec2f,
        @location(2) p1: vec2f,
        @builtin(vertex_index) vertex_index: u32
    };
    
    struct VertexShaderOutput {
        @location(0) normal: vec2f,
        @builtin(position) position: vec4f
    };
    
    const ANTIALIAS: f32 = 1.0; // This value (although unconventional) seems to work best

    @vertex
    fn vertexMain(in: VertexShaderInput) -> VertexShaderOutput{                
        let transformed_p0 = mix(vec2f(-1.0), vec2f(1.0), (in.p0 - param.lower_bound) / param.length_bound);
        let transformed_p1 = mix(vec2f(-1.0), vec2f(1.0), (in.p1 - param.lower_bound) / param.length_bound);

        let v = transformed_p1 - transformed_p0;
        let normal = normalize(-vec2f(-v.y, v.x));

        // Define a small triangle in local space (relative to center)
        /*let local = array<vec2f, 4>(
            vec2( -0.01,  0.01), 
            vec2( 0.01,  0.01),
            vec2( 0.01,  -0.01),
            vec2( -0.01, -0.01)
        ); 
        let pos = transformed_p0 + local[in.vertex_index];*/
        
        let pos = transformed_p0 + v * f32(in.condition.x) + normal * vec2f(1.0, display.aspect_ratio) * f32(in.condition.y) * param.thickness;
        var out: VertexShaderOutput;
        out.position = vec4(pos, 0.0, 1.0);
        out.normal = normal * f32(in.condition.y);
        return out;
    }

    @fragment
    fn fragmentMain(in: VertexShaderOutput) -> @location(0) vec4f {
        let alpha = smoothstep(0.0, 1.0, (1.0 - length(in.normal)) * ANTIALIAS);
        return vec4f(param.color, alpha);
    }
`;

// Below is the basicLineShader (which is not used to render lines for the waveforms, see waveformShader instead)
// It will be used to render the vertical / horizontal lines involved in background axes, ticks, and grid lines.
// It has the capability to draw dashed lines too!
// 
// Note that in the vertex shader, I implemented snapping of the lines to pixels to make it pixel perfect
//
// Note that there is no antialiasing
// So use pixel perfect dash_length and dash_gap
const basicLineShader = `
    struct DisplayUniform {
        width_pixels: u32,
        height_pixels: u32,
        aspect_ratio: f32
    };
    @group(0) @binding(0) var<uniform> display: DisplayUniform;
    
    struct VertexShaderInput {
        @location(0) condition: vec2i,
        @location(1) p0: vec2f,
        @location(2) p1: vec2f,
        @location(3) color: vec3f,
        @location(4) thickness: f32,
        @location(5) dash_length: f32,
        @location(6) dash_gap: f32,
        @builtin(vertex_index) vertex_index: u32
    };
    
    struct VertexShaderOutput {
        @location(0) lineVector: vec2f, // how far along the line we are
        @location(1) color: vec3f,
        @location(2) dash_length: f32,
        @location(3) dash_gap: f32,
        
        @builtin(position) position: vec4f
    };
    @vertex
    fn vertexMain(in: VertexShaderInput) -> VertexShaderOutput{
        let v = in.p1 - in.p0;
        let normal = normalize(-vec2f(-v.y, v.x));

        let pos = in.p0 + v * f32(in.condition.x) + normal * vec2f(1.0, display.aspect_ratio) * f32(in.condition.y) * in.thickness;
        var out: VertexShaderOutput;
        out.position = vec4(pos, 0.0, 1.0);
        out.color = in.color;
        out.dash_length = in.dash_length;
        out.dash_gap = in.dash_gap;
        
        if(in.vertex_index == 0 || in.vertex_index == 3) {
            out.lineVector = vec2f(0.0, 0.0);
        } else {
            out.lineVector = v;
        }
        return out;
    }

    @fragment
    fn fragmentMain(in: VertexShaderOutput) -> @location(0) vec4f {
        if(length(in.lineVector) % (in.dash_length + in.dash_gap) < in.dash_length) {
            return vec4f(in.color, 1.0);
        }

        return vec4f(0.0, 0.0, 0.0, 0.0);
    }
`;

// --------------------- Constants ---------------------- //
const MAX_EXPONENT = 15; // set limits due to floating point (64 bit) errors
const MIN_EXPONENT = -15; // set limits due to floating point (64 bit) errors
const NUM_DIV_Y = 8;
const NUM_SNAP_PER_DIV_Y = 20;
const NUM_MINOR_TICKS_PER_DIV_Y = 5;
const NUM_MINOR_TICKS_Y = NUM_DIV_Y * NUM_MINOR_TICKS_PER_DIV_Y;
const NUM_DIV_X = 10;
const NUM_SNAP_PER_DIV_X = 50;
const NUM_MINOR_TICKS_PER_DIV_X = 5;
const NUM_MINOR_TICKS_X = NUM_DIV_X * NUM_MINOR_TICKS_PER_DIV_X;
const TICK_LENGTH = 0.01;

// The default formatting for labels that require less resolution/digits/decimal places
const FORMAT_NUM_DP_LOWRES = 2;
const FORMAT_MAX_DIGITS_LOWRES = 4;

// The default formatting for labels that require more resolution/digits/decimal places
const FORMAT_NUM_DP_HIGHRES = 3;
const FORMAT_MAX_DIGITS_HIGHRES = 5;

// --------------------- Utilities ---------------------- //
// https://webgpufundamentals.org/webgpu/lessons/webgpu-resizing-the-canvas.html
// https://webgpu.github.io/webgpu-samples/?sample=resizeObserverHDDPI#main.ts
// https://web.dev/articles/device-pixel-content-box
function getCanvasSize(entry) {
    let physicalWidth = 0;
    let physicalHeight = 0;

    if (entry.devicePixelContentBoxSize) {
        physicalWidth = entry.devicePixelContentBoxSize[0].inlineSize;
        physicalHeight = entry.devicePixelContentBoxSize[0].blockSize;
    } else {
        physicalWidth = Math.round(entry.contentBoxSize[0].inlineSize * devicePixelRatio);
        physicalHeight = Math.round(entry.contentBoxSize[0].blockSize * devicePixelRatio);
    }

    return {
        physicalWidth: physicalWidth,
        physicalHeight: physicalHeight,
        logicalWidth: entry.contentBoxSize[0].inlineSize,
        logicalHeight: entry.contentBoxSize[0].blockSize,
    }
}

function getNumberString(val, suffix, numDp = 3, max_digits = 5) {
    const minSIBase = -5;
    const maxSIBase = 5;
    const centerIndex = 5;
    const prefixes =  ["f", "p", "n", "u", "m", "", "k", "M", "G", "T", "P"];

    // Special case for zero
    if(val < (10 ** MIN_EXPONENT) && val > -(10 ** MIN_EXPONENT)) {
        return (0).toFixed(numDp) + suffix;
    }

    const base = Math.floor(Math.log10(Math.abs(val)));
    let siBase = (base < 0 ? Math.ceil : Math.floor)(base / 3);
    siBase = Math.max(Math.min(siBase, maxSIBase), minSIBase);

    const prefix = prefixes[siBase + centerIndex];

    // Lets limit the number of decimal places to numDp, and total number of digits to max_digits
    // for example 3.44, 99.77, 234.4
    let str = (val / Math.pow(10, siBase * 3)).toFixed(numDp);

    const isNegative = str < 0;

    const dotIndex = str.indexOf(".");
    if(dotIndex != -1) {
        // Has decimal place
        const maxDigits = max_digits;
        const numWholeDigits = dotIndex - isNegative;
        const numDecimalDigits = str.length - 1 - dotIndex;

        const decimalDigitsToRemove = Math.max(Math.min(numWholeDigits + isNegative + numDecimalDigits - maxDigits, numDecimalDigits), 0);

        str = str.slice(0, str.length - decimalDigitsToRemove);
    }

    return str + prefix + suffix;
}

class ScaleStepper {
    constructor(target = 1) {
        this.bases = [1, 2, 5];
        this.setTo(target);
    }

    // Get current scale value
    getValue() {
        return this.bases[this.baseIndex] * 10 ** this.exponent;
    }

    // Set to smallest scale ≥ target
    setTo(target) {
        const log10 = Math.log10(target);
        this.exponent = Math.floor(log10);
        const normalized = target / 10 ** this.exponent;

        this.baseIndex = this.bases.findIndex(b => b >= normalized);
        if (this.baseIndex === -1) {
            this.baseIndex = 0;
            this.exponent += 1;
        }
    }

    increment() {
        this.baseIndex += 1;
        if (this.baseIndex >= this.bases.length) {
            if(this.exponent < MAX_EXPONENT) {
                this.baseIndex = 0;
                this.exponent += 1;
            } else {
                this.baseIndex -= 1;
            } 
        }
    }

    decrement() {
        this.baseIndex -= 1;
        if (this.baseIndex < 0) {
            if(this.exponent > MIN_EXPONENT) {
                this.baseIndex = this.bases.length - 1;
                this.exponent--;
            } else {
                this.baseIndex += 1;
            }
        }
    }
}

// Handles mouse, touch, scroll wheel events
class DragScrollHandler {
    constructor(element) {
        this._element = element;
        this._startCallback = null;
        this._changeCallback = null;

        this.dragging = false;

        this.startX = 0;
        this.startY = 0;

        this._element.addEventListener("mousedown", this._onStart.bind(this), { passive: false });
        this._element.addEventListener("touchstart", this._onStart.bind(this), { passive: false });
        this._element.addEventListener("wheel", this._onWheel.bind(this), { passive: false });

        window.addEventListener("mousemove", this._onMove.bind(this));
        window.addEventListener("mouseup", this._onEnd.bind(this));

        window.addEventListener("touchmove", this._onMove.bind(this), { passive: false });
        window.addEventListener("touchend", this._onEnd.bind(this), { passive: false });
    }

    /**
    * Registers a callback function to be invoked when
    * when starting a drag
    * 
    * Thereafter you should immediately update this.config with the new scale or offsets
    *
    * @param {function(): void} callback - The callback function to register.
    */
    registerStartCallback(callback) {
        this._startCallback = callback;
    }

    /**
    * Registers a callback function to be invoked during a drag or scroll
    * 
    *
    * @param {function(obj): void} callback - The callback function to register.
    */
    registerChangeCallback(callback) {
        this._changeCallback = callback;
    }

    _onWheel(e) {
        const { x, y } = this._getEventPos(e);

        // Reset the start reference point
        this.startX = x;
        this.startY = y;

        const rect = this._element.getBoundingClientRect();
        
        if(this._changeCallback) {
            this._changeCallback({
                scroll: e.deltaY,
                fracX: (x - rect.left)/rect.width,
                fracY: (y - rect.top)/rect.height
            });
        }

        e.preventDefault();
    }

    _getEventPos(e) {
        if (e.touches) {
            return { x: e.touches[0].clientX, y: e.touches[0].clientY };
        }
        return { x: e.clientX, y: e.clientY };
    }

    _onStart(e) {
        const { x, y } = this._getEventPos(e);
        this.dragging = true;
        this.startX = x;
        this.startY = y;

        if(this._startCallback) {
            this._startCallback();
        }
        
        this.windowEventListener = this._onWheel.bind(this);
        // We want to listen the wheel events for the whole window, when our element has been clicked
        window.addEventListener("wheel", this.windowEventListener, {passive: false, capture: true});
    }

    _onMove(e) {
        if (!this.dragging) return;

        let rect = this._element.getBoundingClientRect();

        // Calculate how far the cursor moved since mouse down / touch started
        // resets on mouse up / touch end / scroll wheel event
        const { x, y } = this._getEventPos(e);
        const dx = x - this.startX;
        const dy = y - this.startY;

        if(this._changeCallback) {
            this._changeCallback({
                fracDeltaX: dx / rect.width,
                fracDeltaY: dy / rect.height
            });
        }

        e.preventDefault(); // Prevent scrolling during touch drag
    }

    _onEnd() {
        this.dragging = false;

        // note {passive: false, capture: true} must be exactly the same how it was specified in addEventListener
        window.removeEventListener("wheel", this.windowEventListener, {passive: false, capture: true}); 
    }
}

class XYDragScrollManager {
    constructor(horizontalAxesScaleElement, verticalAxesScaleElement) {
        // The offsets and scales of the current project and waveform
        this.config = {};
        this.config.offsetX = undefined;
        this.config.offsetY = undefined;
        this.config.scalePerDivX = undefined;
        this.config.scalePerDivY = undefined

        // Used to store the offset on the start of the drag
        this._onStartOffsetX = undefined;
        this._onStartOffsetY = undefined;
        
        // The new calculated offsets
        this._newConfig = {};
        this._newConfig.offsetX = undefined;
        this._newConfig.offsetY = undefined;
        this._newConfig.scalePerDivX = undefined;
        this._newConfig.scalePerDivY = undefined

        this._changeCallback = null;

        this._dragScrollHandlerX = new DragScrollHandler(horizontalAxesScaleElement);
        this._dragScrollHandlerX.registerStartCallback(this._startHandler.bind(this));
        this._dragScrollHandlerX.registerChangeCallback(this._changeHandlerX.bind(this));

        this._dragScrollHandlerY = new DragScrollHandler(verticalAxesScaleElement);
        this._dragScrollHandlerY.registerStartCallback(this._startHandler.bind(this));
        this._dragScrollHandlerY.registerChangeCallback(this._changeHandlerY.bind(this));

        // We may or may not want to implement full dragging of the canvas in the future
        // this.xyDragScrollHandler = new DragScrollHandler(theCanvas);
        // this._startHandler.bind(this)
        // this._changeHandlerXY.bind(this));
    }

    /**
    * Registers a callback function to be invoked when
    * the scale or offset is changed via dragging or scrolling
    * 
    * Thereafter you should immediately update this.config with the new scale or offsets
    *
    * @param {function(obj): void} callback - The callback function to register.
    */
    registerChangeCallback(callback) {
        this._changeCallback = callback;
    }

    _change() {
        if(this._changeCallback) {
            this._changeCallback(this._newConfig);
        }
    }
    
    _startHandler() {
        this._onStartOffsetX = this.config.offsetX;
        this._onStartOffsetY = this.config.offsetY;
    }

    _calcSnap(val, snap_to) { 
        const c = Math.floor(val / snap_to);
        return c * snap_to;
    }

    _changeHandlerX(data) {
        if(data.scroll) {
            const scaleStepper = new ScaleStepper(this.config.scalePerDivX);
            
            // We define the origin to be the center of the screen, which is precisely this.config.offsetX
            const originX = this.config.offsetX;

            const prev_extent = (originX - this.config.offsetX) / scaleStepper.getValue();
            if(data.scroll > 0.000001) {
                // Increase the scale of x-axis by 1 step
                scaleStepper.increment();
            } else if(data.scroll < -0.000001) {
                // Decrease the scale of x-axis by 1 step
                scaleStepper.decrement();
            }
            
            // calculate the new scale and offset
            const newScalePerDivX = scaleStepper.getValue();
            const snapTo = newScalePerDivX / NUM_SNAP_PER_DIV_X;
            const newOffsetX = this._calcSnap(originX - (prev_extent * newScalePerDivX), snapTo);
            
            this._newConfig.offsetX = newOffsetX;
            this._newConfig.offsetY = this.config.offsetY; // not modified
            this._newConfig.scalePerDivX = newScalePerDivX;  
            this._newConfig.scalePerDivY = this.config.scalePerDivY; // not modified
            this._change();
            
            // In case we are in the middle of the drag.
            // and we changed the scale, the offset may have changed
            this._startHandler();
        } else {
            const lengthBoundX = this.config.scalePerDivX * NUM_DIV_X;
            const snapTo = this.config.scalePerDivX / NUM_SNAP_PER_DIV_X;
            const newOffsetX = this._calcSnap(this._onStartOffsetX - data.fracDeltaX * lengthBoundX, snapTo);

            this._newConfig.offsetX = newOffsetX;
            this._newConfig.offsetY = this.config.offsetY; // not modified
            this._newConfig.scalePerDivX = this.config.scalePerDivX; // not modified
            this._newConfig.scalePerDivY = this.config.scalePerDivY; // not modified
            this._change();
        }
    }

    _changeHandlerY(data) {
        if(data.scroll) {
            const scaleStepper = new ScaleStepper(this.config.scalePerDivY);
            
            // We define the origin to be the center of the screen, which is precisely this.config.offsetY
            const originY = this.config.offsetY;

            const prev_extent = (originY - this.config.offsetY) / scaleStepper.getValue();
            if(data.scroll > 0.000001) {
                // Increase the scale of x-axis by 1 step
                scaleStepper.increment();
            } else if(data.scroll < -0.000001) {
                // Decrease the scale of x-axis by 1 step
                scaleStepper.decrement();
            }
            
            // calculate the new scale and offset
            const newScalePerDivY = scaleStepper.getValue();
            const snapTo = newScalePerDivY / NUM_SNAP_PER_DIV_Y;
            const newOffsetY = this._calcSnap(originY - (prev_extent * newScalePerDivY), snapTo);
            
            this._newConfig.offsetX = this.config.offsetX; // not modified 
            this._newConfig.offsetY = newOffsetY;  
            this._newConfig.scalePerDivX = this.config.scalePerDivX; // not modified 
            this._newConfig.scalePerDivY = newScalePerDivY;
            this._change();
            
            // In case we are in the middle of the drag.
            // and we changed the scale, the offset may have changed
            this._startHandler();
        } else {
            const lengthBoundY = this.config.scalePerDivY * NUM_DIV_Y;
            const snapTo = this.config.scalePerDivY / NUM_SNAP_PER_DIV_Y;
            const newOffsetY = this._calcSnap(this._onStartOffsetY - data.fracDeltaY * lengthBoundY, snapTo);
            
            this._newConfig.offsetX = this.config.offsetX;  // not modified
            this._newConfig.offsetY = newOffsetY;
            this._newConfig.scalePerDivX = this.config.scalePerDivX; // not modified
            this._newConfig.scalePerDivY = this.config.scalePerDivY; // not modified
            this._change();
        }
    }
}

// ------------------ UI Templates ---------------------- //
class SmallTag extends HTMLElement {
    constructor() {
        super();
        const shadow = this.attachShadow({ mode: "open" });
        const template = document.getElementById("small-tag-template");
        const content = template.content.cloneNode(true);
    
        shadow.appendChild(content);

        this.contentNode = shadow.getElementById("small-tag-filled");
    }

    static get observedAttributes() {
        return ["content"];
    }

    attributeChangedCallback(attributeName, oldValue, newValue) {
        if(oldValue == newValue) return;

        if(attributeName == "content") {
            this.contentNode.textContent = newValue;
        }
    }
}
window.customElements.define("small-tag", SmallTag);

class QuickGlancePanel extends HTMLElement {
    constructor() {
        super();
        const shadow = this.attachShadow({ mode: "open" });
        const template = document.getElementById("quick-glance-panel-template");
        const content = template.content.cloneNode(true);
        shadow.appendChild(content);

        this.panel = shadow.host;
    }
}
window.customElements.define("quick-glance-panel", QuickGlancePanel);

class ChannelInfoPanel extends HTMLElement {
    constructor() {
        super();
        const shadow = this.attachShadow({ mode: "open" });
        const template = document.getElementById("channel-info-panel-template");
        const content = template.content.cloneNode(true);
            
        shadow.appendChild(content);

        this.panel = shadow.getElementById("panel");
        this.nameNode = shadow.getElementById("name");
        this.scalePerDivYNode = shadow.getElementById("scale-per-div-y");
        this.offsetYNode = shadow.getElementById("offset-y");
    }

    
    static get observedAttributes() {
        return ["name", "scale-per-div-y", "offset-y", "color", "selected"];
    }

    attributeChangedCallback(attributeName, oldValue, newValue) {
        if(oldValue == newValue) return;
        
        switch(attributeName) {
            case "name":
                this.nameNode.setAttribute("content", newValue);
                break;
            case "scale-per-div-y":
                this.scalePerDivYNode.textContent = newValue;
                break;
            case "offset-y":
                this.offsetYNode.textContent = newValue;
                break;
            case "color":
                this.nameNode.style = `color: ${newValue}`;
                break;
            case "selected":
                if (newValue == "true") {
                    this.panel.classList.add("selected");
                } else {
                    this.panel.classList.remove("selected");
                }
            default:
        }
    }
}
window.customElements.define("channel-info-panel", ChannelInfoPanel);


// ------------------ Main Code Classes ------------------ //
class Project {
    constructor(name = "My Project") {
        this.config = {};
        this._waveformsLengthChangeCallback = null;

        this.initEmpty(name);
    }

    /**
    * Registers a callback function to be invoked when the length of the 
    * waveforms array changes.
    *
    * If a new waveform was added, the new Waveform object may be passed to the callback.
    * 
    * @param {function(Waveform | null): void} callback - The callback function to register.
    */
    registerWaveformsLengthChangeCallback(callback) {
        this._waveformsLengthChangeCallback = callback;
    }

    /**
    * Call this to notify when we add or remove a waveform
    */
    _changed(w = null) {
        if(this._waveformsLengthChangeCallback) {
            this._waveformsLengthChangeCallback(w);
        }
    }

    /**
    * Clears the current project and create a new empty project
    *
    * @param {string} name - The name of the new project.
    */
    initEmpty(name) {
        this.config.name = name;
        this.config.scalePerDivX = 1;
        this.config.offsetX = 0;
        this.config.selectedIndex = 0;
        this.waveforms = [];

        this._changed();
    }

    /**
    * Clears the current project and opens a new project from the given URL.
    *
    * @param {string} url - The URL from which to fetch and open the new project.
    */
    async initFromUrl(url) {
        const response = await fetch(url);
        if (response.ok) {
            const arrayBuffer = await response.arrayBuffer();
            this.initFromArrayBuffer(arrayBuffer);
        }
    }

    /**
    * Clears the current project and opens a new project from an ArrayBuffer,
    * it should be in RIFF format 
    *
    * @param {ArrayBuffer} arrayBuffer
    */
    initFromArrayBuffer(arrayBuffer) {
        this.initEmpty("");

        const dataView = new DataView(arrayBuffer);
        const decoder = new TextDecoder();
        const riff = decoder.decode(arrayBuffer.slice(0, 4));
        const fileSize = dataView.getUint32(4, true); // little endian
        const fileType = decoder.decode(arrayBuffer.slice(8, 12));
        
        if (riff !== "RIFF") {
            throw new Error("Invalid RIFF header: expected 'RIFF'");
        }

        if (fileType !== "wask") {
            throw new Error(`Invalid RIFF type: expected 'wask', got '${fileType}'`);
        }

        // We know the first chunk should contain json config
        const projectCfgsChunk = this._parseRIFFSubchunk(arrayBuffer, 12);

        if(projectCfgsChunk.chunkId !== "cfgs") {
            throw new Error(`Invalid RIFF chunk id: expected 'cfgs', got '${projectCfgsChunk.chunkId}'`);
        }

        const projectConfig = JSON.parse(
            decoder.decode(
                new Uint8Array(arrayBuffer, projectCfgsChunk.dataStart, projectCfgsChunk.dataSize)
            )
        );
        
        this.config.name = projectConfig.name;
        this.config.scalePerDivX = projectConfig.scalePerDivX;
        this.config.offsetX = projectConfig.offsetX;
        this.config.selectedIndex = projectConfig.selectedIndex;

        // We know the next chunk should contain a list
        const wavsListchunkOffset = projectCfgsChunk.dataEnd;
        const wavsListchunk = this._parseRIFFListchunk(arrayBuffer, wavsListchunkOffset);

        if(wavsListchunk.listType !== "wavs") {
            throw new Error(`Invalid RIFF listType: expected 'wavs', got '${wavsListchunk.listType}'`);
        }
        let hi = false;
        let waveListchunkOffset = wavsListchunk.dataStart;
        while(waveListchunkOffset < wavsListchunk.dataEnd) {
            const waveListchunk = this._parseRIFFListchunk(arrayBuffer, waveListchunkOffset);
            if(waveListchunk.listType !== "wave") {
                throw new Error(`Invalid RIFF listType: expected 'wave', got '${waveListchunk.listType}'`);
            }

            const waveCfgsChunk = this._parseRIFFSubchunk(arrayBuffer, waveListchunk.dataStart);
            if(waveCfgsChunk.chunkId !== "cfgs") {
                throw new Error(`Invalid RIFF chunk id: expected 'cfgs', got '${waveCfgsChunk.chunkId}'`);
            }

            const waveformConfig = JSON.parse(
                decoder.decode(
                    new Uint8Array(arrayBuffer, waveCfgsChunk.dataStart, waveCfgsChunk.dataSize)
                )
            ); 
            
            const wavdChunk = this._parseRIFFSubchunk(arrayBuffer, waveCfgsChunk.dataEnd);
            if(wavdChunk.chunkId !== "wavd") {
                throw new Error(`Invalid RIFF chunk id: expected 'wavd', got '${wavdChunk.chunkId}'`);
            }

            const w = new Waveform();
            w.config.name = waveformConfig.name;
            w.config.sampleInterval = waveformConfig.sampleInterval;
            w.config.unitY = waveformConfig.unitY;
            w.config.numSamples = waveformConfig.numSamples;
            w.config.offsetX = waveformConfig.offsetX;
            w.config.offsetY = waveformConfig.offsetY;
            w.config.scalePerDivY = waveformConfig.scalePerDivY;
            w.config.colorR = waveformConfig.colorR;
            w.config.colorG = waveformConfig.colorG;
            w.config.colorB = waveformConfig.colorB;

            if(w.config.numSamples * 4 !== wavdChunk.dataSize) {
                throw new Error(`Invalid numSamples`);
            } 
            w.waveformArray = new Float32Array(arrayBuffer, wavdChunk.dataStart, w.config.numSamples); // assumes little endian
            this.waveforms.push(w); 
            this._changed(w);

            waveListchunkOffset = waveListchunk.dataEnd;
        }
        
    }

    /**
    * Adds a waveform from an Siglent CSV format
    *
    * @param {str} text
    */
    addWaveformFromSiglentCsv(text) {
        const w = new Waveform();

        const lines = text.split(/\r?\n/);

        const CSV_INFO_NUM_ROWS = 13;

        const numSamplesStr = (lines[0].split(',')[1]).split(':')[1];
        w.config.numSamples = parseInt(numSamplesStr);
        
        if(w.config.numSamples + CSV_INFO_NUM_ROWS != lines.length) {
            throw Error("numSamples does not match");
        }

        w.config.sampleInterval = parseFloat(lines[1].split(',')[1]);
        w.config.unitY = lines[2].split(',')[1];
        w.config.scalePerDivY = parseFloat(lines[3].split(',')[1]);
        w.config.offsetY = parseFloat(lines[4].split(',')[1]);
        // const unitX = lines[5].split(',')[1]; // not yet implemented
        const scalePerDivX = parseFloat(lines[6].split(',')[1]);
        if(this.waveforms.length == 0) {
            // Use the waveform's scalePerDivX if this is the first one added
            this.scalePerDivX = scalePerDivX;
        }
        // const model = lines[7].split(',')[1]; // not used
        // const serialNo = lines[8].split(',')[1]; // not used
        // const scopeSoftwareVersion = lines[9].split(',')[1]; // not used
        w.config.name = lines[10].split(',')[1];

        // Instead of storing each timestamp,
        // we take the first time to be our offset
        // and since sampleInterval is constant, the timestamp can be calculated later
        w.config.offsetX = parseFloat(lines[CSV_INFO_NUM_ROWS - 1].split(',')[0]);

        
        w.waveformArray = new Float32Array(w.config.numSamples);

        for (let index = CSV_INFO_NUM_ROWS - 1; index < lines.length; index++) {
            const line = lines[index].trim();
            
            const fields = line.split(',');
    
            if (fields.length < 2) continue;

            w.waveformArray[index - CSV_INFO_NUM_ROWS + 1] = parseFloat(fields[1]);
        }
        
        this.waveforms.push(w);

        // Select the latest (this waveform)
        this.config.selectedIndex = this.waveforms.length - 1;

        this._changed(w);
    }

    /**
    * Export the project as a RIFF file
    *
    * The structure of our waveseek file uses the RIFF file specification.
    *   The form is as follows:
    *   """
    *   RIFF ('wask '
    *       CHUNK ('cfgs' (project configuration JSON)),
    *       LIST ('wavs' (list of individual waveforms),
    *           LIST ('wave' (waveform configuration JSON),
    *               CHUNK ('cfgs' (waveform configuration JSON)),
    *               CHUNK ('wavd' (waveform binary data))
    *           ),
    *           LIST ('wave' (waveform configuration JSON),
    *               CHUNK ('cfgs' (waveform configuration JSON)),
    *               CHUNK ('wavd' (waveform binary data))
    *           ),
    *           ...
    *       )
    *   )
    */
    export() {
        const waveformSubchunks = [];

        this.waveforms.forEach(w => {
            const waveformConfigArray = this._jsonToUint8ArrayPadded(w.config);

            const listchunk = this._generateRIFFListchunk("wave", 
                [
                    this._generateRIFFSubchunk("cfgs", waveformConfigArray),
                    this._generateRIFFSubchunk("wavd", w.waveformArray),
                ]
            );
            waveformSubchunks.push(listchunk);
        })

        const projectConfigArray = this._jsonToUint8ArrayPadded(this.config);

        const blob = this._generateRIFF(
            new Blob([
                this._generateRIFFSubchunk("cfgs", projectConfigArray),
                this._generateRIFFListchunk("wavs", waveformSubchunks)
            ])
        );
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = this.config.name + ".waveseek";
        a.click();
        URL.revokeObjectURL(url);
    }

    /**
     * Stringify a javascript object, convert it into Uint8Array 
     * and pad it to a multiple of 4 bytes using whitespaces if neccessary
     *
     * @param {Object} obj - The object to be stringified.
     * @returns {Uint8Array} - The padded Uint8Array
     */
    _jsonToUint8ArrayPadded(obj) {
        const encoder = new TextEncoder();
        const jsonString = JSON.stringify(obj);
        const encoded = encoder.encode(jsonString);
        
        const remainder = encoded.length % 4
        if(remainder == 0) {
            return encoded;
        } else {
            const padding = 4 - remainder;
            return encoder.encode(jsonString + ' '.repeat(padding));
        }
    }

    /**
     * Generates a RIFF subchunk.
     *
     * @param {string} chunkId - 4-character string identifier for the chunk.
     * @param {Uint8Array | Uint32Array} data - Binary data to include in the chunk (must be 4-byte aligned).
     * @returns {Blob} - The subchunk as a Blob.
     */
    _generateRIFFSubchunk(chunkId, data) {
        // In the official RIFF specification, 
        // the data size can be any number of bytes but it will be padded to a multiple of 2 bytes (16 bits)
        // chunk_size does not include the new padded length
        // However, to make it easier and faster for the decoding,
        // we enforce that the provide chunk_size must be a multiple of 4 bytes
        if (chunkId.length !== 4) throw new Error("chunkId must be exactly 4 characters.");
        if (data.byteLength % 4 !== 0) throw new Error("data size must be multiple of 4 bytes");

        const encoder = new TextEncoder();
        const header = new Uint8Array(8);
        const headerView = new DataView(header.buffer);

        const chunkIdUTF8 = encoder.encode(chunkId);
        const dataLength = data.byteLength;

        header.set(chunkIdUTF8, 0); 
        headerView.setUint32(4, dataLength, true); // little endian
        
        // Note the endianess of the data here is based on the platform
        // TODO. As we assume that the platform is little endian
        return new Blob([header, data]);
    }

    /**
    * Parses a RIFF subchunk from an arrayBuffer
    * This is not fully compliant as it assumes that our data size is in multiples of 2 bytes,
    * it does not handle padding
    *
    * @param {ArrayBuffer} arrayBuffer - The entire RIFF buffer.
    * @param {number} offset - Byte offset where the subchunk begins.
    * @returns {{ chunkId: string, dataStart: number, dataEnd: number, nextOffset: number }} - Parsed chunk info.
    */
    _parseRIFFSubchunk(arrayBuffer, offset) {
        const dataView = new DataView(arrayBuffer, offset);

        // Decode 4-byte chunkId
        const chunkIdBytes = new Uint8Array(arrayBuffer, offset, 4);
        const chunkId = new TextDecoder().decode(chunkIdBytes);

        const chunkSize = dataView.getUint32(4, true); // little endian

        const dataStart = offset + 8;
        const dataEnd = dataStart + chunkSize;

        if (dataEnd > arrayBuffer.byteLength) {
            throw new Error(`Subchunk data exceeds ArrayBuffer bounds. chunkId=${chunkId}`);
        }
            
        return {
            chunkId: chunkId,
            dataSize: chunkSize,
            dataStart: dataStart,
            dataEnd: dataEnd
        };
    }

    /**
     * Generates a RIFF LIST subchunk containing subchunks.
     *
     * @param {string} listType - 4-character list type (e.g., 'INFO').
     * @param {Blob[]} subchunks - Array of already-generated subchunk Blobs.
     * @returns {Blob} - The complete LIST chunk as a Blob.
     */
    _generateRIFFListchunk(listType, subchunks) {
        if (listType.length !== 4) throw new Error("listType must be exactly 4 characters.");
        
        const header = new Uint8Array(12);
        const headerView = new DataView(header.buffer);
        const encoder = new TextEncoder();

        const list = encoder.encode("LIST");
        const listTypeUTF8 = encoder.encode(listType);

        const subchunksBlob = new Blob(subchunks);
        const listSize = 4 + subchunksBlob.size; // 4 for listType

        header.set(list, 0);  
        headerView.setUint32(4, listSize, true); // little endian
        header.set(listTypeUTF8, 8);

        return new Blob([header, subchunksBlob]);
    }

    /**
    * Parses a RIFF list subchunk from an arrayBuffer
    * Assumes subchunk begins at the given offset and is properly aligned (4-byte aligned data).
    *
    * @param {ArrayBuffer} arrayBuffer - The entire RIFF buffer.
    * @param {number} offset - Byte offset where the subchunk begins.
    * @returns {{ chunkId: string, dataStart: number, dataEnd: number, nextOffset: number }} - Parsed chunk info.
    */
    _parseRIFFListchunk(arrayBuffer, offset) {
        const dataView = new DataView(arrayBuffer, offset);

        // Decode 4-byte "list" characters
        const listBytes = new Uint8Array(arrayBuffer, offset, 4);
        const list = new TextDecoder().decode(listBytes);
        if(list !== "LIST") {
            throw new Error(`Invalid RIFF list header: expected 'list', got '${list}'`);
        }

        // Decode 4-byte listSize
        const listSize = dataView.getUint32(4, true); // little endian

        // Decode 4-byte listType
        const listTypeBytes = new Uint8Array(arrayBuffer, offset + 8, 4);
        const listType = new TextDecoder().decode(listTypeBytes);
        
        const dataStart = offset + 12;
        const dataEnd = dataStart + listSize - 4;

        if (dataEnd > arrayBuffer.byteLength) {
            throw new Error(`List chunk data exceeds ArrayBuffer bounds. listType=${listType}`);
        }
            
        return {
            listType: listType,
            dataStart: dataStart,
            dataEnd: dataEnd
        };
    }

    /**
     * Generates a complete RIFF file structure using the provided data chunk.
     *
     * @param {Blob} dataBlob - The payload (e.g., LIST chunk or raw data).
     * @returns {Blob} - The complete Blob
     */
    _generateRIFF(dataBlob) {
        const riffHeader = new Uint8Array(12);
        const riffHeaderView = new DataView(riffHeader.buffer);
        const encoder = new TextEncoder();


        // fileSize includes the fileType (4 bytes) and the following data but excludes the 'RIFF' and size 
        const riff = encoder.encode("RIFF");
        const fileType = encoder.encode("wask");
        const fileSize = 4 + dataBlob.size;

        riffHeader.set(riff, 0);
        riffHeaderView.setUint32(4, fileSize, true); // little endian
        riffHeader.set(fileType, 8);

        return new Blob([riffHeader, dataBlob], { type: "application/octet-stream" });
    }
}

class Waveform {
    constructor() {
        this.config = {};
        this.config.numSamples = 0;
        this.config.sampleInterval = 1;
        this.config.scalePerDivY = 1;
        this.config.offsetY = 0;
        this.config.offsetX = 0;
        this.config.name = "My Wave";
        this.config.colorR = 1.0;
        this.config.colorG = 1.0;
        this.config.colorB = 1.0;

        this.waveformArray = null;
        this._waveformVertexArray = null;

        // GPU Related Variables
        this._PARAM_UNIFORM_BYTE_LENGTH = 32;
        this._paramUniformBuffer = null;
        this._waveformBindGroup = null;
        this._waveformVertexBuffer = null;
    } 

    /*
    * Generates a waveformVertexArray for the GPU from the waveformArray.
        Each line is represented by 2 points (x0, y0) and (x1, y1)
        To draw a continous line, we need to generate (x0, y0) and (x1, y1), (x1, y1) and (x2, y2) ... 
    */
    generateWaveformVertexArray() {
        this._waveformVertexArray = new Float32Array(this.config.numSamples * 4);
        for (let i = 0; i < this.config.numSamples - 1; i++) {
            const x0 = this.config.sampleInterval * i;
            const x1 = this.config.sampleInterval * (i + 1);

            this._waveformVertexArray[i * 4 + 0] = x0;
            this._waveformVertexArray[i * 4 + 1] = this.waveformArray[i];

            this._waveformVertexArray[i * 4 + 2] = x1;
            this._waveformVertexArray[i * 4 + 3] = this.waveformArray[i + 1];
        }
    }

    setupGPU({gpuDevice, waveformPipeline, indexBuffer, displayUniformBuffer}) {
        // Setup GPU Buffers 
        this._paramUniformBuffer = gpuDevice.createBuffer({
            label: `Oscilloscope Waveform Param Uniform Buffer [${this.name}]`,
            size: this._PARAM_UNIFORM_BYTE_LENGTH,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        }); 
        
        
        this._waveformBindGroup = gpuDevice.createBindGroup({
            label: `Oscilloscope Waveform Bind Group [${this.name}]`,
            layout: waveformPipeline.getBindGroupLayout(0),
            entries: [{
                binding: 0, 
                resource: { buffer: displayUniformBuffer}
            },
            {
                binding: 1, 
                resource: { buffer: this._paramUniformBuffer}
            }],
        });

        this._waveformVertexBuffer = gpuDevice.createBuffer({
            label: `Oscilloscope Waveforms Vertex Buffer [${this.name}]`,
            size: this._waveformVertexArray.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        
        gpuDevice.queue.writeBuffer(this._waveformVertexBuffer, 0, this._waveformVertexArray);
    }

    // Setup to render the waveform
    // @param gpuRenderPassEncoder The GPU render pass encoder, which must be initialised prior WaveformChannelManager
    render({project, gpuDevice, gpuRenderPassEncoder, waveformPipeline, conditionVertexBuffer, indexBuffer, canvasPhysicalWidth}) { 
        let paramUniformArray = new Float32Array(this._PARAM_UNIFORM_BYTE_LENGTH/4);

        const lengthBoundX = project.config.scalePerDivX * NUM_DIV_X;
        const lengthBoundY = this.config.scalePerDivY * NUM_DIV_Y;

        // Note: project.config.offsetX shifts the viewing window horizontally along the time axis
        // It determines where the center of the timebase view is.
        
        // In contrast, this.config.offsetX shifts the *graph data* itself (not the viewing window).
        // It offsets the signal line on the screen.
        const lowerBoundX = project.config.offsetX - this.config.offsetX - lengthBoundX/2;
        const lowerBoundY = -this.config.offsetY - lengthBoundY/2;

        paramUniformArray[0] = lowerBoundX; // lower_bound_x
        paramUniformArray[1] = lowerBoundY; // lower_bound_y
        paramUniformArray[2] = lengthBoundX; // length_bound_x
        paramUniformArray[3] = lengthBoundY; // length_bound_y
        paramUniformArray[4] = this.config.colorR; 
        paramUniformArray[5] = this.config.colorG; 
        paramUniformArray[6] = this.config.colorB;
        paramUniformArray[7] = 4 / canvasPhysicalWidth; // thickness (just a arbitary value for looks)
        
        gpuDevice.queue.writeBuffer(this._paramUniformBuffer, 0, paramUniformArray);

        gpuRenderPassEncoder.setPipeline(waveformPipeline);
        gpuRenderPassEncoder.setBindGroup(0, this._waveformBindGroup);
        gpuRenderPassEncoder.setVertexBuffer(0, this._waveformVertexBuffer);
        gpuRenderPassEncoder.setVertexBuffer(1, conditionVertexBuffer); // this has 4 vec2
        gpuRenderPassEncoder.setIndexBuffer(indexBuffer, "uint16");
        gpuRenderPassEncoder.drawIndexed(6, this.config.numSamples); // 6 indices per segment (4 vertices)
    }
}

// ------------------ Main Code ------------------ //
let canvasPhysicalWidth = 0;
let canvasPhysicalHeight = 0;
let canvasLogicalWidth = 0;
let canvasLogicalHeight = 0;
let prevCanvasPhysicalWidth = 0;
let prevCanvasPhysicalHeight = 0;

// Wait for Shoelace components to load
await Promise.allSettled([
    customElements.whenDefined("sl-alert"),
    customElements.whenDefined("sl-button"),
    customElements.whenDefined("sl-dialog"),
    customElements.whenDefined("sl-dropdown"),
    customElements.whenDefined("sl-input"),
    customElements.whenDefined("sl-icon"),
    customElements.whenDefined("sl-menu"),
    customElements.whenDefined("sl-menu-item")
]);

// The UI elements for alerts
const gpuUnsupportedAlertElement = document.getElementById("gpu-unsupported-alert")

// The UI elements for the full screen popup-dialogs
const newProjectDialogElement = document.getElementById("new-project-dialog");
const newProjectDialogFormElement = document.getElementById("new-project-dialog-form");
const openProjectFromUrlDialogElement = document.getElementById("open-project-from-url-dialog");
const openProjectFromUrlDialogFormElement = document.getElementById("open-project-from-url-dialog-form");

// The UI elements from top-cont
const projectNameElement = document.getElementById("project-name");
const fileDropdownElement = document.getElementById("file-dropdown");

const openProjectFromFileInputElement = document.getElementById("open-project-from-file-input");
const addWaveformFromSiglentCsvInputElement = document.getElementById("add-waveform-from-siglent-csv-input");

// The UI elements from waveform-cont
const horizontalAxesScaleElement = document.getElementById("horizontal-axes-scale");
const verticalAxesScaleElement = document.getElementById("vertical-axes-scale");

// The UI elements from bottom-cont
const timebaseLabelElement = document.getElementById("timebase-label");
const timebaseOffsetLabelElement = document.getElementById("timebase-offset-label");
const bottomChannelInfoElement = document.getElementById("bottom-channel-info");

// ----- GPU Related Stuff -----
if (!navigator.gpu) {
    gpuUnsupportedAlertElement.toast();
    throw new Error("WebGPU not supported on this browser.");
}

const adapter = await navigator.gpu.requestAdapter();
if (!adapter) {
    gpuUnsupportedAlertElement.toast();
    throw new Error("No appropriate GPUAdapter found.");
}

const gpuDevice = await adapter.requestDevice();

const waveformCanvas = document.getElementById("waveform-canvas");

const observer = new ResizeObserver(([entry]) => {
    const { physicalWidth, physicalHeight, logicalWidth, logicalHeight } = getCanvasSize(entry);
    
    canvasPhysicalWidth = Math.max(1, Math.min(physicalWidth, gpuDevice.limits.maxTextureDimension2D));
    canvasPhysicalHeight = Math.max(1, Math.min(physicalHeight, gpuDevice.limits.maxTextureDimension2D));
    canvasLogicalWidth = logicalWidth;
    canvasLogicalHeight = logicalHeight;
});
observer.observe(waveformCanvas);

const waveformCanvasCtx = waveformCanvas.getContext("webgpu");
const waveformCanvasFormat = navigator.gpu.getPreferredCanvasFormat();
waveformCanvasCtx.configure({
    device: gpuDevice,
    format: waveformCanvasFormat
});

const waveformVertexBufferLayout = {
    arrayStride: 16,
    stepMode: "instance",
    attributes: [{
        format: "float32x2",
        offset: 0,
        shaderLocation: 1,
    },
    {
        format: "float32x2",
        offset: 8,
        shaderLocation: 2,
    }],
};

// First vertex (top left): x=0, y=1
// Second vertex (top right): x=1, y=1
// Third vertex (bottom right): x=1, y=-1
// Fourth vertex (bottom left): x=0, y=-1
const conditionVertexArray = new Int16Array([0, 1, 1, 1, 1, -1, 0, -1]);

const conditionVertexBuffer = gpuDevice.createBuffer({
label: "Condition Vertex Buffer",
size: conditionVertexArray.byteLength,
usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
});

gpuDevice.queue.writeBuffer(conditionVertexBuffer, 0, conditionVertexArray);

const conditionVertexBufferLayout = {
    arrayStride: 4, // must be a multiple of 4
    stepMode: "vertex",
    attributes: [{
        format: "sint16x2",
        offset: 0,
        shaderLocation: 0,
    }]
};

const DISPLAY_UNIFORM_BYTE_LENGTH = 12;
const displayUniformBuffer = gpuDevice.createBuffer({
    label: "Display Uniform Buffer",
    size: DISPLAY_UNIFORM_BYTE_LENGTH,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
});

const indicesArray = new Uint16Array([0, 1, 2, 2, 3, 0]);
const indexBuffer = gpuDevice.createBuffer({
    size: indicesArray.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
});
gpuDevice.queue.writeBuffer(indexBuffer, 0, indicesArray);

const waveformShaderModule = gpuDevice.createShaderModule({
    label: "Oscilloscope Waveform Shader",
    code: waveformShader
});

const waveformPipeline = gpuDevice.createRenderPipeline({
    label: "Oscilloscope Waveform Render Pipeline",
    layout: "auto",
    vertex: {
        module: waveformShaderModule,
        entryPoint: "vertexMain",
        buffers: [waveformVertexBufferLayout, conditionVertexBufferLayout]
    },
    fragment: {
        module: waveformShaderModule,
        entryPoint: "fragmentMain",
        targets: [{
            format: waveformCanvasFormat,
            blend: {
                color: {
                    operation: "add",
                    srcFactor: "src-alpha",
                    dstFactor: "one-minus-src-alpha",
                },
                alpha: {
                    operation: "add",
                    srcFactor: "one",
                    dstFactor: "one-minus-src",
                },
            }
        }]
        
    }
});

// Basic Line Renderer
const maxBasicLines = 128; // We shouldn"t need to draw more than 128 basic lines
const basicLineArrayStride = 40;
let basicLineVertexArray =  new Float32Array(basicLineArrayStride/4 * maxBasicLines);
const basicLineVertexBuffer = gpuDevice.createBuffer({
    label: "Basic Line Vertex Buffer",
    size: basicLineVertexArray.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
});

gpuDevice.queue.writeBuffer(basicLineVertexBuffer, 0, basicLineVertexArray);

const basicLineVertexBufferLayout = {
    arrayStride: basicLineArrayStride,
    stepMode: "instance",
    attributes: [{
        format: "float32x2",
        offset: 0,
        shaderLocation: 1,
    },
    {
        format: "float32x2",
        offset: 8,
        shaderLocation: 2,
    },
    {
        format: "float32x3",
        offset: 16,
        shaderLocation: 3,
    },
    {
        format: "float32",
        offset: 28,
        shaderLocation: 4,
    },
    {
        format: "float32",
        offset: 32,
        shaderLocation: 5,
    },
    {
        format: "float32",
        offset: 36,
        shaderLocation: 6,
    }],
};

const basicLineShaderModule = gpuDevice.createShaderModule({
    label: "Basic Line Shader",
    code: basicLineShader
});

const basicLinePipeline = gpuDevice.createRenderPipeline({
    label: "Basic Line Render Pipeline",
    layout: "auto",
    vertex: {
        module: basicLineShaderModule,
        entryPoint: "vertexMain",
        buffers: [basicLineVertexBufferLayout, conditionVertexBufferLayout]
    },
    fragment: {
        module: basicLineShaderModule,
        entryPoint: "fragmentMain",
        targets: [{
            format: waveformCanvasFormat,
            blend: {
                color: {
                    operation: "add",
                    srcFactor: "src-alpha",
                    dstFactor: "one-minus-src-alpha",
                },
                alpha: {
                    operation: "add",
                    srcFactor: "one",
                    dstFactor: "one-minus-src",
                },
            }
        }]
        
    }
});

const basicLineBindGroup = gpuDevice.createBindGroup({
    label: "Basic Line Bind Group",
    layout: basicLinePipeline.getBindGroupLayout(0),
    entries: [{
        binding: 0, 
        resource: { buffer: displayUniformBuffer}
    }]
});


function setBasicLineInstanceParams({float32Array, index, p0_x, p0_y, p1_x, p1_y, color_r, color_g, color_b, thickness, dash_length, dash_gap}) {
    const skip = basicLineArrayStride/4;
    float32Array[index * skip] = p0_x;
    float32Array[index * skip + 1] = p0_y; 
    float32Array[index * skip + 2] = p1_x; 
    float32Array[index * skip + 3] = p1_y; 
    float32Array[index * skip + 4] = color_r; 
    float32Array[index * skip + 5] = color_g; 
    float32Array[index * skip + 6] = color_b; 
    float32Array[index * skip + 7] = thickness; 
    float32Array[index * skip + 8] = dash_length; 
    float32Array[index * skip + 9] = dash_gap;
}

// This should only be called once
let project = new Project();

const xyDragScrollManager = new XYDragScrollManager(horizontalAxesScaleElement, verticalAxesScaleElement);

xyDragScrollManager.registerChangeCallback(newConfig => {
    const w = project.waveforms[project.config.selectedIndex];
    project.config.offsetX = newConfig.offsetX;
    w.config.offsetY = newConfig.offsetY;
    project.config.scalePerDivX = newConfig.scalePerDivX;
    w.config.scalePerDivY = newConfig.scalePerDivY;

    updateXYDragScrollManagerConfig();
})

function updateXYDragScrollManagerConfig() {
    if(project.waveforms.length > 0 && project.config.selectedIndex < project.waveforms.length) {
        const w = project.waveforms[project.config.selectedIndex];

        xyDragScrollManager.config.offsetX = project.config.offsetX;
        xyDragScrollManager.config.offsetY = w.config.offsetY;
        xyDragScrollManager.config.scalePerDivX = project.config.scalePerDivX;
        xyDragScrollManager.config.scalePerDivY = w.config.scalePerDivY;
    }
}

project.registerWaveformsLengthChangeCallback((w) => { 
    // Since we added / removed some waveforms we must call updateXYDragScrollManagerConfig();
    // updateXYDragScrollManagerConfig(); is also called when we select a waveform by clicking the info panel 
    // TODO, handle change of waveforms
    updateXYDragScrollManagerConfig();

    if(w) {
        w.generateWaveformVertexArray();
        w.setupGPU({
            gpuDevice: gpuDevice, 
            waveformPipeline: waveformPipeline,
            indexBuffer: indexBuffer,
            displayUniformBuffer: displayUniformBuffer
        })
    }
    // Generate as many panels as there are waveforms
    // Remove all elements, we will regenerate all of them
    while (bottomChannelInfoElement.firstChild) {
        bottomChannelInfoElement.removeChild(bottomChannelInfoElement.firstChild);
    }

    for(let i=0; i<project.waveforms.length; i++) {
        const infoPanelElement = document.createElement("channel-info-panel");
        infoPanelElement.addEventListener("click", (ev) => channelInfoPanelClickHandler(ev, i));
        bottomChannelInfoElement.appendChild(infoPanelElement);
    }
});

function channelInfoPanelClickHandler(e, i) {
    project.config.selectedIndex = i;

    updateXYDragScrollManagerConfig();
}

// If provided with a URL, we can automatically load the project file
const params = new URLSearchParams(window.location.search);
const url = params.get("dataURL");

if(url) {
    project.initFromUrl(url);
}

openProjectFromFileInputElement.addEventListener('change', async (event) => {
    const file = event.target.files[0];

    // Reset the input so it can trigger change event even if the same file is selected again
    event.target.value = '';

    if (!file) return;

    const arrayBuffer = await file.arrayBuffer(); 
    project.initFromArrayBuffer(arrayBuffer);
});

addWaveformFromSiglentCsvInputElement.addEventListener('change', async (event) => {
    const file = event.target.files[0];

    // Reset the input so it can trigger change event even if the same file is selected again
    event.target.value = '';

    if (!file) return;

    const text = await file.text(); 
    project.addWaveformFromSiglentCsv(text);
    
});

newProjectDialogFormElement.addEventListener('submit', event => {
    event.preventDefault();
    // Create the new project
    const data = new FormData(event.target);
    
    const filename = data.get("filename");
    project.initEmpty(filename);
    
    newProjectDialogElement.hide()
});

openProjectFromUrlDialogFormElement.addEventListener('submit', event => {
    event.preventDefault();
    // Open the project from URL
    const data = new FormData(event.target);
    
    const url = data.get("url");

    project.initFromUrl(url);

    openProjectFromUrlDialogElement.hide()
});

fileDropdownElement.addEventListener('sl-select', event => {
    const selectedItem = event.detail.item;
    switch(selectedItem.value) {
        case "new-project":
            newProjectDialogFormElement.reset();
            newProjectDialogElement.show();
            break;
        case "open-project-from-file":
            openProjectFromFileInputElement.click();
            break;
        case "open-project-from-url":
            openProjectFromUrlDialogFormElement.reset();
            openProjectFromUrlDialogElement.show();
            break;
        case "export-project":
            project.export()
            break;
        case "add-waveform-from-siglent-csv":
            addWaveformFromSiglentCsvInputElement.click();
            break;
        default:
    }
});

function renderFrame(timestamp) {
    const aspect_ratio = canvasPhysicalWidth/canvasPhysicalHeight;

    if(canvasPhysicalWidth != prevCanvasPhysicalWidth || canvasPhysicalHeight != prevCanvasPhysicalHeight) {
        prevCanvasPhysicalWidth = canvasPhysicalWidth;
        prevCanvasPhysicalHeight = canvasPhysicalHeight;

        waveformCanvas.width = canvasPhysicalWidth;
        waveformCanvas.height = canvasPhysicalHeight;

        const displayUniformArray = new Float32Array(3);
        displayUniformArray[0] = canvasPhysicalWidth; // width_pixels
        displayUniformArray[1] = canvasPhysicalHeight; // height_pixels
        displayUniformArray[2] = aspect_ratio; // lets precalculate the aspect_ratio
        gpuDevice.queue.writeBuffer(displayUniformBuffer, 0, displayUniformArray);
    }

    
    if(canvasPhysicalWidth == 0 || canvasPhysicalHeight == 0) {
        return;
    }


    // ------- Update HTML UI ------- //
    // We will update regardless there is a change or not for simplicity
    // since we are not using a framework
    projectNameElement.textContent = project.config.name;
    
    // Update the bottom per channel info panel
    project.waveforms.forEach((w, i) => {
        const infoPanelElement = bottomChannelInfoElement.children[i];
        infoPanelElement.setAttribute("name", w.config.name);
        infoPanelElement.setAttribute("color", `rgba(${Math.floor(w.config.colorR * 255)}, ${Math.floor(w.config.colorG * 255)}, ${Math.floor(w.config.colorB * 255)}, 1.0)`);
            
        infoPanelElement.setAttribute("scale-per-div-y", getNumberString(w.config.scalePerDivY, w.config.unitY + "/div", FORMAT_NUM_DP_LOWRES, FORMAT_MAX_DIGITS_LOWRES));
        infoPanelElement.setAttribute("offset-y", getNumberString(w.config.offsetY, w.config.unitY, FORMAT_NUM_DP_LOWRES, FORMAT_MAX_DIGITS_LOWRES));
        infoPanelElement.setAttribute("selected", project.config.selectedIndex == i ? true: false); 
    }); 

    // Update the X axis scale labels
    let val = project.config.offsetX;
    for(let i=NUM_DIV_X/2; i < NUM_DIV_X + 1 ; i+=1) {
        horizontalAxesScaleElement.children[i].children[0].textContent = getNumberString(val, "s", FORMAT_NUM_DP_HIGHRES, FORMAT_MAX_DIGITS_HIGHRES);
        val += project.config.scalePerDivX;
    }

    val = project.config.offsetX - project.config.scalePerDivX;
    for(let i=NUM_DIV_X/2 - 1; i >= 0 ; i-=1) {
        horizontalAxesScaleElement.children[i].children[0].textContent = getNumberString(val, "s", FORMAT_NUM_DP_HIGHRES, FORMAT_MAX_DIGITS_HIGHRES);
        val -= project.config.scalePerDivX;
    }
    
    // Update the Y axis scale labels
    if(project.waveforms.length > 0 && project.config.selectedIndex < project.waveforms.length) {
        const w = project.waveforms[project.config.selectedIndex];
        const style = `color: rgba(${Math.floor(w.config.colorR * 255)}, ${Math.floor(w.config.colorG * 255)}, ${Math.floor(w.config.colorB * 255)}, 1.0)`;

        let val = -w.config.offsetY;
        for(let i=NUM_DIV_Y/2; i < NUM_DIV_Y + 1 ; i+=1) {
            verticalAxesScaleElement.style = style;
            verticalAxesScaleElement.children[i].children[0].textContent = getNumberString(val, w.config.unitY, FORMAT_NUM_DP_HIGHRES, FORMAT_MAX_DIGITS_HIGHRES);
            val -= w.config.scalePerDivY;
        }

        val = -w.config.offsetY + w.config.scalePerDivY;
        for(let i=NUM_DIV_Y/2 - 1; i >= 0 ; i-=1) {
            verticalAxesScaleElement.style = style;
            verticalAxesScaleElement.children[i].children[0].textContent = getNumberString(val, w.config.unitY, FORMAT_NUM_DP_HIGHRES, FORMAT_MAX_DIGITS_HIGHRES);
            val += w.config.scalePerDivY;
        }
    }
    
    // Update timebase labels
    timebaseLabelElement.textContent = getNumberString(project.config.scalePerDivX, "s/div", FORMAT_NUM_DP_LOWRES, FORMAT_MAX_DIGITS_LOWRES);
    timebaseOffsetLabelElement.textContent = getNumberString(project.config.offsetX, "s", FORMAT_NUM_DP_LOWRES, FORMAT_MAX_DIGITS_LOWRES);

    const startTime = performance.now();

    // ----- Waveform Canvas ----- //
    const encoder = gpuDevice.createCommandEncoder();

    const color_table = [
        [0.35, 0.35, 0.35],
        [0.45, 0.45, 0.45]
    ]


    // Background Axes, Ticks, Grid Render Pass
    let line_index = 0;
    
    // Draw solid axes lines
    function draw_axis_line({p0_x, p0_y, p1_x, p1_y}) {
        setBasicLineInstanceParams({
            float32Array: basicLineVertexArray,
            index: line_index,
            p0_x: p0_x,
            p0_y: p0_y,
            p1_x: p1_x, 
            p1_y: p1_y,
            color_r: 0.4,
            color_g: 0.4,
            color_b: 0.4,
            thickness: 1 / canvasPhysicalWidth,
            dash_length: 2.0,
            dash_gap: 0.0
        });
        line_index += 1;
    }

    draw_axis_line({p0_x: -1.0, p0_y: 0.0, p1_x: 1.0, p1_y: 0.0});
    draw_axis_line({p0_x: 0.0, p0_y: -1.0, p1_x: 0.0, p1_y: 1.0});

    // Draw ticks
    for(let i=1; i<NUM_MINOR_TICKS_Y; i+=1) {
        const y = -1.0 + i * 2.0/NUM_MINOR_TICKS_Y;
        let c = 0;
        setBasicLineInstanceParams({
            float32Array: basicLineVertexArray,
            index: line_index,
            p0_x: -TICK_LENGTH/2,
            p0_y: y,
            p1_x: TICK_LENGTH/2, 
            p1_y: y,
            color_r: color_table[c][0],
            color_g: color_table[c][1],
            color_b: color_table[c][2],
            thickness: 1 / canvasPhysicalWidth,
            dash_length: 2.0,
            dash_gap: 0.0});

        line_index += 1;
    }
    
    for(let i=1; i<NUM_MINOR_TICKS_X; i+=1) {
        const x = -1.0 + i * 2.0/NUM_MINOR_TICKS_X;
        let c = 0;
        setBasicLineInstanceParams({
            float32Array: basicLineVertexArray,
            index: line_index,
            p0_x: x,
            p0_y: -(TICK_LENGTH * aspect_ratio)/2,
            p1_x: x, 
            p1_y: (TICK_LENGTH * aspect_ratio)/2,
            color_r: color_table[c][0],
            color_g: color_table[c][1],
            color_b: color_table[c][2],
            thickness: 1 / canvasPhysicalWidth,
            dash_length: 2.0,
            dash_gap: 0.0});

        line_index += 1;
    }

    // Draw dashed lines
    for(let i=1; i<NUM_DIV_Y; i+=1) {
        const y = -1.0 + i * 2.0/NUM_DIV_Y;
        let c = 0;

        if(i == NUM_DIV_Y/2) {
            continue;
        }
        setBasicLineInstanceParams({
            float32Array: basicLineVertexArray,
            index: line_index,
            p0_x: -1.0,
            p0_y: y,
            p1_x: 1.0, 
            p1_y: y,
            color_r: color_table[c][0],
            color_g: color_table[c][1],
            color_b: color_table[c][2],
            thickness: 1 / canvasPhysicalWidth,
            dash_length: 2/canvasPhysicalWidth,//0.002,
            dash_gap: 8/canvasPhysicalWidth});

        line_index += 1;
    }

    for(let i=1; i<NUM_DIV_X; i+=1) {
        const x = -1.0 + i * 2.0/NUM_DIV_X;
        let c = 0;

        if(i == NUM_DIV_X/2) {
            continue;
        }

        setBasicLineInstanceParams({
            float32Array: basicLineVertexArray,
            index: line_index,
            p0_x: x,
            p0_y: -1,
            p1_x: x, 
            p1_y: 1,
            color_r: color_table[c][0],
            color_g: color_table[c][1],
            color_b: color_table[c][2],
            thickness: 1 / canvasPhysicalWidth,
            dash_length: 2/canvasPhysicalHeight,//0.002,
            dash_gap: 8/canvasPhysicalHeight});

        line_index += 1;
    }
    gpuDevice.queue.writeBuffer(basicLineVertexBuffer, 0, basicLineVertexArray);

    const pass1 = encoder.beginRenderPass({
        colorAttachments: [{
            view: waveformCanvasCtx.getCurrentTexture().createView(),
            loadOp: "clear",
            storeOp: "store",
        }]
    });
    pass1.setPipeline(basicLinePipeline);
    pass1.setBindGroup(0, basicLineBindGroup);
    pass1.setVertexBuffer(0, basicLineVertexBuffer);
    pass1.setVertexBuffer(1, conditionVertexBuffer); // this has 4 vec2
    pass1.setIndexBuffer(indexBuffer, "uint16");
    if(line_index + 1 > maxBasicLines) {
        throw Error("number of basic lines requested exceed maxBasicLines");
    }
    pass1.drawIndexed(6, line_index + 1); // 6 indices per segment (4 vertices)
    pass1.end();

    const pass2 = encoder.beginRenderPass({
        colorAttachments: [{
            view: waveformCanvasCtx.getCurrentTexture().createView(),
            loadOp: "load",
            storeOp: "store",
        }]
    });
    // Waveform Render Pass
    const renderInfo = {
        project: project,
        gpuDevice: gpuDevice,
        gpuRenderPassEncoder: pass2,
        waveformPipeline: waveformPipeline,
        conditionVertexBuffer: conditionVertexBuffer,
        indexBuffer: indexBuffer,
        canvasPhysicalWidth: canvasPhysicalWidth
    };

    // Render the waveforms except the selected one
    project.waveforms.forEach((w) => {
        if(!w.selected) {
            w.render(renderInfo);
        }
    });

    // Render the selected one last (so it is on top)
    project.waveforms.forEach((w) => {
        if(w.selected) {
            w.render(renderInfo);
        }
    });
    pass2.end() 
    
    const commandBuffer = encoder.finish();
    gpuDevice.queue.submit([commandBuffer]);

    const diff = performance.now() - startTime;
    //console.log(`it took ${diff} ms`)
    //console.log(`timestamp ${timestamp} ms`)
}

function renderLoop(timestamp) {
    renderFrame(timestamp);
    requestAnimationFrame(renderLoop);
}

requestAnimationFrame(renderLoop);