const { ItemView, MarkdownRenderChild, Notice, Plugin, SuggestModal, TFile } = require("obsidian");

const VIEW_TYPE_STL = "three-d-model-viewer";
const DEFAULT_COLOR = "#7894e8";
const SUPPORTED_MODEL_EXTENSIONS = ["stl", "obj", "3mf"];
const SUPPORTED_MODEL_PATTERN = "\\.(?:stl|obj|3mf)";
const CAD_MODEL_EXTENSIONS = ["step", "stp"];
const KNOWN_MODEL_PATTERN = "\\.(?:stl|obj|3mf|step|stp)";

module.exports = class MinimalStlViewerPlugin extends Plugin {
  async onload() {
    this.registerView(VIEW_TYPE_STL, (leaf) => new StlFileView(leaf, this));
    this.registerExtensions(SUPPORTED_MODEL_EXTENSIONS, VIEW_TYPE_STL);

    this.addCommand({
      id: "open-active-stl",
      name: "Open active 3D model in 3D Model Viewer",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!isSupportedModelFile(file)) return false;
        if (!checking) this.openStlFile(file);
        return true;
      },
    });

    this.addCommand({
      id: "open-first-stl",
      name: "Open first supported 3D model in vault",
      callback: async () => {
        const file = this.app.vault.getFiles().find(isSupportedModelFile);
        if (!file) {
          new Notice("No supported 3D model files found in this vault.");
          return;
        }
        await this.openStlFile(file);
      },
    });

    this.addCommand({
      id: "insert-stl-viewer-block",
      name: "Insert 3D model viewer block",
      editorCallback: (editor) => {
        const selectedRef = extractModelReference(editor.getSelection());
        if (selectedRef) {
          insertModelViewerBlock(editor, selectedRef);
          return;
        }

        const files = this.app.vault.getFiles().filter(isSupportedModelFile).sort((a, b) => a.path.localeCompare(b.path));
        if (files.length === 0) {
          new Notice("No supported 3D model files found in this vault.");
          return;
        }

        new StlFileSuggestModal(this.app, files, (file) => {
          insertModelViewerBlock(editor, file.path);
        }).open();
      },
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!isSupportedModelFile(file)) return;
        menu.addItem((item) => {
          item
            .setTitle("Open in 3D Model Viewer")
            .setIcon("box")
            .onClick(() => this.openStlFile(file));
        });
      })
    );

    const processModelBlock = async (source, el, ctx) => {
      const modelRef = getFirstModelReference(source);
      if (!modelRef) {
        renderError(el, "Add a model link, for example: [[model.stl]], [[model.obj]], or [[model.3mf]]");
        return;
      }

      const file = this.app.metadataCache.getFirstLinkpathDest(modelRef, ctx.sourcePath);
      if (isCadModelReference(modelRef) || isCadModelFile(file)) {
        renderError(el, "STEP/STP is a CAD solid format. Convert it to STL, OBJ, or 3MF first, then insert that mesh file here.");
        return;
      }

      if (!isSupportedModelFile(file)) {
        renderError(el, `Supported 3D model file not found: ${modelRef}`);
        return;
      }

      const child = new StlMarkdownRenderChild(el, this, file);
      ctx.addChild(child);
      await child.loadFile();
    };

    this.registerMarkdownCodeBlockProcessor("stl-viewer", processModelBlock);
    this.registerMarkdownCodeBlockProcessor("3d-viewer", processModelBlock);

    this.registerMarkdownPostProcessor((el, ctx) => {
      this.renderStlEmbeds(el, ctx);
    });
  }

  async openStlFile(file) {
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({
      type: VIEW_TYPE_STL,
      state: { file: file.path },
      active: true,
    });
    this.app.workspace.revealLeaf(leaf);
  }

  renderStlEmbeds(el, ctx) {
    const embeds = Array.from(el.querySelectorAll(".internal-embed"));

    for (const embed of embeds) {
      if (embed.dataset.minimalStlProcessed === "true") continue;
      if (embed.closest(".minimal-stl-viewer")) continue;

      const modelRef = getStlReferenceFromElement(embed);
      if (!modelRef) continue;

      const file = this.app.metadataCache.getFirstLinkpathDest(modelRef, ctx.sourcePath);
      if (!isSupportedModelFile(file)) continue;

      embed.dataset.minimalStlProcessed = "true";
      embed.empty();
      const child = new StlMarkdownRenderChild(embed, this, file);
      ctx.addChild(child);
      child.loadFile();
    }
  }
};

class StlFileSuggestModal extends SuggestModal {
  constructor(app, files, onChoose) {
    super(app);
    this.files = files;
    this.onChoose = onChoose;
    this.setPlaceholder("Choose a 3D model file to insert");
  }

  getSuggestions(query) {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return this.files.slice(0, 50);

    return this.files
      .filter((file) => {
        const path = file.path.toLowerCase();
        const basename = file.basename.toLowerCase();
        return path.includes(normalizedQuery) || basename.includes(normalizedQuery);
      })
      .slice(0, 50);
  }

  renderSuggestion(file, el) {
    el.createDiv({ text: file.basename });
    el.createDiv({ cls: "minimal-stl-suggestion-path", text: file.path });
  }

  onChooseSuggestion(file) {
    this.onChoose(file);
  }
}

