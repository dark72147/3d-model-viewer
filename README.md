# 3D Model Viewer

3D Model Viewer is a lightweight Obsidian plugin for previewing local 3D model files directly inside notes.

It supports STL, OBJ, and 3MF files, with automatic centering, clean rendering, mouse rotation, zooming, and a view cube for quick view direction changes.

## Features

- Preview STL, OBJ, and 3MF files in Obsidian notes
- Open supported 3D model files directly in a custom viewer
- Automatic model centering and scaling
- Clean display without grid, axes, or shadows
- Mouse drag rotation and wheel zoom
- View cube for switching view direction
- In-plane 90 degree rotation controls
- Command palette support for inserting viewer blocks

## Supported Formats

- `.stl`
- `.obj`
- `.3mf`

STEP/STP files are CAD solid formats and are not displayed directly. Please convert them to STL, OBJ, or 3MF before using this plugin.

## Usage

Insert a 3D viewer code block in your note:

````text
```3d-viewer
[[your-model.stl]]
```
````

You can also use OBJ or 3MF files:

````text
```3d-viewer
[[your-model.obj]]
```
````

````text
```3d-viewer
[[your-model.3mf]]
```
````

The older `stl-viewer` code block is still supported:

````text
```stl-viewer
[[your-model.stl]]
```
````

## Command Palette

Open the Obsidian command palette and run:

```text
Insert 3D model viewer block
```

Then select a supported model file. The plugin will insert the viewer block automatically.

## Installation

### Manual Installation

1. Download or copy the following files:

- `main.js`
- `manifest.json`
- `styles.css`

2. Place them in:

```text
<vault>/.obsidian/plugins/three-d-model-viewer/
```
3. Restart Obsidian.

4. Enable the plugin in:

```text
Settings > Community plugins > Installed plugins
```

## Notes

- This plugin is designed for local model preview inside Obsidian.
- Large models may take longer to load.
- 3MF support focuses on common mesh-based 3MF files.
- STEP/STP support requires conversion to a mesh format first.

## License

MIT
