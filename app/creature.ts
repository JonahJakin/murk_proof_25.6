import * as THREE from "three";

export interface CreatureRig {
  /** Root object. Move and rotate this exactly as the original creature group. */
  group: THREE.Group;
  /** Head transform, exposed for central sight confirmation. */
  head: THREE.Object3D;
  /** Shared material, exposed for silhouette-pass lighting. */
  material: THREE.MeshStandardMaterial;
  /** Animate the articulated rig with elapsed time and an optional escape pose. */
  update: (seconds: number, evasion?: CreatureEvasionPose, motion?: CreatureMotionPose) => void;
}

export type CreatureEvasionVariant = "c-turn" | "roll-dive" | "about-face";
export type CreatureBehavior = "present" | "investigating" | "committed";

export interface CreatureEvasionPose {
  variant: CreatureEvasionVariant;
  progress: number;
  handedness: -1 | 1;
  verticalDirection: -1 | 1;
}

export interface CreatureMotionPose {
  /** Measured world-space speed in metres per second. */
  speed: number;
  /** Signed horizontal steering input, from -1 (left) to 1 (right). */
  turn: number;
  /** Signed vertical steering input, from -1 (down) to 1 (up). */
  vertical: number;
  /** High-level AI state used only to alter body language, not decisions. */
  behavior?: CreatureBehavior;
  /** Signed local-space bearing to the current point of interest. */
  focusYaw?: number;
  /** Signed local-space elevation to the current point of interest. */
  focusPitch?: number;
  /** Zero far from the cave, rising to one through the final braking run. */
  caveApproach?: number;
  /** Strength of the authored cave-floor pose, from swimming to fully settled. */
  cavePose?: number;
  resting?: boolean;
  /** Zero-to-one transition out of the cave-rest pose; one is inactive. */
  wakeProgress?: number;
  /** Zero-to-one push-off from the cave into an ordinary cruise. */
  departureProgress?: number;
  /** Normalized progress through the currently playing creature call. */
  vocalizationProgress?: number;
  /** True while navigation is steering through a stuck-route recovery. */
  recovering?: boolean;
  /** Zero-to-one counter-bank after an evasion; one is inactive. */
  evasionRecoveryProgress?: number;
  /** Side of the completed evasion, retained for the counter-bank. */
  evasionRecoverySide?: -1 | 1;
  attackProgress?: number;
}

const BODY = {
  girth: 1.03,
  dorsal: 0.51,
};

const TAIL = {
  count: 10,
  len: 0.47,
  taper: 0.74,
  flat: 0,
  sway: 0.07,
};

const NECK_COUNT = 16;
const CREATURE_REFERENCE_SWIM_SPEED = 7.8;

interface LoftStation {
  z: number;
  width: number;
  height: number;
  centerY?: number;
}

/**
 * Builds a smooth elliptical loft while keeping the model code-native. The
 * longitudinal UV axis follows the creature rather than restarting on every
 * overlapping sphere, which keeps the broad hide bands coherent.
 */
