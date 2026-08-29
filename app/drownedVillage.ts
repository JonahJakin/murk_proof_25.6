import * as THREE from "three";

// Supplied Demo 20 drowned-village presets. These values were tuned in the
// viewer and intentionally retain their original precision.
export const VILLAGE_WALL_THICKNESS = .32;
export const VILLAGE_WINDOW_VOID_COLOR = 0x070b09;
export const VILLAGE_STONE_COLOR = 0x5b6353;
export const VILLAGE_DARK_COURSE_COLOR = 0x4e5748;
export const VILLAGE_TIMBER_COLOR = 0x39362a;
export const VILLAGE_SLATE_COLOR = 0x424a44;
export const VILLAGE_SILT_COLOR = 0x5a6046;
export const VILLAGE_BUILDING_SEED = 0x20d09e;
export const VILLAGE_ROAD_X = 12;
export const VILLAGE_FACING_SLOP_MIN_DEGREES = 5;
export const VILLAGE_FACING_SLOP_MAX_DEGREES = 15;

export type BuildingType = "cottage" | "townhouse" | "farmhouse" | "outbuilding" | "chapel" | "shell";

export interface BuildingPreset {
  type: BuildingType;
  width: number;
  depth: number;
  storeys: number;
  storeyHeight: number;
  pitch: number;
  windows: number;
  windowSize: number;
  broken: number;
  roofLoss: number;
  wallLoss: number;
  silt: number;
  rubble: number;
}

export const DROWNED_BUILDING_PRESETS: Record<BuildingType, BuildingPreset> = {
  cottage: { type: "cottage", width: 6.0, depth: 5.0, storeys: 1, storeyHeight: 2.50, pitch: .62, windows: 2, windowSize: .95, broken: .72, roofLoss: .55, wallLoss: .22, silt: .50, rubble: .90 },
  townhouse: { type: "townhouse", width: 5.5, depth: 7.5, storeys: 2, storeyHeight: 2.70, pitch: .50, windows: 2, windowSize: 1.00, broken: .68, roofLoss: .62, wallLoss: .26, silt: .42, rubble: 1.00 },
  farmhouse: { type: "farmhouse", width: 10.5, depth: 7.0, storeys: 2, storeyHeight: 2.85, pitch: .55, windows: 3, windowSize: 1.05, broken: .66, roofLoss: .58, wallLoss: .20, silt: .55, rubble: 1.20 },
  outbuilding: { type: "outbuilding", width: 9.0, depth: 5.5, storeys: 1, storeyHeight: 3.20, pitch: .85, windows: 1, windowSize: .70, broken: .85, roofLoss: .78, wallLoss: .34, silt: .62, rubble: 1.35 },
  chapel: { type: "chapel", width: 6.5, depth: 11.0, storeys: 1, storeyHeight: 5.20, pitch: .90, windows: 3, windowSize: 1.50, broken: .60, roofLoss: .50, wallLoss: .15, silt: .38, rubble: .80 },
  shell: { type: "shell", width: 7.0, depth: 5.5, storeys: 2, storeyHeight: 2.60, pitch: .40, windows: 2, windowSize: 1.00, broken: 1.00, roofLoss: .95, wallLoss: .62, silt: .85, rubble: 1.80 },
};

export const VILLAGE_TYPE_COUNTS: Record<BuildingType, number> = {
  cottage: 6,
  townhouse: 3,
  shell: 2,
  outbuilding: 2,
  farmhouse: 1,
  chapel: 1,
};

export interface WorldSolidBox {
  id: string;
  x: number;
  z: number;
  halfX: number;
  halfZ: number;
  minY: number;
  maxY: number;
}

export interface WorldRadialObstacle {
  x: number;
  z: number;
  radius: number;
  minY: number;
  maxY: number;
}

