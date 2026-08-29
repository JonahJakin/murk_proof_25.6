import * as THREE from "three";

export type PhysicalEvidenceId =
  | "scale-shallow"
  | "net-cut"
  | "forest-scale"
  | "church-gouge"
  | "ledge-tooth"
  | "nest-scale"
  | "nest-bone"
  | "forest-bone";

export type PhysicalEvidenceSite = {
  id: PhysicalEvidenceId;
  label: string;
  x: number;
  z: number;
  value: number;
  nearNest: boolean;
  rotation: number;
};

export const PHYSICAL_EVIDENCE_SITES: readonly PhysicalEvidenceSite[] = [
  { id: "scale-shallow", label: "RIDGED SCALE", x: -3, z: 6, value: 1, nearNest: false, rotation: 2.86 },
  { id: "net-cut", label: "SHEARED NET CLASP", x: 12, z: -6, value: 2, nearNest: false, rotation: .42 },
  { id: "forest-scale", label: "CURVED SCALE", x: -38, z: 5, value: 2, nearNest: false, rotation: 3.28 },
  { id: "church-gouge", label: "GOUGED BELL PLATE", x: 5.8, z: -27, value: 3, nearNest: false, rotation: .24 },
  { id: "ledge-tooth", label: "TOOTH-LIKE FRAGMENT", x: 28, z: -11, value: 3, nearNest: false, rotation: -.46 },
  { id: "nest-scale", label: "FRESH SCALE", x: 42, z: -24, value: 5, nearNest: true, rotation: 2.92 },
  { id: "nest-bone", label: "CRUSHED TAG COLLAR", x: 45, z: 18, value: 5, nearNest: true, rotation: -.28 },
  { id: "forest-bone", label: "SCARRED VERTEBRA", x: -59, z: -19, value: 3, nearNest: false, rotation: .72 },
] as const;

const organicDull = new THREE.MeshStandardMaterial({
  color: 0x575a47,
  emissive: 0x080a06,
  roughness: .82,
  metalness: .02,
  flatShading: true,
});
const organicEdge = new THREE.MeshStandardMaterial({
  color: 0x373c30,
  roughness: .92,
  flatShading: true,
});
const organicFresh = new THREE.MeshStandardMaterial({
  color: 0x696e56,
  emissive: 0x0b1008,
  roughness: .42,
  metalness: .02,
  flatShading: true,
});
const organicRoot = new THREE.MeshStandardMaterial({
  color: 0x3d3b30,
  roughness: .74,
  flatShading: true,
});
const bone = new THREE.MeshStandardMaterial({
  color: 0x918b72,
  emissive: 0x0b0a06,
  roughness: .77,
  flatShading: true,
});
const boneCore = new THREE.MeshStandardMaterial({
  color: 0x5a5545,
  roughness: .96,
  flatShading: true,
});
const oxidizedIron = new THREE.MeshStandardMaterial({
  color: 0x514f42,
  emissive: 0x050604,
  roughness: .9,
  metalness: .58,
  flatShading: true,
});
const exposedIron = new THREE.MeshStandardMaterial({
  color: 0x817d68,
  roughness: .48,
  metalness: .72,
  flatShading: true,
});
const verdigrisBronze = new THREE.MeshStandardMaterial({
  color: 0x5e6650,
  emissive: 0x050805,
  roughness: .72,
  metalness: .62,
  flatShading: true,
});
const gougeDark = new THREE.MeshStandardMaterial({
  color: 0x242820,
  roughness: 1,
  flatShading: true,
});
const netFiber = new THREE.MeshStandardMaterial({
  color: 0x343a30,
  roughness: 1,
  flatShading: true,
});

const evidenceMaterials: THREE.Material[] = [
  organicDull,
  organicEdge,
  organicFresh,
  organicRoot,
  bone,
  boneCore,
  oxidizedIron,
  exposedIron,
  verdigrisBronze,
  gougeDark,
  netFiber,
];

