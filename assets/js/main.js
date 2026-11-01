const vertexShader = `
    attribute vec2 position;
    varying vec2 uv;
    void main() {
    uv = position * 0.5 + 0.5;
    gl_Position = vec4(position, 0.0, 1.0);
}`;

const trailShader = `
    precision highp float;
    varying vec2 uv;
    uniform sampler2D trail;
    uniform vec2 from;
    uniform vec2 to;
    uniform float aspect;
    uniform float size;
    uniform float strength;
    uniform float fade;
    void main() {
    float paint = texture2D(trail, uv).r - fade;
    vec2 point = (uv - from) * vec2(aspect, 1.0);
    vec2 line = (to - from) * vec2(aspect, 1.0);
    float along = clamp(dot(point, line) / max(dot(line, line), 0.00001), 0.0, 1.0);
    float stroke = 1.0 - smoothstep(0.0, size, length(point - line * along));
    gl_FragColor = vec4(paint + stroke * strength, 0.0, 0.0, 1.0);
}`;

const photoShader = `
    precision highp float;
    varying vec2 uv;
    uniform sampler2D photo;
    uniform sampler2D trail;
    uniform vec2 scale;
    uniform vec2 offset;
    uniform float aspect;
    uniform float time;
    float random(vec2 point) {
    return fract(sin(dot(point, vec2(12.9898, 78.233))) * 43758.5453);
    }
    float noise(vec2 point) {
    vec2 cell = floor(point);
    vec2 blend = smoothstep(0.0, 1.0, fract(point));
    float a = random(cell);
    float b = random(cell + vec2(1.0, 0.0));
    float c = random(cell + vec2(0.0, 1.0));
    float d = random(cell + vec2(1.0, 1.0));
    return mix(mix(a, b, blend.x), mix(c, d, blend.x), blend.y);
    }
    void main() {
    vec3 color = texture2D(photo, uv * scale + offset).rgb;
    vec3 gray = vec3(dot(color, vec3(0.299, 0.587, 0.114)));
    vec2 point = uv * vec2(aspect, 1.0) * 6.0;
    vec2 wobble = vec2(noise(point + time * 0.4), noise(point - time * 0.4 + 9.0)) - 0.5;
    float reveal = smoothstep(0.4, 0.6, texture2D(trail, uv + wobble * 0.06).r);
    float glow = smoothstep(0.03, 0.12, max(color.g, color.b));
    gl_FragColor = vec4(mix(gray, color, reveal * glow), 1.0);
}`;

const canvas = document.querySelector(".photo");
const gl = canvas.getContext("webgl");
const image = new Image();
image.src = "./assets/images/bg.jpg";

const pointer = { x: 0.5, y: 0.5 };
const brush = { x: 0.5, y: 0.5 };
let brushPlaced = false;
let trailProgram, photoProgram, photoTexture;
let trails = [];
let lastTime = performance.now();
let leftover = 0;

function createProgram(fragmentShader) {
    const program = gl.createProgram();
    for (const [type, source] of [
        [gl.VERTEX_SHADER, vertexShader],
        [gl.FRAGMENT_SHADER, fragmentShader],
    ]) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        gl.attachShader(program, shader);
    }
    gl.bindAttribLocation(program, 0, "position");
    gl.linkProgram(program);
    return program;
}

function createTexture(width, height, source) {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    if (source)
        gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            source,
        );
    else
        gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA,
            width,
            height,
            0,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            null,
        );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
}

function createTrail(width, height) {
    const texture = createTexture(width, height);
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        texture,
        0,
    );
    return { texture, framebuffer, width, height };
}

