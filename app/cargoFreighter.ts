import * as THREE from "three";
import type { WorldRadialObstacle, WorldSolidBox } from "./drownedVillage";

// Supplied freighter preset. Do not round these live-viewer values.
export const FREIGHTER_LENGTH = 64;
export const FREIGHTER_BEAM = 11.0;
export const FREIGHTER_DEPTH = 7.0;
export const FREIGHTER_HEEL_DEGREES = 68;
export const FREIGHTER_BURY = 1.8;
export const FREIGHTER_STATIONS = 22;
export const FREIGHTER_BREAK_FRACTION = .42;
export const FREIGHTER_BREAK_SEPARATION = 4.5;
export const FREIGHTER_HULL_DAMAGE = .34;
export const FREIGHTER_DECK_LOSS = .55;
export const FREIGHTER_SUPERSTRUCTURE = 1.00;
export const FREIGHTER_CRANE_COUNT = 2;
export const FREIGHTER_CONTAINER_COUNT = 14;
export const FREIGHTER_CONTAINER_SCATTER = 26;
export const FREIGHTER_CONTAINER_SIZE = new THREE.Vector3(6.1, 2.44, 2.6);
export const FREIGHTER_SEED = 22040;
export const FREIGHTER_X = 74;
export const FREIGHTER_Z = -5;
export const FREIGHTER_YAW = .18;
export const FREIGHTER_HULL_COLOR = 0xa84a24;
export const FREIGHTER_DECK_COLOR = 0x8e3d1e;
export const FREIGHTER_FRAME_COLOR = 0x6f2f18;
export const FREIGHTER_SUPERSTRUCTURE_COLOR = 0xb35730;
export const FREIGHTER_CONTAINER_COLOR = 0x8a4526;
export const FREIGHTER_WINDOW_COLOR = 0x080806;

export interface CargoFreighterResult {
  group: THREE.Group;
  playerSolids: WorldSolidBox[];
  creatureObstacle: WorldRadialObstacle;
  floraExclusions: Array<{ x: number; z: number; radius: number }>;
  occluderMeshes: THREE.Mesh[];
  stats: {
    sidePanels: number;
    missingSidePanels: number;
    deckPanels: number;
    missingDeckPanels: number;
    frames: number;
    containers: number;
  };
  dispose: () => void;
}

function mulberry32(seed: number) {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function halfBeamAt(t: number) {
  const halfBeam = FREIGHTER_BEAM / 2;
  let profile: number;
  if (t < .10) profile = .74 + (t / .10) * .24;
  else if (t < .70) profile = 1;
  else {
    const u = (t - .70) / .30;
    profile = 1 - Math.pow(u, 1.7) * .94;
  }
  return halfBeam * profile;
}

function stationPoint(t: number, x: number, y: number) {
  return new THREE.Vector3(x, y, (t - .5) * FREIGHTER_LENGTH);
}

function makeQuad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z,
    a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z,
  ], 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute([
    0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1,
  ], 2));
  geometry.computeVertexNormals();
  return geometry;
}

function addPanel(
  parent: THREE.Group,
  material: THREE.Material,
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
  d: THREE.Vector3,
  solidMeshes: THREE.Mesh[],
  occluders: THREE.Mesh[],
  name: string,
) {
  const mesh = new THREE.Mesh(makeQuad(a, b, c, d), material);
  mesh.name = name;
  parent.add(mesh);
  solidMeshes.push(mesh);
  occluders.push(mesh);
  return mesh;
}

function addBox(
  parent: THREE.Group,
  size: THREE.Vector3,
  position: THREE.Vector3,
  material: THREE.Material,
  solidMeshes: THREE.Mesh[],
  occluders: THREE.Mesh[],
  rotation = new THREE.Euler(),
  name = "freighter-solid",
) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), material);
  mesh.position.copy(position);
  mesh.rotation.copy(rotation);
  mesh.name = name;
  parent.add(mesh);
  solidMeshes.push(mesh);
  occluders.push(mesh);
  return mesh;
}