export interface DrownedVillageResult {
  group: THREE.Group;
  playerSolids: WorldSolidBox[];
  creatureObstacles: WorldRadialObstacle[];
  floraExclusions: Array<{ x: number; z: number; radius: number }>;
  occluderMeshes: THREE.Mesh[];
  buildingCount: number;
  dispose: () => void;
}

interface BuildingSite {
  type: BuildingType;
  x: number;
  z: number;
  side: "west" | "east";
  slop: number;
}

const BUILDING_SITES: BuildingSite[] = [
  { type: "chapel", x: 2.0, z: 16.0, side: "west", slop: -7 },
  { type: "farmhouse", x: 25.0, z: 4.0, side: "east", slop: 11 },
  // This outbuilding formerly straddled the x≈30 procedural drop-off and
  // left half its shell hanging in open water. Keep it in the village, but
  // relocate it to the stable eastern shelf north of the farmhouse.
  { type: "outbuilding", x: 25.0, z: 27.0, side: "east", slop: -8 },
  { type: "townhouse", x: 20.0, z: -13.0, side: "east", slop: 5 },
  { type: "townhouse", x: 20.2, z: -18.7, side: "east", slop: -5 },
  { type: "cottage", x: 3.0, z: -15.5, side: "west", slop: 9 },
  { type: "cottage", x: -6.0, z: -25.0, side: "west", slop: -12 },
  { type: "townhouse", x: 3.2, z: -33.0, side: "west", slop: 6 },
  { type: "cottage", x: 21.5, z: -29.0, side: "east", slop: 13 },
  { type: "cottage", x: 21.0, z: -39.5, side: "east", slop: -9 },
  { type: "outbuilding", x: .5, z: -44.0, side: "west", slop: 14 },
  { type: "cottage", x: 3.0, z: -49.5, side: "west", slop: -6 },
  { type: "cottage", x: 21.2, z: -52.5, side: "east", slop: 10 },
  { type: "shell", x: 1.5, z: -60.0, side: "west", slop: -15 },
  { type: "shell", x: 23.0, z: -61.5, side: "east", slop: 12 },
];

function mulberry32(seed: number) {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function addBox(
  parent: THREE.Group,
  solidMeshes: THREE.Mesh[],
  occluders: THREE.Mesh[],
  size: THREE.Vector3,
  position: THREE.Vector3,
  material: THREE.Material,
  rotation = new THREE.Euler(),
  solid = true,
) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), material);
  mesh.position.copy(position);
  mesh.rotation.copy(rotation);
  parent.add(mesh);
  occluders.push(mesh);
  if (solid) solidMeshes.push(mesh);
  return mesh;
}

function addWindowVoid(
  parent: THREE.Group,
  position: THREE.Vector3,
  width: number,
  height: number,
  sideWall: boolean,
  voidMaterial: THREE.Material,
  rand: () => number,
  brokenChance: number,
) {
  const geometry = new THREE.PlaneGeometry(width, height);
  const voidMesh = new THREE.Mesh(geometry, voidMaterial);
  voidMesh.position.copy(position);
  if (sideWall) voidMesh.rotation.y = Math.PI / 2;
  parent.add(voidMesh);
  if (rand() < brokenChance) {
    const shardCount = Math.floor(rand() * 4);
    for (let shard = 0; shard < shardCount; shard++) {
      const shardGeometry = new THREE.BufferGeometry();
      const shardWidth = width * (.07 + rand() * .13);
      const shardHeight = height * (.08 + rand() * .18);
      shardGeometry.setAttribute("position", new THREE.Float32BufferAttribute([
        -shardWidth, 0, 0, shardWidth, 0, 0, (rand() - .5) * shardWidth, -shardHeight, 0,
      ], 3));
      shardGeometry.computeVertexNormals();
      const shardMesh = new THREE.Mesh(shardGeometry, voidMaterial);
      shardMesh.position.copy(position);
      if (sideWall) shardMesh.rotation.y = Math.PI / 2;
      shardMesh.position.y += height * .5 - .025;
      if (sideWall) shardMesh.position.z += (rand() - .5) * width * .72;
      else shardMesh.position.x += (rand() - .5) * width * .72;
      parent.add(shardMesh);
    }
  }
}