function draw(program, uniforms, textures, target) {
    gl.useProgram(program);
    for (const [name, value] of Object.entries(uniforms)) {
        const location = gl.getUniformLocation(program, name);
        if (Array.isArray(value)) gl.uniform2fv(location, value);
        else gl.uniform1f(location, value);
    }
    Object.entries(textures).forEach(([name, texture], unit) => {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.uniform1i(gl.getUniformLocation(program, name), unit);
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.framebuffer : null);
    gl.viewport(
        0,
        0,
        target ? target.width : canvas.width,
        target ? target.height : canvas.height,
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);
}

function resize() {
    const pixelRatio = Math.min(devicePixelRatio, 2);
    canvas.width = Math.round(innerWidth * pixelRatio);
    canvas.height = Math.round(innerHeight * pixelRatio);
    trails.forEach((trail) => {
        gl.deleteTexture(trail.texture);
        gl.deleteFramebuffer(trail.framebuffer);
    });
    const width = Math.round(innerWidth / 2);
    const height = Math.round(innerHeight / 2);
    trails = [createTrail(width, height), createTrail(width, height)];
}

function coverPhoto() {
    const screenAspect = innerWidth / innerHeight;
    const photoAspect = image.width / image.height;
    const scale =
        screenAspect > photoAspect
            ? [1, photoAspect / screenAspect]
            : [screenAspect / photoAspect, 1];
    return {
        scale,
        offset: [(1 - scale[0]) / 2, (1 - scale[1]) / 2],
    };
}

function paintTrail() {
    const from = [brush.x, brush.y];
    brush.x += (pointer.x - brush.x) * 0.25;
    brush.y += (pointer.y - brush.y) * 0.25;
    const speed = Math.hypot(brush.x - from[0], brush.y - from[1]);

    draw(
        trailProgram,
        {
            from,
            to: [brush.x, brush.y],
            aspect: innerWidth / innerHeight,
            size: 0.13,
            strength: Math.min(speed * 60, 1),
            fade: 0.01,
        },
        { trail: trails[0].texture },
        trails[1],
    );
    trails.reverse();
}

function render(now) {
    leftover = Math.min(leftover + now - lastTime, 100);
    lastTime = now;
    while (leftover >= 1000 / 60) {
        leftover -= 1000 / 60;
        paintTrail();
    }

    const { scale, offset } = coverPhoto();
    draw(
        photoProgram,
        {
            scale,
            offset,
            aspect: innerWidth / innerHeight,
            time: now / 1000,
        },
        { photo: photoTexture, trail: trails[0].texture },
    );
    requestAnimationFrame(render);
}

function movePointer(event) {
    if (!event.isPrimary) return;
    pointer.x = event.clientX / innerWidth;
    pointer.y = 1 - event.clientY / innerHeight;
    if (!brushPlaced) {
        brush.x = pointer.x;
        brush.y = pointer.y;
        brushPlaced = true;
    }
}

function pointerDown(event) {
    if (!event.isPrimary) return;
    gsap.killTweensOf(pointer);
    brushPlaced = false;
    movePointer(event);
}

function startPainting() {
    trailProgram = createProgram(trailShader);
    photoProgram = createProgram(photoShader);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 3, -1, -1, 3]),
        gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    photoTexture = createTexture(image.width, image.height, image);

    resize();
    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", movePointer);
    window.addEventListener("pointerdown", pointerDown);
    document.documentElement.addEventListener(
        "pointerleave",
        () => (brushPlaced = false),
    );
    requestAnimationFrame(render);
}

function paintHint() {
    if (brushPlaced) return;
    Object.assign(pointer, { x: 0.2, y: 0.6 });
    Object.assign(brush, pointer);
    gsap.to(pointer, {
        keyframes: [
            { x: 0.4, y: 0.7 },
            { x: 0.6, y: 0.66 },
            { x: 0.8, y: 0.62 },
            { x: 0.88, y: 0.5 },
        ],
        duration: 2,
        ease: "sine.inOut",
    });
}

function playIntro() {
    gsap.registerPlugin(SplitText);
    const split = SplitText.create(".reveal", {
        type: "lines",
        mask: "lines",
    });
    const intro = gsap.timeline({
        defaults: { duration: 1.4, ease: "expo.out" },
        onComplete: () => split.revert(),
    });

    intro.from(
        canvas,
        {
            opacity: 0,
            scale: 1.06,
            duration: 2.4,
            ease: "power3.out",
        },
        0,
    );
    intro.from(
        ".lines span",
        {
            scaleY: 0,
            transformOrigin: "top",
            duration: 1.8,
            ease: "expo.inOut",
            stagger: 0.06,
        },
        0,
    );
    intro.from(split.lines, { yPercent: 105, stagger: 0.04 }, 0.6);

    const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (gl && matchMedia("(hover: none)").matches && !reduceMotion)
        intro.add(paintHint, 1.2);
    if (reduceMotion) intro.progress(1);
}

Promise.all([image.decode(), document.fonts.ready]).then(() => {
    if (gl) startPainting();
    else document.body.classList.add("no-webgl");
    playIntro();
    document.body.classList.add("ready");
});