class StlFileView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.file = null;
    this.renderer = null;
  }

  getViewType() {
    return VIEW_TYPE_STL;
  }

  getDisplayText() {
    return this.file ? this.file.basename : "STL Viewer";
  }

  getIcon() {
    return "box";
  }

  async setState(state, result) {
    await super.setState(state, result);
    const path = state && state.file;
    const file = path ? this.app.vault.getAbstractFileByPath(path) : null;
    this.file = isSupportedModelFile(file) ? file : null;
    await this.render();
  }

  getState() {
    const state = super.getState();
    if (this.file) state.file = this.file.path;
    return state;
  }

  async onOpen() {
    await this.render();
  }

  async onClose() {
    if (this.renderer) {
      this.renderer.destroy();
      this.renderer = null;
    }
  }

  async render() {
    const container = this.contentEl;
    container.empty();

    if (this.renderer) {
      this.renderer.destroy();
      this.renderer = null;
    }

    if (!this.file) {
      renderError(container, "No STL file selected.");
      return;
    }

    const host = container.createDiv({ cls: "minimal-stl-viewer" });

    try {
      const buffer = await this.app.vault.readBinary(this.file);
      const model = await parseModel(buffer, this.file);
      this.renderer = new StlRenderer(host, {
        title: this.file.name,
        model,
        color: DEFAULT_COLOR,
      });
    } catch (error) {
      renderError(host, formatError(error));
    }
  }
}

class StlMarkdownRenderChild extends MarkdownRenderChild {
  constructor(containerEl, plugin, file) {
    super(containerEl);
    this.plugin = plugin;
    this.file = file;
    this.renderer = null;
  }

  async loadFile() {
    this.containerEl.empty();
    const host = this.containerEl.createDiv({ cls: "minimal-stl-viewer is-embed" });

    try {
      const buffer = await this.plugin.app.vault.readBinary(this.file);
      const model = await parseModel(buffer, this.file);
      this.renderer = new StlRenderer(host, {
        title: this.file.name,
        model,
        color: DEFAULT_COLOR,
      });
    } catch (error) {
      renderError(host, formatError(error));
    }
  }

  onunload() {
    if (this.renderer) {
      this.renderer.destroy();
      this.renderer = null;
    }
  }
}

class StlRenderer {
  constructor(container, options) {
    this.container = container;
    this.model = options.model;
    this.color = hexToRgb(options.color || DEFAULT_COLOR);
    this.orientation = getStandardViewOrientation("isometric");
    this.dragStartVector = null;
    this.dragStartOrientation = null;
    this.distance = 4.0;
    this.isDragging = false;
    this.lastX = 0;
    this.lastY = 0;
    this.animationFrame = 0;
    this.destroyed = false;

    this.canvas = container.createEl("canvas", { cls: "minimal-stl-canvas" });
    this.gl = this.canvas.getContext("webgl", {
      antialias: true,
      alpha: true,
      depth: true,
      preserveDrawingBuffer: false,
    });

    if (!this.gl) {
      throw new Error("WebGL is not available in this Obsidian window.");
    }

    this.createToolbar(options.title || "STL model");
    this.createViewCube();
    this.createProgram();
    this.createBuffers();
    this.bindEvents();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    this.resize();
    this.renderLoop();
  }

  createToolbar(title) {
    const toolbar = this.container.createDiv({ cls: "minimal-stl-toolbar" });
    const titleEl = toolbar.createDiv({ cls: "minimal-stl-title" });
    titleEl.createSpan({ text: title });

    const controls = toolbar.createDiv({ cls: "minimal-stl-controls" });
    const colorInput = controls.createEl("input", { cls: "minimal-stl-color", attr: { type: "color" } });
    colorInput.value = rgbToHex(this.color);
    colorInput.addEventListener("input", () => {
      this.color = hexToRgb(colorInput.value);
      this.requestRender();
    });

    const resetButton = controls.createEl("button", { cls: "minimal-stl-button", text: "Reset" });
    resetButton.addEventListener("click", () => {
      this.orientation = getStandardViewOrientation("isometric");
      this.distance = 4.0;
      this.requestRender();
    });

    const rotateLeftButton = controls.createEl("button", {
      cls: "minimal-stl-button",
      text: "↶90°",
      attr: { title: "当前平面逆时针旋转 90°" },
    });
    rotateLeftButton.addEventListener("click", () => {
      this.rotateInPlane(-Math.PI / 2);
    });

    const rotateRightButton = controls.createEl("button", {
      cls: "minimal-stl-button",
      text: "↷90°",
      attr: { title: "当前平面顺时针旋转 90°" },
    });
    rotateRightButton.addEventListener("click", () => {
      this.rotateInPlane(Math.PI / 2);
    });

    const status = this.container.createDiv({ cls: "minimal-stl-status" });
    status.setText(`${this.model.triangleCount.toLocaleString()} triangles. Drag to rotate, wheel to zoom.`);
  }

  createViewCube() {
    this.viewCubeCanvas = this.container.createEl("canvas", {
      cls: "minimal-stl-view-cube",
      attr: { title: "点击立方体切换视图方向" },
    });
    this.cubeHitRegions = [];

    this.onViewCubePointerDown = (event) => {
      const rect = this.viewCubeCanvas.getBoundingClientRect();
      const point = [event.clientX - rect.left, event.clientY - rect.top];
      const region = [...this.cubeHitRegions].reverse().find((hit) => pointInPolygon(point, hit.points));
      if (!region) return;

      event.preventDefault();
      event.stopPropagation();
      this.setStandardView(region.view);
    };

    this.viewCubeCanvas.addEventListener("pointerdown", this.onViewCubePointerDown);
  }

