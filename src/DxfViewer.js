import * as THREE from "three";
// import { Octree } from "three/examples/jsm/math/Octree.js"; // Currently unused? Remove if not needed

import { BatchingKey } from "./BatchingKey";
import { Block } from "./blocks/Block"; // Assuming BlockContext is exported or accessible
import { ColorCode, DxfScene } from "./DxfScene";
import { DxfWorker } from "./DxfWorker";
import { MaterialKey } from "./MaterialKey";
import { OrbitControls } from "./OrbitControls";
import { RBTree } from "./RBTree";
import { BoundingBoxManager } from "./utils/BoundingBoxManager"; // Use the refactored BoundingBoxManager
import { Select } from "./utils/Select"; // Use the refactored Select

/** Level in "message" events. */
const MessageLevel = Object.freeze({
	INFO: "info",
	WARN: "warn",
	ERROR: "error"
});

// Keep blockBoundingBoxMap global or move into the class if preferred
const blockBoundingBoxMap = new Map();
// let objectCount = 0; // Seems unused
// let index = 0; // Seems unused
let allBlockEntity = []; // Keep global or move into the class if preferred

/** The representation class for the viewer, based on Three.js WebGL renderer. */
export class DxfViewer {
	/** @param domContainer Container element to create the canvas in. Usually empty div. Should not
	 *  have padding if auto-resize feature is used.
	 * @param options Some options can be overridden if specified. See DxfViewer.DefaultOptions
	 */
	constructor(domContainer, options = null) {
		this.domContainer = domContainer;
		this.options = Object.create(DxfViewer.DefaultOptions);
		if (options) {
			Object.assign(this.options, options);
		}
		options = this.options;

		this.clearColor = this.options.clearColor.getHex();
		// this.boundingBoxMeshList = []; // Managed by BoundingBoxManager now
		this.scene = new THREE.Scene();
		this.raycaster = new THREE.Raycaster(); // Keep if used elsewhere, otherwise Select handles its own
		this.mouse = new THREE.Vector2(); // Keep if used elsewhere
		this.entityMap = new Map(); // Keep if used elsewhere
		// this.octree = new Octree(); // Currently unused? Remove if not needed
		// this.octreeObjects = []; // Currently unused? Remove if not needed

		// this.hoveredObject = null; // Managed by Select/BBoxManager now
		// this.outlineMaterial = new THREE.MeshBasicMaterial({ // Example, remove if not used
		// 	color: 0xffff00,
		// 	side: THREE.BackSide,
		// });
		// this.outlineMesh = null; // Example, remove if not used

		try {
			this.renderer = new THREE.WebGLRenderer({
				alpha: options.canvasAlpha,
				premultipliedAlpha: options.canvasPremultipliedAlpha,
				antialias: options.antialias,
				depth: false, // Keep false if overlaying or specific rendering needs
				preserveDrawingBuffer: options.preserveDrawingBuffer
			});
		} catch (e) {
			console.error("Failed to create renderer: " + e); // Use console.error
			this.renderer = null;
			return;
		}
		const renderer = this.renderer;
		renderer.sortObjects = false;
		renderer.setPixelRatio(window.devicePixelRatio);

		const camera = (this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 2));
		camera.position.z = 1;
		camera.position.x = 0;
		camera.position.y = 0;

		this.simpleColorMaterial = [];
		this.simplePointMaterial = [];
		for (let i = 0; i < InstanceType.MAX; i++) {
			this.simpleColorMaterial[i] = this._CreateSimpleColorMaterial(i);
			this.simplePointMaterial[i] = this._CreateSimplePointMaterial(i);
		}

		renderer.setClearColor(options.clearColor, options.clearAlpha);

		if (options.autoResize) {
			this.canvasWidth = domContainer.clientWidth || options.canvasWidth; // Fallback
			this.canvasHeight = domContainer.clientHeight || options.canvasHeight; // Fallback
			domContainer.style.position = "relative"; // Needed for absolute canvas positioning
		} else {
			this.canvasWidth = options.canvasWidth;
			this.canvasHeight = options.canvasHeight;
			this.resizeObserver = null;
		}
		renderer.setSize(this.canvasWidth, this.canvasHeight);

		this.canvas = renderer.domElement;
		domContainer.style.display = "block"; // Ensure container takes space
		if (options.autoResize) {
			this.canvas.style.position = "absolute";
			this.canvas.style.top = "0";
			this.canvas.style.left = "0";
			this.resizeObserver = new ResizeObserver((entries) => this._OnResize(entries[0]));
			this.resizeObserver.observe(domContainer);
		}
		domContainer.appendChild(this.canvas);

		// Remove default listeners if Select handles them
		// this.canvas.addEventListener("mousemove", this._OnPointerEvent.bind(this));
		// this.canvas.addEventListener("pointerdown", this._OnPointerEvent.bind(this));
		// this.canvas.addEventListener("pointerup", this._OnPointerEvent.bind(this));

		this.Render();

		/* Indexed by MaterialKey, value is {key, material}. */
		this.materials = new RBTree((m1, m2) => m1.key.Compare(m2.key));
		/* Indexed by layer name, value is Layer instance. */
		this.layers = new Map();
		/* Indexed by block name, value is Block instance. */
		this.blocks = new Map();

		/** Set during data loading. */
		this.worker = null;