function evidenceMesh(geometry: THREE.BufferGeometry, material: THREE.Material) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function horizontalPlate(
  points: readonly [number, number][],
  depth: number,
  material: THREE.Material,
  bevel = .025,
) {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (let index = 1; index < points.length; index++) shape.lineTo(points[index][0], points[index][1]);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelSegments: 1,
    bevelSize: bevel,
    bevelThickness: Math.min(depth * .32, bevel),
    curveSegments: 1,
    steps: 1,
  });
  geometry.translate(0, 0, -depth * .5);
  geometry.rotateX(Math.PI / 2);
  geometry.computeVertexNormals();
  return evidenceMesh(geometry, material);
}

function tube(points: readonly THREE.Vector3[], radius: number, material: THREE.Material, radialSegments = 5) {
  const curve = new THREE.CatmullRomCurve3([...points], false, "catmullrom", .35);
  return evidenceMesh(new THREE.TubeGeometry(curve, Math.max(2, points.length * 2), radius, radialSegments, false), material);
}

function branch(
  start: THREE.Vector3,
  end: THREE.Vector3,
  startRadius: number,
  endRadius: number,
  material: THREE.Material,
) {
  const direction = end.clone().sub(start);
  const mesh = evidenceMesh(
    new THREE.CylinderGeometry(endRadius, startRadius, direction.length(), 7, 1, false),
    material,
  );
  mesh.position.copy(start).add(end).multiplyScalar(.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  return mesh;
}

function torusArc(radius: number, thickness: number, arc: number, material: THREE.Material, segments = 18) {
  const mesh = evidenceMesh(new THREE.TorusGeometry(radius, thickness, 5, segments, arc), material);
  mesh.rotation.x = Math.PI / 2;
  return mesh;
}

function addScaleRidges(
  group: THREE.Group,
  count: number,
  width: number,
  length: number,
  height: number,
  material: THREE.Material,
  flare = .74,
) {
  for (let ridgeIndex = 0; ridgeIndex < count; ridgeIndex++) {
    const across = count === 1 ? 0 : ridgeIndex / (count - 1) * 2 - 1;
    // Fish-scale ridges spread from the broad root and converge toward the
    // point. Reversing that taper makes the surface read like insect legs.
    const rootX = across * width * flare;
    const middleX = across * width * .52;
    const endX = across * width * .22;
    group.add(tube([
      new THREE.Vector3(rootX, height, length * .40),
      new THREE.Vector3(middleX, height + .018, length * .06),
      new THREE.Vector3(endX, height - .008, -length * (.30 + Math.abs(across) * .04)),
    ], .014 + (1 - Math.abs(across)) * .008, material, 4));
  }
}

function createRidgedScale() {
  const group = new THREE.Group();
  const points: [number, number][] = [
    [0, -.79], [-.18, -.61], [-.39, -.29], [-.48, .08], [-.42, .35],
    [-.19, .53], [.02, .44], [.21, .55], [.43, .31], [.48, .02], [.33, -.38], [.16, -.65],
  ];
  const underlay = horizontalPlate(points, .052, organicEdge, .014);
  underlay.scale.set(1.035, 1, 1.035);
  group.add(underlay);
  const shell = horizontalPlate(points, .058, organicDull, .018);
  shell.position.y = .027;
  shell.scale.set(.97, 1, .97);
  group.add(shell);
  addScaleRidges(group, 5, .45, .74, .073, organicEdge, .82);
  group.add(tube([
    new THREE.Vector3(0, .071, .40),
    new THREE.Vector3(0, .088, -.08),
    new THREE.Vector3(0, .068, -.65),
  ], .024, organicEdge, 5));
  const chippedEdge = horizontalPlate([
    [-.24, -.52], [-.06, -.72], [.03, -.65], [-.11, -.43],
  ], .014, gougeDark, 0);
  chippedEdge.position.y = .065;
  group.add(chippedEdge);
  return group;
}

function createCurvedScale() {
  const group = new THREE.Group();
  const points: [number, number][] = [
    [-.02, -.82], [-.27, -.61], [-.50, -.23], [-.55, .14], [-.40, .43],
    [-.15, .61], [.08, .53], [.28, .62], [.50, .36], [.57, .03], [.39, -.40], [.17, -.67],
  ];
  const shell = horizontalPlate(points, .065, organicDull, .02);
  shell.rotation.z = -.07;
  shell.rotation.x = -.18;
  group.add(shell);
  addScaleRidges(group, 6, .52, .74, .115, organicEdge, .85);
  group.add(tube([
    new THREE.Vector3(.02, .11, .48),
    new THREE.Vector3(.02, .15, -.10),
    new THREE.Vector3(-.02, .085, -.70),
  ], .032, organicEdge, 5));
  const tornRoot = horizontalPlate([
    [-.24, .48], [-.09, .64], [.08, .56], [.20, .50], [.04, .36],
  ], .022, organicRoot, .006);
  tornRoot.position.y = .11;
  group.add(tornRoot);
  return group;
}

function createFreshScale() {
  const group = new THREE.Group();
  const points: [number, number][] = [
    [0, -.96], [-.26, -.72], [-.53, -.32], [-.63, .11], [-.55, .45],
    [-.27, .68], [-.08, .76], [.07, .66], [.20, .79], [.43, .59], [.63, .20], [.58, -.31], [.31, -.73],
  ];
  const darkMargin = horizontalPlate(points, .068, organicRoot, .022);
  darkMargin.scale.set(1.035, 1, 1.035);
  group.add(darkMargin);
  const shell = horizontalPlate(points, .072, organicFresh, .022);
  shell.position.y = .035;
  shell.scale.set(.97, 1, .97);
  group.add(shell);
  addScaleRidges(group, 7, .59, .88, .092, organicEdge, .84);
  group.add(tube([
    new THREE.Vector3(0, .09, .61),
    new THREE.Vector3(0, .115, -.08),
    new THREE.Vector3(0, .082, -.82),
  ], .034, organicEdge, 5));
  const rootMembrane = horizontalPlate([
    [-.36, .52], [-.17, .73], [-.05, .66], [.08, .77], [.18, .65], [.34, .52], [.18, .38], [-.17, .39],
  ], .026, organicRoot, .009);
  rootMembrane.position.y = .105;
  group.add(rootMembrane);
  for (const offset of [-.18, .04, .22]) {
    const filament = branch(
      new THREE.Vector3(offset, .12, .60),
      new THREE.Vector3(offset * 1.15, .10, .80 + Math.abs(offset) * .12),
      .016,
      .006,
      organicRoot,
    );
    group.add(filament);
  }
  return group;
}

function createNetClasp() {
  const group = new THREE.Group();
  const ring = torusArc(.39, .085, Math.PI * 1.68, oxidizedIron, 16);
  ring.rotation.z = .17;
  group.add(ring);
  for (const side of [-1, 1]) {
    const cut = evidenceMesh(new THREE.CylinderGeometry(.095, .095, .12, 6), exposedIron);
    cut.rotation.z = Math.PI / 2;
    cut.position.set(side * .35, .055, -.20 + side * .05);
    group.add(cut);
  }
  const jaw = horizontalPlate([
    [-.10, -.12], [.48, -.08], [.61, .02], [.44, .13], [-.10, .10],
  ], .095, oxidizedIron, .012);
  jaw.position.set(.37, .025, -.12);
  jaw.rotation.y = -.12;
  group.add(jaw);
  const ropeOrigins = [
    new THREE.Vector3(.56, .13, -.08),
    new THREE.Vector3(.61, .11, .02),
    new THREE.Vector3(.54, .10, .12),
  ];
  ropeOrigins.forEach((origin, index) => {
    group.add(tube([
      origin,
      new THREE.Vector3(.80 + index * .06, .08, -.02 + index * .13),
      new THREE.Vector3(1.04 + index * .10, .045, -.16 + index * .22),
    ], .018, netFiber, 4));
  });
  group.add(tube([
    new THREE.Vector3(.77, .075, -.10),
    new THREE.Vector3(.83, .07, .09),
    new THREE.Vector3(.94, .05, .28),
  ], .012, netFiber, 4));
  return group;
}

function createBellPlate() {
  const group = new THREE.Group();
  const platePoints: [number, number][] = [
    [-.65, -.36], [-.25, -.49], [.42, -.42], [.64, -.19], [.57, .30],
    [.22, .43], [-.48, .35], [-.61, .13],
  ];
  const plate = horizontalPlate(platePoints, .082, verdigrisBronze, .02);
  plate.rotation.x = -.08;
  group.add(plate);
  const rim = tube([
    new THREE.Vector3(-.59, .105, -.31),
    new THREE.Vector3(-.12, .14, -.43),
    new THREE.Vector3(.40, .13, -.37),
    new THREE.Vector3(.59, .10, -.18),
  ], .035, oxidizedIron, 5);
  group.add(rim);
  for (let mark = 0; mark < 3; mark++) {
    const x = -.25 + mark * .20;
    const scar = tube([
      new THREE.Vector3(x - .18, .151, .29),
      new THREE.Vector3(x, .165, .02),
      new THREE.Vector3(x + .22, .145, -.25),
    ], .025 + mark * .003, gougeDark, 4);
    group.add(scar);
    const exposed = tube([
      new THREE.Vector3(x - .15, .162, .275),
      new THREE.Vector3(x + .02, .176, .02),
      new THREE.Vector3(x + .19, .157, -.22),
    ], .010, exposedIron, 4);
    group.add(exposed);
  }
  const fracture = tube([
    new THREE.Vector3(.45, .145, .28),
    new THREE.Vector3(.35, .15, .15),
    new THREE.Vector3(.47, .14, .02),
  ], .015, gougeDark, 4);
  group.add(fracture);
  return group;
}

function createToothFragment() {
  const group = new THREE.Group();
  const tooth = horizontalPlate([
    [-.57, -.25], [-.33, -.39], [-.02, -.32], [.34, -.14], [.72, .06],
    [.34, .18], [.02, .34], [-.35, .31], [-.56, .14],
  ], .19, bone, .035);
  tooth.rotation.x = -.09;
  group.add(tooth);
  const rootFace = horizontalPlate([
    [-.60, -.25], [-.34, -.38], [-.29, .31], [-.58, .15],
  ], .035, boneCore, .006);
  rootFace.position.y = .12;
  group.add(rootFace);
  const rootLobeA = evidenceMesh(new THREE.DodecahedronGeometry(.23, 0), bone);
  rootLobeA.scale.set(1.25, .58, .72);
  rootLobeA.position.set(-.47, .15, -.18);
  group.add(rootLobeA);
  const rootLobeB = rootLobeA.clone();
  rootLobeB.position.z = .18;
  rootLobeB.rotation.y = .3;
  group.add(rootLobeB);
  group.add(tube([
    new THREE.Vector3(-.27, .22, -.18),
    new THREE.Vector3(-.05, .23, -.07),
    new THREE.Vector3(.12, .21, -.13),
  ], .014, boneCore, 4));
  group.add(tube([
    new THREE.Vector3(-.03, .22, .19),
    new THREE.Vector3(.14, .21, .08),
    new THREE.Vector3(.27, .18, .11),
  ], .011, boneCore, 4));
  return group;
}

function createTagCollar() {
  const group = new THREE.Group();
  const collar = torusArc(.48, .105, Math.PI * 1.72, oxidizedIron, 20);
  collar.scale.z = .66;
  collar.rotation.z = -.42;
  group.add(collar);
  const crushedBar = branch(
    new THREE.Vector3(-.42, .05, -.11),
    new THREE.Vector3(.28, .16, .23),
    .10,
    .075,
    oxidizedIron,
  );
  group.add(crushedBar);
  const tag = horizontalPlate([
    [-.28, -.18], [.22, -.18], [.31, -.03], [.20, .20], [-.22, .19], [-.31, .03],
  ], .075, verdigrisBronze, .018);
  tag.position.set(.55, .04, .23);
  tag.rotation.y = -.24;
  group.add(tag);
  const tagHole = evidenceMesh(new THREE.TorusGeometry(.065, .018, 5, 10), exposedIron);
  tagHole.position.set(.38, .102, .22);
  tagHole.rotation.x = Math.PI / 2;
  group.add(tagHole);
  for (const offset of [-.11, .04, .17]) {
    const scoredLine = new THREE.Mesh(new THREE.BoxGeometry(.24, .012, .018), gougeDark);
    scoredLine.position.set(.62, .085, .23 + offset);
    scoredLine.rotation.y = -.24;
    group.add(scoredLine);
  }
  const tornEnd = evidenceMesh(new THREE.CylinderGeometry(.10, .10, .10, 6), exposedIron);
  tornEnd.rotation.z = Math.PI / 2;
  tornEnd.position.set(-.35, .09, -.29);
  group.add(tornEnd);
  return group;
}

function createVertebra() {
  const group = new THREE.Group();
  const body = evidenceMesh(new THREE.CylinderGeometry(.31, .27, .40, 9), bone);
  body.rotation.z = Math.PI / 2;
  body.position.y = .30;
  group.add(body);
  for (const side of [-1, 1]) {
    const endPlate = evidenceMesh(new THREE.CylinderGeometry(.34, .34, .07, 9), bone);
    endPlate.rotation.z = Math.PI / 2;
    endPlate.position.set(side * .225, .30, 0);
    group.add(endPlate);
    const endCore = evidenceMesh(new THREE.CylinderGeometry(.14, .16, .074, 8), boneCore);
    endCore.rotation.z = Math.PI / 2;
    endCore.position.set(side * .263, .30, 0);
    group.add(endCore);
  }
  group.add(branch(
    new THREE.Vector3(0, .44, 0),
    new THREE.Vector3(-.05, .92, -.05),
    .13,
    .045,
    bone,
  ));
  group.add(branch(
    new THREE.Vector3(-.06, .45, -.10),
    new THREE.Vector3(-.18, .56, -.66),
    .10,
    .035,
    bone,
  ));
  group.add(branch(
    new THREE.Vector3(.06, .45, .09),
    new THREE.Vector3(.23, .54, .62),
    .10,
    .028,
    bone,
  ));
  group.add(branch(
    new THREE.Vector3(-.04, .20, -.10),
    new THREE.Vector3(.02, .10, -.48),
    .075,
    .025,
    bone,
  ));
  const scarBand = torusArc(.285, .022, Math.PI * 1.2, boneCore, 10);
  scarBand.position.set(.04, .30, 0);
  scarBand.rotation.y = Math.PI / 2;
  scarBand.rotation.z = .4;
  group.add(scarBand);
  return group;
}

function groundEvidence(group: THREE.Group, id: PhysicalEvidenceId) {
  const wrapper = new THREE.Group();
  wrapper.name = `physical-evidence-${id}`;
  wrapper.userData.evidenceId = id;
  wrapper.userData.artVersion = "distinct-procedural-v2";
  wrapper.add(group);
  const bounds = new THREE.Box3().setFromObject(group);
  group.position.y -= bounds.min.y;
  wrapper.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      object.castShadow = true;
      object.receiveShadow = true;
    }
  });
  return wrapper;
}

export function createPhysicalEvidence(id: PhysicalEvidenceId) {
  let art: THREE.Group;
  switch (id) {
    case "scale-shallow": art = createRidgedScale(); break;
    case "net-cut": art = createNetClasp(); break;
    case "forest-scale": art = createCurvedScale(); break;
    case "church-gouge": art = createBellPlate(); break;
    case "ledge-tooth": art = createToothFragment(); break;
    case "nest-scale": art = createFreshScale(); break;
    case "nest-bone": art = createTagCollar(); break;
    case "forest-bone": art = createVertebra(); break;
  }
  return groundEvidence(art, id);
}

export function disposePhysicalEvidence(groups: readonly THREE.Group[]) {
  const geometries = new Set<THREE.BufferGeometry>();
  groups.forEach((group) => group.traverse((object) => {
    if (object instanceof THREE.Mesh) geometries.add(object.geometry);
  }));
  geometries.forEach((geometry) => geometry.dispose());
  evidenceMaterials.forEach((material) => material.dispose());
}