  createProgram() {
    const gl = this.gl;
    const vertexShader = compileShader(gl, gl.VERTEX_SHADER, `
      attribute vec3 a_position;
      attribute vec3 a_normal;
      uniform mat4 u_view;
      uniform mat4 u_projection;
      varying vec3 v_normal;
      varying vec3 v_position;
      void main() {
        v_normal = normalize(a_normal);
        v_position = a_position;
        gl_Position = u_projection * u_view * vec4(a_position, 1.0);
      }
    `);
    const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, `
      precision mediump float;
      varying vec3 v_normal;
      varying vec3 v_position;
      uniform vec3 u_color;
      uniform vec3 u_lightDir;
      void main() {
        vec3 normal = normalize(v_normal);
        vec3 lightDir = normalize(u_lightDir);
        float diffuse = max(dot(normal, lightDir), 0.0);
        float backLight = max(dot(normal, -lightDir), 0.0) * 0.18;
        vec3 viewDir = normalize(vec3(0.0, 0.0, 1.0) - v_position);
        float rim = pow(1.0 - max(dot(normal, viewDir), 0.0), 2.0) * 0.12;
        vec3 shaded = u_color * (0.42 + diffuse * 0.54 + backLight) + vec3(rim);
        gl_FragColor = vec4(shaded, 1.0);
      }
    `);

    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || "Unable to link WebGL program.");
    }

    this.program = program;
    this.locations = {
      position: gl.getAttribLocation(program, "a_position"),
      normal: gl.getAttribLocation(program, "a_normal"),
      view: gl.getUniformLocation(program, "u_view"),
      projection: gl.getUniformLocation(program, "u_projection"),
      color: gl.getUniformLocation(program, "u_color"),
      lightDir: gl.getUniformLocation(program, "u_lightDir"),
    };
  }

  createBuffers() {
    const gl = this.gl;
    this.positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.model.positions, gl.STATIC_DRAW);

    this.normalBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.normalBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.model.normals, gl.STATIC_DRAW);
  }

  bindEvents() {
    this.onPointerDown = (event) => {
      this.isDragging = true;
      this.lastX = event.clientX;
      this.lastY = event.clientY;
      this.dragStartVector = mapPointerToTrackball(this.canvas, event);
      this.dragStartOrientation = this.orientation.slice();
      this.canvas.setPointerCapture(event.pointerId);
    };

    this.onPointerMove = (event) => {
      if (!this.isDragging) return;
      this.lastX = event.clientX;
      this.lastY = event.clientY;
      const currentVector = mapPointerToTrackball(this.canvas, event);
      const delta = quatFromUnitVectors(this.dragStartVector, currentVector);
      this.orientation = quatNormalize(quatMultiply(this.dragStartOrientation, delta));
      this.requestRender();
    };

    this.onPointerUp = (event) => {
      this.isDragging = false;
      this.dragStartVector = null;
      this.dragStartOrientation = null;
      if (this.canvas.hasPointerCapture(event.pointerId)) {
        this.canvas.releasePointerCapture(event.pointerId);
      }
    };

    this.onWheel = (event) => {
      event.preventDefault();
      const factor = Math.exp(event.deltaY * 0.001);
      this.distance = clamp(this.distance * factor, 1.2, 20);
      this.requestRender();
    };

    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointercancel", this.onPointerUp);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
  }

  setStandardView(view) {
    const views = {
      front: true,
      back: true,
      left: true,
      right: true,
      top: true,
      bottom: true,
    };
    if (!views[view]) return;

    this.orientation = getStandardViewOrientation(view);
    this.requestRender();
  }

  rotateInPlane(angle) {
    const zAxis = quatRotateVector(this.orientation, [0, 0, 1]);
    const roll = quatFromAxisAngle(zAxis, angle);
    this.orientation = quatNormalize(quatMultiply(roll, this.orientation));
    this.requestRender();
  }

  resize() {
    const rect = this.container.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    const ratio = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.floor(width * ratio));
    const pixelHeight = Math.max(1, Math.floor(height * ratio));

    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
    }

    this.requestRender();
  }

  requestRender() {
    this.needsRender = true;
  }

  renderLoop() {
    if (this.destroyed) return;
    if (this.needsRender) {
      this.draw();
      this.needsRender = false;
    }
    this.animationFrame = requestAnimationFrame(() => this.renderLoop());
  }

  draw() {
    const gl = this.gl;
    const width = this.canvas.width;
    const height = this.canvas.height;
    const aspect = width / Math.max(1, height);

    gl.viewport(0, 0, width, height);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.program);

    const zAxis = quatRotateVector(this.orientation, [0, 0, 1]);
    const up = quatRotateVector(this.orientation, [0, 1, 0]);
    const eye = [
      zAxis[0] * this.distance,
      zAxis[1] * this.distance,
      zAxis[2] * this.distance,
    ];
    const view = lookAt(eye, [0, 0, 0], up);
    const projection = perspective(Math.PI / 4, aspect, 0.01, 100);

    gl.uniformMatrix4fv(this.locations.view, false, view);
    gl.uniformMatrix4fv(this.locations.projection, false, projection);
    gl.uniform3fv(this.locations.color, this.color);
    gl.uniform3fv(this.locations.lightDir, normalize3([0.35, 0.75, 0.55]));

    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.enableVertexAttribArray(this.locations.position);
    gl.vertexAttribPointer(this.locations.position, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.normalBuffer);
    gl.enableVertexAttribArray(this.locations.normal);
    gl.vertexAttribPointer(this.locations.normal, 3, gl.FLOAT, false, 0, 0);

    gl.drawArrays(gl.TRIANGLES, 0, this.model.vertexCount);
    this.drawViewCube(eye, up);
  }

  drawViewCube(eye, up) {
    if (!this.viewCubeCanvas) return;

    const canvas = this.viewCubeCanvas;
    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(rect.width * ratio));
    const height = Math.max(1, Math.floor(rect.height * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    const basis = getCameraBasis(eye, [0, 0, 0], up);
    const center = [rect.width / 2, rect.height / 2];
    const scale = Math.min(rect.width, rect.height) * 0.28;
    const faces = getViewCubeFaces();
    const visibleFaces = faces
      .map((face) => ({ ...face, visibility: dot3(face.normal, basis.zAxis) }))
      .filter((face) => face.visibility > 0.01)
      .sort((a, b) => a.visibility - b.visibility);

    this.cubeHitRegions = [];

    for (const face of visibleFaces) {
      const points = face.vertices.map((vertex) => projectCubeVertex(vertex, basis, center, scale));
      const shade = Math.round(214 + face.visibility * 32);
      ctx.beginPath();
      ctx.moveTo(points[0][0], points[0][1]);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i][0], points[i][1]);
      }
      ctx.closePath();
      ctx.fillStyle = `rgb(${shade}, ${shade + 2}, ${shade + 8})`;
      ctx.strokeStyle = "rgba(42, 48, 60, 0.78)";
      ctx.lineWidth = 1;
      ctx.fill();
      ctx.stroke();

      const labelPoint = points.reduce((sum, point) => [sum[0] + point[0], sum[1] + point[1]], [0, 0]).map((value) => value / points.length);
      ctx.fillStyle = "rgba(22, 26, 34, 0.86)";
      ctx.font = "12px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(face.label, labelPoint[0], labelPoint[1]);
      this.cubeHitRegions.push({ view: face.view, points });
    }
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.animationFrame);
    if (this.resizeObserver) this.resizeObserver.disconnect();

    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerUp);
    this.canvas.removeEventListener("wheel", this.onWheel);
    if (this.viewCubeCanvas) {
      this.viewCubeCanvas.removeEventListener("pointerdown", this.onViewCubePointerDown);
    }

    const gl = this.gl;
    if (gl) {
      if (this.positionBuffer) gl.deleteBuffer(this.positionBuffer);
      if (this.normalBuffer) gl.deleteBuffer(this.normalBuffer);
      if (this.program) gl.deleteProgram(this.program);
    }
  }
}

