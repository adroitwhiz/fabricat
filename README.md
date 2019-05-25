## fabricat
#### Canvas-based version of the Scratch 3.0 renderer

[![Build Status](https://travis-ci.org/adroitwhiz/fabricat.svg?branch=develop)](https://travis-ci.org/adroitwhiz/fabricat)

## Setup
```html
<!DOCTYPE html>
<html lang="en">
    <head>
        <meta charset="UTF-8">
        <title>Fabricat canvas rendering demo</title>
    </head>

    <body>
        <canvas id="myStage"></canvas>
        <canvas id="myDebug"></canvas>
    </body>
</html>
```

```js
var canvas = document.getElementById('myStage');
var debug = document.getElementById('myDebug');

// Instantiate the renderer
var renderer = new require('fabricat')(canvas);

// Connect to debug canvas
renderer.setDebugCanvas(debug);

// Start drawing
function drawStep() {
    renderer.draw();
    requestAnimationFrame(drawStep);
}
drawStep();

// Connect to worker (see "playground" example)
var worker = new Worker('worker.js');
renderer.connectWorker(worker);
```

## Standalone Build
```bash
npm run build
```

```html
<script src="/path/to/render.js"></script>
<script>
    var renderer = new window.RenderCanvasLocal();
    // do things
</script>
```

## Testing
```bash
npm test
```

## Credit
Most of this codebase was written by the Scratch Team for [scratch-render](https://github.com/llk/scratch-render), the official WebGL-based renderer for [Scratch](https://scratch.mit.edu). I simply modified it to work via the 2D canvas drawing API.