		/** @type {BoundingBoxManager | null} */
		this.boundingBoxManager = null;
		/** @type {Select | null} */
		this.selector = null; // Renamed from select for clarity
		/** @type {OrbitControls | null} */
		this.controls = null;
		/** @type {{x: number, y: number} | null} */
		this.origin = null;
		/** @type {{minX: number, maxX: number, minY: number, maxY: number} | null} */
		this.bounds = null;
		/** @type {object | null} */
		this.parsedDxf = null;
		/** @type {boolean} */
		this.hasMissingChars = false;
	}

	// --- Public API Methods ---

	HasRenderer() {
		return Boolean(this.renderer);
	}

	GetRenderer() {
		return this.renderer;
	}

	GetCanvas() {
		return this.canvas;
	}

	GetDxf() {
		return this.parsedDxf;
	}

	GetScene() {
		return this.scene;
	}

	GetCamera() {
		return this.camera;
	}

	GetBoundingBoxes() {
		// Replaced by manager access if needed
		return this.boundingBoxManager ? this.boundingBoxManager.boundingBoxMeshList : [];
	}

	GetOrigin() {
		return this.origin;
	}

	GetBounds() {
		return this.bounds;
	}

	Render() {
		if (!this.renderer) return; // Check if renderer exists

		// Make sure camera matrix is up to date
		this.camera.updateMatrixWorld();

		// Clear the renderer
		this.renderer.clear();

		// Render the scene
		this.renderer.render(this.scene, this.camera);
	}

	SetSize(width, height) {
		this._EnsureRenderer();
		if (width === this.canvasWidth && height === this.canvasHeight) return; // Avoid unnecessary updates

		// --- Camera Update ---
		// Maintain center and scale relative to new aspect ratio
		const oldAspect = this.canvasWidth / this.canvasHeight;
		const newAspect = width / height;

		const cam = this.camera;
		const currentWidth = cam.right - cam.left;
		const currentHeight = cam.top - cam.bottom;
		const centerX = (cam.left + cam.right) / 2;
		const centerY = (cam.bottom + cam.top) / 2;

		let newWidth, newHeight;
		if (newAspect >= oldAspect) {
			// Wider or same aspect: Match height, adjust width
			newHeight = currentHeight;
			newWidth = newHeight * newAspect;
		} else {
			// Taller aspect: Match width, adjust height
			newWidth = currentWidth;
			newHeight = newWidth / newAspect;
		}

		cam.left = centerX - newWidth / 2;
		cam.right = centerX + newWidth / 2;
		cam.bottom = centerY - newHeight / 2;
		cam.top = centerY + newHeight / 2;
		cam.updateProjectionMatrix();

		// --- Update Members & Renderer ---
		this.canvasWidth = width;
		this.canvasHeight = height;
		this.renderer.setSize(width, height);
		if (this.controls) {
			this.controls.update(); // Important for OrbitControls
		}

		this._Emit("resized", { width, height });
		this._Emit("viewChanged"); // View potentially changed due to aspect ratio
		this.Render();
	}

	SetView(center, width) {
		const aspect = this.canvasWidth / this.canvasHeight;
		const height = width / aspect;
		const cam = this.camera;
		cam.left = -width / 2;
		cam.right = width / 2;
		cam.top = height / 2;
		cam.bottom = -height / 2;
		cam.zoom = 1; // Reset zoom when setting view explicitly
		cam.position.set(center.x, center.y, cam.position.z); // Keep current Z
		cam.rotation.set(0, 0, 0);
		// cam.updateMatrix(); // position/rotation set above handle this
		cam.updateProjectionMatrix(); // Essential after changing bounds/zoom

		// Update controls target to match new center
		if (this.controls) {
			this.controls.target.set(center.x, center.y, 0);
			this.controls.update();
		}

		this._Emit("viewChanged");
		this.Render(); // Render the change
	}
	_Emit(eventName, data = null) {
		this.canvas.dispatchEvent(new CustomEvent(EVENT_NAME_PREFIX + eventName, { detail: data }));
	}

	FitView(minX, maxX, minY, maxY, padding = 0.1) {
		const aspect = this.canvasWidth / this.canvasHeight;
		let width = maxX - minX;
		let height = maxY - minY;
		const center = { x: minX + width / 2, y: minY + height / 2 };

		// Adjust width/height based on aspect ratio to fit everything
		if (width / height > aspect) {
			// Content is wider than view: use width, calculate required height
			height = width / aspect;
		} else {
			// Content is taller than view (or same aspect): use height, calculate required width
			width = height * aspect;
		}

		// Add padding
		width *= 1 + padding;
		// height *= (1 + padding); // Width adjustment already covers height padding implicitly

		if (width <= Number.EPSILON * 2) {
			width = 1; // Prevent zero width
		}

		this.SetView(center, width);
	}

	ResetView() {
		if (this.bounds && this.origin) {
			this.FitView(
				this.bounds.minX - this.origin.x,
				this.bounds.maxX - this.origin.x,
				this.bounds.minY - this.origin.y,
				this.bounds.maxY - this.origin.y
			);
			// FitView calls Render
		}
	}

	GetLayers() {
		const result = [];
		for (const lyr of this.layers.values()) {
			result.push({
				name: lyr.name,
				displayName: lyr.displayName,
				color: this._TransformColor(lyr.color)
			});
		}
		return result;
	}

	ShowLayer(name, show) {
		const layer = this.layers.get(name);
		if (!layer) return;

		layer.visible = show;

		// Update all objects in this layer
		layer.objects.forEach((obj) => {
			obj.visible = show;
			// Also update any associated bounding boxes
			const bbox = this.boundingBoxManager?.getMesh(obj.userData?.entityUUID);
			if (bbox) {
				bbox.visible =
					show &&
					(this.selectedEntities?.has(obj.userData?.entityUUID) ||
						this.hoveredEntityUUID === obj.userData?.entityUUID);
			}
		});

		this.Render();
	}

	Subscribe(eventName, eventHandler) {
		this._EnsureRenderer();
		// Use a more specific prefix if needed, or just use the name directly
		this.canvas.addEventListener(EVENT_NAME_PREFIX + eventName, eventHandler);
	}

	Unsubscribe(eventName, eventHandler) {
		this._EnsureRenderer();
		this.canvas.removeEventListener(EVENT_NAME_PREFIX + eventName, eventHandler);
	}

	Clear() {
		this._EnsureRenderer();
		if (this.worker) {
			this.worker.Destroy(true);
			this.worker = null;
		}
		if (this.controls) {
			this.controls.dispose();
			this.controls = null;
		}
		if (this.selector) {
			this.selector.dispose(); // Dispose the selector
			this.selector = null;
		}
		if (this.boundingBoxManager) {
			this.boundingBoxManager.dispose(); // Dispose the manager
			this.boundingBoxManager = null;
		}

		// Clear scene objects (including bounding boxes added by the manager)
		while (this.scene.children.length > 0) {
			this.scene.remove(this.scene.children[0]);
		}

		// Dispose layers and materials
		for (const layer of this.layers.values()) {
			layer.Dispose(); // Assuming Layer.Dispose handles geometry/material
		}
		this.layers.clear();
		this.blocks.clear();
		this.materials.each((e) => e.material.dispose());
		this.materials.clear();

		// Reset state
		this.origin = null;
		this.bounds = null;
		this.parsedDxf = null;
		this.hasMissingChars = false;
		blockBoundingBoxMap.clear(); // Clear global map
		allBlockEntity = []; // Clear global array

		this.SetView({ x: 0, y: 0 }, 2); // Reset view
		this._Emit("cleared");
		this.Render();
	}

	Destroy() {
		if (!this.HasRenderer()) {
			return;
		}
		if (this.resizeObserver) {
			this.resizeObserver.disconnect();
			this.resizeObserver = null;
		}
		this.Clear(); // Handles controls, selector, manager, scene, etc.

		// Dispose base materials
		for (const m of this.simplePointMaterial) {
			m?.dispose();
		}
		for (const m of this.simpleColorMaterial) {
			m?.dispose();
		}
		this.simplePointMaterial = [];
		this.simpleColorMaterial = [];

		this.renderer.dispose();
		this.renderer = null;
		// Remove canvas from DOM
		if (this.canvas && this.canvas.parentNode) {
			this.canvas.parentNode.removeChild(this.canvas);
		}
		this.canvas = null;
		this._Emit("destroyed"); // Emit last
	}

	// --- Loading Method ---

	async Load({ url, fonts = null, progressCbk = null, workerFactory = null }) {
		if (url === null || url === undefined) {
			throw new Error("`url` parameter is not specified");
		}

		this._EnsureRenderer();
		this.Clear(); // Clear previous state before loading

		// --- Start Worker ---
		this.worker = new DxfWorker(workerFactory ? workerFactory() : null);
		let sceneData, dxfData;
		try {
			const result = await this.worker.Load(url, fonts, this.options, progressCbk);
			sceneData = result.scene;
			dxfData = result.dxf;
			// blockData = result.blockData; // Use if needed
		} catch (error) {
			console.error("Failed to load or parse DXF:", error);
			this._Message(`Failed to load DXF: ${error.message}`, MessageLevel.ERROR);
			await this.worker?.Destroy();
			this.worker = null;
			return; // Stop loading process
		} finally {
			await this.worker?.Destroy(); // Ensure worker is destroyed
			this.worker = null;
		}

		// --- Process Loaded Data ---
		this.parsedDxf = dxfData;
		this.origin = sceneData.origin;
		this.bounds = sceneData.bounds;
		this.hasMissingChars = sceneData.hasMissingChars;

		// 1. Calculate Block Definition Bounding Boxes (Local Coords)
		this._calculateBlockDefinitionBounds(dxfData);

		// 2. Collect Top-Level Block Entities
		this._collectBlockEntities(dxfData);

		// 3. Process Layers
		for (const layer of sceneData.layers) {
			this.layers.set(layer.name, new Layer(layer.name, layer.displayName, layer.color));
		}

		// 4. Process Block Definitions (Load geometry batches into Block instances)
		for (const batch of sceneData.batches) {
			if (
				batch.key.blockName !== null &&
				batch.key.geometryType !== BatchingKey.GeometryType.BLOCK_INSTANCE &&
				batch.key.geometryType !== BatchingKey.GeometryType.POINT_INSTANCE
			) {
				let block = this.blocks.get(batch.key.blockName);
				if (!block) {
					block = new Block(); // Assuming Block constructor takes no args now
					this.blocks.set(batch.key.blockName, block);
				}
				// Pass sceneData for buffer access
				block.PushBatch(new Batch(this, sceneData, batch));
			}
		}

		console.log(`DXF scene loaded:
             ${sceneData.batches.length} batches,
             ${this.layers.size} layers,
             ${this.blocks.size} blocks`);
		// Add vertex/index counts if needed

		// 5. Instantiate Entities (Create THREE objects from batches)
		for (const batch of sceneData.batches) {
			// Pass sceneData for buffer access
			this._LoadBatch(sceneData, batch);
		}

		console.log("Scene contents:", {
			numChildren: this.scene.children.length,
			bounds: this.bounds,
			origin: this.origin
		});

		// --- Setup Interaction ---
		// 6. Initialize BoundingBoxManager
		this.boundingBoxManager = new BoundingBoxManager(this.scene);

		// 7. Create Bounding Box Meshes for Block Instances
		this._setupAllBoundingBoxMeshes(); // Pass necessary data

		// 8. Initialize Selector
		if (this.renderer && this.camera && this.boundingBoxManager) {
			this.selector = new Select(this.renderer.domElement, this.camera, this.boundingBoxManager);

			// 9. Subscribe to Selection Events
			this.selector.subscribe("select", (selectedUUIDs) => {
				// selectedUUIDs is a Set<string>
				console.log("Selected entity UUIDs:", selectedUUIDs);

				if (selectedUUIDs.size > 0) {
					// Get the first selected UUID to zoom to
					const firstUUID = selectedUUIDs.values().next().value;
					const mesh = this.boundingBoxManager.getMesh(firstUUID);
					if (mesh) {
						this._zoomToObject(mesh); // Zoom to the bounding box mesh
					} else {
						console.warn(`Mesh not found for selected UUID: ${firstUUID}`);
					}
				} else {
					// Handle deselection if needed (e.g., reset info panel)
				}
			});
		} else {
			console.warn("Cannot initialize Select tool - missing renderer, camera, or bbox manager.");
		}

		// --- Finalize ---
		// 10. Setup Helper (If still needed)
		// const sceneWorldBounds = { ... }; // Calculate if needed for helper
		// this._setupHelper(sceneWorldBounds);

		this._Emit("loaded");

		// 11. Fit View to Content
		if (this.bounds && this.origin) {
			this.FitView(
				this.bounds.minX - this.origin.x,
				this.bounds.maxX - this.origin.x,
				this.bounds.minY - this.origin.y,
				this.bounds.maxY - this.origin.y
			);
		} else {
			this._Message("Empty or invalid document bounds", MessageLevel.WARN);
			this.SetView({ x: 0, y: 0 }, 100); // Default view for empty doc
		}

		if (this.hasMissingChars) {
			this._Message(
				"Some characters cannot be properly displayed due to missing fonts",
				MessageLevel.WARN
			);
		}

		// 12. Create Controls
		this._CreateControls(); // Create controls after initial FitView/SetView

		this.Render(); // Final render
	}

	// --- Internal Helper Methods ---

	_Message(message, level = MessageLevel.INFO) {
		this._Emit("message", { message, level });
	}

	_EnsureRenderer() {
		if (!this.HasRenderer()) {
			throw new Error(
				"WebGL renderer not available. Probable WebGL context loss, try refreshing the page."
			);
		}
	}

	/** Calculates bounding boxes for block definitions in their local coordinates */
	_calculateBlockDefinitionBounds(dxf) {
		blockBoundingBoxMap.clear(); // Clear previous definitions
		if (!dxf || !dxf.blocks) return;

		for (const [blockName, blockDef] of Object.entries(dxf.blocks)) {
			// Use BlockContext if available and needed for transforms within definition
			const block = new Block(blockDef); // Assuming Block constructor takes definition
			const blockCtx = block.DefinitionContext(); // Get context for transforms

			let minX = Infinity,
				minY = Infinity,
				maxX = -Infinity,
				maxY = -Infinity;
			let hasVertices = false;

			if (blockDef.entities) {
				for (const entity of blockDef.entities) {
					if (entity.vertices) {
						for (const vertex of entity.vertices) {
							// Transform vertex using block context if necessary
							// For simple bounds, raw vertex might be okay if definition is at (0,0)
							// If blockCtx applies transforms, use it:
							// const tv = blockCtx.TransformVertex(vertex);
							// For now, assume vertices are relative to block origin (0,0)
							const tv = vertex; // Adjust if blockCtx is needed

							minX = Math.min(minX, tv.x);
							maxX = Math.max(maxX, tv.x);
							minY = Math.min(minY, tv.y);
							maxY = Math.max(maxY, tv.y);
							hasVertices = true;
						}
					}
					// TODO: Handle other entity types within blocks (lines, circles)
					// to get more accurate definition bounds if needed.
				}
			}

			if (hasVertices) {
				// Store definition bounds (min corner + dimensions)
				const boundingBoxDef = {
					x: minX, // Min corner X (local)
					y: minY, // Min corner Y (local)
					width: maxX - minX,
					height: maxY - minY
				};
				blockBoundingBoxMap.set(blockName, boundingBoxDef);
			}
		}
	}

	/** Collects top-level INSERT entities */
	_collectBlockEntities(dxf) {
		allBlockEntity = []; // Clear previous
		if (dxf && dxf.entities) {
			for (const entity of dxf.entities) {
				if (entity.type === "INSERT") {
					allBlockEntity.push(entity);
				}
			}
		}
	}

	/** Creates THREE.js objects for a given batch */
	_LoadBatch(sceneData, batch) {
		// Skip block definition batches
		if (
			batch.key.blockName !== null &&
			batch.key.geometryType !== BatchingKey.GeometryType.BLOCK_INSTANCE &&
			batch.key.geometryType !== BatchingKey.GeometryType.POINT_INSTANCE
		) {
			return;
		}

		// Create objects using the Batch class helper
		const batchHelper = new Batch(this, sceneData, batch);
		const objects = batchHelper.CreateObjects(); // This is a generator

		// Add created objects to the scene and appropriate layer
		for (const obj of objects) {
			this.scene.add(obj);
			const layer = this.layers.get(batch.key.layerName);
			if (layer) {
				// Assuming Layer class has a method to track its objects
				layer.PushObject(obj);
			}
		}
	}

	/** Creates bounding box meshes for all collected block entities */
	_setupAllBoundingBoxMeshes() {
		if (!this.boundingBoxManager || !this.origin) {
			console.error("BoundingBoxManager or scene origin not initialized.");
			return;
		}

		allBlockEntity.forEach((entity) => {
			// Get the pre-calculated definition bounds
			const definitionBounds = blockBoundingBoxMap.get(entity.name);
			if (!definitionBounds) {
				// console.warn(`No definition bounds found for block: ${entity.name}`);
				return; // Skip if no definition bounds exist
			}

			// Calculate final world position (applying scene origin)
			const finalWorldPos = new THREE.Vector3(
				entity.position.x - this.origin.x,
				entity.position.y - this.origin.y,
				entity.position.z ?? 0 // Use Z if available, else 0
			);

			// Prepare the boundingBoxDef for the manager
			// Calculate local center from min corner and dimensions
			const boundingBoxDef = {
				width: definitionBounds.width,
				height: definitionBounds.height,
				x: definitionBounds.x + definitionBounds.width / 2, // Local center X
				y: definitionBounds.y + definitionBounds.height / 2 // Local center Y
			};

			// Prepare entity data for the manager
			const entityData = {
				uuid: entity.handle || THREE.MathUtils.generateUUID(), // Use handle or generate UUID
				name: entity.name,
				handle: entity.handle,
				position: finalWorldPos,
				xScale: entity.xScale ?? 1,
				yScale: entity.yScale ?? 1,
				rotation: entity.rotation ?? 0, // Rotation in degrees
				// Add any other relevant entity properties from DXF
				layerName: entity.layer,
				entityType: entity.type
			};

			// Create the bounding box mesh via the manager
			this.boundingBoxManager.createBoundingBox(entityData, boundingBoxDef);
			// No need to push to this.boundingBoxMeshList, manager handles it
		});
	}

	_setupHelper(sceneBounds) {
		const { objectWidth, objectHeight } = this.getObjectSizeInWorldUnits(
			sceneBounds,
			8,
			this.renderer
		);

		const boxDimesion = objectWidth > objectHeight ? objectWidth : objectHeight;

		const helperBoxGeometry = new THREE.PlaneGeometry(boxDimesion, boxDimesion);

		const helperBoxMaterial = new THREE.MeshBasicMaterial({
			color: 0xff0000,
			side: THREE.DoubleSide,
			transparent: true,
			opacity: 0.5
		});
		this.helperBox = new THREE.Mesh(helperBoxGeometry, helperBoxMaterial);
		this.helperBox.visible = false;
		this.scene.add(this.helperBox);
	}

	_CreateControls() {
		// Ensure controls are created only once and after camera is positioned
		if (this.controls) {
			this.controls.dispose();
		}
		const controls = (this.controls = new OrbitControls(this.camera, this.canvas));
		controls.enableRotate = false; // Keep as orthographic pan/zoom
		controls.mouseButtons = {
			LEFT: THREE.MOUSE.PAN, // Or THREE.MOUSE.NONE if Select handles left click exclusively
			MIDDLE: THREE.MOUSE.DOLLY,
			RIGHT: THREE.MOUSE.PAN // Optional: Right mouse pan
		};
		controls.touches = {
			ONE: THREE.TOUCH.PAN,
			TWO: THREE.TOUCH.DOLLY_PAN
		};
		controls.zoomSpeed = 2; // Adjust as needed
		// controls.mouseZoomSpeedFactor = 0.05; // Deprecated? Use zoomSpeed

		// Set initial target (important!)
		controls.target.set(this.camera.position.x, this.camera.position.y, 0);

		controls.addEventListener("change", () => {
			this._Emit("viewChanged");
			this.Render(); // Make sure render is called on control changes
		});
		controls.update();
	}

	// _OnPointerEvent(e) { ... } // Remove if Select handles all pointer events

	_CanvasToSceneCoord(x, y) {
		// Ensure camera matrix is up-to-date before unprojecting
		this.camera.updateMatrixWorld();
		const vec = new THREE.Vector3(
			(x / this.canvasWidth) * 2 - 1,
			-(y / this.canvasHeight) * 2 + 1,
			0.5 // Use 0.5 for depth, works for ortho
		);
		vec.unproject(this.camera);
		return { x: vec.x, y: vec.y };
	}

	_OnResize(entry) {
		// Use contentRect for size
		const width = Math.floor(entry.contentRect.width);
		const height = Math.floor(entry.contentRect.height);
		if (width > 0 && height > 0) {
			this.SetSize(width, height);
		}
	}

	/** Zooms the view to fit the provided object */
	_zoomToObject(object) {
		if (!object || !this.camera || !this.renderer || !this.controls) return;

		const padding = 0.2; // Adjust padding factor (20% here)

		// Use the object's world bounding box directly
		const box = new THREE.Box3().setFromObject(object);

		// Check if the box is valid
		if (box.isEmpty()) {
			console.warn("Cannot zoom to object with empty bounding box.");
			return;
		}

		const size = box.getSize(new THREE.Vector3());
		const center = box.getCenter(new THREE.Vector3());

		// Calculate the required size of the view area to encompass the object + padding
		const paddedWidth = size.x * (1 + padding);
		const paddedHeight = size.y * (1 + padding);

		// Get the current canvas aspect ratio
		const aspect = this.canvasWidth / this.canvasHeight;

		// Determine the larger dimension needed for the view, adjusted for aspect ratio
		let targetOrthoWidth;
		if (paddedWidth / paddedHeight > aspect) {
			targetOrthoWidth = paddedWidth; // Width is limiting
		} else {
			targetOrthoWidth = paddedHeight * aspect; // Height is limiting
		}

		// Prevent zooming into an infinitely small area
		if (targetOrthoWidth <= Number.EPSILON) {
			console.warn("Calculated zoom target width is too small.");
			targetOrthoWidth = 1; // Set a minimum sensible width
		}

		// --- Calculate New View ---
		// For Orthographic camera, setting the bounds is more direct than calculating zoom
		const targetOrthoHeight = targetOrthoWidth / aspect;

		// --- Apply the changes ---
		// 1. Set camera orthographic bounds
		this.camera.left = center.x - targetOrthoWidth / 2;
		this.camera.right = center.x + targetOrthoWidth / 2;
		this.camera.top = center.y + targetOrthoHeight / 2;
		this.camera.bottom = center.y - targetOrthoHeight / 2;
		this.camera.zoom = 1; // Reset zoom after setting bounds

		// 2. Move the camera position to the center (keep Z)
		this.camera.position.set(center.x, center.y, this.camera.position.z);

		// 3. Update the camera's projection matrix
		this.camera.updateProjectionMatrix();

		// 4. Set the OrbitControls target
		this.controls.target.set(center.x, center.y, 0);

		// 5. Update the controls
		this.controls.update();

		// 6. Re-render the scene
		this._Emit("viewChanged"); // Notify view changed
		this.Render();
	}

	_UpdateBounds(v) {
		if (this.bounds === null) {
			this.bounds = { minX: v.x, maxX: v.x, minY: v.y, maxY: v.y };
		} else {
			if (v.x < this.bounds.minX) {
				this.bounds.minX = v.x;
			} else if (v.x > this.bounds.maxX) {
				this.bounds.maxX = v.x;
			}
			if (v.y < this.bounds.minY) {
				this.bounds.minY = v.y;
			} else if (v.y > this.bounds.maxY) {
				this.bounds.maxY = v.y;
			}
		}
		if (this.origin === null) {
			this.origin = { x: v.x, y: v.y };
		}
	}

	// --- Material/Shader Methods ---
	// (Keep _GetSimpleColorMaterial, _CreateSimpleColorMaterial, etc. as they are)
	// ... (rest of the material/shader methods) ...
	_GetSimpleColorMaterial(color, instanceType = InstanceType.NONE) {
		const key = new MaterialKey(instanceType, null, color, 0);
		let entry = this.materials.find({ key });
		if (entry !== null) {
			return entry.material;
		}
		entry = {
			key,
			material: this._CreateSimpleColorMaterialInstance(color, instanceType)
		};
		this.materials.insert(entry);
		return entry.material;
	}

	_CreateSimpleColorMaterial(instanceType = InstanceType.NONE) {
		const shaders = this._GenerateShaders(instanceType, false);
		return new THREE.RawShaderMaterial({
			uniforms: {
				color: {
					value: new THREE.Color(0xff00ff)
				}
			},
			vertexShader: shaders.vertex,
			fragmentShader: shaders.fragment,
			depthTest: false,
			depthWrite: false,
			transparent: false,
			side: THREE.DoubleSide
		});
	}

	/** @param color {number} Color RGB numeric value.
	 * @param instanceType {number}
	 */
	_CreateSimpleColorMaterialInstance(color, instanceType = InstanceType.NONE) {
		// Reuse the base material shader program, just change uniforms
		const baseMaterial = this.simpleColorMaterial[instanceType];
		const m = baseMaterial.clone(); // Clone to get new uniform instances
		m.uniforms.color.value = new THREE.Color(color); // Set specific color
		return m;
	}

	_GetSimplePointMaterial(color, instanceType = InstanceType.NONE) {
		const key = new MaterialKey(instanceType, BatchingKey.GeometryType.POINTS, color, 0);
		let entry = this.materials.find({ key });
		if (entry !== null) {
			return entry.material;
		}
		entry = {
			key,
			material: this._CreateSimplePointMaterialInstance(color, this.options.pointSize, instanceType)
		};
		this.materials.insert(entry);
		return entry.material;
	}

	_CreateSimplePointMaterial(instanceType = InstanceType.NONE) {
		const shaders = this._GenerateShaders(instanceType, true);
		return new THREE.RawShaderMaterial({
			uniforms: {
				color: {
					value: new THREE.Color(0xff00ff)
				},
				pointSize: {
					value: this.options.pointSize // Use option
				}
			},
			vertexShader: shaders.vertex,
			fragmentShader: shaders.fragment,
			depthTest: false,
			depthWrite: false,
			glslVersion: THREE.GLSL3
		});
	}

	/** @param color {number} Color RGB numeric value.
	 * @param size {number} Rasterized point size in pixels.
	 * @param instanceType {number}
	 */
	_CreateSimplePointMaterialInstance(color, size = 2, instanceType = InstanceType.NONE) {
		const baseMaterial = this.simplePointMaterial[instanceType];
		const m = baseMaterial.clone();
		m.uniforms.color.value = new THREE.Color(color);
		m.uniforms.pointSize.value = size; // Set specific size
		return m;
	}

	_GenerateShaders(instanceType, pointSize) {
		const fullInstanceAttr =
			instanceType === InstanceType.FULL
				? `
            /* First row. */
            attribute vec3 instanceTransform0;
            /* Second row. */
            attribute vec3 instanceTransform1;
            `
				: "";
		const fullInstanceTransform =
			instanceType === InstanceType.FULL
				? `
            // Apply 2x3 Affine Transformation (mat2 + vec2)
            pos.xy = mat2(instanceTransform0.x, instanceTransform1.x,  // col 0
                          instanceTransform0.y, instanceTransform1.y)  // col 1
                          * pos.xy +
                     vec2(instanceTransform0.z, instanceTransform1.z); // translation
            `
				: "";

		const pointInstanceAttr =
			instanceType === InstanceType.POINT
				? `
            attribute vec2 instanceTransform; // Simple translation offset
            `
				: "";
		const pointInstanceTransform =
			instanceType === InstanceType.POINT
				? `
            pos.xy += instanceTransform;
            `
				: "";

		const pointSizeUniform = pointSize ? "uniform float pointSize;" : "";
		const pointSizeAssignment = pointSize ? "gl_PointSize = pointSize;" : "";

		return {
			vertex: `
                precision highp float;
                precision highp int;

                uniform mat4 modelViewMatrix;
                uniform mat4 projectionMatrix;
                ${pointSizeUniform}

                attribute vec2 position;
                ${fullInstanceAttr}
                ${pointInstanceAttr}

                void main() {
                    vec4 pos = vec4(position, 0.0, 1.0);
                    ${fullInstanceTransform}
                    ${pointInstanceTransform}
                    gl_Position = projectionMatrix * modelViewMatrix * pos;
                    ${pointSizeAssignment}
                }
                `,
			fragment: `
                precision highp float;
                precision highp int;

                uniform vec3 color;
                varying vec4 vColor;

                void main() {
                    ${pointSize ? "if (length(gl_PointCoord - vec2(0.5)) > 0.5) discard;" : ""}
                    gl_FragColor = vec4(color, 1.0);
                }
                `
		};
	}

	_TransformColor(color) {
		if (!this.options.colorCorrection && !this.options.blackWhiteInversion) {
			return color;
		}

		// Convert hex color to THREE.Color for easier manipulation
		const threeColor = new THREE.Color(color);

		// Get background luminance
		const bkgLum = Luminance(this.clearColor);

		// Handle special cases
		if (color === 0xffffff && bkgLum >= 0.8) {
			return 0x000000; // White on light -> Black
		}
		if (color === 0x000000 && bkgLum <= 0.2) {
			return 0xffffff; // Black on dark -> White
		}

		if (!this.options.colorCorrection) {
			return color;
		}

		// Full color correction with contrast adjustment
		const MIN_TARGET_RATIO = 1.5;
		const contrast = ContrastRatio(color, this.clearColor);

		if (Math.abs(contrast) < MIN_TARGET_RATIO) {
			if (bkgLum > 0.5) {
				return Darken(color, MIN_TARGET_RATIO / Math.abs(contrast));
			} else {
				return Lighten(color, MIN_TARGET_RATIO / Math.abs(contrast));
			}
		}
		return color;
	}
} // End DxfViewer Class