function isSupportedModelFile(file) {
  return file instanceof TFile && SUPPORTED_MODEL_EXTENSIONS.includes(getFileExtension(file));
}

function isCadModelFile(file) {
  return file instanceof TFile && CAD_MODEL_EXTENSIONS.includes(getFileExtension(file));
}

function isCadModelReference(modelRef) {
  const extension = String(modelRef || "").split(".").pop().toLowerCase().replace(/\]\]$/, "");
  return CAD_MODEL_EXTENSIONS.includes(extension);
}

function getFirstModelReference(source) {
  const linkMatch = source.match(new RegExp(`\\[\\[([^\\]]+?${KNOWN_MODEL_PATTERN})(?:\\|[^\\]]+)?\\]\\]`, "i"));
  if (linkMatch) return linkMatch[1].trim();
  const firstLine = source.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return firstLine || "";
}

function insertModelViewerBlock(editor, modelRef) {
  const cursor = editor.getCursor();
  const currentLine = editor.getLine(cursor.line) || "";
  const beforeCursor = currentLine.slice(0, cursor.ch);
  const afterCursor = currentLine.slice(cursor.ch);
  const prefix = beforeCursor.trim() ? "\n" : "";
  const suffix = afterCursor.trim() ? "\n" : "";

  editor.replaceSelection(`${prefix}${createModelViewerBlock(modelRef)}${suffix}`);
}

function createModelViewerBlock(modelRef) {
  return `\`\`\`3d-viewer\n[[${modelRef}]]\n\`\`\``;
}

function getStlReferenceFromElement(element) {
  const attributes = ["src", "data-src", "href", "data-href", "alt", "title", "aria-label"];

  for (const attribute of attributes) {
    const value = element.getAttribute(attribute);
    const ref = extractModelReference(value);
    if (ref) return ref;
  }

  const child = element.querySelector("[src*='.stl' i], [src*='.obj' i], [src*='.3mf' i], [data-src*='.stl' i], [data-src*='.obj' i], [data-src*='.3mf' i], [href*='.stl' i], [href*='.obj' i], [href*='.3mf' i], [data-href*='.stl' i], [data-href*='.obj' i], [data-href*='.3mf' i], [alt*='.stl' i], [alt*='.obj' i], [alt*='.3mf' i]");
  if (child) {
    for (const attribute of attributes) {
      const value = child.getAttribute(attribute);
      const ref = extractModelReference(value);
      if (ref) return ref;
    }
  }

  return extractModelReference(element.textContent);
}