function createWall(
  building: THREE.Group,
  solidMeshes: THREE.Mesh[],
  occluders: THREE.Mesh[],
  preset: BuildingPreset,
  material: THREE.Material,
  darkMaterial: THREE.Material,
  voidMaterial: THREE.Material,
  rand: () => number,
  storey: number,
  face: "front" | "back" | "left" | "right",
) {
  const sideWall = face === "left" || face === "right";
  const wallLength = sideWall ? preset.depth : preset.width;
  const openingCount = Math.max(1, sideWall ? Math.round(preset.windows * preset.depth / Math.max(preset.width, preset.depth)) : preset.windows);
  const baseY = storey * preset.storeyHeight;
  const sillHeight = .38;
  const headHeight = .32;
  const wallPosition = sideWall
    ? new THREE.Vector3(face === "left" ? -preset.width / 2 : preset.width / 2, baseY, 0)
    : new THREE.Vector3(0, baseY, face === "front" ? preset.depth / 2 : -preset.depth / 2);
  const wallRotation = new THREE.Euler();
  const outward = face === "front" || face === "right" ? 1 : -1;
  const openings: Array<{ center: number; width: number; bottom: number; top: number; door: boolean }> = [];
  const spacing = wallLength / (openingCount + 1);
  for (let index = 0; index < openingCount; index++) {
    const door = face === "front" && storey === 0 && index === Math.floor(openingCount / 2) && preset.type !== "outbuilding";
    const width = door ? 1.05 : preset.windowSize;
    const height = door ? Math.min(2.15, preset.storeyHeight - .36) : Math.min(preset.windowSize * 1.25, preset.storeyHeight * .48);
    const bottom = door ? sillHeight : preset.storeyHeight * .34;
    openings.push({ center: -wallLength / 2 + spacing * (index + 1), width, bottom, top: bottom + height, door });
  }

  const addWallBox = (length: number, height: number, center: number, y: number, dark = false, preserve = false) => {
    if (!preserve && rand() < preset.wallLoss) return;
    const size = sideWall
      ? new THREE.Vector3(VILLAGE_WALL_THICKNESS, height, length)
      : new THREE.Vector3(length, height, VILLAGE_WALL_THICKNESS);
    const position = wallPosition.clone();
    if (sideWall) position.z += center;
    else position.x += center;
    position.y += y;
    addBox(building, solidMeshes, occluders, size, position, dark ? darkMaterial : material, wallRotation);
  };

  addWallBox(wallLength, sillHeight, 0, sillHeight / 2, true, true);
  addWallBox(wallLength, headHeight, 0, preset.storeyHeight - headHeight / 2, true, true);
  let cursor = -wallLength / 2;
  openings.forEach((opening, index) => {
    const left = opening.center - opening.width / 2;
    const pierWidth = left - cursor;
    if (pierWidth > .08) addWallBox(pierWidth, preset.storeyHeight - sillHeight - headHeight, cursor + pierWidth / 2, sillHeight + (preset.storeyHeight - sillHeight - headHeight) / 2, index === 0, index === 0);
    if (!opening.door) {
      const lowerHeight = opening.bottom - sillHeight;
      if (lowerHeight > .05) addWallBox(opening.width, lowerHeight, opening.center, sillHeight + lowerHeight / 2);
    }
    const upperHeight = preset.storeyHeight - headHeight - opening.top;
    if (upperHeight > .05) addWallBox(opening.width, upperHeight, opening.center, opening.top + upperHeight / 2);
    const voidPosition = wallPosition.clone();
    if (sideWall) {
      voidPosition.z += opening.center;
      voidPosition.x += outward * (VILLAGE_WALL_THICKNESS / 2 + .006);
    } else {
      voidPosition.x += opening.center;
      voidPosition.z += outward * (VILLAGE_WALL_THICKNESS / 2 + .006);
    }
    voidPosition.y += (opening.bottom + opening.top) / 2;
    addWindowVoid(building, voidPosition, opening.width * .91, opening.top - opening.bottom, sideWall, voidMaterial, rand, opening.door ? 1 : preset.broken);
    cursor = opening.center + opening.width / 2;
  });
  const remaining = wallLength / 2 - cursor;
  if (remaining > .08) addWallBox(remaining, preset.storeyHeight - sillHeight - headHeight, cursor + remaining / 2, sillHeight + (preset.storeyHeight - sillHeight - headHeight) / 2, true, true);
}

