import * as THREE from "three";

// Supplied nest preset. These values are the model design and intentionally
// retain the original live-viewer precision.
export const NEST_EGG_SIZE = .62;
export const NEST_EGG_COUNT = 8;
export const NEST_EGG_ELONGATION = 1.34;
export const NEST_EGG_VARIATION = .00;
export const NEST_EGG_SIDES = 7;
export const NEST_CLUTCH_RADIUS = 1.35;
export const NEST_EGG_BURY = .34;
export const NEST_HATCHED_SHARE = .28;
export const NEST_COLLAPSED_SHARE = .12;
export const NEST_SCRAPE = .50;
export const NEST_SILT_RING_BLOCKS = 22;
export const NEST_LINING = 1.00;
export const NEST_LINING_PIECES = 34;
export const NEST_BONES = .00;
export const NEST_PULSE = .35;
export const NEST_MOVING_SHARE = .45;
export const NEST_PULSE_RATE_MIN = .5;
export const NEST_PULSE_RATE_MAX = 1.2;
export const NEST_SEED = 86777;
export const NEST_X = -79.0;
export const NEST_Z = -67.0;
export const NEST_PHOTO_EVIDENCE_VALUE = 5;

export type NestEggState = "intact" | "hatched" | "collapsed";

export interface CreatureNestResult {
  group: THREE.Group;
  update: (time: number) => void;
  dispose: () => void;
  stats: {
    eggCount: number;
    intactCount: number;
    hatchedCount: number;
    collapsedCount: number;
    movingCount: number;
    liningCount: number;
    boneCount: number;
  };
}

interface MovingEgg {
  mesh: THREE.Mesh;
  baseScale: THREE.Vector3;
  rate: number;
  phase: number;
}

function mulberry32(seed: number) {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeFlapGeometry(width: number, length: number) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    -width / 2, 0, 0,
    width / 2, 0, 0,
    0, .035, length,
  ], 3));
  geometry.computeVertexNormals();
  return geometry;
}