function createLoftGeometry(
  stations: LoftStation[],
  radialSegments = 18,
  uStart = 0,
  uEnd = 1,
) {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const ringSize = radialSegments + 1;
  const distances = [0];
  for (let index = 1; index < stations.length; index++) {
    distances.push(distances[index - 1] + Math.abs(stations[index].z - stations[index - 1].z));
  }
  const totalDistance = Math.max(.001, distances[distances.length - 1]);

  stations.forEach((station, stationIndex) => {
    const longitudinal = distances[stationIndex] / totalDistance;
    for (let segment = 0; segment <= radialSegments; segment++) {
      const around = segment / radialSegments;
      const angle = around * Math.PI * 2;
      positions.push(
        Math.cos(angle) * station.width,
        (station.centerY ?? 0) + Math.sin(angle) * station.height,
        station.z,
      );
      uvs.push(THREE.MathUtils.lerp(uStart, uEnd, longitudinal), around);
    }
  });

  const increasingZ = stations[stations.length - 1].z >= stations[0].z;
  for (let station = 0; station < stations.length - 1; station++) {
    for (let segment = 0; segment < radialSegments; segment++) {
      const a = station * ringSize + segment;
      const b = (station + 1) * ringSize + segment;
      const c = station * ringSize + segment + 1;
      const d = (station + 1) * ringSize + segment + 1;
      if (increasingZ) indices.push(a, c, b, c, d, b);
      else indices.push(a, b, c, c, b, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function createJointSegmentGeometry(
  length: number,
  startWidth: number,
  endWidth: number,
  startHeight: number,
  endHeight: number,
  direction: -1 | 1,
  uStart: number,
  uEnd: number,
  radialSegments = 14,
) {
  // The meshes overlap beyond both joint pivots, but their cross-sections do
  // not bulge at every control. That distinction matters: overlapping tapered
  // sleeves bend as one neck/tail, while repeated local maxima read as beads.
  return createLoftGeometry([
    { z: direction * -.28, width: startWidth * 1.015, height: startHeight * 1.015 },
    { z: direction * .12, width: THREE.MathUtils.lerp(startWidth, endWidth, .16), height: THREE.MathUtils.lerp(startHeight, endHeight, .16) },
    { z: direction * (length * .54), width: THREE.MathUtils.lerp(startWidth, endWidth, .48), height: THREE.MathUtils.lerp(startHeight, endHeight, .48) },
    { z: direction * length, width: endWidth * .99, height: endHeight * .99 },
    { z: direction * (length + .24), width: endWidth * .975, height: endHeight * .975 },
  ], radialSegments, uStart, uEnd);
}

function createPaddleSectionGeometry(
  length: number,
  startWidth: number,
  endWidth: number,
  startThickness: number,
  endThickness: number,
  side: number,
) {
  const geometry = createLoftGeometry([
    { z: -.24, width: startWidth * .9, height: startThickness * .94 },
    { z: 0, width: startWidth, height: startThickness },
    { z: length * .58, width: THREE.MathUtils.lerp(startWidth, endWidth, .55), height: THREE.MathUtils.lerp(startThickness, endThickness, .55) },
    { z: length, width: endWidth, height: endThickness },
    { z: length + .16, width: endWidth * .34, height: endThickness * .46 },
  ], 18);
  geometry.rotateY(side > 0 ? Math.PI / 2 : -Math.PI / 2);
  return geometry;
}

export function createCreature(
  sharedMaterial?: THREE.MeshStandardMaterial,
): CreatureRig {
  let skinTexture: THREE.Texture | undefined;
  if (typeof document !== "undefined") {
    skinTexture = new THREE.TextureLoader().load(
      new URL("textures/creature/plesiosaur-hide.png", document.baseURI).toString(),
    );
    skinTexture.name = "supplied-plesiosaur-hide-broad-bands";
    skinTexture.wrapS = skinTexture.wrapT = THREE.RepeatWrapping;
    // Preserve the supplied pattern's wide bands while the remodeled geometry
    // gives them one continuous longitudinal UV direction.
    skinTexture.repeat.set(.72, .9);
    skinTexture.colorSpace = THREE.SRGBColorSpace;
    skinTexture.anisotropy = 4;
  }
  const material = sharedMaterial ?? new THREE.MeshStandardMaterial({
    color: 0x9aa692,
    map: skinTexture,
    // Using the blurry color bands as bump made the hide look like carved
    // grooves under the floodlight. Let the geometry and normals carry volume.
    roughness: .91,
    metalness: 0,
    flatShading: false,
  });

  const blob = (
    radius: number,
    scaleX: number,
    scaleY: number,
    scaleZ: number,
    widthSegments = 18,
    heightSegments = 11,
  ) => {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(radius, widthSegments, heightSegments),
      material,
    );
    mesh.scale.set(scaleX, scaleY, scaleZ);
    return mesh;
  };

  const group = new THREE.Group();
  group.scale.setScalar(0.92);
  const swimRoot = new THREE.Group();
  group.add(swimRoot);

  // A single loft replaces the four intersecting low-poly blobs. Invisible
  // shoulder/hip/dorsal controls remain so the established animation code and
  // blend vocabulary do not need to be rewritten.
  const girth = BODY.girth;
  const coreBody = new THREE.Mesh(createLoftGeometry([
    { z: -3.78, width: .7, height: .64, centerY: .28 },
    { z: -3.42, width: 1.22, height: .98, centerY: .2 },
    { z: -2.82, width: 1.6, height: girth * 1.16, centerY: .12 },
    { z: -1.92, width: 1.76, height: girth * 1.28, centerY: .06 },
    { z: -.78, width: 1.84, height: girth * 1.32, centerY: .05 },
    { z: .55, width: 1.8, height: girth * 1.29, centerY: .03 },
    { z: 1.72, width: 1.67, height: girth * 1.18 },
    { z: 2.65, width: 1.47, height: girth * 1.02, centerY: -.02 },
    { z: 3.35, width: 1.13, height: girth * .82, centerY: -.035 },
    { z: 3.78, width: .8, height: girth * .63, centerY: -.04 },
  ], 30), material);
  swimRoot.add(coreBody);

  const shoulder = new THREE.Object3D();
  shoulder.position.set(0, 0.16, -2.85);
  swimRoot.add(shoulder);

  const hip = new THREE.Object3D();
  hip.position.set(0, -0.02, 3.05);
  swimRoot.add(hip);

  const dorsal = new THREE.Object3D();
  dorsal.position.set(0, BODY.dorsal, 0.05);
  swimRoot.add(dorsal);

  // Every neck joint is parented to the previous joint, so the overlapping
  // masses remain connected while the travelling wave moves through them.
  const neckJoints: THREE.Object3D[] = [];
  const neckBase = new THREE.Object3D();
  neckBase.position.set(0, 0.55, -3);
  neckBase.rotation.x = -0.3;
  swimRoot.add(neckBase);

  let parent: THREE.Object3D = neckBase;
  for (let index = 0; index < NECK_COUNT; index++) {
    const progress = index / (NECK_COUNT - 1);
    const joint = new THREE.Object3D();
    joint.position.set(0, 0, -0.5);
    joint.rotation.x = 0.052;
    parent.add(joint);
    const nextProgress = Math.min(1, (index + 1) / (NECK_COUNT - 1));
    const startWidth = THREE.MathUtils.lerp(.71, .37, progress);
    const endWidth = THREE.MathUtils.lerp(.71, .37, nextProgress);
    const neckSegment = new THREE.Mesh(createJointSegmentGeometry(
      .55,
      startWidth,
      endWidth,
      startWidth * .82,
      endWidth * .82,
      -1,
      progress,
      nextProgress,
      16,
    ), material);
    joint.add(neckSegment);
    neckJoints.push(joint);
    parent = joint;
  }

  // The compact head is one continuous loft rather than two faceted spheres.
  const head = new THREE.Object3D();
  head.position.set(0, 0, -0.42);
  parent.add(head);
  const skull = new THREE.Mesh(createLoftGeometry([
    { z: .32, width: .34, height: .3, centerY: .015 },
    { z: .08, width: .52, height: .43, centerY: .035 },
    { z: -.36, width: .64, height: .47, centerY: .04 },
    { z: -.78, width: .56, height: .39, centerY: .025 },
    { z: -1.18, width: .43, height: .3 },
    { z: -1.48, width: .3, height: .22, centerY: -.015 },
  ], 20), material);
  head.add(skull);

  // The supplied head previously had no articulating mouth at all. A dark,
  // flattened interior remains a near-invisible seam when closed, while the
  // skin-covered lower jaw pivots from the rear of the snout during calls.
  const mouthMaterial = new THREE.MeshStandardMaterial({
    color: 0x0e100c,
    roughness: 1,
    metalness: 0,
    flatShading: false,
  });
  const mouthInterior = new THREE.Mesh(
    new THREE.SphereGeometry(1, 18, 10),
    mouthMaterial,
  );
  mouthInterior.position.set(0, -.2, -.98);
  mouthInterior.scale.set(.39, .042, .72);
  head.add(mouthInterior);

  const jawPivot = new THREE.Object3D();
  jawPivot.position.set(0, -.135, -.48);
  head.add(jawPivot);
  const lowerJaw = new THREE.Mesh(createLoftGeometry([
    { z: .1, width: .28, height: .105, centerY: -.04 },
    { z: -.25, width: .36, height: .13, centerY: -.045 },
    { z: -.7, width: .34, height: .12, centerY: -.05 },
    { z: -1.05, width: .24, height: .085, centerY: -.055 },
  ], 16), material);
  jawPivot.add(lowerJaw);

  const toothMaterial = new THREE.MeshStandardMaterial({
    color: 0xd8d3b4,
    emissive: 0x4a493e,
    emissiveIntensity: .32,
    roughness: .76,
    metalness: 0,
    flatShading: false,
  });
  const toothGeometry = new THREE.ConeGeometry(1, 1, 8, 1);
  const upperTeeth = new THREE.Group();
  const lowerTeeth = new THREE.Group();
  head.add(upperTeeth);
  jawPivot.add(lowerTeeth);
  for (const side of [-1, 1] as const) {
    for (let index = 0; index < 7; index++) {
      const progress = index / 6;
      const height = .17 + ((index * 5 + (side > 0 ? 2 : 0)) % 4) * .014;
      const radius = .042 + ((index + (side > 0 ? 1 : 0)) % 3) * .006;
      const upper = new THREE.Mesh(toothGeometry, toothMaterial);
      upper.scale.set(radius, height, radius);
      upper.position.set(
        side * THREE.MathUtils.lerp(.31, .17, progress),
        -.205,
        THREE.MathUtils.lerp(-.62, -1.37, progress),
      );
      upper.rotation.z = Math.PI + side * .075;
      upper.rotation.x = side * .035 + (progress - .5) * .06;
      upperTeeth.add(upper);

      const lower = new THREE.Mesh(toothGeometry, toothMaterial);
      lower.scale.set(radius * .94, height * .91, radius * .94);
      lower.position.set(
        side * THREE.MathUtils.lerp(.29, .155, progress),
        .075,
        THREE.MathUtils.lerp(-.2, -.98, progress),
      );
      lower.rotation.z = side * -.06;
      lower.rotation.x = side * -.03 - (progress - .5) * .055;
      lowerTeeth.add(lower);
    }
  }
  // Four small front teeth complete each arc so the rows do not disappear
  // when the animal vocalizes directly toward the camera.
  for (let index = 0; index < 4; index++) {
    const across = THREE.MathUtils.lerp(-.18, .18, index / 3);
    const height = .17 + (index % 2) * .018;
    const upper = new THREE.Mesh(toothGeometry, toothMaterial);
    upper.scale.set(.046, height, .046);
    upper.position.set(across, -.205, -1.4 + Math.abs(across) * .08);
    upper.rotation.z = Math.PI - across * .18;
    upperTeeth.add(upper);
    const lower = new THREE.Mesh(toothGeometry, toothMaterial);
    lower.scale.set(.043, height * .9, .043);
    lower.position.set(across * .9, .075, -1.01 + Math.abs(across) * .08);
    lower.rotation.z = across * .16;
    lowerTeeth.add(lower);
  }
  upperTeeth.visible = false;
  lowerTeeth.visible = false;

  // Tail spacing shrinks with its mass, avoiding gaps toward the tip.
  const tailJoints: THREE.Object3D[] = [];
  const tailBase = new THREE.Object3D();
  tailBase.position.set(0, -0.05, 3.25);
  tailBase.rotation.x = 0.04;
  swimRoot.add(tailBase);

  parent = tailBase;
  for (let index = 0; index < TAIL.count; index++) {
    const progress = index / (TAIL.count - 1);
    const joint = new THREE.Object3D();
    joint.position.set(0, 0, TAIL.len * (1 - progress * 0.38));
    joint.rotation.x = -0.03;
    parent.add(joint);
    const nextProgress = Math.min(1, (index + 1) / (TAIL.count - 1));
    const startWidth = THREE.MathUtils.lerp(.82, .11, Math.pow(progress, 1.28));
    const endWidth = THREE.MathUtils.lerp(.82, .11, Math.pow(nextProgress, 1.28));
    const segmentLength = TAIL.len * (1 - progress * .38) + .08;
    const tailSegment = new THREE.Mesh(createJointSegmentGeometry(
      segmentLength,
      startWidth,
      endWidth,
      startWidth * .76,
      endWidth * .76,
      1,
      progress,
      nextProgress,
      16,
    ), material);
    joint.add(tailSegment);
    tailJoints.push(joint);
    parent = joint;
  }

  interface Flipper {
    chain: THREE.Object3D[];
    side: number;
    index: number;
  }

  const flippers: Flipper[] = [];
  const paddleLength = [1.04, 1.04, .86];
  const paddleStartWidth = [.88, .75, .55];
  const paddleEndWidth = [.75, .55, .16];
  const paddleStartThickness = [.29, .22, .155];
  const paddleEndThickness = [.22, .155, .08];

  ([
    [-1, -1.7],
    [1, -1.7],
    [-1, 1.5],
    [1, 1.5],
  ] as const).forEach(([side, z], flipperIndex) => {
    const root = new THREE.Object3D();
    root.position.set(side * 1.3, -0.42, z);
    root.rotation.y = side * (z < 0 ? 0.2 : -0.26);
    swimRoot.add(root);

    const bulge = blob(1, .76, .48, .88, 20, 12);
    bulge.position.set(side * .08, .02, 0);
    root.add(bulge);

    const chain: THREE.Object3D[] = [];
    let flipperParent: THREE.Object3D = root;
    for (let index = 0; index < 3; index++) {
      const joint = new THREE.Object3D();
      joint.position.set(side * (index === 0 ? 0.95 : 1), 0, 0);
      joint.rotation.y = side * 0.085;
      joint.rotation.x = 0.07;
      flipperParent.add(joint);
      const paddleSection = new THREE.Mesh(createPaddleSectionGeometry(
        paddleLength[index],
        paddleStartWidth[index],
        paddleEndWidth[index],
        paddleStartThickness[index],
        paddleEndThickness[index],
        side,
      ), material);
      joint.add(paddleSection);
      chain.push(joint);
      flipperParent = joint;
    }
    flippers.push({ chain, side, index: flipperIndex });
  });

  let lastUpdateSeconds = 0;
  let swimPhase = 0;
  let smoothedMotion = 1;
  let smoothedInvestigating = 0;
  let smoothedCommitted = 0;
  let smoothedResting = 0;
  let smoothedRecovery = 0;
  let smoothedFocusYaw = 0;
  let smoothedFocusPitch = 0;
  const update = (seconds: number, evasion?: CreatureEvasionPose, motion?: CreatureMotionPose) => {
    const animationDt = lastUpdateSeconds > 0
      ? THREE.MathUtils.clamp(seconds - lastUpdateSeconds, 0, .05)
      : 0;
    lastUpdateSeconds = seconds;
    const requestedSpeed = motion?.resting ? 0 : motion?.speed ?? CREATURE_REFERENCE_SWIM_SPEED;
    const speed01 = THREE.MathUtils.clamp(requestedSpeed / CREATURE_REFERENCE_SWIM_SPEED, 0, 1.8);
    smoothedMotion = THREE.MathUtils.lerp(
      smoothedMotion,
      speed01,
      1 - Math.exp(-animationDt * (speed01 > smoothedMotion ? 5.8 : 2.5)),
    );
    const behavior = motion?.behavior ?? "present";
    const stateBlendRate = 1 - Math.exp(-animationDt * 2.35);
    smoothedInvestigating = THREE.MathUtils.lerp(
      smoothedInvestigating,
      behavior === "investigating" ? 1 : 0,
      stateBlendRate,
    );
    smoothedCommitted = THREE.MathUtils.lerp(
      smoothedCommitted,
      behavior === "committed" ? 1 : 0,
      stateBlendRate,
    );
    smoothedResting = THREE.MathUtils.lerp(
      smoothedResting,
      motion?.resting ? 1 : 0,
      1 - Math.exp(-animationDt * (motion?.resting ? 1.35 : 3.4)),
    );
    smoothedRecovery = THREE.MathUtils.lerp(
      smoothedRecovery,
      motion?.recovering ? 1 : 0,
      1 - Math.exp(-animationDt * (motion?.recovering ? 4.8 : 2.8)),
    );
    smoothedFocusYaw = THREE.MathUtils.lerp(
      smoothedFocusYaw,
      THREE.MathUtils.clamp(motion?.focusYaw ?? 0, -.72, .72),
      1 - Math.exp(-animationDt * (behavior === "committed" ? 5.2 : 2.8)),
    );
    smoothedFocusPitch = THREE.MathUtils.lerp(
      smoothedFocusPitch,
      THREE.MathUtils.clamp(motion?.focusPitch ?? 0, -.38, .38),
      1 - Math.exp(-animationDt * 2.6),
    );
    const swimCadence = THREE.MathUtils.lerp(.18, 1.48, THREE.MathUtils.clamp(smoothedMotion, 0, 1));
    swimPhase = (swimPhase + animationDt * swimCadence) % (Math.PI * 200);
    const swimTime = swimPhase;
    const motionAmount = THREE.MathUtils.lerp(.18, 1.15, THREE.MathUtils.clamp(smoothedMotion, 0, 1.25) / 1.25);
    const bodyWave = swimTime * .86;
    swimRoot.rotation.z = (Math.sin(bodyWave) * .105 + Math.sin(bodyWave * .43 + 1.1) * .035) * motionAmount
      + (motion?.turn ?? 0) * .18;
    swimRoot.rotation.y = Math.sin(bodyWave * .72 + .35) * .052 * motionAmount
      + (motion?.turn ?? 0) * .08;
    swimRoot.rotation.x = Math.sin(bodyWave * .51) * .024 * motionAmount
      - (motion?.vertical ?? 0) * .11;
    swimRoot.position.y = Math.sin(bodyWave * 1.16) * .055 * motionAmount;
    swimRoot.position.z = 0;
    coreBody.rotation.x = 0;
    coreBody.rotation.y = Math.sin(bodyWave - .25) * .034 * motionAmount;
    shoulder.rotation.y = Math.sin(bodyWave - .92) * .064 * motionAmount;
    shoulder.position.x = Math.sin(bodyWave - .92) * .07 * motionAmount;
    hip.rotation.y = Math.sin(bodyWave + .78) * -.072 * motionAmount;
    hip.position.x = Math.sin(bodyWave + .78) * -.075 * motionAmount;
    dorsal.rotation.z = Math.sin(bodyWave + .18) * .028 * motionAmount;

    for (let index = 0; index < neckJoints.length; index++) {
      const phase = swimTime * 1.18 - index * .37;
      neckJoints[index].rotation.y = Math.sin(phase) * (.034 + index * .0052) * motionAmount
        + (motion?.turn ?? 0) * (.006 + index * .0022);
      neckJoints[index].rotation.z = Math.sin(phase * .76 + .8) * (.008 + index * .0015) * motionAmount;
      neckJoints[index].rotation.x = .052 + Math.sin(phase * .72 + .6) * (.012 + index * .0005) * motionAmount
        - (motion?.vertical ?? 0) * (.004 + index * .0018);
    }

    for (let index = 0; index < tailJoints.length; index++) {
      const phase = swimTime * 1.22 - index * .44;
      tailJoints[index].rotation.y = Math.sin(phase)
        * (TAIL.sway * .92 + index * TAIL.sway * .27) * motionAmount;
      tailJoints[index].rotation.z = Math.sin(phase * .68 + .4) * (.009 + index * .0024) * motionAmount;
      tailJoints[index].rotation.x = -.03 + Math.sin(phase * .63) * .012 * motionAmount;
    }

    for (const flipper of flippers) {
      for (let index = 0; index < flipper.chain.length; index++) {
        const phase = swimTime * 1.58 + Math.floor(flipper.index / 2) * 1.05 + index * .38;
        flipper.chain[index].rotation.z = flipper.side
          * (-.13 + Math.sin(phase) * (.085 + index * .058) * motionAmount);
        flipper.chain[index].rotation.x = .1
          + Math.sin(phase - .72) * (.034 + index * .034) * motionAmount;
        flipper.chain[index].rotation.y = flipper.side
          * (.085 + Math.sin(phase - .34) * .018);
      }
    }

    head.position.z = -.42;
    head.rotation.y = Math.sin(swimTime * 1.13) * .07 * motionAmount + (motion?.turn ?? 0) * .12;
    head.rotation.x = Math.sin(swimTime * .73 + .4) * .026 * motionAmount - (motion?.vertical ?? 0) * .08;
    jawPivot.rotation.x = 0;
    mouthInterior.scale.y = .012;

    // Investigation is an alert, inquisitive swim: the head and last third
    // of the neck lead toward the diver while the body keeps following its
    // orbit. The restrained scan remains visible when the exact bearing is
    // nearly centred, without becoming a repetitive left-right metronome.
    const attentionBlend = Math.max(smoothedInvestigating, smoothedCommitted);
    const investigationScan = Math.sin(seconds * .47 + .6) * .12 * smoothedInvestigating;
    const focusYaw = smoothedFocusYaw * attentionBlend + investigationScan;
    const focusPitch = smoothedFocusPitch * attentionBlend;
    swimRoot.rotation.z += focusYaw * (.08 * smoothedInvestigating + .045 * smoothedCommitted);
    head.rotation.y += focusYaw * (.78 + smoothedCommitted * .18);
    head.rotation.x += focusPitch * (.7 + smoothedCommitted * .16);
    neckJoints.forEach((joint, index) => {
      const neckT = index / Math.max(1, neckJoints.length - 1);
      const attentionT = THREE.MathUtils.smoothstep(neckT, .28, 1);
      joint.rotation.y += focusYaw * attentionT * (.0048 + neckT * .0072);
      joint.rotation.x += focusPitch * attentionT * (.003 + neckT * .005);
    });

    if (smoothedInvestigating > .001) {
      // An investigating animal flies its front flippers a little wider and
      // uses tiny asymmetric corrections while it studies the orbit centre.
      for (const flipper of flippers) {
        const front = flipper.index < 2 ? 1 : .55;
        flipper.chain.forEach((joint, index) => {
          joint.rotation.z -= flipper.side * smoothedInvestigating * front * (.035 + index * .022);
          joint.rotation.x += focusYaw * flipper.side * smoothedInvestigating * front * (.025 + index * .012);
        });
      }
      shoulder.rotation.y += focusYaw * .11 * smoothedInvestigating;
    }

    if (smoothedCommitted > .001) {
      // Commitment removes the leisurely display posture: the torso levels,
      // neck straightens toward the target, and all four flippers tuck into a
      // narrower, faster-looking silhouette while the tail keeps propelling.
      swimRoot.rotation.z *= 1 - smoothedCommitted * .22;
      swimRoot.rotation.x -= smoothedCommitted * .025;
      shoulder.position.y = .16 - smoothedCommitted * .055;
      head.position.z -= smoothedCommitted * .075;
      neckJoints.forEach((joint, index) => {
        const neckT = index / Math.max(1, neckJoints.length - 1);
        joint.rotation.z *= 1 - smoothedCommitted * (.22 + neckT * .3);
        joint.rotation.x -= smoothedCommitted * (.0015 + neckT * .0025);
      });
      tailJoints.forEach((joint, index) => {
        joint.rotation.y *= 1 + smoothedCommitted * (.08 + index * .008);
      });
      for (const flipper of flippers) {
        flipper.chain.forEach((joint, index) => {
          joint.rotation.z += flipper.side * smoothedCommitted * (.07 + index * .055);
          joint.rotation.x -= smoothedCommitted * (.025 + index * .012);
        });
      }
    } else {
      shoulder.position.y = .16;
    }

    // Calls use a modest gape rather than a theatrical roar. The last half of
    // the neck lifts and straightens, the throat pulses once, and the front
    // paddles open slightly to brace the body while sound is being produced.
    const vocalizationProgress = THREE.MathUtils.clamp(motion?.vocalizationProgress ?? 0, 0, 1);
    upperTeeth.visible = vocalizationProgress > .015;
    lowerTeeth.visible = vocalizationProgress > .015;
    if (vocalizationProgress > 0) {
      const opening = THREE.MathUtils.smootherstep(vocalizationProgress, 0, .2);
      const closing = 1 - THREE.MathUtils.smootherstep(vocalizationProgress, .68, 1);
      const vocalEnvelope = opening * closing;
      const throatPulse = Math.sin(vocalizationProgress * Math.PI * 3) * vocalEnvelope;
      jawPivot.rotation.x = -vocalEnvelope * .46 - throatPulse * .014;
      mouthInterior.scale.y = .012 + vocalEnvelope * .17;
      head.rotation.x += vocalEnvelope * .105;
      head.rotation.y *= 1 - vocalEnvelope * .34;
      swimRoot.rotation.x -= vocalEnvelope * .022;
      swimRoot.position.y += throatPulse * .012;
      neckJoints.forEach((joint, index) => {
        const neckT = index / Math.max(1, neckJoints.length - 1);
        const throatT = THREE.MathUtils.smoothstep(neckT, .38, 1);
        joint.rotation.x += vocalEnvelope * throatT * .0065;
        joint.rotation.y *= 1 - vocalEnvelope * throatT * .28;
      });
      for (const flipper of flippers) {
        const front = flipper.index < 2 ? 1 : .32;
        flipper.chain.forEach((joint, index) => {
          joint.rotation.z -= flipper.side * vocalEnvelope * front * (.035 + index * .022);
        });
      }
    }

    // On the final cave approach the animal stops looking like a cruising rig:
    // the front paddles open to catch water, the tail quiets, and the neck leads
    // into the dark rather than continuing to wag at full amplitude.
    const caveApproach = THREE.MathUtils.clamp(motion?.caveApproach ?? 0, 0, 1);
    if (caveApproach > .001) {
      const brakingEnvelope = Math.sin(caveApproach * Math.PI);
      swimRoot.rotation.x += caveApproach * .035;
      swimRoot.rotation.z *= 1 - caveApproach * .34;
      head.rotation.x -= caveApproach * .055;
      neckJoints.forEach((joint, index) => {
        const neckT = index / Math.max(1, neckJoints.length - 1);
        joint.rotation.y *= 1 - caveApproach * (.18 + neckT * .32);
        joint.rotation.x -= caveApproach * neckT * .0018;
      });
      tailJoints.forEach((joint, index) => {
        const tailT = index / Math.max(1, tailJoints.length - 1);
        joint.rotation.y *= 1 - caveApproach * (.16 + tailT * .28);
      });
      for (const flipper of flippers) {
        const front = flipper.index < 2 ? 1 : .42;
        flipper.chain.forEach((joint, index) => {
          joint.rotation.z -= flipper.side * brakingEnvelope * front * (.105 + index * .07);
          joint.rotation.x += brakingEnvelope * front * (.025 + index * .015);
        });
      }
    }

    // The final settle, nap, and wake share exactly one end pose. This keeps
    // the animal from snapping when navigation hands control to the nap loop.
    // It lies slightly rolled with the neck curled toward one shoulder, the
    // tail counter-curled, and the paddles resting unevenly on the cave floor.
    const wakeProgress = THREE.MathUtils.clamp(motion?.wakeProgress ?? 1, 0, 1);
    const wakeRestCarry = wakeProgress < 1
      ? 1 - THREE.MathUtils.smootherstep(wakeProgress, .04, .82)
      : 0;
    const cavePose = THREE.MathUtils.clamp(motion?.cavePose ?? 0, 0, 1);
    const restPose = Math.max(smoothedResting, cavePose, wakeRestCarry);
    const wakeImpulse = wakeProgress < 1 ? Math.sin(wakeProgress * Math.PI) : 0;
    if (restPose > .001 || wakeImpulse > .001) {
      const napBreath = Math.sin(seconds * .36 + .7) * restPose;
      const napTwitch = Math.pow(Math.max(0, Math.sin(seconds * .173 + 2.1)), 18) * restPose;
      swimRoot.position.y -= restPose * .24;
      swimRoot.position.y += napBreath * .018;
      swimRoot.rotation.z -= restPose * .14;
      swimRoot.rotation.z += napBreath * .012;
      swimRoot.rotation.x += restPose * .035;
      coreBody.rotation.x = napBreath * .008;
      shoulder.position.y -= restPose * .035;
      head.rotation.x -= restPose * .31;
      head.rotation.y -= restPose * .23;
      head.rotation.y += napTwitch * .045;
      head.rotation.x += wakeImpulse * .13;
      neckJoints.forEach((joint, index) => {
        const neckT = index / Math.max(1, neckJoints.length - 1);
        const curl = Math.sin(neckT * Math.PI);
        joint.rotation.x -= restPose * (.006 + neckT * .011);
        joint.rotation.y -= restPose * curl * (.009 + neckT * .015);
        joint.rotation.z -= restPose * neckT * .0028;
        joint.rotation.x += wakeImpulse * (.003 + neckT * .006);
        joint.rotation.y += wakeImpulse * neckT * .007;
      });
      tailJoints.forEach((joint, index) => {
        const tailT = index / Math.max(1, tailJoints.length - 1);
        joint.rotation.y += restPose * (.012 + tailT * .026);
        joint.rotation.y += Math.sin(index * .43 + .4) * restPose * (.007 + tailT * .01);
        joint.rotation.x += restPose * tailT * .004;
      });
      for (const flipper of flippers) {
        const front = flipper.index < 2 ? 1 : .52;
        const uneven = flipper.side < 0 ? 1 : .72;
        flipper.chain.forEach((joint, index) => {
          joint.rotation.z -= flipper.side * restPose * front * uneven * (.075 + index * .047);
          joint.rotation.x += restPose * front * (flipper.side < 0 ? -.018 : .012) * (index + 1);
          joint.rotation.z += flipper.side * wakeImpulse * front * (.11 + index * .05);
          joint.rotation.x -= wakeImpulse * front * (.045 + index * .018);
        });
      }
    }

    // After the head-lift wake, a rear-paddle brace and travelling tail kick
    // bridge the floor pose into propulsion. This is deliberately not another
    // locomotion state: it decays into the ordinary speed-driven swim cycle.
    const departureProgress = motion?.departureProgress;
    if (typeof departureProgress === "number") {
      const progress = THREE.MathUtils.clamp(departureProgress, 0, 1);
      const push = Math.sin(THREE.MathUtils.smootherstep(progress, 0, .5) * Math.PI)
        * (1 - THREE.MathUtils.smootherstep(progress, .55, .9));
      const tailKick = Math.sin(progress * Math.PI * 2.35)
        * Math.sin(progress * Math.PI);
      swimRoot.position.z -= push * .16;
      swimRoot.rotation.x -= push * .045;
      head.rotation.x += push * .08;
      neckJoints.forEach((joint, index) => {
        const neckT = index / Math.max(1, neckJoints.length - 1);
        joint.rotation.x += push * neckT * .006;
        joint.rotation.y *= 1 - push * neckT * .22;
      });
      tailJoints.forEach((joint, index) => {
        const tailT = index / Math.max(1, tailJoints.length - 1);
        joint.rotation.y += tailKick * (.015 + tailT * .065);
      });
      for (const flipper of flippers) {
        const rear = flipper.index >= 2 ? 1 : .38;
        flipper.chain.forEach((joint, index) => {
          joint.rotation.z += flipper.side * push * rear * (.12 + index * .068);
          joint.rotation.x -= push * rear * (.035 + index * .018);
        });
      }
    }

    if (smoothedRecovery > .001 && !evasion) {
      // Route recovery needs readable effort rather than a creature sliding
      // sideways: bank, fold the inside neck, and paddle asymmetrically until
      // the navigation system has acquired its escape tangent.
      const recoverySide = Math.sign(motion?.turn || focusYaw || 1);
      const recoveryPulse = .72 + Math.sin(seconds * 4.1) * .28;
      swimRoot.rotation.z += recoverySide * smoothedRecovery * .28;
      head.rotation.y += recoverySide * smoothedRecovery * .19;
      neckJoints.forEach((joint, index) => {
        const neckT = index / Math.max(1, neckJoints.length - 1);
        joint.rotation.y += recoverySide * smoothedRecovery * neckT * .018;
      });
      for (const flipper of flippers) {
        const inside = flipper.side === recoverySide ? 1 : .35;
        flipper.chain.forEach((joint, index) => {
          joint.rotation.z += flipper.side * smoothedRecovery * inside * recoveryPulse * (.08 + index * .045);
        });
      }
    }

    const evasionRecoveryProgress = THREE.MathUtils.clamp(motion?.evasionRecoveryProgress ?? 1, 0, 1);
    if (evasionRecoveryProgress < 1 && !evasion) {
      // The route continues after the authored escape instead of snapping
      // immediately to a generic swim. A small counter-bank absorbs the turn
      // and the flippers reopen while forward propulsion remains continuous.
      const recoveryEnvelope = Math.sin(evasionRecoveryProgress * Math.PI);
      const recoverySide = motion?.evasionRecoverySide ?? 1;
      swimRoot.rotation.z -= recoverySide * recoveryEnvelope * .14;
      head.rotation.y -= recoverySide * recoveryEnvelope * .09;
      tailJoints.forEach((joint, index) => {
        const tailT = index / Math.max(1, tailJoints.length - 1);
        joint.rotation.y -= recoverySide * recoveryEnvelope * (.012 + tailT * .032);
      });
      for (const flipper of flippers) {
        flipper.chain.forEach((joint, index) => {
          joint.rotation.z -= flipper.side * recoveryEnvelope * (.035 + index * .025);
          joint.rotation.x += recoveryEnvelope * (.018 + index * .011);
        });
      }
    }

    const attackProgress = THREE.MathUtils.clamp(motion?.attackProgress ?? 0, 0, 1);
    if (attackProgress > 0) {
      const anticipation = THREE.MathUtils.smootherstep(attackProgress, 0, .2)
        * (1 - THREE.MathUtils.smootherstep(attackProgress, .24, .43));
      const lunge = THREE.MathUtils.smootherstep(attackProgress, .2, .62)
        * (1 - THREE.MathUtils.smootherstep(attackProgress, .82, 1));
      const followThrough = THREE.MathUtils.smootherstep(attackProgress, .55, .76)
        * (1 - THREE.MathUtils.smootherstep(attackProgress, .84, 1));
      const attackSide = Math.sign(smoothedFocusYaw || motion?.turn || 1);
      swimRoot.position.z = anticipation * .12 - lunge * .42;
      swimRoot.rotation.y -= attackSide * anticipation * .1;
      swimRoot.rotation.x += followThrough * .08;
      head.position.z = -.42 + anticipation * .28 - lunge * 1.08;
      head.rotation.x -= anticipation * .18;
      head.rotation.x += followThrough * .12;
      head.rotation.y += attackSide * anticipation * .16;
      neckJoints.forEach((joint, index) => {
        const neckT = index / Math.max(1, neckJoints.length - 1);
        const neckArch = Math.sin(neckT * Math.PI);
        joint.rotation.x += anticipation * neckArch * .075;
        joint.rotation.x -= followThrough * neckT * .009;
        joint.rotation.y += attackSide * anticipation * neckT * .018;
        joint.rotation.y *= 1 - lunge * (.48 + neckT * .26);
      });
      tailJoints.forEach((joint, index) => {
        const tailT = index / Math.max(1, tailJoints.length - 1);
        joint.rotation.y -= attackSide * anticipation * (.015 + tailT * .055);
        joint.rotation.y *= 1 + lunge * (.12 + tailT * .18);
        joint.rotation.x += followThrough * tailT * .014;
      });
      for (const flipper of flippers) {
        const front = flipper.index < 2 ? 1 : .62;
        flipper.chain.forEach((joint, index) => {
          // Open during the tell, knife backward during the drive, then catch
          // water once on the follow-through. No jaw motion is introduced.
          joint.rotation.z -= flipper.side * anticipation * front * (.08 + index * .05);
          joint.rotation.z += flipper.side * lunge * (.17 + index * .075);
          joint.rotation.z -= flipper.side * followThrough * (.07 + index * .035);
          joint.rotation.x -= lunge * (.065 + index * .024);
          joint.rotation.x += followThrough * (.035 + index * .018);
        });
      }
    }

    if (evasion) {
      const progress = THREE.MathUtils.clamp(evasion.progress, 0, 1);
      const envelope = Math.sin(progress * Math.PI);
      const curlProgress = THREE.MathUtils.smoothstep(progress, 0, .48);
      const curl = Math.sin(curlProgress * Math.PI) * (1 - THREE.MathUtils.smoothstep(progress, .62, 1));
      const headLead = Math.sin(THREE.MathUtils.smoothstep(progress, 0, .34) * Math.PI) * (1 - THREE.MathUtils.smoothstep(progress, .7, 1));
      const axialBank = Math.sin(progress * Math.PI);
      const anticipation = Math.sin(THREE.MathUtils.smootherstep(progress, 0, .18) * Math.PI)
        * (1 - THREE.MathUtils.smootherstep(progress, .14, .3));
      const exitRecovery = Math.sin(THREE.MathUtils.smootherstep(progress, .68, 1) * Math.PI);
      const handedness = evasion.handedness;
      const vertical = evasion.verticalDirection;

      if (evasion.variant === "c-turn") {
        // The head initiates the hook and the neck carries it rearward. A
        // restrained bank supports the world-space turn without making the
        // whole animal perform a rapid axial spin.
        head.rotation.y += handedness * headLead * .66;
        head.rotation.y += handedness * anticipation * .2;
        swimRoot.rotation.y += handedness * curl * .28;
        swimRoot.rotation.y -= handedness * anticipation * .07;
        swimRoot.rotation.z += handedness * axialBank * .24;
        swimRoot.rotation.z -= handedness * exitRecovery * .08;
        shoulder.rotation.y += handedness * curl * .23;
        hip.rotation.y += handedness * curl * .18;
        neckJoints.forEach((joint, index) => {
          const travel = THREE.MathUtils.smoothstep(progress - index * .012, .02, .52);
          joint.rotation.y += handedness * Math.sin(travel * Math.PI) * (.07 + index * .015) * envelope;
        });
        tailJoints.forEach((joint, index) => {
          const travel = THREE.MathUtils.smoothstep(progress - index * .018, .12, .7);
          joint.rotation.y += handedness * Math.sin(travel * Math.PI) * (.08 + index * .024) * envelope;
          joint.rotation.y -= handedness * anticipation * (.012 + index * .008);
        });
      } else if (evasion.variant === "roll-dive") {
        // A vertical escape banks first, folds through an up/down C, then
        // rolls into the new line of travel. The bank returns to neutral at
        // both ends, avoiding a one-frame orientation reset when evasion ends.
        head.rotation.x += vertical * headLead * .58;
        head.rotation.x += vertical * anticipation * .18;
        swimRoot.rotation.x += vertical * curl * .27;
        swimRoot.rotation.x -= vertical * exitRecovery * .07;
        swimRoot.rotation.z += handedness * axialBank * 1.18;
        neckJoints.forEach((joint, index) => {
          const travel = THREE.MathUtils.smoothstep(progress - index * .014, .02, .55);
          joint.rotation.x += vertical * Math.sin(travel * Math.PI) * (.05 + index * .012) * envelope;
          joint.rotation.z += handedness * envelope * (.012 + index * .004);
        });
        tailJoints.forEach((joint, index) => {
          const travel = THREE.MathUtils.smoothstep(progress - index * .018, .1, .72);
          joint.rotation.x += vertical * Math.sin(travel * Math.PI) * (.055 + index * .017) * envelope;
        });
      } else {
        // The about-face is the most dramatic planar turn: a deep head-led C
        // that straightens only after the animal is pointed directly away.
        head.rotation.y += handedness * headLead * .82;
        head.rotation.y += handedness * anticipation * .24;
        swimRoot.rotation.y += handedness * curl * .43;
        swimRoot.rotation.y -= handedness * anticipation * .09;
        swimRoot.rotation.z += handedness * axialBank * .3;
        swimRoot.rotation.z -= handedness * exitRecovery * .1;
        neckJoints.forEach((joint, index) => {
          const travel = THREE.MathUtils.smoothstep(progress - index * .011, 0, .5);
          joint.rotation.y += handedness * Math.sin(travel * Math.PI) * (.085 + index * .019) * envelope;
        });
        tailJoints.forEach((joint, index) => {
          const travel = THREE.MathUtils.smoothstep(progress - index * .02, .08, .76);
          joint.rotation.y += handedness * Math.sin(travel * Math.PI) * (.1 + index * .027) * envelope;
        });
      }

      // All three escapes tuck and then reopen the flippers, preventing the
      // ordinary leisurely stroke from fighting the high-level manoeuvre.
      for (const flipper of flippers) {
        flipper.chain.forEach((joint, index) => {
          joint.rotation.z -= flipper.side * anticipation * (.07 + index * .045);
          joint.rotation.z += flipper.side * envelope * (.2 + index * .09);
          joint.rotation.z -= flipper.side * exitRecovery * (.045 + index * .03);
          joint.rotation.x -= envelope * (.08 + index * .035);
          joint.rotation.x += exitRecovery * (.02 + index * .014);
        });
      }
    }
  };

  return { group, head, material, update };
}