function addRoof(
  building: THREE.Group,
  solidMeshes: THREE.Mesh[],
  occluders: THREE.Mesh[],
  preset: BuildingPreset,
  timberMaterial: THREE.Material,
  slateMaterial: THREE.Material,
  stoneMaterial: THREE.Material,
  rand: () => number,
) {
  const roofBase = preset.storeys * preset.storeyHeight;
  const rise = preset.width * .5 * preset.pitch;
  const slopeLength = Math.hypot(preset.width * .5, rise);
  const roofAngle = Math.atan2(rise, preset.width * .5);
  const rafterCount = Math.max(4, Math.round(preset.depth / .72));
  for (let index = 0; index <= rafterCount; index++) {
    const z = -preset.depth / 2 + index / rafterCount * preset.depth;
    for (const side of [-1, 1]) {
      const rafter = addBox(
        building,
        solidMeshes,
        occluders,
        new THREE.Vector3(slopeLength, .11, .12),
        new THREE.Vector3(side * preset.width * .25, roofBase + rise * .5, z),
        timberMaterial,
        new THREE.Euler(0, 0, side * -roofAngle),
      );
      rafter.name = `${preset.type}-exposed-rafter`;
    }
  }
  const roofStrips = Math.max(4, Math.round(preset.depth / 1.05));
  for (let strip = 0; strip < roofStrips; strip++) {
    const z = -preset.depth / 2 + (strip + .5) / roofStrips * preset.depth;
    for (const side of [-1, 1]) {
      if (rand() < preset.roofLoss) continue;
      const panel = addBox(
        building,
        solidMeshes,
        occluders,
        new THREE.Vector3(slopeLength * .99, .075, preset.depth / roofStrips * .94),
        new THREE.Vector3(side * preset.width * .25, roofBase + rise * .5 + .05, z),
        slateMaterial,
        new THREE.Euler(0, 0, side * -roofAngle),
      );
      panel.name = `${preset.type}-surviving-slate`;
    }
  }
  for (const z of [-preset.depth / 2, preset.depth / 2]) {
    const gableSurvival = Math.min(1, 1 - preset.roofLoss * .5);
    if (rand() > gableSurvival) continue;
    const courses = 5;
    for (let course = 0; course < courses; course++) {
      const t = (course + .5) / courses;
      const width = preset.width * (1 - t) * .92;
      if (width < .25) continue;
      addBox(
        building,
        solidMeshes,
        occluders,
        new THREE.Vector3(width, rise / courses * .92, VILLAGE_WALL_THICKNESS),
        new THREE.Vector3(0, roofBase + rise * t, z),
        stoneMaterial,
      );
    }
  }
}