export function createCreatureNest(terrainHeight: (x: number, z: number) => number): CreatureNestResult {
  const rand = mulberry32(NEST_SEED);
  const group = new THREE.Group();
  group.name = "demo-20-creature-egg-nest";
  const floor = terrainHeight(NEST_X, NEST_Z);
  group.position.set(NEST_X, floor + .018, NEST_Z);
  const paleMaterial = new THREE.MeshStandardMaterial({ color: 0xa8a487, roughness: 1, metalness: 0, flatShading: true });
  const mutedMaterial = new THREE.MeshStandardMaterial({ color: 0x94906f, roughness: 1, metalness: 0, flatShading: true });
  const collapsedMaterial = new THREE.MeshStandardMaterial({ color: 0x77755d, roughness: 1, metalness: 0, flatShading: true });
  const innerMaterial = new THREE.MeshBasicMaterial({ color: 0x080a08, side: THREE.DoubleSide });
  const siltMaterial = new THREE.MeshStandardMaterial({ color: 0x4e523d, roughness: 1, flatShading: true });
  const liningMaterial = new THREE.MeshStandardMaterial({ color: 0x343c2d, roughness: 1, flatShading: true });
  const materials = [paleMaterial, mutedMaterial, collapsedMaterial, innerMaterial, siltMaterial, liningMaterial];
  const movingEggs: MovingEgg[] = [];

  const scrapeRadius = NEST_CLUTCH_RADIUS * (1.25 + NEST_SCRAPE * .35);
  const scrape = new THREE.Mesh(new THREE.CircleGeometry(scrapeRadius, 22), siltMaterial);
  scrape.name = "nest-cleared-scrape";
  scrape.rotation.x = -Math.PI / 2;
  scrape.position.y = .012;
  scrape.scale.set(1.15, .86, 1);
  group.add(scrape);
  for (let block = 0; block < NEST_SILT_RING_BLOCKS; block++) {
    const angle = block / NEST_SILT_RING_BLOCKS * Math.PI * 2 + (rand() - .5) * .12;
    const radius = scrapeRadius * (.9 + rand() * .2);
    const silt = new THREE.Mesh(new THREE.IcosahedronGeometry(.16 + rand() * .19, 0), siltMaterial);
    silt.position.set(Math.cos(angle) * radius, .07 + rand() * .08, Math.sin(angle) * radius);
    silt.scale.set(1.4 + rand() * .9, .35 + rand() * .25, .7 + rand() * .7);
    silt.rotation.y = angle + (rand() - .5) * .45;
    group.add(silt);
  }

  for (let piece = 0; piece < Math.round(NEST_LINING_PIECES * NEST_LINING); piece++) {
    const angle = rand() * Math.PI * 2;
    const radius = Math.sqrt(rand()) * scrapeRadius * .92;
    const weed = rand() < .68;
    const lining = weed
      ? new THREE.Mesh(new THREE.CylinderGeometry(.018, .035, .45 + rand() * .55, 4), liningMaterial)
      : new THREE.Mesh(new THREE.IcosahedronGeometry(.10 + rand() * .16, 0), liningMaterial);
    lining.position.set(Math.cos(angle) * radius, .055 + rand() * .04, Math.sin(angle) * radius);
    if (weed) {
      lining.rotation.z = Math.PI / 2 + (rand() - .5) * .22;
      lining.rotation.y = angle + (rand() - .5) * .7;
    } else lining.scale.y = .45 + rand() * .35;
    group.add(lining);
  }

  const hatchedCount = Math.round(NEST_EGG_COUNT * NEST_HATCHED_SHARE);
  const collapsedCount = Math.round(NEST_EGG_COUNT * NEST_COLLAPSED_SHARE);
  const states: NestEggState[] = [
    ...Array.from({ length: hatchedCount }, () => "hatched" as const),
    ...Array.from({ length: collapsedCount }, () => "collapsed" as const),
    ...Array.from({ length: NEST_EGG_COUNT - hatchedCount - collapsedCount }, () => "intact" as const),
  ];
  for (let index = states.length - 1; index > 0; index--) {
    const swap = Math.floor(rand() * (index + 1));
    [states[index], states[swap]] = [states[swap], states[index]];
  }
  const intactCount = states.filter((state) => state === "intact").length;
  const movingCount = Math.round(intactCount * NEST_MOVING_SHARE);
  let movingAssigned = 0;
  states.forEach((state, index) => {
    const angle = rand() * Math.PI * 2;
    const radius = Math.sqrt(rand()) * NEST_CLUTCH_RADIUS;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    const material = index % 2 === 0 ? paleMaterial : mutedMaterial;
    const halfHeight = NEST_EGG_SIZE * NEST_EGG_ELONGATION * .5;
    const baseY = halfHeight - NEST_EGG_SIZE * NEST_EGG_ELONGATION * NEST_EGG_BURY;
    if (state === "intact") {
      const egg = new THREE.Mesh(new THREE.SphereGeometry(NEST_EGG_SIZE / 2, NEST_EGG_SIDES, 5), material);
      egg.name = "nest-egg-intact";
      egg.position.set(x, baseY, z);
      egg.scale.set(1, NEST_EGG_ELONGATION, 1);
      egg.rotation.set((rand() - .5) * 1.1, rand() * Math.PI * 2, (rand() - .5) * 1.1);
      group.add(egg);
      if (movingAssigned < movingCount) {
        movingEggs.push({
          mesh: egg,
          baseScale: egg.scale.clone(),
          rate: NEST_PULSE_RATE_MIN + rand() * (NEST_PULSE_RATE_MAX - NEST_PULSE_RATE_MIN),
          phase: rand() * Math.PI * 2,
        });
        movingAssigned += 1;
      }
    } else if (state === "hatched") {
      const shell = new THREE.Mesh(
        new THREE.SphereGeometry(NEST_EGG_SIZE / 2, NEST_EGG_SIDES, 3, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
        material,
      );
      shell.name = "nest-egg-hatched";
      shell.position.set(x, baseY * .42, z);
      shell.scale.y = NEST_EGG_ELONGATION * .72;
      shell.rotation.y = rand() * Math.PI * 2;
      group.add(shell);
      const inside = new THREE.Mesh(new THREE.CircleGeometry(NEST_EGG_SIZE * .38, NEST_EGG_SIDES), innerMaterial);
      inside.rotation.x = -Math.PI / 2;
      inside.position.set(x, baseY * .45 + .015, z);
      group.add(inside);
      const flapCount = 3 + Math.floor(rand() * 4);
      for (let flap = 0; flap < flapCount; flap++) {
        const flapAngle = flap / flapCount * Math.PI * 2 + (rand() - .5) * .35;
        const membrane = new THREE.Mesh(makeFlapGeometry(.11 + rand() * .08, .22 + rand() * .16), material);
        membrane.position.set(x + Math.cos(flapAngle) * NEST_EGG_SIZE * .31, baseY * .46 + .025, z + Math.sin(flapAngle) * NEST_EGG_SIZE * .31);
        membrane.rotation.y = -flapAngle + Math.PI / 2;
        membrane.rotation.x = -.12 - rand() * .24;
        group.add(membrane);
      }
    } else {
      const egg = new THREE.Mesh(new THREE.SphereGeometry(NEST_EGG_SIZE / 2, NEST_EGG_SIDES, 5), collapsedMaterial);
      egg.name = "nest-egg-collapsed";
      egg.position.set(x, baseY * .42, z);
      egg.scale.set(1.04, NEST_EGG_ELONGATION * .5, 1.02);
      egg.rotation.set((rand() - .5) * .5, rand() * Math.PI * 2, (rand() - .5) * .5);
      group.add(egg);
      const dent = new THREE.Mesh(new THREE.CircleGeometry(NEST_EGG_SIZE * .18, 7), innerMaterial);
      dent.rotation.x = -Math.PI / 2;
      dent.position.set(x, baseY * .42 + NEST_EGG_SIZE * .30, z);
      group.add(dent);
    }
  });

  const stats = {
    eggCount: NEST_EGG_COUNT,
    intactCount,
    hatchedCount,
    collapsedCount,
    movingCount: movingEggs.length,
    liningCount: Math.round(NEST_LINING_PIECES * NEST_LINING),
    boneCount: Math.round(NEST_BONES),
  };
  group.userData.stats = stats;
  group.userData.photoEvidenceValue = NEST_PHOTO_EVIDENCE_VALUE;

  const update = (time: number) => {
    movingEggs.forEach((egg) => {
      const pulse = 1 + Math.sin(time * egg.rate + egg.phase) * NEST_PULSE * .055;
      egg.mesh.scale.copy(egg.baseScale).multiplyScalar(pulse);
    });
  };

  const dispose = () => {
    group.traverse((child) => {
      if (child instanceof THREE.Mesh) child.geometry.dispose();
    });
    materials.forEach((material) => material.dispose());
  };

  return { group, update, dispose, stats };
}
