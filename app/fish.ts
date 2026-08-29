import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

// Release fish tuning. Keep behavior values named and centralized so the
// ambient population can be tuned without rewriting the steering system.
// "250% faster" than the ordinary cruise means 350% of normal speed.
export const FISH_FLEE_SPEED_MULTIPLIER = 3.5;
// A relative multiplier alone left every species slower than the 3.1875 m/s
// diver because their ambient cruise speeds are intentionally tiny. Full fear
// now reaches roughly 1.8x the player's baseline swim speed for a legible exit.
export const FISH_FLEE_MIN_SPEED = 5.75;
export const FISH_PLAYER_FEAR_RADIUS = 0.6;
export const FISH_PLAYER_HARD_CLEARANCE = 0.42;
export const FISH_CREATURE_FEAR_RADIUS = 15;
export const FISH_CREATURE_IMMEDIATE_FEAR_RADIUS = 7;
export const FISH_FLOODLIGHT_FEAR_RANGE = 54;
export const FISH_FLOODLIGHT_CENTER_COSINE = 0.91;
export const FISH_FLEE_RELEASE_SECONDS = 3;
export const FISH_WANDER_RADIUS = 12;
export const FISH_WANDER_TIMER_MIN_SECONDS = 4.5;
export const FISH_WANDER_TIMER_MAX_SECONDS = 10.5;
export const FISH_OBSTACLE_CLEARANCE = 0.48;
export const FISH_FLOOR_CLEARANCE = 0.26;
export const FISH_SURFACE_CEILING = -1.25;
export const FISH_WORLD_RADIUS = 104;
export const FISH_FALSE_SCATTER_CHANCE_PER_SECOND = 0.0018;
export const FISH_FALSE_SCATTER_DURATION_SECONDS = 2.4;
export const MINNOW_SCHOOL_MIN_SIZE = 5;
export const MINNOW_SCHOOL_MAX_SIZE = 15;
export const MINNOW_SCHOOL_COUNT = 33;
export const MINNOW_REGROUP_DELAY_SECONDS = 15;
export const MINNOW_REGROUP_CHANCE = 0.5;
export const MINNOW_SCHOOL_HALF_EXTENTS = new THREE.Vector3(3.2, 1.15, 3.8);
export const BREAM_GROUP_COUNT = 58;
export const PIKE_GROUP_COUNT = 56;
export const COELACANTH_COUNT = 1;
export const COELACANTH_DEEP_CENTER = new THREE.Vector2(-78, -67);
export const COELACANTH_DEEP_RADIUS = 32;
export const COELACANTH_MAX_Y = -24;

export type FishSpecies = "minnow" | "bream" | "pike" | "coelacanth";

// Keep the supplied live-viewer dimensions as the geometry design values.
// These render multipliers compensate for dense particulate and short murky
// sightlines so the silhouettes remain readable in actual play.
export const FISH_DISPLAY_SCALE: Record<FishSpecies, number> = {
  minnow: 1.85,
  bream: 1.65,
  pike: 1.4,
  coelacanth: 1.18,
};

export interface FishPreset {
  species: FishSpecies;
  length: number;
  depth: number;
  thickness: number;
  peak: number;
  tailTaper: number;
  peduncle: number;
  sides: number;
  tailSize: number;
  tailFork: number;
  dorsal: number;
  amplitude: number;
  animationSpeed: number;
  wave: number;
  normalSpeed: number;
  color: number;
}

// Every model value below comes directly from the supplied live-viewer preset.
export const FISH_PRESETS: Record<FishSpecies, FishPreset> = {
  minnow: {
    species: "minnow", length: .14, depth: .30, thickness: .13, peak: .30,
    tailTaper: 1.10, peduncle: .16, sides: 6, tailSize: .34, tailFork: .45,
    dorsal: .22, amplitude: .28, animationSpeed: 2.60, wave: 3.20,
    normalSpeed: .46, color: 0x89937c,
  },
  bream: {
    species: "bream", length: .26, depth: .58, thickness: .14, peak: .34,
    tailTaper: 1.50, peduncle: .13, sides: 7, tailSize: .30, tailFork: .55,
    dorsal: .44, amplitude: .20, animationSpeed: 2.00, wave: 3.00,
    normalSpeed: .30, color: 0x76806c,
  },
  pike: {
    species: "pike", length: .62, depth: .20, thickness: .15, peak: .44,
    tailTaper: .75, peduncle: .14, sides: 6, tailSize: .26, tailFork: .35,
    dorsal: .16, amplitude: .34, animationSpeed: 1.60, wave: 4.20,
    normalSpeed: .36, color: 0x536b48,
  },
  coelacanth: {
    species: "coelacanth", length: 1.60, depth: .40, thickness: .30, peak: .36,
    tailTaper: 1.00, peduncle: .30, sides: 8, tailSize: .30, tailFork: .05,
    dorsal: .18, amplitude: .14, animationSpeed: 1.00, wave: 2.20,
    normalSpeed: .24, color: 0x33415e,
  },
};

export interface FishObstacle {
  x: number;
  z: number;
  radius: number;
  minY: number;
  maxY: number;
}

export interface FishSystemOptions {
  terrainHeight: (x: number, z: number) => number;
  obstacles: FishObstacle[];
  seed?: number;
}

export interface FishUpdateContext {
  playerPosition: THREE.Vector3;
  floodlightOn: boolean;
  floodlightDirection: THREE.Vector3;
  creaturePosition: THREE.Vector3;
}

export interface FishSystem {
  group: THREE.Group;
  update: (time: number, dt: number, context: FishUpdateContext) => void;
  dispose: () => void;
  debug: {
    nearestPlayerDistance: number;
    nearestSpecies: FishSpecies;
    nearestPosition: THREE.Vector3;
    forwardCandidateCount: number;
    fleeingCount: number;
    longestFleeRemaining: number;
    maxTurnCurl: number;
    maxVerticalBend: number;
    maxBurstBlend: number;
  };
  stats: {
    minnowSchools: number;
    minnowCount: number;
    breamCount: number;
    pikeCount: number;
    coelacanthCount: number;
  };
}

interface AnimatedFishMaterial extends THREE.MeshStandardMaterial {
  userData: {
    fishShader?: { uniforms: Record<string, never> };
    [key: string]: unknown;
  };
}