function addSiltAndRubble(building: THREE.Group, preset: BuildingPreset, siltMaterial: THREE.Material, stoneMaterial: THREE.Material, rand: () => number) {
  const side = rand() < .5 ? -1 : 1;
  const bank = new THREE.Mesh(
    new THREE.BoxGeometry(preset.width * .72, .18 + preset.silt * .72, preset.depth * .34),
    siltMaterial,
  );
  bank.position.set(side * preset.width * .22, (.18 + preset.silt * .72) / 2 - .08, side * preset.depth * .36);
  bank.rotation.set((rand() - .5) * .16, (rand() - .5) * .35, side * preset.silt * .12);
  building.add(bank);
  const rubbleCount = Math.max(2, Math.round(7 * preset.rubble));
  for (let index = 0; index < rubbleCount; index++) {
    const rubble = new THREE.Mesh(new THREE.IcosahedronGeometry(.18 + rand() * .34, 0), stoneMaterial);
    const angle = rand() * Math.PI * 2;
    const radius = Math.max(preset.width, preset.depth) * (.45 + rand() * .24);
    rubble.position.set(Math.cos(angle) * radius, .1 + rand() * .16, Math.sin(angle) * radius);
    rubble.scale.y = .35 + rand() * .5;
    rubble.rotation.set(rand(), rand() * 3, rand());
    building.add(rubble);
  }
}

function addChapelTower(
  building: THREE.Group,
  solidMeshes: THREE.Mesh[],
  occluders: THREE.Mesh[],
  preset: BuildingPreset,
  stoneMaterial: THREE.Material,
  darkMaterial: THREE.Material,
  slateMaterial: THREE.Material,
  voidMaterial: THREE.Material,
) {
  const towerZ = -preset.depth / 2 - 1.15;
  const towerWidth = 2.8;
  const towerHeight = 14.6;
  const baseY = 0;
  const wallHeight = towerHeight;
  for (const side of [-1, 1]) {
    addBox(building, solidMeshes, occluders, new THREE.Vector3(VILLAGE_WALL_THICKNESS, wallHeight, towerWidth), new THREE.Vector3(side * towerWidth / 2, baseY + wallHeight / 2, towerZ), stoneMaterial);
    addBox(building, solidMeshes, occluders, new THREE.Vector3(towerWidth, wallHeight, VILLAGE_WALL_THICKNESS), new THREE.Vector3(0, baseY + wallHeight / 2, towerZ + side * towerWidth / 2), stoneMaterial);
  }
  const openingY = 11.2;
  for (const side of [-1, 1]) {
    addWindowVoid(building, new THREE.Vector3(side * (towerWidth / 2 + .006), openingY, towerZ), .72, 2.1, true, voidMaterial, () => 1, 1);
    addWindowVoid(building, new THREE.Vector3(0, openingY, towerZ + side * (towerWidth / 2 + .006)), .72, 2.1, false, voidMaterial, () => 1, 1);
  }
  addBox(building, solidMeshes, occluders, new THREE.Vector3(3.25, .26, 3.25), new THREE.Vector3(0, towerHeight, towerZ), darkMaterial);
  const roof = new THREE.Mesh(new THREE.ConeGeometry(2.48, 5.15, 4), slateMaterial);
  roof.position.set(0, towerHeight + 2.7, towerZ);
  roof.rotation.y = Math.PI / 4;
  building.add(roof);
  occluders.push(roof);
  const needle = new THREE.Mesh(new THREE.CylinderGeometry(.045, .15, 2.5, 5), darkMaterial);
  needle.position.set(0, towerHeight + 6.5, towerZ);
  building.add(needle);
  occluders.push(needle);
}