function addBeamBetween(
  parent: THREE.Group,
  a: THREE.Vector3,
  b: THREE.Vector3,
  thickness: number,
  material: THREE.Material,
  solidMeshes: THREE.Mesh[],
  occluders: THREE.Mesh[],
  name = "freighter-frame",
) {
  const direction = new THREE.Vector3().subVectors(b, a);
  const length = direction.length();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(thickness, thickness, length), material);
  mesh.position.addVectors(a, b).multiplyScalar(.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction.normalize());
  mesh.name = name;
  parent.add(mesh);
  solidMeshes.push(mesh);
  occluders.push(mesh);
  return mesh;
}

function isHoldStation(t: number) {
  return (t > .49 && t < .60) || (t > .64 && t < .75) || (t > .79 && t < .90);
}

export function createCargoFreighter(terrainHeight: (x: number, z: number) => number): CargoFreighterResult {
  const rand = mulberry32(FREIGHTER_SEED);
  const group = new THREE.Group();
  group.name = "demo-20-sunken-cargo-freighter";
  group.position.set(FREIGHTER_X, 0, FREIGHTER_Z);
  group.rotation.y = FREIGHTER_YAW;
  const heelingGroup = new THREE.Group();
  heelingGroup.name = "freighter-heeling-hull";
  heelingGroup.rotation.z = THREE.MathUtils.degToRad(FREIGHTER_HEEL_DEGREES);
  group.add(heelingGroup);
  const aftPart = new THREE.Group();
  aftPart.name = "freighter-aft-half";
  const forwardPart = new THREE.Group();
  forwardPart.name = "freighter-forward-half";
  forwardPart.position.set(2.55, .32, FREIGHTER_BREAK_SEPARATION * .82);
  forwardPart.rotation.set(.045, -.105, .025);
  heelingGroup.add(aftPart, forwardPart);

  const hullMaterial = new THREE.MeshStandardMaterial({ color: FREIGHTER_HULL_COLOR, roughness: 1, metalness: 0, flatShading: true, side: THREE.DoubleSide });
  const deckMaterial = new THREE.MeshStandardMaterial({ color: FREIGHTER_DECK_COLOR, roughness: 1, metalness: 0, flatShading: true, side: THREE.DoubleSide });
  const frameMaterial = new THREE.MeshStandardMaterial({ color: FREIGHTER_FRAME_COLOR, roughness: 1, metalness: 0, flatShading: true });
  const superstructureMaterial = new THREE.MeshStandardMaterial({ color: FREIGHTER_SUPERSTRUCTURE_COLOR, roughness: 1, metalness: 0, flatShading: true });
  const containerMaterial = new THREE.MeshStandardMaterial({ color: FREIGHTER_CONTAINER_COLOR, roughness: 1, metalness: 0, flatShading: true });
  const windowMaterial = new THREE.MeshBasicMaterial({ color: FREIGHTER_WINDOW_COLOR, side: THREE.DoubleSide });
  const materials = [hullMaterial, deckMaterial, frameMaterial, superstructureMaterial, containerMaterial, windowMaterial];
  const solidMeshes: THREE.Mesh[] = [];
  const occluderMeshes: THREE.Mesh[] = [];
  const stats = { sidePanels: 0, missingSidePanels: 0, deckPanels: 0, missingDeckPanels: 0, frames: 0, containers: 0 };

  const buildPart = (parent: THREE.Group, startT: number, endT: number) => {
    const stationStart = Math.floor(startT * (FREIGHTER_STATIONS - 1));
    const stationEnd = Math.ceil(endT * (FREIGHTER_STATIONS - 1));
    for (let station = stationStart; station < stationEnd; station++) {
      const tA = Math.max(startT, station / (FREIGHTER_STATIONS - 1));
      const tB = Math.min(endT, (station + 1) / (FREIGHTER_STATIONS - 1));
      if (tB <= tA) continue;
      const beamA = halfBeamAt(tA);
      const beamB = halfBeamAt(tB);
      const centerA = stationPoint(tA, 0, 0);
      const centerB = stationPoint(tB, 0, 0);
      for (const side of [-1, 1]) {
        const flatA = stationPoint(tA, side * beamA * .80, 0);
        const flatB = stationPoint(tB, side * beamB * .80, 0);
        const bilgeA = stationPoint(tA, side * beamA, FREIGHTER_DEPTH * .22);
        const bilgeB = stationPoint(tB, side * beamB, FREIGHTER_DEPTH * .22);
        const deckA = stationPoint(tA, side * beamA, FREIGHTER_DEPTH);
        const deckB = stationPoint(tB, side * beamB, FREIGHTER_DEPTH);
        addPanel(parent, hullMaterial, centerA, flatA, flatB, centerB, solidMeshes, occluderMeshes, "freighter-flat-bottom");
        stats.sidePanels += 2;
        if (rand() >= FREIGHTER_HULL_DAMAGE) {
          addPanel(parent, hullMaterial, flatA, bilgeA, bilgeB, flatB, solidMeshes, occluderMeshes, "freighter-bilge-panel");
        } else stats.missingSidePanels += 1;
        if (rand() >= FREIGHTER_HULL_DAMAGE) {
          addPanel(parent, hullMaterial, bilgeA, deckA, deckB, bilgeB, solidMeshes, occluderMeshes, "freighter-side-panel");
        } else stats.missingSidePanels += 1;

        const stringerA1 = stationPoint(tA, side * (beamA - .13), FREIGHTER_DEPTH * .42);
        const stringerB1 = stationPoint(tB, side * (beamB - .13), FREIGHTER_DEPTH * .42);
        const stringerA2 = stationPoint(tA, side * (beamA - .13), FREIGHTER_DEPTH * .76);
        const stringerB2 = stationPoint(tB, side * (beamB - .13), FREIGHTER_DEPTH * .76);
        addBeamBetween(parent, stringerA1, stringerB1, .15, frameMaterial, solidMeshes, occluderMeshes, "freighter-longitudinal-stringer");
        addBeamBetween(parent, stringerA2, stringerB2, .15, frameMaterial, solidMeshes, occluderMeshes, "freighter-longitudinal-stringer");
      }
      stats.deckPanels += 1;
      if (!isHoldStation((tA + tB) / 2) && rand() >= FREIGHTER_DECK_LOSS) {
        addPanel(
          parent,
          deckMaterial,
          stationPoint(tA, -beamA, FREIGHTER_DEPTH),
          stationPoint(tA, beamA, FREIGHTER_DEPTH),
          stationPoint(tB, beamB, FREIGHTER_DEPTH),
          stationPoint(tB, -beamB, FREIGHTER_DEPTH),
          solidMeshes,
          occluderMeshes,
          "freighter-deck-panel",
        );
      } else stats.missingDeckPanels += 1;

      if (station % 2 === 0) {
        const t = tA;
        const beam = beamA;
        const points = [
          stationPoint(t, -beam, FREIGHTER_DEPTH),
          stationPoint(t, -beam, FREIGHTER_DEPTH * .22),
          stationPoint(t, -beam * .8, 0),
          stationPoint(t, beam * .8, 0),
          stationPoint(t, beam, FREIGHTER_DEPTH * .22),
          stationPoint(t, beam, FREIGHTER_DEPTH),
        ];
        for (let index = 0; index < points.length - 1; index++) {
          addBeamBetween(parent, points[index], points[index + 1], .19, frameMaterial, solidMeshes, occluderMeshes);
          stats.frames += 1;
        }
      }
    }
  };

  buildPart(aftPart, 0, FREIGHTER_BREAK_FRACTION - .012);
  buildPart(forwardPart, FREIGHTER_BREAK_FRACTION + .012, 1);

  // Three empty cargo holds. Only the coamings are solid; their centers remain
  // open so the player can enter through surviving or missing deck sections.
  for (const centerT of [.545, .695, .845]) {
    const z = (centerT - .5) * FREIGHTER_LENGTH;
    const width = halfBeamAt(centerT) * 1.42;
    const holdLength = 5.6;
    addBox(forwardPart, new THREE.Vector3(width, .38, .28), new THREE.Vector3(0, FREIGHTER_DEPTH + .19, z - holdLength / 2), frameMaterial, solidMeshes, occluderMeshes, new THREE.Euler(), "open-hold-coaming");
    addBox(forwardPart, new THREE.Vector3(width, .38, .28), new THREE.Vector3(0, FREIGHTER_DEPTH + .19, z + holdLength / 2), frameMaterial, solidMeshes, occluderMeshes, new THREE.Euler(), "open-hold-coaming");
    addBox(forwardPart, new THREE.Vector3(.28, .38, holdLength), new THREE.Vector3(-width / 2, FREIGHTER_DEPTH + .19, z), frameMaterial, solidMeshes, occluderMeshes, new THREE.Euler(), "open-hold-coaming");
    addBox(forwardPart, new THREE.Vector3(.28, .38, holdLength), new THREE.Vector3(width / 2, FREIGHTER_DEPTH + .19, z), frameMaterial, solidMeshes, occluderMeshes, new THREE.Euler(), "open-hold-coaming");
  }

  // Aft superstructure and near-black window insets.
  if (FREIGHTER_SUPERSTRUCTURE === 1.00) {
    const z = (.16 - .5) * FREIGHTER_LENGTH;
    addBox(aftPart, new THREE.Vector3(8.3, 3.4, 6.8), new THREE.Vector3(0, FREIGHTER_DEPTH + 1.7, z), superstructureMaterial, solidMeshes, occluderMeshes, new THREE.Euler(), "freighter-superstructure");
    addBox(aftPart, new THREE.Vector3(6.6, 2.5, 4.8), new THREE.Vector3(0, FREIGHTER_DEPTH + 4.65, z - .35), superstructureMaterial, solidMeshes, occluderMeshes, new THREE.Euler(), "freighter-bridge");
    for (let window = -2; window <= 2; window++) {
      const inset = new THREE.Mesh(new THREE.PlaneGeometry(.72, .58), windowMaterial);
      inset.position.set(window * 1.05, FREIGHTER_DEPTH + 4.9, z + 2.406);
      aftPart.add(inset);
    }
    addBox(aftPart, new THREE.Vector3(1.6, 3.0, 1.8), new THREE.Vector3(1.8, FREIGHTER_DEPTH + 7.4, z - 1.1), frameMaterial, solidMeshes, occluderMeshes, new THREE.Euler(), "freighter-funnel");
  }

  for (let crane = 0; crane < FREIGHTER_CRANE_COUNT; crane++) {
    const t = crane === 0 ? .61 : .78;
    const z = (t - .5) * FREIGHTER_LENGTH;
    const mastHeight = 7.4;
    addBox(forwardPart, new THREE.Vector3(.38, mastHeight, .38), new THREE.Vector3(0, FREIGHTER_DEPTH + mastHeight / 2, z), frameMaterial, solidMeshes, occluderMeshes, new THREE.Euler(0, 0, crane ? -.12 : .16), "freighter-deck-crane");
    addBox(forwardPart, new THREE.Vector3(8.6, .28, .32), new THREE.Vector3(crane ? -2.2 : 2.2, FREIGHTER_DEPTH + mastHeight - .5, z), frameMaterial, solidMeshes, occluderMeshes, new THREE.Euler(0, .08, crane ? -.18 : .22), "freighter-crane-boom");
  }

  const addContainer = (parent: THREE.Group, position: THREE.Vector3, rotation: THREE.Euler, ripped: boolean) => {
    const container = new THREE.Group();
    container.name = "freighter-container-group";
    container.position.copy(position);
    container.rotation.copy(rotation);
    const body = addBox(container, FREIGHTER_CONTAINER_SIZE, new THREE.Vector3(), containerMaterial, solidMeshes, occluderMeshes, new THREE.Euler(), "freighter-container");
    body.name = "freighter-container-body";
    for (let rib = -2; rib <= 2; rib++) {
      const strip = new THREE.Mesh(new THREE.BoxGeometry(.09, FREIGHTER_CONTAINER_SIZE.y + .04, FREIGHTER_CONTAINER_SIZE.z + .04), frameMaterial);
      strip.position.x = rib * FREIGHTER_CONTAINER_SIZE.x / 5;
      container.add(strip);
      occluderMeshes.push(strip);
    }
    if (ripped) {
      const rip = new THREE.Mesh(new THREE.PlaneGeometry(2.2, .82), windowMaterial);
      rip.rotation.x = -Math.PI / 2;
      rip.position.y = FREIGHTER_CONTAINER_SIZE.y / 2 + .011;
      rip.rotation.z = (rand() - .5) * .45;
      container.add(rip);
    }
    parent.add(container);
    stats.containers += 1;
    return container;
  };

  const deckContainerCount = Math.round(FREIGHTER_CONTAINER_COUNT * .25);
  for (let index = 0; index < deckContainerCount; index++) {
    const t = .49 + index * .115;
    addContainer(
      forwardPart,
      new THREE.Vector3((rand() - .5) * 2.6, FREIGHTER_DEPTH + FREIGHTER_CONTAINER_SIZE.y / 2 + .3, (t - .5) * FREIGHTER_LENGTH),
      new THREE.Euler((rand() - .5) * .05, (rand() - .5) * .22, (rand() - .5) * .07),
      rand() < .25,
    );
  }

  // Shift the rolled wreck down until its lowest surviving structure is buried
  // exactly 1.8 m into the local lake floor.
  group.updateMatrixWorld(true);
  const hullBounds = new THREE.Box3().setFromObject(heelingGroup);
  const wreckFloor = terrainHeight(FREIGHTER_X, FREIGHTER_Z);
  heelingGroup.position.y += wreckFloor - FREIGHTER_BURY - hullBounds.min.y;
  group.updateMatrixWorld(true);

  const localWorld = (x: number, z: number) => {
    const world = new THREE.Vector3(x, 0, z).applyAxisAngle(new THREE.Vector3(0, 1, 0), FREIGHTER_YAW);
    world.x += FREIGHTER_X;
    world.z += FREIGHTER_Z;
    return world;
  };
  for (let index = deckContainerCount; index < FREIGHTER_CONTAINER_COUNT; index++) {
    const angle = rand() * Math.PI * 2;
    const radius = Math.sqrt(rand()) * FREIGHTER_CONTAINER_SCATTER;
    const localX = Math.cos(angle) * radius;
    const localZ = Math.sin(angle) * radius;
    const world = localWorld(localX, localZ);
    const bury = rand() * .7;
    addContainer(
      group,
      new THREE.Vector3(localX, terrainHeight(world.x, world.z) + FREIGHTER_CONTAINER_SIZE.y * (.5 - bury), localZ),
      new THREE.Euler(rand() * Math.PI, rand() * Math.PI * 2, rand() * Math.PI),
      rand() < .25,
    );
  }
  group.updateMatrixWorld(true);

  const playerSolids: WorldSolidBox[] = [];
  solidMeshes.forEach((mesh, index) => {
    const bounds = new THREE.Box3().setFromObject(mesh);
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    if (size.x < .025 || size.z < .025 || size.y < .025) return;
    playerSolids.push({
      id: `freighter-solid-${index}`,
      x: center.x,
      z: center.z,
      halfX: size.x / 2,
      halfZ: size.z / 2,
      minY: bounds.min.y,
      maxY: bounds.max.y,
    });
  });
  const finalBounds = new THREE.Box3().setFromObject(group);
  const creatureObstacle: WorldRadialObstacle = {
    x: FREIGHTER_X,
    z: FREIGHTER_Z,
    radius: FREIGHTER_LENGTH * .54,
    minY: finalBounds.min.y - 1,
    maxY: finalBounds.max.y + 2,
  };
  const floraExclusions: Array<{ x: number; z: number; radius: number }> = [];
  for (let station = 0; station <= 8; station++) {
    const z = -FREIGHTER_LENGTH / 2 + station / 8 * FREIGHTER_LENGTH;
    const world = localWorld(0, z);
    floraExclusions.push({ x: world.x, z: world.z, radius: FREIGHTER_BEAM * .72 });
  }
  group.children.forEach((child) => {
    if (!child.name.includes("container")) return;
    const world = child.getWorldPosition(new THREE.Vector3());
    floraExclusions.push({ x: world.x, z: world.z, radius: 3.6 });
  });
  group.userData.stats = stats;
  group.userData.enterable = "missing-plating-open-holds-solid-surfaces-only";
  group.userData.location = `${FREIGHTER_X},${FREIGHTER_Z}`;

  const dispose = () => {
    group.traverse((child) => {
      if (child instanceof THREE.Mesh) child.geometry.dispose();
    });
    materials.forEach((material) => material.dispose());
  };

  return { group, playerSolids, creatureObstacle, floraExclusions, occluderMeshes, stats, dispose };
}
