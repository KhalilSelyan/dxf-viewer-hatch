import * as THREE from "three";
import { Raycaster as BaseRaycaster } from "../tools/raycaster"; // Assuming path
import { BoundingBoxManager } from "./BoundingBoxManager"; // Assuming path

/**
 * @typedef {Object} Entity - Define your entity structure
 * @property {string} uuid
 * @property {string} [name]
 * @property {THREE.Vector3} position - Final world position
 * @property {number} [xScale]
 * @property {number} [yScale]
 * @property {number} [rotation] - Degrees
 */

/**
 * Handles user input for selecting entities via clicks or drag-boxes,
 * managing the logical selection state.
 */
export class Select extends BaseRaycaster {
	/**
	 * @param {HTMLElement} container
	 * @param {THREE.Camera} camera
	 * @param {BoundingBoxManager} boundingBoxManager
	 * @param {Object} [raycastingOptions=null] - Options for BaseRaycaster
	 */
	constructor(container, camera, boundingBoxManager, raycastingOptions = null) {
		super(); // Call BaseRaycaster constructor if needed

		this.container = container;
		this.camera = camera;
		this.boundingBoxManager = boundingBoxManager;

		// --- State ---
		/** @type {Set<string>} - Stores UUIDs of selected entities (Single Source of Truth) */
		this.selectedEntities = new Set();
		/** @type {string | null} - UUID of the currently hovered entity */
		this.hoveredEntityUUID = null;

		this._isMouseDown = false;
		this._isDragging = false; // Use 'dragging' instead of 'moving' for clarity
		this._startPoint = { x: 0, y: 0 }; // Screen coordinates for drag start
		this._selectionBoxElement = null; // DOM element for visual feedback

		// Init raycasting using the bounding box meshes as targets
		this._initRaycasting(
			container,
			camera,
			this.boundingBoxManager.boundingBoxMeshList, // Target the visible meshes
			raycastingOptions
		);

		this._boundOnPointerDown = this._onPointerDown.bind(this);
		this._boundOnPointerMove = this._onPointerMove.bind(this);
		this._boundOnPointerUp = this._onPointerUp.bind(this);
		this._boundOnKeyDown = this._onKeyDown.bind(this);
		this._boundOnKeyUp = this._onKeyUp.bind(this);

		this._addEventListeners();
	}

	_addEventListeners() {
		this.container.addEventListener("pointerdown", this._boundOnPointerDown);
		// Add move/up listeners to window to capture events outside the container during drag
		window.addEventListener("pointermove", this._boundOnPointerMove);
		window.addEventListener("pointerup", this._boundOnPointerUp);
		window.addEventListener("keydown", this._boundOnKeyDown);
		window.addEventListener("keyup", this._boundOnKeyUp);
	}

	_removeEventListeners() {
		this.container.removeEventListener("pointerdown", this._boundOnPointerDown);
		window.removeEventListener("pointermove", this._boundOnPointerMove);
		window.removeEventListener("pointerup", this._boundOnPointerUp);
		window.removeEventListener("keydown", this._boundOnKeyDown);
		window.removeEventListener("keyup", this._boundOnKeyUp);
	}

	/**
	 * @param {PointerEvent} event
	 */
	_onPointerDown(event) {
		// Ignore if not left mouse button or if interacting with UI elements potentially over the canvas
		if (event.button !== 0 || event.target !== this.container) return;

		this._isMouseDown = true;
		this._isDragging = false;
		const rect = this.container.getBoundingClientRect();
		this._startPoint = {
			x: event.clientX - rect.left,
			y: event.clientY - rect.top
		};
	}

	/**
	 * @param {PointerEvent} event
	 */
	_onPointerMove(event) {
		if (!this._isMouseDown) {
			// --- Hover Logic ---
			// Perform raycast even if mouse isn't down to detect hovers
			this._updateHover(event);
			return;
		}

		// --- Drag Logic ---
		this._isDragging = true; // Mouse has moved while down

		// Create or update visual selection box
		const rect = this.container.getBoundingClientRect();
		const currentPoint = {
			x: event.clientX - rect.left,
			y: event.clientY - rect.top
		};
		this._drawSelectionBox(this._startPoint, currentPoint);
	}