interface FishEntity {
  species: FishSpecies;
  preset: FishPreset;
  instanceIndex: number;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  desired: THREE.Vector3;
  wanderTarget: THREE.Vector3;
  phase: number;
  motionPhase: number;
  motionAmount: number;
  fleeBlend: number;
  orientation: THREE.Quaternion;
  bank: number;
  turnCurl: number;
  verticalBend: number;
  scale: number;
  nextWanderAt: number;
  fleeUntil: number;
  fleeDirection: THREE.Vector3;
  falseScatterAt: number;
  schoolIndex: number | null;
}

interface MinnowSchool {
  memberIndices: number[];
  center: THREE.Vector3;
  direction: THREE.Vector3;
  disbanded: boolean;
  regroupDecisionMade: boolean;
  willRegroup: boolean;
  regroupAt: number;
  permanentlyScattered: boolean;
  nextTurnAt: number;
}

function mulberry32(seed: number) {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function addSolidColor(geometry: THREE.BufferGeometry, color: THREE.ColorRepresentation) {
  const position = geometry.getAttribute("position");
  const shade = new THREE.Color(color);
  const values = new Float32Array(position.count * 3);
  for (let index = 0; index < position.count; index++) {
    values[index * 3] = shade.r;
    values[index * 3 + 1] = shade.g;
    values[index * 3 + 2] = shade.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(values, 3));
  if (!geometry.getAttribute("uv")) {
    geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(position.count * 2), 2));
  }
  return geometry;
}

function nonIndexed(geometry: THREE.BufferGeometry) {
  return geometry.index ? geometry.toNonIndexed() : geometry;
}

function markFishPart(geometry: THREE.BufferGeometry, part: 0 | 1 | 2 | 3 | 4) {
  const count = geometry.getAttribute("position").count;
  geometry.setAttribute("fishPart", new THREE.Float32BufferAttribute(new Array(count).fill(part), 1));
  return geometry;
}

function makeTriangle(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, color = 0xb2b7a1) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z,
  ], 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, .5, 1], 2));
  geometry.computeVertexNormals();
  return addSolidColor(geometry, color);
}