export function createDrownedVillage(terrainHeight: (x: number, z: number) => number): DrownedVillageResult {
  const group = new THREE.Group();
  group.name = "demo-20-drowned-village";
  const stoneMaterial = new THREE.MeshStandardMaterial({ color: VILLAGE_STONE_COLOR, roughness: 1, flatShading: true });
  const darkCourseMaterial = new THREE.MeshStandardMaterial({ color: VILLAGE_DARK_COURSE_COLOR, roughness: 1, flatShading: true });
  const timberMaterial = new THREE.MeshStandardMaterial({ color: VILLAGE_TIMBER_COLOR, roughness: 1, flatShading: true });
  const slateMaterial = new THREE.MeshStandardMaterial({ color: VILLAGE_SLATE_COLOR, roughness: 1, flatShading: true });
  const siltMaterial = new THREE.MeshStandardMaterial({ color: VILLAGE_SILT_COLOR, roughness: 1, flatShading: true });
  const voidMaterial = new THREE.MeshBasicMaterial({ color: VILLAGE_WINDOW_VOID_COLOR, side: THREE.DoubleSide });
  const materials = [stoneMaterial, darkCourseMaterial, timberMaterial, slateMaterial, siltMaterial, voidMaterial];
  const solidMeshes: THREE.Mesh[] = [];
  const occluderMeshes: THREE.Mesh[] = [];
  const creatureObstacles: WorldRadialObstacle[] = [];
  const floraExclusions: Array<{ x: number; z: number; radius: number }> = [];

  BUILDING_SITES.forEach((site, index) => {
    const preset = DROWNED_BUILDING_PRESETS[site.type];
    const rand = mulberry32(VILLAGE_BUILDING_SEED + index * 1907);
    const building = new THREE.Group();
    building.name = `ruined-${site.type}-${index}`;
    for (let storey = 0; storey < preset.storeys; storey++) {
      createWall(building, solidMeshes, occluderMeshes, preset, stoneMaterial, darkCourseMaterial, voidMaterial, rand, storey, "front");
      createWall(building, solidMeshes, occluderMeshes, preset, stoneMaterial, darkCourseMaterial, voidMaterial, rand, storey, "back");
      createWall(building, solidMeshes, occluderMeshes, preset, stoneMaterial, darkCourseMaterial, voidMaterial, rand, storey, "left");
      createWall(building, solidMeshes, occluderMeshes, preset, stoneMaterial, darkCourseMaterial, voidMaterial, rand, storey, "right");
    }
    addRoof(building, solidMeshes, occluderMeshes, preset, timberMaterial, slateMaterial, stoneMaterial, rand);
    addSiltAndRubble(building, preset, siltMaterial, stoneMaterial, rand);
    if (site.type === "chapel") {
      addChapelTower(building, solidMeshes, occluderMeshes, preset, stoneMaterial, darkCourseMaterial, slateMaterial, voidMaterial);
    }
    const facing = site.side === "west" ? Math.PI / 2 : -Math.PI / 2;
    building.rotation.y = facing + THREE.MathUtils.degToRad(site.slop);
    building.position.set(site.x, terrainHeight(site.x, site.z), site.z);
    group.add(building);
    const totalHeight = preset.storeys * preset.storeyHeight + preset.width * .5 * preset.pitch + (site.type === "chapel" ? 7 : 0);
    creatureObstacles.push({
      x: site.x,
      z: site.z,
      radius: Math.hypot(preset.width, preset.depth) * .52 + 1.2,
      minY: building.position.y - .4,
      maxY: building.position.y + totalHeight,
    });
    floraExclusions.push({ x: site.x, z: site.z, radius: Math.hypot(preset.width, preset.depth) * .52 + 1.4 });
  });

  group.updateMatrixWorld(true);
  const playerSolids: WorldSolidBox[] = [];
  solidMeshes.forEach((mesh, index) => {
    const bounds = new THREE.Box3().setFromObject(mesh);
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    if (size.x < .025 || size.z < .025 || size.y < .025) return;
    playerSolids.push({
      id: `village-solid-${index}`,
      x: center.x,
      z: center.z,
      halfX: size.x / 2,
      halfZ: size.z / 2,
      minY: bounds.min.y,
      maxY: bounds.max.y,
    });
  });
  group.userData.buildingCount = BUILDING_SITES.length;
  group.userData.typeCounts = VILLAGE_TYPE_COUNTS;
  group.userData.wallThickness = VILLAGE_WALL_THICKNESS;

  const dispose = () => {
    group.traverse((child) => {
      if (child instanceof THREE.Mesh) child.geometry.dispose();
    });
    materials.forEach((material) => material.dispose());
  };

  return {
    group,
    playerSolids,
    creatureObstacles,
    floraExclusions,
    occluderMeshes,
    buildingCount: BUILDING_SITES.length,
    dispose,
  };
}