	/**
	 * @param {PointerEvent} event
	 */
	async _onPointerUp(event) {
		if (!this._isMouseDown || event.button !== 0) return; // Ensure it's the corresponding mouse up

		const isMultiSelect = event.ctrlKey || event.metaKey;
		const wasDragging = this._isDragging;

		// Cleanup state regardless of click or drag
		this._isMouseDown = false;
		this._isDragging = false;
		this._removeSelectionBox();

		if (wasDragging) {
			// --- Box Selection Finalization ---
			const rect = this.container.getBoundingClientRect();
			const endPoint = {
				x: event.clientX - rect.left,
				y: event.clientY - rect.top
			};
			this._performBoxSelection(this._startPoint, endPoint, isMultiSelect);
		} else {
			// --- Single Click Selection ---
			const intersectedMesh = await this._getIntersectedObject(event);
			const clickedUUID = intersectedMesh?.userData?.entityUUID;

			if (clickedUUID) {
				this._performSingleClickSelection(clickedUUID, isMultiSelect);
			} else if (!isMultiSelect) {
				// Clicked on empty space, not multi-selecting: deselect all
				this.deselectAll();
			}
		}

		// Update hover state after selection changes
		this._updateHover(event);

		// Trigger event with the final selection set
		await this.trigger("select", new Set(this.selectedEntities)); // Send a copy
	}

	/**
	 * @param {KeyboardEvent} event
	 */
	_onKeyDown(event) {
		if (event.key === "Escape") {
			this.deselectAll();
			this.trigger("select", new Set()); // Notify deselection
		} else if (event.key === "a" && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			this.selectAll();
			this.trigger("select", new Set(this.selectedEntities)); // Notify selection
		}
	}

	/**
	 * @param {KeyboardEvent} event
	 */
	_onKeyUp(event) {
		// Optional: Could potentially update hover/selection if modifier keys change state
	}

	// --- Selection Logic Methods ---

	/**
	 * Handles selection logic for a single click.
	 * @param {string} clickedUUID
	 * @param {boolean} isMultiSelect
	 */
	_performSingleClickSelection(clickedUUID, isMultiSelect) {
		const isSelected = this.selectedEntities.has(clickedUUID);

		if (isMultiSelect) {
			// Toggle selection for the clicked entity
			if (isSelected) {
				this.deselect(clickedUUID);
			} else {
				this.select(clickedUUID);
			}
		} else {
			// Single select mode:
			// 1. Deselect all others first
			const previouslySelected = new Set(this.selectedEntities);
			this.deselectAll();
			// 2. Select the clicked one (unless it was the *only* one selected)
			if (!(previouslySelected.size === 1 && isSelected)) {
				this.select(clickedUUID);
			}
		}
	}

	/**
	 * Handles selection logic after a drag operation.
	 * @param {{x: number, y: number}} screenStart
	 * @param {{x: number, y: number}} screenEnd
	 * @param {boolean} isMultiSelect
	 */
	_performBoxSelection(screenStart, screenEnd, isMultiSelect) {
		const selectionBox3D = this._get3DSelectionBox(screenStart, screenEnd);
		if (!selectionBox3D) return;

		const entitiesInBox = new Set();
		for (const mesh of this.boundingBoxManager.boundingBoxMeshList) {
			if (!mesh.visible && !this.materials?.default?.visible) continue; // Skip hidden meshes unless default is visible

			const meshBox = new THREE.Box3().setFromObject(mesh);

			// Choose selection mode: intersection or containment
			// if (selectionBox3D.intersectsBox(meshBox)) { // Intersecting
			if (selectionBox3D.containsBox(meshBox)) {
				// Fully Contained
				const entityUUID = mesh.userData?.entityUUID;
				if (entityUUID) {
					entitiesInBox.add(entityUUID);
				}
			}
		}

		if (!isMultiSelect) {
			// Replace selection
			this.deselectAll();
			entitiesInBox.forEach((uuid) => this.select(uuid));
		} else {
			// Add to selection (or toggle if needed, though box usually adds)
			entitiesInBox.forEach((uuid) => this.select(uuid));
		}
	}