function extractModelReference(value) {
  if (!value) return "";
  const decoded = safeDecodeURIComponent(value).trim();
  const wikilink = decoded.match(new RegExp(`\\[\\[([^\\]]+?${SUPPORTED_MODEL_PATTERN})(?:\\|[^\\]]+)?\\]\\]`, "i"));
  if (wikilink) return wikilink[1].trim();

  const plain = decoded.match(new RegExp(`([^|#\\n\\r]+?${SUPPORTED_MODEL_PATTERN})\\b`, "i"));
  if (!plain) return "";

  return plain[1].replace(/^obsidian:\/\//, "").trim();
}

function getFileExtension(file) {
  return file && file.extension ? file.extension.toLowerCase() : "";
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch (_error) {
    return value;
  }
}

function renderError(container, message) {
  container.empty();
  container.createDiv({ cls: "minimal-stl-error", text: message });
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

async function parseModel(buffer, file) {
  const extension = getFileExtension(file);

  if (extension === "stl") return parseStl(buffer);
  if (extension === "obj") return parseObj(buffer);
  if (extension === "3mf") return parse3mf(buffer);

  throw new Error(`Unsupported 3D model format: .${extension}`);
}

function parseStl(buffer) {
  if (looksLikeBinaryStl(buffer)) {
    return parseBinaryStl(buffer);
  }
  return parseAsciiStl(buffer);
}

function looksLikeBinaryStl(buffer) {
  if (buffer.byteLength < 84) return false;
  const view = new DataView(buffer);
  const triangles = view.getUint32(80, true);
  return 84 + triangles * 50 === buffer.byteLength;
}

function parseBinaryStl(buffer) {
  const view = new DataView(buffer);
  const triangleCount = view.getUint32(80, true);
  const rawPositions = new Float32Array(triangleCount * 9);
  const rawNormals = new Float32Array(triangleCount * 9);
  const bounds = makeEmptyBounds();
  let offset = 84;
  let positionIndex = 0;
  let normalIndex = 0;

  for (let i = 0; i < triangleCount; i++) {
    let nx = view.getFloat32(offset, true);
    let ny = view.getFloat32(offset + 4, true);
    let nz = view.getFloat32(offset + 8, true);
    offset += 12;

    const base = positionIndex;
    for (let vertex = 0; vertex < 3; vertex++) {
      const x = view.getFloat32(offset, true);
      const y = view.getFloat32(offset + 4, true);
      const z = view.getFloat32(offset + 8, true);
      rawPositions[positionIndex++] = x;
      rawPositions[positionIndex++] = y;
      rawPositions[positionIndex++] = z;
      includeBounds(bounds, x, y, z);
      offset += 12;
    }

    if (!isFinite(nx) || !isFinite(ny) || !isFinite(nz) || length3([nx, ny, nz]) < 0.000001) {
      const computed = computeFaceNormal(rawPositions, base);
      nx = computed[0];
      ny = computed[1];
      nz = computed[2];
    }

    for (let vertex = 0; vertex < 3; vertex++) {
      rawNormals[normalIndex++] = nx;
      rawNormals[normalIndex++] = ny;
      rawNormals[normalIndex++] = nz;
    }

    offset += 2;
  }

  return normalizeModel(rawPositions, rawNormals, triangleCount, bounds);
}

function parseAsciiStl(buffer) {
  const text = new TextDecoder("utf-8").decode(buffer);
  const vertexPattern = /^\s*vertex\s+([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?)\s+([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?)\s+([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?)/gim;
  const points = [];
  const bounds = makeEmptyBounds();
  let match;

  while ((match = vertexPattern.exec(text))) {
    const x = Number.parseFloat(match[1]);
    const y = Number.parseFloat(match[2]);
    const z = Number.parseFloat(match[3]);
    points.push(x, y, z);
    includeBounds(bounds, x, y, z);
  }

  if (points.length === 0 || points.length % 9 !== 0) {
    throw new Error("This does not look like a valid STL file.");
  }

  const rawPositions = new Float32Array(points);
  const rawNormals = new Float32Array(points.length);
  const triangleCount = points.length / 9;
  let normalIndex = 0;

  for (let i = 0; i < rawPositions.length; i += 9) {
    const normal = computeFaceNormal(rawPositions, i);
    for (let vertex = 0; vertex < 3; vertex++) {
      rawNormals[normalIndex++] = normal[0];
      rawNormals[normalIndex++] = normal[1];
      rawNormals[normalIndex++] = normal[2];
    }
  }

  return normalizeModel(rawPositions, rawNormals, triangleCount, bounds);
}

function parseObj(buffer) {
  const text = new TextDecoder("utf-8").decode(buffer);
  const vertices = [];
  const vertexNormals = [];
  const rawPositions = [];
  const rawNormals = [];
  const bounds = makeEmptyBounds();
  const lines = text.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*/, "").trim();
    if (!line) continue;

    const parts = line.split(/\s+/);
    const type = parts[0].toLowerCase();

    if (type === "v" && parts.length >= 4) {
      vertices.push([
        Number.parseFloat(parts[1]),
        Number.parseFloat(parts[2]),
        Number.parseFloat(parts[3]),
      ]);
      continue;
    }

    if (type === "vn" && parts.length >= 4) {
      vertexNormals.push(normalize3([
        Number.parseFloat(parts[1]),
        Number.parseFloat(parts[2]),
        Number.parseFloat(parts[3]),
      ]));
      continue;
    }

    if (type !== "f" || parts.length < 4) continue;

    const face = parts.slice(1).map((token) => parseObjFaceToken(token, vertices.length, vertexNormals.length));
    for (let i = 1; i < face.length - 1; i++) {
      appendObjTriangle([face[0], face[i], face[i + 1]], vertices, vertexNormals, rawPositions, rawNormals, bounds);
    }
  }

  if (rawPositions.length === 0) {
    throw new Error("This OBJ file has no renderable faces.");
  }

  return normalizeModel(
    new Float32Array(rawPositions),
    new Float32Array(rawNormals),
    rawPositions.length / 9,
    bounds
  );
}

function parseObjFaceToken(token, vertexCount, normalCount) {
  const parts = token.split("/");
  const vertexIndex = resolveObjIndex(parts[0], vertexCount);
  const normalIndex = parts[2] ? resolveObjIndex(parts[2], normalCount) : -1;

  if (vertexIndex < 0 || vertexIndex >= vertexCount) {
    throw new Error(`OBJ face references a missing vertex: ${token}`);
  }

  return { vertexIndex, normalIndex };
}

function resolveObjIndex(value, count) {
  const index = Number.parseInt(value, 10);
  if (!Number.isFinite(index) || index === 0) return -1;
  return index > 0 ? index - 1 : count + index;
}

function appendObjTriangle(face, vertices, vertexNormals, rawPositions, rawNormals, bounds) {
  const base = rawPositions.length;

  for (const item of face) {
    const vertex = vertices[item.vertexIndex];
    rawPositions.push(vertex[0], vertex[1], vertex[2]);
    includeBounds(bounds, vertex[0], vertex[1], vertex[2]);
  }

  const hasVertexNormals = face.every((item) => item.normalIndex >= 0 && item.normalIndex < vertexNormals.length);
  if (hasVertexNormals) {
    for (const item of face) {
      const normal = vertexNormals[item.normalIndex];
      rawNormals.push(normal[0], normal[1], normal[2]);
    }
    return;
  }

  const normal = computeFaceNormal(rawPositions, base);
  for (let i = 0; i < 3; i++) {
    rawNormals.push(normal[0], normal[1], normal[2]);
  }
}

async function parse3mf(buffer) {
  const entries = readZipEntries(buffer);
  const modelEntry =
    entries.find((entry) => entry.name.toLowerCase().endsWith(".model") && entry.name.toLowerCase().includes("3d/")) ||
    entries.find((entry) => entry.name.toLowerCase().endsWith(".model"));

  if (!modelEntry) {
    throw new Error("This 3MF file does not contain a model XML file.");
  }

  const xmlBytes = await readZipEntryBytes(buffer, modelEntry);
  const xml = new TextDecoder("utf-8").decode(xmlBytes);
  return parse3mfModelXml(xml);
}

function parse3mfModelXml(xml) {
  if (typeof DOMParser === "undefined") {
    throw new Error("This Obsidian window does not provide DOMParser, so 3MF cannot be parsed here.");
  }

  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    throw new Error("The 3MF model XML could not be parsed.");
  }

  const objects = new Map();
  for (const objectEl of Array.from(doc.getElementsByTagName("object"))) {
    const id = objectEl.getAttribute("id");
    if (!id) continue;

    const meshEl = objectEl.getElementsByTagName("mesh")[0];
    const componentEls = Array.from(objectEl.getElementsByTagName("component"));
    objects.set(id, {
      vertices: meshEl ? parse3mfVertices(meshEl) : [],
      triangles: meshEl ? parse3mfTriangles(meshEl) : [],
      components: componentEls.map((componentEl) => ({
        objectId: componentEl.getAttribute("objectid") || "",
        transform: parse3mfTransform(componentEl.getAttribute("transform")),
      })),
    });
  }

  const rawPositions = [];
  const rawNormals = [];
  const bounds = makeEmptyBounds();
  const buildItems = Array.from(doc.getElementsByTagName("build")[0]?.getElementsByTagName("item") || []);

  if (buildItems.length > 0) {
    for (const itemEl of buildItems) {
      append3mfObject(
        itemEl.getAttribute("objectid") || "",
        objects,
        [parse3mfTransform(itemEl.getAttribute("transform"))],
        rawPositions,
        rawNormals,
        bounds,
        new Set()
      );
    }
  } else {
    for (const [objectId, objectData] of objects) {
      if (objectData.triangles.length > 0) {
        append3mfObject(objectId, objects, [], rawPositions, rawNormals, bounds, new Set());
      }
    }
  }

  if (rawPositions.length === 0) {
    throw new Error("This 3MF file has no renderable mesh triangles.");
  }

  return normalizeModel(
    new Float32Array(rawPositions),
    new Float32Array(rawNormals),
    rawPositions.length / 9,
    bounds
  );
}

function parse3mfVertices(meshEl) {
  return Array.from(meshEl.getElementsByTagName("vertex")).map((vertexEl) => [
    readRequiredNumberAttribute(vertexEl, "x"),
    readRequiredNumberAttribute(vertexEl, "y"),
    readRequiredNumberAttribute(vertexEl, "z"),
  ]);
}

function parse3mfTriangles(meshEl) {
  return Array.from(meshEl.getElementsByTagName("triangle")).map((triangleEl) => [
    readRequiredIntegerAttribute(triangleEl, "v1"),
    readRequiredIntegerAttribute(triangleEl, "v2"),
    readRequiredIntegerAttribute(triangleEl, "v3"),
  ]);
}

function append3mfObject(objectId, objects, transforms, rawPositions, rawNormals, bounds, stack) {
  const objectData = objects.get(objectId);
  if (!objectData || stack.has(objectId)) return;

  const nextStack = new Set(stack);
  nextStack.add(objectId);

  for (const component of objectData.components) {
    append3mfObject(
      component.objectId,
      objects,
      [component.transform, ...transforms],
      rawPositions,
      rawNormals,
      bounds,
      nextStack
    );
  }

  for (const triangle of objectData.triangles) {
    append3mfTriangle(triangle, objectData.vertices, transforms, rawPositions, rawNormals, bounds);
  }
}

function append3mfTriangle(triangle, vertices, transforms, rawPositions, rawNormals, bounds) {
  const base = rawPositions.length;

  for (const vertexIndex of triangle) {
    const vertex = vertices[vertexIndex];
    if (!vertex) {
      throw new Error(`3MF triangle references a missing vertex: ${vertexIndex}`);
    }

    const transformed = apply3mfTransformChain(vertex, transforms);
    rawPositions.push(transformed[0], transformed[1], transformed[2]);
    includeBounds(bounds, transformed[0], transformed[1], transformed[2]);
  }

  const normal = computeFaceNormal(rawPositions, base);
  for (let i = 0; i < 3; i++) {
    rawNormals.push(normal[0], normal[1], normal[2]);
  }
}

function parse3mfTransform(value) {
  if (!value || !value.trim()) return null;

  const numbers = value.trim().split(/\s+/).map((part) => Number.parseFloat(part));
  if (numbers.length !== 12 || numbers.some((number) => !Number.isFinite(number))) {
    throw new Error(`Invalid 3MF transform: ${value}`);
  }

  return numbers;
}

function apply3mfTransformChain(vertex, transforms) {
  let point = vertex;
  for (const transform of transforms) {
    if (transform) point = apply3mfTransform(point, transform);
  }
  return point;
}

function apply3mfTransform(point, matrix) {
  return [
    point[0] * matrix[0] + point[1] * matrix[3] + point[2] * matrix[6] + matrix[9],
    point[0] * matrix[1] + point[1] * matrix[4] + point[2] * matrix[7] + matrix[10],
    point[0] * matrix[2] + point[1] * matrix[5] + point[2] * matrix[8] + matrix[11],
  ];
}

function readRequiredNumberAttribute(element, name) {
  const value = Number.parseFloat(element.getAttribute(name));
  if (!Number.isFinite(value)) {
    throw new Error(`Missing or invalid numeric attribute: ${name}`);
  }
  return value;
}

function readRequiredIntegerAttribute(element, name) {
  const value = Number.parseInt(element.getAttribute(name), 10);
  if (!Number.isFinite(value)) {
    throw new Error(`Missing or invalid integer attribute: ${name}`);
  }
  return value;
}

function readZipEntries(buffer) {
  const view = new DataView(buffer);
  const eocdOffset = findZipEndOfCentralDirectory(view);
  if (eocdOffset < 0) {
    throw new Error("This does not look like a valid 3MF ZIP package.");
  }

  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true);

  if (entryCount === 0xffff || centralDirectoryOffset === 0xffffffff) {
    throw new Error("ZIP64 3MF packages are not supported yet.");
  }

  const entries = [];
  let offset = centralDirectoryOffset;

  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("Invalid ZIP central directory in 3MF file.");
    }

    const bitFlag = view.getUint16(offset + 8, true);
    const compressionMethod = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const fileNameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const nameStart = offset + 46;
    const nameBytes = new Uint8Array(buffer, nameStart, fileNameLength);

    entries.push({
      name: decodeZipFileName(nameBytes, bitFlag),
      bitFlag,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });

    offset = nameStart + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

function findZipEndOfCentralDirectory(view) {
  const minOffset = Math.max(0, view.byteLength - 65557);
  for (let offset = view.byteLength - 22; offset >= minOffset; offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  return -1;
}

async function readZipEntryBytes(buffer, entry) {
  if ((entry.bitFlag & 1) !== 0) {
    throw new Error("Encrypted 3MF ZIP entries are not supported.");
  }

  const view = new DataView(buffer);
  if (view.getUint32(entry.localHeaderOffset, true) !== 0x04034b50) {
    throw new Error("Invalid ZIP local header in 3MF file.");
  }

  const fileNameLength = view.getUint16(entry.localHeaderOffset + 26, true);
  const extraLength = view.getUint16(entry.localHeaderOffset + 28, true);
  const dataStart = entry.localHeaderOffset + 30 + fileNameLength + extraLength;
  const compressed = new Uint8Array(buffer).slice(dataStart, dataStart + entry.compressedSize);

  if (entry.compressionMethod === 0) return compressed;
  if (entry.compressionMethod === 8) {
    const inflated = await inflateRawDeflate(compressed);
    if (entry.uncompressedSize && inflated.byteLength !== entry.uncompressedSize) {
      return inflated.slice(0, entry.uncompressedSize);
    }
    return inflated;
  }

  throw new Error(`Unsupported ZIP compression method in 3MF file: ${entry.compressionMethod}`);
}

async function inflateRawDeflate(bytes) {
  const nodeInflated = tryInflateRawWithNode(bytes);
  if (nodeInflated) return nodeInflated;

  if (typeof DecompressionStream === "undefined") {
    throw new Error("This Obsidian window cannot decompress 3MF ZIP entries.");
  }

  let lastError = null;
  for (const format of ["deflate-raw", "deflate"]) {
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`Could not decompress 3MF ZIP entry: ${formatError(lastError)}`);
}

function tryInflateRawWithNode(bytes) {
  try {
    const zlib = require("zlib");
    const buffer = zlib.inflateRawSync(Buffer.from(bytes));
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength).slice();
  } catch (_error) {
    return null;
  }
}

function decodeZipFileName(bytes, bitFlag) {
  const encoding = (bitFlag & 0x800) !== 0 ? "utf-8" : "utf-8";
  return new TextDecoder(encoding).decode(bytes).replace(/\\/g, "/");
}

function normalizeModel(rawPositions, rawNormals, triangleCount, bounds) {
  const center = [
    (bounds.minX + bounds.maxX) / 2,
    (bounds.minY + bounds.maxY) / 2,
    (bounds.minZ + bounds.maxZ) / 2,
  ];
  const size = [
    bounds.maxX - bounds.minX,
    bounds.maxY - bounds.minY,
    bounds.maxZ - bounds.minZ,
  ];
  const maxSize = Math.max(size[0], size[1], size[2], 0.000001);
  const scale = 2.25 / maxSize;
  const positions = new Float32Array(rawPositions.length);
  const normals = new Float32Array(rawNormals.length);

  for (let i = 0; i < rawPositions.length; i += 3) {
    positions[i] = (rawPositions[i] - center[0]) * scale;
    positions[i + 1] = (rawPositions[i + 1] - center[1]) * scale;
    positions[i + 2] = (rawPositions[i + 2] - center[2]) * scale;

    const normal = normalize3([rawNormals[i], rawNormals[i + 1], rawNormals[i + 2]]);
    normals[i] = normal[0];
    normals[i + 1] = normal[1];
    normals[i + 2] = normal[2];
  }

  return {
    positions,
    normals,
    triangleCount,
    vertexCount: positions.length / 3,
    center,
    size,
  };
}

function makeEmptyBounds() {
  return {
    minX: Infinity,
    minY: Infinity,
    minZ: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
    maxZ: -Infinity,
  };
}

function includeBounds(bounds, x, y, z) {
  bounds.minX = Math.min(bounds.minX, x);
  bounds.minY = Math.min(bounds.minY, y);
  bounds.minZ = Math.min(bounds.minZ, z);
  bounds.maxX = Math.max(bounds.maxX, x);
  bounds.maxY = Math.max(bounds.maxY, y);
  bounds.maxZ = Math.max(bounds.maxZ, z);
}

function computeFaceNormal(positions, index) {
  const ax = positions[index];
  const ay = positions[index + 1];
  const az = positions[index + 2];
  const bx = positions[index + 3];
  const by = positions[index + 4];
  const bz = positions[index + 5];
  const cx = positions[index + 6];
  const cy = positions[index + 7];
  const cz = positions[index + 8];
  const ux = bx - ax;
  const uy = by - ay;
  const uz = bz - az;
  const vx = cx - ax;
  const vy = cy - ay;
  const vz = cz - az;
  return normalize3([
    uy * vz - uz * vy,
    uz * vx - ux * vz,
    ux * vy - uy * vx,
  ]);
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) || "Unable to compile WebGL shader.");
  }
  return shader;
}

