import * as THREE from "three";

/**
 * @typedef {import('./Select.js').Entity} Entity - Assuming Entity type is defined elsewhere
 */
/**
 * @typedef {Object} BoundingBoxDef
 * @property {number} width
 * @property {number} height
 * @property {number} x - Local center X relative to entity origin
 * @property {number} y - Local center Y relative to entity origin
 */
/**
 * @typedef {Object} SceneBounds
 * @property {number} minX
 * @property {number} maxX
 * @property {number} minY
 * @property {number} maxY
 */

/**
 * Manages bounding box meshes and their visual states (default, selected, hover).
 * Does NOT track logical selection state; it only displays the state provided.
 */
export class BoundingBoxManager {
	/**
	 * @param {THREE.Scene} scene
	 */
	constructor(scene) {
		this.scene = scene;
		this.meshMap = new Map(); // Maps entity UUID to mesh
		this.boundingBoxMeshList = []; // List of all bounding box meshes

		// --- Shared Materials ---
		this.materials = {
			default: new THREE.MeshBasicMaterial({
				color: 0x000000, // Black
				transparent: true,
				opacity: 0.0, // Completely invisible
				side: THREE.DoubleSide,
				depthTest: false,
				visible: false
			}),
			selected: new THREE.MeshBasicMaterial({
				color: 0x0088ff, // Light blue
				transparent: true,
				opacity: 0.2, // More subtle
				side: THREE.DoubleSide,
				depthTest: false,
				visible: true
			}),
			hover: new THREE.MeshBasicMaterial({
				color: 0xff8800, // Orange
				transparent: true,
				opacity: 0.15, // Very subtle
				side: THREE.DoubleSide,
				depthTest: false,
				visible: true
			})
		};

		// Pre-create geometry
		this.boxGeometry = new THREE.PlaneGeometry(1, 1);
	}

	/**
	 * Creates and registers a bounding box mesh for an entity.
	 * Assumes entity.position is the final world position in the viewer.
	 * @param {Entity} entity - Contains final world position, scale, rotation, uuid
	 * @param {BoundingBoxDef} boundingBoxDef - Contains width, height, local center x/y
	 * @returns {THREE.Mesh | null}
	 */
	createBoundingBox(entity, boundingBoxDef) {
		if (!boundingBoxDef || !entity || !entity.uuid) {
			console.warn("Missing data for bounding box creation", entity, boundingBoxDef);
			return null;
		}

		// Create mesh with default (invisible) material
		const mesh = new THREE.Mesh(this.boxGeometry, this.materials.default);
		mesh.name = `bbox_${entity.name || entity.uuid}`; // Helpful for debugging

		// --- Apply Transformations ---
		// 1. Scale: Apply definition size * entity instance scale
		const scaleX = boundingBoxDef.width * (entity.xScale ?? 1);
		const scaleY = boundingBoxDef.height * (entity.yScale ?? 1);
		mesh.scale.set(scaleX, scaleY, 1);

		// 2. Rotation: Apply entity instance rotation (assuming Z-axis rotation)
		if (entity.rotation) {
			mesh.rotation.z = THREE.MathUtils.degToRad(entity.rotation);
		}

		// 3. Position: Set to entity's final world position + offset for local center
		// We need to rotate the local center offset by the entity's rotation
		const localCenter = new THREE.Vector2(boundingBoxDef.x, boundingBoxDef.y);
		if (entity.rotation) {
			localCenter.rotateAround(new THREE.Vector2(0, 0), THREE.MathUtils.degToRad(entity.rotation));
		}
		// Apply entity scale to the rotated local center offset
		localCenter.x *= entity.xScale ?? 1;
		localCenter.y *= entity.yScale ?? 1;

		mesh.position.set(
			entity.position.x + localCenter.x,
			entity.position.y + localCenter.y,
			entity.position.z ?? 0 // Use provided Z or default to 0
		);

		// Update matrix after manual transformations
		mesh.updateMatrix();
		mesh.updateMatrixWorld(true); // Ensure world matrix is current

		// Store essential entity reference
		mesh.userData = {
			entityUUID: entity.uuid
			// Store any other entity data needed directly on the mesh if required
		};

		// Register the mesh
		this.meshMap.set(entity.uuid, mesh);
		this.boundingBoxMeshList.push(mesh);

		this.scene.add(mesh);
		return mesh;
	}

	/**
	 * Updates the visual state of a bounding box mesh.
	 * @param {string} entityUUID
	 * @param {{selected?: boolean, hovered?: boolean}} state
	 */
	setVisualState(entityUUID, state) {
		const mesh = this.meshMap.get(entityUUID);
		if (!mesh) return;

		if (state.selected) {
			mesh.material = this.materials.selected;
			mesh.visible = true;
		} else if (state.hovered) {
			mesh.material = this.materials.hover;
			mesh.visible = true;
		} else {
			// Default state (not selected, not hovered)
			mesh.material = this.materials.default;
			mesh.visible = false; // Default is invisible
		}
		// Optimization: If you want default boxes to be slightly visible:
		// mesh.material = this.materials.default;
		// mesh.visible = this.materials.default.opacity > 0;
	}

	/**
	 * Gets the mesh associated with an entity UUID.
	 * @param {string} entityUUID
	 * @returns {THREE.Mesh | undefined}
	 */
	getMesh(entityUUID) {
		return this.meshMap.get(entityUUID);
	}

	/**
	 * Cleans up resources: geometries, materials, removes from scene.
	 */
	dispose() {
		// Dispose shared geometry
		if (this.boxGeometry) {
			this.boxGeometry.dispose();
		}

		// Dispose shared materials
		Object.values(this.materials).forEach((material) => {
			if (material) material.dispose();
		});

		// Remove meshes from scene
		for (const mesh of this.meshMap.values()) {
			this.scene.remove(mesh);
			// Geometry/material are shared, already handled
		}

		this.meshMap.clear();
		this.boundingBoxMeshList = [];
	}
}