	/**
	 * Selects a single entity by UUID.
	 * @param {string} entityUUID
	 */
	select(entityUUID) {
		if (!entityUUID || this.selectedEntities.has(entityUUID)) return;

		this.selectedEntities.add(entityUUID);
		this.boundingBoxManager.setVisualState(entityUUID, { selected: true });
	}

	/**
	 * Deselects a single entity by UUID.
	 * @param {string} entityUUID
	 */
	deselect(entityUUID) {
		if (!entityUUID || !this.selectedEntities.has(entityUUID)) return;

		this.selectedEntities.delete(entityUUID);
		// Restore hover state if it was hovered, otherwise default
		const isHovered = this.hoveredEntityUUID === entityUUID;
		this.boundingBoxManager.setVisualState(entityUUID, { hovered: isHovered });
	}

	/** Deselects all entities. */
	deselectAll() {
		// Create a copy because deselect modifies the set
		const currentSelection = new Set(this.selectedEntities);
		currentSelection.forEach((uuid) => this.deselect(uuid));
	}

	/** Selects all selectable entities. */
	selectAll() {
		this.boundingBoxManager.boundingBoxMeshList.forEach((mesh) => {
			const entityUUID = mesh.userData?.entityUUID;
			if (entityUUID) {
				// Add check if mesh is visible/selectable if needed
				this.select(entityUUID);
			}
		});
	}

	/**
	 * Checks if an entity is currently selected.
	 * @param {string} entityUUID
	 * @returns {boolean}
	 */
	isSelected(entityUUID) {
		return this.selectedEntities.has(entityUUID);
	}

	// --- Hover Logic ---

	/**
	 * Updates the hover state based on pointer position.
	 * @param {PointerEvent} event
	 */
	async _updateHover(event) {
		const intersectedMesh = await this._getIntersectedObject(event);
		const hoveredUUID = intersectedMesh?.userData?.entityUUID;

		if (this.hoveredEntityUUID === hoveredUUID) {
			return; // No change
		}

		// Clear previous hover (if any and not selected)
		if (this.hoveredEntityUUID && !this.selectedEntities.has(this.hoveredEntityUUID)) {
			this.boundingBoxManager.setVisualState(this.hoveredEntityUUID, {
				/* default state */
			});
		}

		// Set new hover (if any and not selected)
		this.hoveredEntityUUID = hoveredUUID;
		if (this.hoveredEntityUUID && !this.selectedEntities.has(this.hoveredEntityUUID)) {
			this.boundingBoxManager.setVisualState(this.hoveredEntityUUID, { hovered: true });
		}
	}

	// --- Raycasting & Box Calculation ---

	/**
	 * Performs raycast and returns the intersected bounding box mesh.
	 * @param {PointerEvent} event
	 * @returns {Promise<THREE.Object3D | null>}
	 */
	async _getIntersectedObject(event) {
		if (!event.target) return null;

		const rect = this.container.getBoundingClientRect();
		const x = event.clientX - rect.left;
		const y = event.clientY - rect.top;

		// Ensure pointer coords are updated before raycasting
		this.pointer.x = (x / this.container.clientWidth) * 2 - 1;
		this.pointer.y = -(y / this.container.clientHeight) * 2 + 1;

		// Use the raycast method from the base class or your implementation
		// Make sure it targets this.boundingBoxManager.boundingBoxMeshList
		const intersected = await this.raycast.raycast(this.pointer);
		// Filter: only return meshes managed by the BBoxManager
		if (
			intersected &&
			this.boundingBoxManager.meshMap.has(intersected.object?.userData?.entityUUID)
		) {
			return intersected.object;
		}
		return null;
	}