function perspective(fov, aspect, near, far) {
  const f = 1 / Math.tan(fov / 2);
  const rangeInv = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (near + far) * rangeInv, -1,
    0, 0, near * far * rangeInv * 2, 0,
  ]);
}

function lookAt(eye, target, up) {
  const { xAxis, yAxis, zAxis } = getCameraBasis(eye, target, up);

  return new Float32Array([
    xAxis[0], yAxis[0], zAxis[0], 0,
    xAxis[1], yAxis[1], zAxis[1], 0,
    xAxis[2], yAxis[2], zAxis[2], 0,
    -dot3(xAxis, eye), -dot3(yAxis, eye), -dot3(zAxis, eye), 1,
  ]);
}

function getCameraBasis(eye, target, up) {
  const zAxis = normalize3([
    eye[0] - target[0],
    eye[1] - target[1],
    eye[2] - target[2],
  ]);
  const xAxis = normalize3(cross3(up, zAxis));
  const yAxis = cross3(zAxis, xAxis);
  return { xAxis, yAxis, zAxis };
}

function getStandardViewOrientation(view) {
  const views = {
    isometric: { direction: [-0.4706, 0.435, 0.7675], up: [0, 1, 0] },
    front: { direction: [0, 0, 1], up: [0, 1, 0] },
    back: { direction: [0, 0, -1], up: [0, 1, 0] },
    left: { direction: [-1, 0, 0], up: [0, 1, 0] },
    right: { direction: [1, 0, 0], up: [0, 1, 0] },
    top: { direction: [0, 1, 0], up: [0, 0, -1] },
    bottom: { direction: [0, -1, 0], up: [0, 0, 1] },
  };
  const selected = views[view] || views.isometric;
  return orientationFromDirectionUp(selected.direction, selected.up);
}