function makeBodyGeometry(preset: FishPreset) {
  const positions: number[] = [0, 0, 0];
  const uvs: number[] = [.5, 0];
  const colors: number[] = [1, 1, 1];
  const indices: number[] = [];
  const sections = 14;
  for (let section = 1; section < sections; section++) {
    const t = section / (sections - 1);
    const profile = t <= preset.peak
      ? Math.pow(t / preset.peak, .48)
      : 1 - Math.pow((t - preset.peak) / (1 - preset.peak), preset.tailTaper) * (1 - preset.peduncle);
    const halfThickness = preset.length * preset.thickness * .5 * profile;
    const halfDepth = preset.length * preset.depth * .5 * profile;
    for (let side = 0; side < preset.sides; side++) {
      const angle = side / preset.sides * Math.PI * 2;
      positions.push(Math.cos(angle) * halfThickness, Math.sin(angle) * halfDepth, -t * preset.length);
      uvs.push(side / preset.sides, t);
      colors.push(1, 1, 1);
    }
  }
  for (let side = 0; side < preset.sides; side++) {
    indices.push(0, 1 + side, 1 + (side + 1) % preset.sides);
  }
  for (let section = 1; section < sections - 1; section++) {
    const ringA = 1 + (section - 1) * preset.sides;
    const ringB = ringA + preset.sides;
    for (let side = 0; side < preset.sides; side++) {
      const next = (side + 1) % preset.sides;
      indices.push(ringA + side, ringB + side, ringA + next);
      indices.push(ringA + next, ringB + side, ringB + next);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function createFishGeometry(preset: FishPreset) {
  const length = preset.length;
  const depth = length * preset.depth;
  const thickness = length * preset.thickness;
  const tailBase = new THREE.Vector3(0, 0, -length * .96);
  const tailEndZ = -length * (1 + preset.tailSize);
  const geometries: THREE.BufferGeometry[] = [markFishPart(makeBodyGeometry(preset), 0)];

  if (preset.species === "coelacanth") {
    geometries.push(
      markFishPart(makeTriangle(tailBase, new THREE.Vector3(0, depth * .64, tailEndZ), new THREE.Vector3(0, depth * .1, tailEndZ * 1.01)), 1),
      markFishPart(makeTriangle(tailBase, new THREE.Vector3(0, -depth * .64, tailEndZ), new THREE.Vector3(0, -depth * .1, tailEndZ * 1.01)), 1),
      markFishPart(makeTriangle(tailBase, new THREE.Vector3(thickness * .08, 0, tailEndZ * 1.08), new THREE.Vector3(-thickness * .08, 0, tailEndZ * 1.08)), 1),
      markFishPart(makeTriangle(new THREE.Vector3(0, depth * .42, -length * .35), new THREE.Vector3(0, depth * .95, -length * .46), new THREE.Vector3(0, depth * .35, -length * .54)), 2),
      markFishPart(makeTriangle(new THREE.Vector3(0, depth * .32, -length * .68), new THREE.Vector3(0, depth * .72, -length * .76), new THREE.Vector3(0, depth * .25, -length * .84)), 2),
    );
  } else {
    const fork = preset.tailFork;
    geometries.push(
      markFishPart(makeTriangle(tailBase, new THREE.Vector3(0, depth * (.45 + fork * .45), tailEndZ), new THREE.Vector3(0, depth * fork * .08, tailEndZ * .995)), 1),
      markFishPart(makeTriangle(tailBase, new THREE.Vector3(0, -depth * (.45 + fork * .45), tailEndZ), new THREE.Vector3(0, -depth * fork * .08, tailEndZ * .995)), 1),
    );
    const dorsalT = preset.species === "pike" ? .68 : .42;
    geometries.push(markFishPart(makeTriangle(
      new THREE.Vector3(0, depth * .34, -length * (dorsalT - .12)),
      new THREE.Vector3(0, depth * (.45 + preset.dorsal), -length * dorsalT),
      new THREE.Vector3(0, depth * .28, -length * (dorsalT + .17)),
    ), 2));
  }
  geometries.push(
    markFishPart(makeTriangle(
      new THREE.Vector3(0, -depth * .32, -length * .58),
      new THREE.Vector3(0, -depth * .62, -length * .73),
      new THREE.Vector3(0, -depth * .24, -length * .83),
    ), 2),
    markFishPart(makeTriangle(
      new THREE.Vector3(thickness * .38, 0, -length * .31),
      new THREE.Vector3(thickness * 1.05, -depth * .12, -length * .46),
      new THREE.Vector3(thickness * .32, -depth * .08, -length * .52),
    ), 3),
    markFishPart(makeTriangle(
      new THREE.Vector3(-thickness * .38, 0, -length * .31),
      new THREE.Vector3(-thickness * 1.05, -depth * .12, -length * .46),
      new THREE.Vector3(-thickness * .32, -depth * .08, -length * .52),
    ), 4),
  );

  const eyeRadius = Math.max(.004, length * .025);
  for (const side of [-1, 1]) {
    const eye = new THREE.SphereGeometry(eyeRadius, 5, 3);
    eye.translate(side * thickness * .46, depth * .12, -length * .13);
    geometries.push(markFishPart(addSolidColor(eye, 0x050807), 0));
  }

  const prepared = geometries.map((geometry) => nonIndexed(geometry));
  const merged = mergeGeometries(prepared, false);
  if (!merged) throw new Error(`Unable to merge ${preset.species} geometry`);
  merged.computeBoundingSphere();
  prepared.forEach((geometry) => {
    if (!geometries.includes(geometry)) geometry.dispose();
  });
  return merged;
}

const FISH_TEXTURE_FILES: Record<FishSpecies, string> = {
  minnow: "fish-scales-minnow.png",
  bream: "fish-scales-bream.png",
  pike: "fish-scales-pike.png",
  coelacanth: "fish-scales-coelacanth.png",
};

function loadFishSkinTexture(loader: THREE.TextureLoader, species: FishSpecies) {
  const texture = loader.load(
    new URL(`textures/fish/${FISH_TEXTURE_FILES[species]}`, document.baseURI).toString(),
  );
  texture.name = `supplied-${species}-scale-skin`;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  // Show fewer, larger scales on the compact geometry instead of shrinking
  // the supplied 1024px pattern into visual noise.
  texture.repeat.set(.62, .68);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createAnimatedMaterial(texture: THREE.Texture, preset: FishPreset) {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: texture,
    roughness: .9,
    metalness: 0,
    flatShading: true,
    side: THREE.DoubleSide,
    vertexColors: true,
  }) as AnimatedFishMaterial;
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      "#include <common>",
      `#include <common>
       attribute float fishMotionPhase;
       attribute float fishMotionAmount;
       attribute float fishTurn;
       attribute float fishVertical;
       attribute float fishBurst;
       attribute float fishPart;`,
    );
    shader.vertexShader = shader.vertexShader.replace(
      "#include <begin_vertex>",
      `vec3 transformed = vec3(position);
       float fishT = clamp(-transformed.z / ${preset.length.toFixed(6)}, 0.0, 1.35);
       float isTail = 1.0 - step(0.45, abs(fishPart - 1.0));
       float isMedianFin = 1.0 - step(0.45, abs(fishPart - 2.0));
       float isRightPectoral = 1.0 - step(0.45, abs(fishPart - 3.0));
       float isLeftPectoral = 1.0 - step(0.45, abs(fishPart - 4.0));
       float isPectoral = isRightPectoral + isLeftPectoral;
       float pectoralSide = isRightPectoral - isLeftPectoral;
       float propulsionGain = 1.0 + isTail * .34 - isMedianFin * .16;
       float bodyWave = sin(fishMotionPhase - fishT * ${preset.wave.toFixed(6)});
       transformed.x += bodyWave * ${preset.amplitude.toFixed(6)} * ${preset.length.toFixed(6)}
         * fishMotionAmount * propulsionGain * pow(fishT, 1.7);
       // A steering curl lets the body visibly lead and trail the world-space
       // orientation change instead of rotating like a rigid arrow.
       transformed.x += fishTurn * ${preset.length.toFixed(6)} * (.075 + isTail * .055)
         * pow(fishT, 1.42);
       transformed.y += fishVertical * ${preset.length.toFixed(6)} * (.052 + isTail * .025)
         * pow(fishT, 1.36);
       // The paired fins supply the smallest useful climb/dive and recovery
       // gesture. Their roots stay planted because reach tends to zero there.
       float pectoralReach = max(0.0, abs(position.x) - ${(preset.length * preset.thickness * .30).toFixed(6)});
       float finBeat = sin(fishMotionPhase * .62 + pectoralSide * 1.25);
       transformed.y += isPectoral * pectoralReach
         * (finBeat * (.24 + fishBurst * .22) - fishVertical * .72);
       transformed.z += isPectoral * pectoralReach * pectoralSide * fishTurn * .28;`,
    );
    material.userData.fishShader = { uniforms: {} };
  };
  material.customProgramCacheKey = () => `murk-fish-${preset.species}-v2`;
  return material;
}

function randomGroupSize(rand: () => number) {
  const roll = rand();
  if (roll < .30) return 2;
  if (roll < .70) return 3;
  if (roll < .95) return 4;
  return 5;
}

// A golden-angle distribution avoids the dense western cluster that the
// former hand-authored spawn lists produced while still looking organic.
function evenLakeCenters(count: number, phase: number) {
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  return Array.from({ length: count }, (_, index) => {
    const radialT = Math.sqrt((index + .5) / count);
    const radius = 8 + radialT * 88;
    const angle = phase + index * goldenAngle;
    return [Math.cos(angle) * radius * 1.04, Math.sin(angle) * radius] as const;
  });
}