	/**
	 * Calculates a 3D bounding box from 2D screen coordinates.
	 * @param {{x: number, y: number}} screenStart
	 * @param {{x: number, y: number}} screenEnd
	 * @returns {THREE.Box3 | null}
	 */
	_get3DSelectionBox(screenStart, screenEnd) {
		// Normalize screen coordinates to NDC (-1 to +1)
		const startNDC = {
			x: (screenStart.x / this.container.clientWidth) * 2 - 1,
			y: -(screenStart.y / this.container.clientHeight) * 2 + 1
		};
		const endNDC = {
			x: (screenEnd.x / this.container.clientWidth) * 2 - 1,
			y: -(screenEnd.y / this.container.clientHeight) * 2 + 1
		};

		// Define near/far planes for unprojection (adjust if needed)
		const near = -1; // Relative to camera
		const far = 1; // Relative to camera

		// Unproject screen corners to world space points on near/far planes
		const points = [
			new THREE.Vector3(startNDC.x, startNDC.y, near),
			new THREE.Vector3(startNDC.x, endNDC.y, near),
			new THREE.Vector3(endNDC.x, endNDC.y, near),
			new THREE.Vector3(endNDC.x, startNDC.y, near),
			new THREE.Vector3(startNDC.x, startNDC.y, far),
			new THREE.Vector3(startNDC.x, endNDC.y, far),
			new THREE.Vector3(endNDC.x, endNDC.y, far),
			new THREE.Vector3(endNDC.x, startNDC.y, far)
		];

		const frustum = new THREE.Frustum();
		frustum.setFromProjectionMatrix(
			new THREE.Matrix4().multiplyMatrices(
				this.camera.projectionMatrix,
				this.camera.matrixWorldInverse
			)
		);

		// Check if camera is Orthographic
		if (this.camera.isOrthographicCamera) {
			// For Orthographic, unproject directly
			points.forEach((p) => p.unproject(this.camera));
		} else if (this.camera.isPerspectiveCamera) {
			// Perspective needs careful handling, often involves building a frustum
			// For simplicity here, we'll still unproject, but be aware this
			// creates a trapezoidal shape, not a perfect box aligned with axes
			// unless the view is straight down.
			// A more robust perspective selection uses a Frustum check.
			console.warn(
				"Box selection with PerspectiveCamera might be inaccurate. Consider Frustum check."
			);
			points.forEach((p) => p.unproject(this.camera));
		} else {
			console.error("Unsupported camera type for box selection.");
			return null;
		}

		// Create a Box3 encompassing the unprojected points
		const box = new THREE.Box3();
		box.setFromPoints(points);

		// Optional: Limit the Z dimension if needed (e.g., for 2D views)
		// box.min.z = -someDepth;
		// box.max.z = someDepth;

		return box;
	}

	// --- Visual Selection Box (DOM) ---

	/**
	 * @param {{x: number, y: number}} start
	 * @param {{x: number, y: number}} end
	 */
	_drawSelectionBox(start, end) {
		if (!this._selectionBoxElement) {
			this._selectionBoxElement = document.createElement("div");
			Object.assign(this._selectionBoxElement.style, {
				position: "absolute", // Position relative to nearest positioned ancestor
				border: "1px dashed #fff", // Dashed for distinction
				pointerEvents: "none", // Don't interfere with underlying events
				background: "rgba(100, 150, 255, 0.2)", // Light blue semi-transparent
				zIndex: "1000", // Ensure visibility
				boxSizing: "border-box" // Include border in width/height
			});
			// Append to container's parent for better relative positioning
			this.container.parentNode.appendChild(this._selectionBoxElement);
		}

		const rect = this.container.getBoundingClientRect();
		const parentRect = this.container.parentNode.getBoundingClientRect();

		// Calculate position relative to the parent node
		const left = Math.min(start.x, end.x) + rect.left - parentRect.left;
		const top = Math.min(start.y, end.y) + rect.top - parentRect.top;
		const width = Math.abs(end.x - start.x);
		const height = Math.abs(end.y - start.y);

		this._selectionBoxElement.style.left = `${left}px`;
		this._selectionBoxElement.style.top = `${top}px`;
		this._selectionBoxElement.style.width = `${width}px`;
		this._selectionBoxElement.style.height = `${height}px`;
	}

	_removeSelectionBox() {
		if (this._selectionBoxElement) {
			if (this._selectionBoxElement.parentNode) {
				this._selectionBoxElement.parentNode.removeChild(this._selectionBoxElement);
			}
			this._selectionBoxElement = null;
		}
	}

	/** Clean up listeners and resources */
	dispose() {
		this._removeEventListeners();
		this._removeSelectionBox();
		this.selectedEntities.clear();
		this.hoveredEntityUUID = null;
		// Call dispose on BaseRaycaster if it has one
		// super.dispose?.();
	}
}