function orientationFromDirectionUp(direction, up) {
  const basis = getCameraBasis(direction, [0, 0, 0], up);
  return quatFromBasis(basis.xAxis, basis.yAxis, basis.zAxis);
}

function mapPointerToTrackball(canvas, event) {
  const rect = canvas.getBoundingClientRect();
  const size = Math.max(1, Math.min(rect.width, rect.height));
  let x = (2 * (event.clientX - rect.left) - rect.width) / size;
  let y = (rect.height - 2 * (event.clientY - rect.top)) / size;
  const lengthSq = x * x + y * y;

  if (lengthSq > 1) {
    const length = Math.sqrt(lengthSq);
    x /= length;
    y /= length;
    return [x, y, 0];
  }

  return [x, y, Math.sqrt(1 - lengthSq)];
}

function quatFromUnitVectors(from, to) {
  const dot = dot3(from, to);
  if (dot < -0.999999) {
    const axis = Math.abs(from[0]) > 0.1 ? normalize3(cross3([0, 1, 0], from)) : normalize3(cross3([1, 0, 0], from));
    return [axis[0], axis[1], axis[2], 0];
  }

  const cross = cross3(from, to);
  return quatNormalize([cross[0], cross[1], cross[2], 1 + dot]);
}

function quatFromAxisAngle(axis, angle) {
  const unitAxis = normalize3(axis);
  const half = angle / 2;
  const sinHalf = Math.sin(half);
  return quatNormalize([
    unitAxis[0] * sinHalf,
    unitAxis[1] * sinHalf,
    unitAxis[2] * sinHalf,
    Math.cos(half),
  ]);
}