export function createFishSystem(options: FishSystemOptions): FishSystem {
  const { terrainHeight, obstacles } = options;
  const rand = mulberry32(options.seed ?? 0x20f15a);
  const group = new THREE.Group();
  group.name = "demo-23-fish-population";
  const textureLoader = new THREE.TextureLoader();
  const textures = new Map<FishSpecies, THREE.Texture>(
    (Object.keys(FISH_PRESETS) as FishSpecies[]).map((species) => [
      species,
      loadFishSkinTexture(textureLoader, species),
    ]),
  );
  const geometries = new Map<FishSpecies, THREE.BufferGeometry>();
  const materials = new Map<FishSpecies, AnimatedFishMaterial>();
  const meshes = new Map<FishSpecies, THREE.InstancedMesh>();
  const entities: FishEntity[] = [];
  const speciesEntities = new Map<FishSpecies, FishEntity[]>();
  const minnowSchools: MinnowSchool[] = [];
  const schoolCenters = evenLakeCenters(MINNOW_SCHOOL_COUNT, .34);
  const breamCenters = evenLakeCenters(BREAM_GROUP_COUNT, 2.17);
  const pikeCenters = evenLakeCenters(PIKE_GROUP_COUNT, 4.03);
  const temp = new THREE.Vector3();

  const safeSpawn = (x: number, z: number, species: FishSpecies) => {
    let candidateX = x;
    let candidateZ = z;
    for (let attempt = 0; attempt < 18; attempt++) {
      const floor = terrainHeight(candidateX, candidateZ);
      const blocked = obstacles.some((obstacle) => (
        Math.hypot(candidateX - obstacle.x, candidateZ - obstacle.z) < obstacle.radius + 1.2
        && floor + 2.5 < obstacle.maxY
      ));
      if (!blocked && Math.hypot(candidateX / 1.04, candidateZ) < FISH_WORLD_RADIUS) {
        let y = floor + 2.6 + rand() * (species === "minnow" ? 5.8 : 3.4);
        if (species === "coelacanth") y = Math.min(COELACANTH_MAX_Y, floor + 5.4);
        return new THREE.Vector3(candidateX, Math.min(FISH_SURFACE_CEILING, y), candidateZ);
      }
      candidateX = x + (rand() - .5) * 12;
      candidateZ = z + (rand() - .5) * 12;
    }
    const floor = terrainHeight(x, z);
    return new THREE.Vector3(x, Math.min(FISH_SURFACE_CEILING, floor + 3.2), z);
  };

  const addEntity = (species: FishSpecies, position: THREE.Vector3, schoolIndex: number | null) => {
    const preset = FISH_PRESETS[species];
    const list = speciesEntities.get(species) ?? [];
    speciesEntities.set(species, list);
    const angle = rand() * Math.PI * 2;
    const initialVelocity = new THREE.Vector3(Math.sin(angle), (rand() - .5) * .08, Math.cos(angle)).multiplyScalar(preset.normalSpeed);
    const initialOrientation = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      initialVelocity.clone().normalize(),
    );
    const entity: FishEntity = {
      species,
      preset,
      instanceIndex: list.length,
      position,
      velocity: initialVelocity,
      desired: new THREE.Vector3(),
      wanderTarget: position.clone(),
      phase: rand() * Math.PI * 2,
      motionPhase: rand() * Math.PI * 2,
      motionAmount: .8,
      fleeBlend: 0,
      orientation: initialOrientation,
      bank: 0,
      turnCurl: 0,
      verticalBend: 0,
      scale: FISH_DISPLAY_SCALE[species] * (.9 + rand() * .2),
      nextWanderAt: rand() * 3,
      fleeUntil: 0,
      fleeDirection: new THREE.Vector3(),
      falseScatterAt: 9 + rand() * 55,
      schoolIndex,
    };
    list.push(entity);
    entities.push(entity);
    return entities.length - 1;
  };

  schoolCenters.slice(0, MINNOW_SCHOOL_COUNT).forEach(([x, z], schoolIndex) => {
    const center = safeSpawn(x, z, "minnow");
    const count = MINNOW_SCHOOL_MIN_SIZE + Math.floor(rand() * (MINNOW_SCHOOL_MAX_SIZE - MINNOW_SCHOOL_MIN_SIZE + 1));
    const members: number[] = [];
    for (let index = 0; index < count; index++) {
      const radius = Math.cbrt(rand());
      const angle = rand() * Math.PI * 2;
      const position = center.clone().add(new THREE.Vector3(
        Math.cos(angle) * MINNOW_SCHOOL_HALF_EXTENTS.x * radius,
        (rand() - .5) * MINNOW_SCHOOL_HALF_EXTENTS.y * 2,
        Math.sin(angle) * MINNOW_SCHOOL_HALF_EXTENTS.z * radius,
      ));
      members.push(addEntity("minnow", position, schoolIndex));
    }
    const heading = rand() * Math.PI * 2;
    minnowSchools.push({
      memberIndices: members,
      center,
      direction: new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading)),
      disbanded: false,
      regroupDecisionMade: false,
      willRegroup: false,
      regroupAt: 0,
      permanentlyScattered: false,
      nextTurnAt: 4 + rand() * 7 + schoolIndex * .3,
    });
  });

  breamCenters.slice(0, BREAM_GROUP_COUNT).forEach(([x, z]) => {
    const count = randomGroupSize(rand);
    const center = safeSpawn(x, z, "bream");
    for (let index = 0; index < count; index++) {
      addEntity("bream", center.clone().add(new THREE.Vector3((rand() - .5) * 2.2, (rand() - .5) * .6, (rand() - .5) * 2.2)), null);
    }
  });
  pikeCenters.slice(0, PIKE_GROUP_COUNT).forEach(([x, z]) => {
    const count = randomGroupSize(rand);
    const center = safeSpawn(x, z, "pike");
    for (let index = 0; index < count; index++) {
      addEntity("pike", center.clone().add(new THREE.Vector3((rand() - .5) * 2.8, (rand() - .5) * .5, (rand() - .5) * 2.8)), null);
    }
  });
  addEntity("coelacanth", safeSpawn(COELACANTH_DEEP_CENTER.x + 5, COELACANTH_DEEP_CENTER.y + 4, "coelacanth"), null);

  for (const species of Object.keys(FISH_PRESETS) as FishSpecies[]) {
    const preset = FISH_PRESETS[species];
    const list = speciesEntities.get(species) ?? [];
    const geometry = createFishGeometry(preset);
    const texture = textures.get(species);
    if (!texture) throw new Error(`Missing supplied ${species} fish texture`);
    const material = createAnimatedMaterial(texture, preset);
    const motionPhase = new THREE.InstancedBufferAttribute(new Float32Array(list.map((entity) => entity.motionPhase)), 1);
    const motionAmount = new THREE.InstancedBufferAttribute(new Float32Array(list.map((entity) => entity.motionAmount)), 1);
    const turn = new THREE.InstancedBufferAttribute(new Float32Array(list.map((entity) => entity.turnCurl)), 1);
    const vertical = new THREE.InstancedBufferAttribute(new Float32Array(list.map((entity) => entity.verticalBend)), 1);
    const burst = new THREE.InstancedBufferAttribute(new Float32Array(list.map((entity) => entity.fleeBlend)), 1);
    geometry.setAttribute("fishMotionPhase", motionPhase);
    geometry.setAttribute("fishMotionAmount", motionAmount);
    geometry.setAttribute("fishTurn", turn);
    geometry.setAttribute("fishVertical", vertical);
    geometry.setAttribute("fishBurst", burst);
    const mesh = new THREE.InstancedMesh(geometry, material, list.length);
    mesh.name = `${species}-population`;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    group.add(mesh);
    geometries.set(species, geometry);
    materials.set(species, material);
    meshes.set(species, mesh);
  }

  const coelacanth = (speciesEntities.get("coelacanth") ?? [])[0];
  const coelacanthFins: THREE.Group[] = [];
  if (coelacanth) {
    const finMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: textures.get("coelacanth"),
      roughness: .92,
      flatShading: true,
      side: THREE.DoubleSide,
    });
    const root = new THREE.Group();
    root.name = "coelacanth-lobed-fin-rig";
    const bodyMesh = meshes.get("coelacanth");
    if (bodyMesh) {
      group.remove(bodyMesh);
      root.add(bodyMesh);
      bodyMesh.setMatrixAt(0, new THREE.Matrix4());
      bodyMesh.instanceMatrix.needsUpdate = true;
    }
    const length = FISH_PRESETS.coelacanth.length;
    for (let index = 0; index < 4; index++) {
      const side = index % 2 === 0 ? -1 : 1;
      const aft = index >= 2;
      const fin = new THREE.Group();
      const stalk = new THREE.Mesh(new THREE.CylinderGeometry(.045, .075, .22, 6), finMaterial);
      stalk.rotation.z = Math.PI / 2;
      stalk.position.x = side * .11;
      fin.add(stalk);
      const paddle = new THREE.Mesh(makeTriangle(
        new THREE.Vector3(side * .18, 0, 0),
        new THREE.Vector3(side * .36, .11, -.05),
        new THREE.Vector3(side * .34, -.12, -.12),
        0xabb4b5,
      ), finMaterial);
      fin.add(paddle);
      fin.position.set(side * length * .12, aft ? -length * .09 : 0, -length * (aft ? .62 : .28));
      root.add(fin);
      coelacanthFins.push(fin);
    }
    group.add(root);
    root.userData.entity = coelacanth;
    root.userData.finMaterial = finMaterial;
  }

  // Geometry is authored from the nose at z=0 toward the tail on -Z, so +Z
  // is the direction of travel. Treating -Z as forward made every species
  // appear to swim tail-first even though its steering velocity was valid.
  const fishForward = new THREE.Vector3(0, 0, 1);
  const currentFishForward = new THREE.Vector3();
  const targetFishDirection = new THREE.Vector3();
  const targetQuaternion = new THREE.Quaternion();
  const bankQuaternion = new THREE.Quaternion();
  const quaternion = new THREE.Quaternion();
  const matrix = new THREE.Matrix4();
  const scaleVector = new THREE.Vector3();
  const awayPlayer = new THREE.Vector3();
  const awayThreat = new THREE.Vector3();
  const candidate = new THREE.Vector3();
  const creatureVelocity = new THREE.Vector3();
  const lastCreaturePosition = new THREE.Vector3();
  const playerToFish = new THREE.Vector3();
  let creatureInitialized = false;
  const debug = {
    nearestPlayerDistance: Infinity,
    nearestSpecies: "minnow" as FishSpecies,
    nearestPosition: new THREE.Vector3(),
    forwardCandidateCount: 0,
    fleeingCount: 0,
    longestFleeRemaining: 0,
    maxTurnCurl: 0,
    maxVerticalBend: 0,
    maxBurstBlend: 0,
  };

  const setIndependentTarget = (entity: FishEntity, time: number) => {
    const angle = rand() * Math.PI * 2;
    const radius = 3 + rand() * FISH_WANDER_RADIUS;
    entity.wanderTarget.set(
      entity.position.x + Math.cos(angle) * radius,
      entity.position.y + (rand() - .5) * 3,
      entity.position.z + Math.sin(angle) * radius,
    );
    const floor = terrainHeight(entity.wanderTarget.x, entity.wanderTarget.z) + FISH_FLOOR_CLEARANCE + entity.preset.length * entity.preset.depth;
    entity.wanderTarget.y = THREE.MathUtils.clamp(entity.wanderTarget.y, floor, FISH_SURFACE_CEILING);
    entity.nextWanderAt = time + FISH_WANDER_TIMER_MIN_SECONDS + rand() * (FISH_WANDER_TIMER_MAX_SECONDS - FISH_WANDER_TIMER_MIN_SECONDS);
  };

  const obstacleSteering = (entity: FishEntity, steering: THREE.Vector3) => {
    const lookAhead = temp.copy(entity.velocity).normalize().multiplyScalar(Math.max(1.2, entity.preset.length * entity.scale * 4)).add(entity.position);
    const aheadFloor = terrainHeight(lookAhead.x, lookAhead.z) + FISH_FLOOR_CLEARANCE + entity.preset.length * entity.preset.depth * entity.scale * .55;
    if (lookAhead.y < aheadFloor + .45) steering.y += 1.35;
    if (lookAhead.y > FISH_SURFACE_CEILING - .35) steering.y -= .8;
    for (const obstacle of obstacles) {
      if (entity.position.y < obstacle.minY - .6 || entity.position.y > obstacle.maxY + .6) continue;
      const dx = lookAhead.x - obstacle.x;
      const dz = lookAhead.z - obstacle.z;
      const distance = Math.hypot(dx, dz);
      const safe = obstacle.radius + FISH_OBSTACLE_CLEARANCE + entity.preset.length * entity.scale * .6;
      if (distance >= safe) continue;
      const inverse = 1 / Math.max(.01, distance);
      steering.x += dx * inverse * (safe - distance + .4) * 1.7;
      steering.z += dz * inverse * (safe - distance + .4) * 1.7;
      steering.y += entity.position.y < (obstacle.minY + obstacle.maxY) * .5 ? -.35 : .35;
    }
    const lakeDistance = Math.hypot(lookAhead.x / 1.04, lookAhead.z);
    if (lakeDistance > FISH_WORLD_RADIUS - 7) {
      steering.x += -lookAhead.x * .08;
      steering.z += -lookAhead.z * .08;
    }
    if (entity.species === "coelacanth") {
      const dx = entity.position.x - COELACANTH_DEEP_CENTER.x;
      const dz = entity.position.z - COELACANTH_DEEP_CENTER.y;
      const distance = Math.hypot(dx, dz);
      if (distance > COELACANTH_DEEP_RADIUS - 5) {
        steering.x += -dx * .12;
        steering.z += -dz * .12;
      }
      if (entity.position.y > COELACANTH_MAX_Y) steering.y -= 1.2;
    }
  };

  const threatDirection = (entity: FishEntity, time: number, context: FishUpdateContext) => {
    awayPlayer.subVectors(entity.position, context.playerPosition);
    const playerDistance = awayPlayer.length();
    if (playerDistance < FISH_PLAYER_FEAR_RADIUS) return awayPlayer.normalize();

    if (context.floodlightOn) {
      awayThreat.subVectors(entity.position, context.playerPosition);
      const distance = awayThreat.length();
      if (distance < FISH_FLOODLIGHT_FEAR_RANGE
        && awayThreat.normalize().dot(context.floodlightDirection) > FISH_FLOODLIGHT_CENTER_COSINE) {
        return awayPlayer.lengthSq() > .001 ? awayPlayer.normalize() : awayThreat.negate();
      }
    }

    awayThreat.subVectors(entity.position, context.creaturePosition);
    const creatureDistance = awayThreat.length();
    if (creatureDistance < FISH_CREATURE_FEAR_RADIUS) {
      const towardFish = creatureVelocity.lengthSq() > .001
        && creatureVelocity.clone().normalize().dot(awayThreat.clone().normalize()) > .3;
      if (towardFish || creatureDistance < FISH_CREATURE_IMMEDIATE_FEAR_RADIUS) return awayThreat.normalize();
    }

    if (time >= entity.falseScatterAt) {
      entity.falseScatterAt = time + 18 + rand() * 65;
      if (rand() < FISH_FALSE_SCATTER_CHANCE_PER_SECOND * 35) {
        const angle = rand() * Math.PI * 2;
        entity.fleeUntil = time + FISH_FALSE_SCATTER_DURATION_SECONDS;
        return new THREE.Vector3(Math.cos(angle), (rand() - .5) * .25, Math.sin(angle));
      }
    }
    return null;
  };

  const stats = {
    minnowSchools: minnowSchools.length,
    minnowCount: (speciesEntities.get("minnow") ?? []).length,
    breamCount: (speciesEntities.get("bream") ?? []).length,
    pikeCount: (speciesEntities.get("pike") ?? []).length,
    coelacanthCount: (speciesEntities.get("coelacanth") ?? []).length,
  };
  group.userData.stats = stats;

  const update = (time: number, dt: number, context: FishUpdateContext) => {
    if (!creatureInitialized) {
      lastCreaturePosition.copy(context.creaturePosition);
      creatureInitialized = true;
    }
    creatureVelocity.subVectors(context.creaturePosition, lastCreaturePosition).divideScalar(Math.max(dt, .001));
    lastCreaturePosition.copy(context.creaturePosition);

    minnowSchools.forEach((school) => {
      if (time >= school.nextTurnAt && !school.disbanded) {
        const angle = (rand() - .5) * 1.2;
        school.direction.applyAxisAngle(new THREE.Vector3(0, 1, 0), angle).normalize();
        school.nextTurnAt = time + 4 + rand() * 8;
      }
      if (!school.disbanded) {
        school.center.addScaledVector(school.direction, FISH_PRESETS.minnow.normalSpeed * dt * .55);
        const schoolLakeDistance = Math.hypot(school.center.x / 1.04, school.center.z);
        const schoolLimit = FISH_WORLD_RADIUS - 8;
        if (schoolLakeDistance > schoolLimit) {
          const edgeScale = schoolLimit / schoolLakeDistance;
          school.center.x *= edgeScale;
          school.center.z *= edgeScale;
          // Turn the whole school back into the basin instead of allowing its
          // invisible center to drift beyond the clamp and pin members there.
          school.direction.x -= school.center.x * .045;
          school.direction.z -= school.center.z * .045;
          school.direction.normalize();
        }
        const centerFloor = terrainHeight(school.center.x, school.center.z) + 2.2;
        school.center.y = THREE.MathUtils.clamp(school.center.y + Math.sin(time * .24 + school.memberIndices.length) * dt * .08, centerFloor, FISH_SURFACE_CEILING);
      }
    });

    const schoolThreats = new Set<number>();
    debug.nearestPlayerDistance = Infinity;
    debug.forwardCandidateCount = 0;
    debug.fleeingCount = 0;
    debug.longestFleeRemaining = 0;
    debug.maxTurnCurl = 0;
    debug.maxVerticalBend = 0;
    debug.maxBurstBlend = 0;
    for (const entity of entities) {
      const threat = threatDirection(entity, time, context);
      if (threat) {
        entity.fleeUntil = Math.max(entity.fleeUntil, time + FISH_FLEE_RELEASE_SECONDS);
        entity.fleeDirection.copy(threat).normalize();
        entity.desired.copy(entity.fleeDirection);
        if (entity.schoolIndex !== null) schoolThreats.add(entity.schoolIndex);
      }
    }
    for (const schoolIndex of schoolThreats) {
      const school = minnowSchools[schoolIndex];
      school.disbanded = true;
      school.regroupDecisionMade = false;
      school.regroupAt = 0;
    }

    minnowSchools.forEach((school) => {
      if (!school.disbanded || school.permanentlyScattered || schoolThreats.has(minnowSchools.indexOf(school))) return;
      const anyFleeing = school.memberIndices.some((index) => entities[index].fleeUntil > time);
      if (anyFleeing) return;
      if (!school.regroupDecisionMade) {
        school.regroupDecisionMade = true;
        school.willRegroup = rand() < MINNOW_REGROUP_CHANCE;
        school.regroupAt = time + MINNOW_REGROUP_DELAY_SECONDS;
        if (!school.willRegroup) school.permanentlyScattered = true;
      } else if (school.willRegroup && time >= school.regroupAt) {
        school.center.set(0, 0, 0);
        school.memberIndices.forEach((index) => school.center.add(entities[index].position));
        school.center.multiplyScalar(1 / school.memberIndices.length);
        school.disbanded = false;
        school.regroupDecisionMade = false;
      }
    });

    for (const entity of entities) {
      const fleeing = entity.fleeUntil > time;
      entity.fleeBlend = THREE.MathUtils.lerp(
        entity.fleeBlend,
        fleeing ? 1 : 0,
        1 - Math.exp(-dt * (fleeing ? 8.5 : 2.6)),
      );
      if (fleeing) {
        debug.fleeingCount += 1;
        debug.longestFleeRemaining = Math.max(debug.longestFleeRemaining, entity.fleeUntil - time);
      }
      if (fleeing) {
        // Commit to the last actual threat vector for the whole escape window.
        // Obstacle steering may bend this path, but school/wander steering
        // cannot turn a frightened fish back toward what scared it.
        entity.desired.copy(entity.fleeDirection);
      } else {
        const school = entity.schoolIndex !== null ? minnowSchools[entity.schoolIndex] : null;
        if (school && !school.disbanded && !school.permanentlyScattered) {
          entity.desired.copy(school.direction);
          entity.desired.addScaledVector(temp.subVectors(school.center, entity.position), .18);
          entity.desired.x += Math.sin(time * .71 + entity.phase) * .13;
          entity.desired.y += Math.sin(time * .93 + entity.phase * 1.7) * .09;
          entity.desired.z += Math.cos(time * .67 + entity.phase) * .13;
          for (const otherIndex of school.memberIndices) {
            const other = entities[otherIndex];
            if (other === entity) continue;
            temp.subVectors(entity.position, other.position);
            const separation = temp.length();
            if (separation > .001 && separation < entity.preset.length * entity.scale * 2.2) {
              entity.desired.addScaledVector(temp.normalize(), .24);
            }
          }
        } else {
          if (time >= entity.nextWanderAt || entity.position.distanceToSquared(entity.wanderTarget) < 1) setIndependentTarget(entity, time);
          entity.desired.subVectors(entity.wanderTarget, entity.position).normalize();
        }
      }

      obstacleSteering(entity, entity.desired);
      if (entity.desired.lengthSq() < .001) entity.desired.copy(entity.velocity).normalize();
      entity.desired.normalize();
      const fullFleeSpeed = Math.max(
        entity.preset.normalSpeed * FISH_FLEE_SPEED_MULTIPLIER,
        FISH_FLEE_MIN_SPEED,
      );
      const speed = THREE.MathUtils.lerp(entity.preset.normalSpeed, fullFleeSpeed, entity.fleeBlend);
      entity.desired.multiplyScalar(speed);
      entity.velocity.lerp(entity.desired, 1 - Math.exp(-dt * THREE.MathUtils.lerp(2.2, 7.5, entity.fleeBlend)));
      candidate.copy(entity.position).addScaledVector(entity.velocity, dt);
      const floor = terrainHeight(candidate.x, candidate.z) + FISH_FLOOR_CLEARANCE + entity.preset.length * entity.preset.depth * entity.scale * .55;
      candidate.y = THREE.MathUtils.clamp(candidate.y, floor, FISH_SURFACE_CEILING);
      const playerDistance = candidate.distanceTo(context.playerPosition);
      if (playerDistance < FISH_PLAYER_HARD_CLEARANCE) {
        awayPlayer.subVectors(candidate, context.playerPosition);
        if (awayPlayer.lengthSq() < .001) awayPlayer.set(1, 0, 0);
        candidate.copy(context.playerPosition).addScaledVector(awayPlayer.normalize(), FISH_PLAYER_HARD_CLEARANCE);
      }
      const normalizedX = candidate.x / 1.04;
      const lakeDistance = Math.hypot(normalizedX, candidate.z);
      if (lakeDistance > FISH_WORLD_RADIUS) {
        const clampScale = FISH_WORLD_RADIUS / lakeDistance;
        candidate.x *= clampScale;
        candidate.z *= clampScale;
      }
      if (entity.species === "coelacanth") {
        const dx = candidate.x - COELACANTH_DEEP_CENTER.x;
        const dz = candidate.z - COELACANTH_DEEP_CENTER.y;
        const distance = Math.hypot(dx, dz);
        if (distance > COELACANTH_DEEP_RADIUS) {
          candidate.x = COELACANTH_DEEP_CENTER.x + dx / distance * COELACANTH_DEEP_RADIUS;
          candidate.z = COELACANTH_DEEP_CENTER.y + dz / distance * COELACANTH_DEEP_RADIUS;
        }
        candidate.y = Math.min(candidate.y, COELACANTH_MAX_Y);
      }
      entity.position.copy(candidate);

      playerToFish.subVectors(entity.position, context.playerPosition);
      const playerDistanceAfterMove = playerToFish.length();
      if (playerDistanceAfterMove < debug.nearestPlayerDistance) {
        debug.nearestPlayerDistance = playerDistanceAfterMove;
        debug.nearestSpecies = entity.species;
        debug.nearestPosition.copy(entity.position);
      }
      if (playerDistanceAfterMove < 12 && playerToFish.normalize().dot(context.floodlightDirection) > .72) {
        debug.forwardCandidateCount += 1;
      }

      const mesh = meshes.get(entity.species);
      if (!mesh) continue;
      const speedRatio = entity.velocity.length() / Math.max(.001, entity.preset.normalSpeed);
      const fleeTailRate = THREE.MathUtils.clamp(speedRatio * .42, 3.05, 7.2);
      entity.motionPhase = (entity.motionPhase
        + dt * entity.preset.animationSpeed * THREE.MathUtils.lerp(.9, fleeTailRate, entity.fleeBlend)) % (Math.PI * 2);
      const targetMotionAmount = THREE.MathUtils.clamp(.72 + (speedRatio - .65) * .18 + entity.fleeBlend * .42, .58, 1.58);
      entity.motionAmount = THREE.MathUtils.lerp(
        entity.motionAmount,
        targetMotionAmount,
        1 - Math.exp(-dt * (entity.fleeBlend > .08 ? 8 : 3.4)),
      );

      targetFishDirection.copy(entity.velocity);
      if (targetFishDirection.lengthSq() < .000001) targetFishDirection.copy(fishForward).applyQuaternion(entity.orientation);
      else targetFishDirection.normalize();
      currentFishForward.copy(fishForward).applyQuaternion(entity.orientation).normalize();
      const signedTurn = currentFishForward.z * targetFishDirection.x - currentFishForward.x * targetFishDirection.z;
      const verticalSteer = targetFishDirection.y - currentFishForward.y;
      targetQuaternion.setFromUnitVectors(fishForward, targetFishDirection);
      entity.orientation.slerp(targetQuaternion, 1 - Math.exp(-dt * THREE.MathUtils.lerp(4.2, 8.8, entity.fleeBlend)));
      entity.bank = THREE.MathUtils.lerp(
        entity.bank,
        THREE.MathUtils.clamp(-signedTurn * .62, -.34, .34),
        1 - Math.exp(-dt * 6.2),
      );
      entity.turnCurl = THREE.MathUtils.lerp(
        entity.turnCurl,
        THREE.MathUtils.clamp(-signedTurn * 1.35, -1, 1),
        1 - Math.exp(-dt * (entity.fleeBlend > .08 ? 9.2 : 5.6)),
      );
      entity.verticalBend = THREE.MathUtils.lerp(
        entity.verticalBend,
        THREE.MathUtils.clamp(-verticalSteer * 2.4, -1, 1),
        1 - Math.exp(-dt * 4.8),
      );
      debug.maxTurnCurl = Math.max(debug.maxTurnCurl, Math.abs(entity.turnCurl));
      debug.maxVerticalBend = Math.max(debug.maxVerticalBend, Math.abs(entity.verticalBend));
      debug.maxBurstBlend = Math.max(debug.maxBurstBlend, entity.fleeBlend);
      bankQuaternion.setFromAxisAngle(fishForward, entity.bank);
      quaternion.copy(entity.orientation).multiply(bankQuaternion);
      scaleVector.setScalar(entity.scale);
      matrix.compose(entity.position, quaternion, scaleVector);
      mesh.setMatrixAt(entity.instanceIndex, matrix);
      const phaseAttribute = mesh.geometry.getAttribute("fishMotionPhase") as THREE.InstancedBufferAttribute;
      const amountAttribute = mesh.geometry.getAttribute("fishMotionAmount") as THREE.InstancedBufferAttribute;
      const turnAttribute = mesh.geometry.getAttribute("fishTurn") as THREE.InstancedBufferAttribute;
      const verticalAttribute = mesh.geometry.getAttribute("fishVertical") as THREE.InstancedBufferAttribute;
      const burstAttribute = mesh.geometry.getAttribute("fishBurst") as THREE.InstancedBufferAttribute;
      phaseAttribute.setX(entity.instanceIndex, entity.motionPhase);
      amountAttribute.setX(entity.instanceIndex, entity.motionAmount);
      turnAttribute.setX(entity.instanceIndex, entity.turnCurl);
      verticalAttribute.setX(entity.instanceIndex, entity.verticalBend);
      burstAttribute.setX(entity.instanceIndex, entity.fleeBlend);
    }

    for (const mesh of meshes.values()) {
      mesh.instanceMatrix.needsUpdate = true;
      (mesh.geometry.getAttribute("fishMotionPhase") as THREE.InstancedBufferAttribute).needsUpdate = true;
      (mesh.geometry.getAttribute("fishMotionAmount") as THREE.InstancedBufferAttribute).needsUpdate = true;
      (mesh.geometry.getAttribute("fishTurn") as THREE.InstancedBufferAttribute).needsUpdate = true;
      (mesh.geometry.getAttribute("fishVertical") as THREE.InstancedBufferAttribute).needsUpdate = true;
      (mesh.geometry.getAttribute("fishBurst") as THREE.InstancedBufferAttribute).needsUpdate = true;
    }

    const coelRoot = group.getObjectByName("coelacanth-lobed-fin-rig") as THREE.Group | undefined;
    if (coelRoot && coelacanth) {
      coelRoot.position.copy(coelacanth.position);
      coelRoot.quaternion.copy(coelacanth.orientation);
      bankQuaternion.setFromAxisAngle(fishForward, coelacanth.bank);
      coelRoot.quaternion.multiply(bankQuaternion);
      coelRoot.scale.setScalar(coelacanth.scale);
      coelacanthFins.forEach((fin, index) => {
        const steeringOffset = (index % 2 === 0 ? -1 : 1) * coelacanth.bank * .42;
        const pitchOffset = coelacanth.verticalBend * (index < 2 ? -.24 : -.15);
        fin.rotation.x = Math.sin(coelacanth.motionPhase * .72 + index * Math.PI / 2)
          * (.24 + coelacanth.motionAmount * .19 + coelacanth.fleeBlend * .08)
          + steeringOffset + pitchOffset;
        fin.rotation.z = (index % 2 === 0 ? -1 : 1) * coelacanth.turnCurl * .11;
      });
      const body = meshes.get("coelacanth");
      if (body) {
        body.setMatrixAt(0, new THREE.Matrix4());
        body.instanceMatrix.needsUpdate = true;
      }
    }
  };

  const dispose = () => {
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
    const coelRoot = group.getObjectByName("coelacanth-lobed-fin-rig") as THREE.Group | undefined;
    const finMaterial = coelRoot?.userData.finMaterial;
    if (finMaterial instanceof THREE.Material) finMaterial.dispose();
    textures.forEach((texture) => texture.dispose());
  };

  return { group, update, dispose, debug, stats };
}