// --- Static Properties and Methods ---
DxfViewer.MessageLevel = MessageLevel;
DxfViewer.DefaultOptions = {
	canvasWidth: 400,
	canvasHeight: 300,
	autoResize: true, // Default to true as it's common
	clearColor: new THREE.Color("#202020"), // Dark grey default
	clearAlpha: 1.0,
	canvasAlpha: false,
	canvasPremultipliedAlpha: true,
	antialias: true,
	colorCorrection: false, // Default off, can be expensive
	blackWhiteInversion: true, // Common useful default
	pointSize: 2,
	sceneOptions: DxfScene.DefaultOptions, // Assuming DxfScene is defined
	retainParsedDxf: false,
	preserveDrawingBuffer: false,
	fileEncoding: "utf-8" // Modern default
};

DxfViewer.SetupWorker = function () {
	// eslint-disable-next-line no-restricted-globals
	new DxfWorker(self, true); // Assuming DxfWorker handles self context
};

// --- Constants ---
const InstanceType = Object.freeze({
	NONE: 0,
	FULL: 1,
	POINT: 2,
	MAX: 3
});

const EVENT_NAME_PREFIX = "__dxf_"; // Keep for event namespacing

// --- Utility Functions (Luminance, Color Transforms) ---
// (Keep Luminance, ContrastRatio, HlsToRgb, RgbToHls, Lighten, Darken as they are)
// ... (utility functions) ...
function LinearColor(c) {
	c = c / 255.0; // Normalize first
	return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function SRgbColor(c) {
	// Clamp linear value before converting back
	c = Math.max(0, Math.min(1, c));
	const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
	return Math.round(Math.max(0, Math.min(1, v)) * 255); // Clamp and scale to 0-255
}
function Luminance(color) {
	const r = LinearColor((color >> 16) & 0xff);
	const g = LinearColor((color >> 8) & 0xff);
	const b = LinearColor(color & 0xff);
	return r * 0.2126 + g * 0.7152 + b * 0.0722; // Rec. 709 coefficients
}
function ContrastRatio(c1, c2) {
	const l1 = Luminance(c1);
	const l2 = Luminance(c2);
	// Return ratio of lighter to darker + 0.05 (WCAG formula)
	return l1 > l2 ? (l1 + 0.05) / (l2 + 0.05) : (l2 + 0.05) / (l1 + 0.05);
}
function RgbToHls(color) {
	const r = LinearColor((color >> 16) & 0xff);
	const g = LinearColor((color >> 8) & 0xff);
	const b = LinearColor(color & 0xff);

	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	let h = 0,
		s = 0;
	const l = (max + min) / 2;

	if (max !== min) {
		const d = max - min;
		s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
		switch (max) {
			case r:
				h = (g - b) / d + (g < b ? 6 : 0);
				break;
			case g:
				h = (b - r) / d + 2;
				break;
			case b:
				h = (r - g) / d + 4;
				break;
		}
		h /= 6;
	}
	return { h, l, s };
}
function HlsToRgb({ h, l, s }) {
	let r, g, b;
	if (s === 0) {
		r = g = b = l; // Achromatic
	} else {
		const hue2rgb = (p, q, t) => {
			if (t < 0) t += 1;
			if (t > 1) t -= 1;
			if (t < 1 / 6) return p + (q - p) * 6 * t;
			if (t < 1 / 2) return q;
			if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
			return p;
		};
		const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
		const p = 2 * l - q;
		r = hue2rgb(p, q, h + 1 / 3);
		g = hue2rgb(p, q, h);
		b = hue2rgb(p, q, h - 1 / 3);
	}
	// Convert back to sRGB 0-255
	return (SRgbColor(r) << 16) | (SRgbColor(g) << 8) | SRgbColor(b);
}
function Lighten(color, factor) {
	const hls = RgbToHls(color);
	hls.l = Math.min(1, hls.l * factor); // Clamp lightness at 1
	return HlsToRgb(hls);
}
function Darken(color, factor) {
	const hls = RgbToHls(color);
	hls.l = Math.max(0, hls.l / factor); // Clamp lightness at 0
	return HlsToRgb(hls);
}

// --- Batch Class ---
// (Keep Batch class as is, assuming it works with the viewer context)
// ... Batch class ...
class Batch {
	/**
	 * @param viewer {DxfViewer}
	 * @param sceneData Serialized scene data containing buffers.
	 * @param batch Serialized scene batch.
	 */
	constructor(viewer, sceneData, batch) {
		this.viewer = viewer;
		this.key = batch.key;
		this.sceneData = sceneData; // Store reference to access buffers

		// --- Geometry Buffers ---
		if (batch.hasOwnProperty("verticesOffset")) {
			const verticesArray = new Float32Array(
				sceneData.vertices,
				batch.verticesOffset * Float32Array.BYTES_PER_ELEMENT,
				batch.verticesSize
			);
			// Vertices for non-point-instance or dots
			if (
				this.key.geometryType !== BatchingKey.GeometryType.POINT_INSTANCE ||
				sceneData.pointShapeHasDot // Check if sceneData has this property
			) {
				this.vertices = new THREE.BufferAttribute(verticesArray, 2); // 2D positions
			}
			// Transforms for point instances (using the same vertex data as offsets)
			if (this.key.geometryType === BatchingKey.GeometryType.POINT_INSTANCE) {
				this.transforms = new THREE.InstancedBufferAttribute(verticesArray, 2, false, 1); // 2D offset per instance
			}
		}

		// --- Chunked Geometry ---
		if (batch.hasOwnProperty("chunks")) {
			this.chunks = batch.chunks.map((rawChunk) => {
				const verticesArray = new Float32Array(
					sceneData.vertices,
					rawChunk.verticesOffset * Float32Array.BYTES_PER_ELEMENT,
					rawChunk.verticesSize
				);
				const indicesArray = new Uint16Array( // Assuming Uint16, adjust if needed
					sceneData.indices,
					rawChunk.indicesOffset * Uint16Array.BYTES_PER_ELEMENT,
					rawChunk.indicesSize
				);
				return {
					vertices: new THREE.BufferAttribute(verticesArray, 2),
					indices: new THREE.BufferAttribute(indicesArray, 1) // Indices are scalar
				};
			});
		}

		// --- Full Instance Transforms ---
		if (batch.hasOwnProperty("transformsOffset")) {
			const transformsArray = new Float32Array(
				sceneData.transforms,
				batch.transformsOffset * Float32Array.BYTES_PER_ELEMENT,
				batch.transformsSize
			);
			// Each transform is 3x2 matrix (6 floats), split into two vec3 attributes
			const buf = new THREE.InstancedInterleavedBuffer(transformsArray, 6, 1); // 6 floats per instance
			this.transforms0 = new THREE.InterleavedBufferAttribute(buf, 3, 0); // First vec3 (mat[0][0], mat[1][0], mat[0][2])
			this.transforms1 = new THREE.InterleavedBufferAttribute(buf, 3, 3); // Second vec3 (mat[0][1], mat[1][1], mat[1][2])
		}

		// --- Layer Color Cache (for ByLayer instances) ---
		if (
			this.key.geometryType === BatchingKey.GeometryType.BLOCK_INSTANCE ||
			this.key.geometryType === BatchingKey.GeometryType.POINT_INSTANCE
		) {
			const layer = this.viewer.layers.get(this.key.layerName);
			this.layerColor = layer ? layer.color : 0x000000; // Default to black if layer not found
		}
	}

	GetInstanceType() {
		switch (this.key.geometryType) {
			case BatchingKey.GeometryType.BLOCK_INSTANCE:
				return InstanceType.FULL;
			case BatchingKey.GeometryType.POINT_INSTANCE:
				return InstanceType.POINT;
			default:
				return InstanceType.NONE;
		}
	}

	/** Create scene objects corresponding to batch data.
	 * @param instanceBatch {?Batch} Batch with instance transform data. Null for non-instanced.
	 */
	*CreateObjects(instanceBatch = null) {
		// If this batch IS an instance definition, delegate to _CreateBlockInstanceObjects
		if (
			this.key.geometryType === BatchingKey.GeometryType.BLOCK_INSTANCE ||
			this.key.geometryType === BatchingKey.GeometryType.POINT_INSTANCE
		) {
			if (instanceBatch !== null) {
				// This case shouldn't happen if LoadBatch logic is correct
				console.error("Instance batch passed to an instance definition batch");
				return;
			}
			yield* this._CreateBlockInstanceObjects();
			return;
		}

		// Otherwise, create geometry objects based on this batch's data
		yield* this._CreateGeometryObjects(instanceBatch);
	}

	/** Creates the actual THREE geometry objects (Points, Lines, Mesh) */
	*_CreateGeometryObjects(instanceBatch) {
		// Determine color: Use instance color if ByBlock/ByLayer, else use definition color
		const color = instanceBatch ? instanceBatch._GetInstanceColor(this.key.color) : this.key.color;
		const finalColor = this.viewer._TransformColor(color); // Apply viewer color correction

		// Determine instance type for material selection
		const instanceType = instanceBatch?.GetInstanceType() ?? InstanceType.NONE;

		// Get appropriate material (Points vs Lines/Triangles)
		const materialFactory =
			this.key.geometryType === BatchingKey.GeometryType.POINTS ||
			this.key.geometryType === BatchingKey.GeometryType.POINT_INSTANCE // Also for dots
				? this.viewer._GetSimplePointMaterial
				: this.viewer._GetSimpleColorMaterial;

		const material = materialFactory.call(this.viewer, finalColor, instanceType);

		// Determine THREE object constructor based on geometry type
		let objConstructor;
		switch (this.key.geometryType) {
			case BatchingKey.GeometryType.POLYLINE: // Treat polyline as lines for now
			case BatchingKey.GeometryType.LINES:
			case BatchingKey.GeometryType.INDEXED_LINES:
				objConstructor = THREE.LineSegments;
				break;
			case BatchingKey.GeometryType.POINTS:
			case BatchingKey.GeometryType.POINT_INSTANCE: // Also for dots
				objConstructor = THREE.Points;
				break;
			case BatchingKey.GeometryType.TRIANGLES:
			case BatchingKey.GeometryType.INDEXED_TRIANGLES:
				objConstructor = THREE.Mesh;
				break;
			default:
				console.error("Unexpected geometry type:", this.key.geometryType);
				return; // Skip unknown types
		}

		// --- Create Object Function ---
		const createSingleObject = (vertices, indices, baseUserData) => {
			const geometry = instanceBatch
				? new THREE.InstancedBufferGeometry()
				: new THREE.BufferGeometry();

			geometry.setAttribute("position", vertices);

			if (instanceBatch) {
				instanceBatch._SetInstanceTransformAttribute(geometry); // Apply instance transforms
			}

			if (indices) {
				geometry.setIndex(indices);
			}

			// Add userData specific to this geometry object
			const obj = new objConstructor(geometry, material);
			obj.frustumCulled = false; // Assume 2D, no culling needed
			// obj.matrixAutoUpdate = false; // Set to false if matrix is managed elsewhere
			obj.userData = { ...baseUserData }; // Copy base user data

			// Optional: Compute bounding sphere/box if needed for other purposes
			// geometry.computeBoundingSphere();

			return obj;
		};
		// --- ---

		// Base user data for all objects created from this batch
		const baseUserData = {
			entityType: this.key.entityType,
			handle: this.key.handle,
			ownerHandle: this.key.ownerHandle,
			layerName: this.key.layerName,
			blockName: this.key.blockName, // Will be null for non-block entities
			// Add color info if needed for debugging or other logic
			definitionColor: this.key.color,
			instanceColor: instanceBatch?.key?.color,
			layerColor: instanceBatch?.layerColor,
			finalColor: finalColor
		};

		// Yield objects, either chunked or single
		if (this.chunks) {
			for (const chunk of this.chunks) {
				yield createSingleObject(chunk.vertices, chunk.indices, baseUserData);
			}
		} else if (this.vertices) {
			// Check if vertices exist (might not for pure instance batches)
			yield createSingleObject(this.vertices, null, baseUserData);
		}
	}

	/** Applies instance transform attributes to a geometry */
	_SetInstanceTransformAttribute(geometry) {
		if (!geometry.isInstancedBufferGeometry) {
			console.error("InstancedBufferGeometry expected for instance transforms");
			return;
		}
		// Apply the correct transform attributes based on the *instance* batch type
		if (this.GetInstanceType() === InstanceType.POINT) {
			if (this.transforms) {
				geometry.setAttribute("instanceTransform", this.transforms);
				geometry.instanceCount = this.transforms.count; // Set instance count
			} else {
				console.error("Missing point instance transforms for geometry");
			}
		} else if (this.GetInstanceType() === InstanceType.FULL) {
			if (this.transforms0 && this.transforms1) {
				geometry.setAttribute("instanceTransform0", this.transforms0);
				geometry.setAttribute("instanceTransform1", this.transforms1);
				geometry.instanceCount = this.transforms0.count; // Set instance count
			} else {
				console.error("Missing full instance transforms for geometry");
			}
		}
	}

	/** Generates objects for block instances by creating objects from the block definition batches */
	*_CreateBlockInstanceObjects() {
		// Find the corresponding Block definition
		const block = this.viewer.blocks.get(this.key.blockName);
		if (!block) {
			// console.warn(`Block definition not found: ${this.key.blockName}`);
			return;
		}

		// Iterate through the batches *within* the block definition
		for (const definitionBatch of block.batches) {
			// Create objects from the definition batch, passing *this* batch (the instance)
			// to provide the necessary instance transforms and colors.
			yield* definitionBatch.CreateObjects(this);
		}

		// Handle dots for point shapes if this instance batch has vertex data
		if (this.hasOwnProperty("vertices")) {
			yield* this._CreateGeometryObjects(); // Create dots using the instance's own vertex data
		}
	}

	/** Determines the final color for an entity within an instance based on DXF color codes */
	_GetInstanceColor(defColor) {
		switch (defColor) {
			case ColorCode.BY_BLOCK:
				// Use the color assigned to the instance itself
				return this.key.color;
			case ColorCode.BY_LAYER:
				// Use the color of the instance's layer
				return this.layerColor; // Use cached layer color
			default:
				// Use the color specified in the block definition entity
				return defColor;
		}
	}
}

// --- Layer Class ---
class Layer {
	constructor(name, displayName, color) {
		this.name = name;
		this.displayName = displayName || name; // Fallback display name
		this.color = color;
		/** @type {THREE.Object3D[]} */
		this.objects = []; // Store references to objects on this layer
	}

	PushObject(obj) {
		this.objects.push(obj);
	}

	Dispose() {
		// Only dispose geometry/material if this layer exclusively owns them.
		// In the current setup, materials are shared via DxfViewer.materials,
		// and geometries are created per batch/chunk. Disposing here might
		// break shared resources.
		// If objects need specific cleanup tied to the layer, do it here.
		this.objects = []; // Clear the list
	}
}