function quatFromBasis(xAxis, yAxis, zAxis) {
  const m00 = xAxis[0];
  const m01 = yAxis[0];
  const m02 = zAxis[0];
  const m10 = xAxis[1];
  const m11 = yAxis[1];
  const m12 = zAxis[1];
  const m20 = xAxis[2];
  const m21 = yAxis[2];
  const m22 = zAxis[2];
  const trace = m00 + m11 + m22;
  let x;
  let y;
  let z;
  let w;

  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = 0.25 * s;
    x = (m21 - m12) / s;
    y = (m02 - m20) / s;
    z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }

  return quatNormalize([x, y, z, w]);
}

function quatMultiply(a, b) {
  const ax = a[0];
  const ay = a[1];
  const az = a[2];
  const aw = a[3];
  const bx = b[0];
  const by = b[1];
  const bz = b[2];
  const bw = b[3];

  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function quatNormalize(q) {
  const length = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!Number.isFinite(length) || length < 0.000001) return [0, 0, 0, 1];
  return [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
}

function quatRotateVector(q, v) {
  const qx = q[0];
  const qy = q[1];
  const qz = q[2];
  const qw = q[3];
  const vx = v[0];
  const vy = v[1];
  const vz = v[2];
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);

  return [
    vx + qw * tx + (qy * tz - qz * ty),
    vy + qw * ty + (qz * tx - qx * tz),
    vz + qw * tz + (qx * ty - qy * tx),
  ];
}

function getViewCubeFaces() {
  return [
    { view: "front", label: "前", normal: [0, 0, 1], vertices: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
    { view: "back", label: "后", normal: [0, 0, -1], vertices: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
    { view: "right", label: "右", normal: [1, 0, 0], vertices: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },
    { view: "left", label: "左", normal: [-1, 0, 0], vertices: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
    { view: "top", label: "上", normal: [0, 1, 0], vertices: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },
    { view: "bottom", label: "下", normal: [0, -1, 0], vertices: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
  ];
}

function projectCubeVertex(vertex, basis, center, scale) {
  return [
    center[0] + dot3(vertex, basis.xAxis) * scale,
    center[1] - dot3(vertex, basis.yAxis) * scale,
  ];
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0];
    const yi = polygon[i][1];
    const xj = polygon[j][0];
    const yj = polygon[j][1];
    const intersects = ((yi > point[1]) !== (yj > point[1])) &&
      (point[0] < (xj - xi) * (point[1] - yi) / (yj - yi || 1e-9) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

function cross3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function length3(v) {
  return Math.sqrt(dot3(v, v));
}

function normalize3(v) {
  const length = length3(v);
  if (!Number.isFinite(length) || length < 0.000001) return [0, 1, 0];
  return [v[0] / length, v[1] / length, v[2] / length];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function hexToRgb(hex) {
  const clean = hex.replace("#", "");
  const value = Number.parseInt(clean.length === 3 ? clean.split("").map((ch) => ch + ch).join("") : clean, 16);
  return [
    ((value >> 16) & 255) / 255,
    ((value >> 8) & 255) / 255,
    (value & 255) / 255,
  ];
}

function rgbToHex(rgb) {
  return "#" + rgb.map((value) => {
    const n = Math.max(0, Math.min(255, Math.round(value * 255)));
    return n.toString(16).padStart(2, "0");
  }).join("");
}
